import type { EngineServices } from '../../runtime/services';
import { backgroundGate } from './gate';
import { budgetOpen } from './runtime';
import { executeJob } from './execute';
import type { JobRow } from './jobs';

/**
 * The `jobs` deadline source's fire (ARCH 8.1): drains due queued jobs in priority order, 1-2 concurrent, behind the
 * background gate and the daily cap. Claims are commits, so a crash mid-run leaves the row `running` and module
 * start's `reset` queues it again — a job may retry, never run twice at once.
 *
 * A gate refusal does not fail rows: it pauses the whole pass to a later `next_at` (reconsent, AI off) or skips
 * this job (an account turned off). Provider failures back off per attempt and dead-letter after 5.
 */

const CONCURRENCY = 2;
const MAX_ATTEMPTS = 5;
/** Gate-paused passes retry the whole queue this far out. */
const PAUSE_MS = 30 * 60_000;
const BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 4 * 60 * 60_000];

/** Due queued rows in priority order. */
function dueJobs(services: EngineServices, now: number, limit: number): JobRow[] {
  return services.store.read(q =>
    q.all<JobRow>(
      "SELECT id, kind, key, priority, payload, state, attempts, next_at, last_error FROM jobs WHERE state IN ('queued','failed') AND next_at <= ? ORDER BY priority, next_at, id LIMIT ?",
      now,
      limit,
    ),
  );
}

/** Claim a due row (queued → running); false when another runner took it. */
function claim(services: EngineServices, row: JobRow, now: number): boolean {
  const seq = services.store.seq();
  services.store.commit({
    opId: `ai-claim-${row.id}-${now}-${seq}`,
    origin: 'system',
    writes: [{ kind: 'job', action: 'claim', id: row.id, at: now }],
  });
  return (
    services.store.read(
      q => q.get<{ state: string }>('SELECT state FROM jobs WHERE id = ?', row.id)?.state,
    ) === 'running'
  );
}

function settle(
  services: EngineServices,
  row: JobRow,
  result: { state: 'done' | 'failed' | 'dead'; lastError?: string | null; nextAt?: number },
): void {
  services.store.commit({
    opId: `ai-settle-${row.id}-${services.clock.now()}`,
    origin: 'system',
    writes: [
      {
        kind: 'job',
        action: 'settle',
        id: row.id,
        state: result.state,
        ...(result.lastError !== undefined ? { lastError: result.lastError } : {}),
        ...(result.nextAt !== undefined ? { nextAt: result.nextAt } : {}),
      },
    ],
  });
}

/** When the whole queue waits on consent or budget: push due rows out so `next()` sleeps instead of spinning. */
function pauseDue(services: EngineServices, rows: JobRow[], until: number): void {
  for (const row of rows)
    services.store.commit({
      opId: `ai-defer-${row.id}-${until}`,
      origin: 'system',
      writes: [{ kind: 'job', action: 'defer', id: row.id, nextAt: until }],
    });
}

/** One fire of the `jobs` source: claim and run what is due, then leave `next()` at the next due row. */
let resetDone = false;

export async function runJobs(services: EngineServices, now: number): Promise<void> {
  // Once per engine life: a crash can leave 'running' rows with no runner behind them — queue them again.
  if (!resetDone) {
    resetDone = true;
    services.store.commit({
      opId: `ai-reset-${now}`,
      origin: 'system',
      writes: [{ kind: 'job', action: 'reset' }],
    });
  }
  for (;;) {
    const rows = dueJobs(services, now, CONCURRENCY);
    if (!rows.length) return;
    // A spent daily cap pauses the queue until tomorrow, not fail-by-fail.
    if (!budgetOpen(services)) {
      pauseDue(services, rows, now + PAUSE_MS);
      return;
    }
    // The gate covers the whole pass: no consent, AI off or a trains-on-inputs pick pauses the queue.
    const gate = backgroundGate(services, 'summaries');
    if (!gate.ok) {
      if (gate.reasonCode === 'ai.accountExcluded') {
        // Per-account gates are checked inside executeJob; run the pass.
      } else {
        pauseDue(services, rows, now + PAUSE_MS);
        return;
      }
    }
    let claimed = 0;
    await Promise.all(
      rows.map(async row => {
        if (!claim(services, row, now)) return;
        claimed++;
        const outcome = await executeJob(services, row, now);
        settle(services, row, outcome);
      }),
    );
    if (!claimed) return;
    // A round finished; loop while more work is due right now.
  }
}

export { BACKOFF_MS, MAX_ATTEMPTS };
