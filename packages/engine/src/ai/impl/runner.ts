import type { EngineServices } from '../../runtime/services';
import { setupSessionOpen } from '../../methods/setup';
import { sweepFollowups } from './backfill';
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
const SETUP_RECHECK_MS = 60_000;
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

/** Claim a due row (queued → running); the commit's changed count says whether OUR update won. */
function claim(services: EngineServices, row: JobRow, now: number): boolean {
  const seq = services.store.seq();
  const res = services.store.commit({
    opId: `ai-claim-${row.id}-${now}-${seq}`,
    origin: 'system',
    writes: [{ kind: 'job', action: 'claim', id: row.id, at: now }],
  });
  return res.changed > 0;
}

function settle(
  services: EngineServices,
  row: JobRow,
  result: {
    state: 'done' | 'failed' | 'dead' | 'skipped' | 'release';
    lastError?: string | null;
    nextAt?: number;
  },
): void {
  // 'release' is a gate/cap pause mid-run: back to queued with a fresh attempt budget at the pause horizon.
  const write =
    result.state === 'release'
      ? {
          kind: 'job' as const,
          action: 'requeue' as const,
          id: row.id,
          nextAt: result.nextAt ?? services.clock.now() + PAUSE_MS,
        }
      : {
          kind: 'job' as const,
          action: 'settle' as const,
          id: row.id,
          state: result.state as 'done' | 'failed' | 'dead',
          ...(result.lastError !== undefined ? { lastError: result.lastError } : {}),
          ...(result.nextAt !== undefined ? { nextAt: result.nextAt } : {}),
        };
  services.store.commit({
    opId: `ai-settle-${row.id}-${services.clock.now()}`,
    origin: 'system',
    writes: [write],
  });
}

/** When the whole queue waits on consent or budget: push ALL due rows out so `next()` sleeps instead of spinning. */
function pauseDue(services: EngineServices, now: number, until: number): void {
  services.store.commit({
    opId: `ai-defer-${now}-${until}`,
    origin: 'system',
    writes: [{ kind: 'job', action: 'defer', at: now, nextAt: until }],
  });
}

/**
 * One fire of the `jobs` source: claim and run what is due, then leave `next()` at the next due row.
 * The crash-reset is per STORE, not per process: two engines (or a test store) each reclaim once.
 */
const resetDone = new WeakSet<object>();

export async function runJobs(services: EngineServices, now: number): Promise<void> {
  // Once per store: a crash can leave 'running' rows with no runner behind them — queue them again.
  if (!resetDone.has(services.store)) {
    resetDone.add(services.store);
    services.store.commit({
      opId: `ai-reset-${now}`,
      origin: 'system',
      writes: [{ kind: 'job', action: 'reset' }],
    });
  }
  // Threads aging into Home's Follow up lane queue their nudge job here, before due work is claimed; the
  // bounded sweep's singleton keys make the repeat pass a no-op when nothing moved.
  sweepFollowups(services);
  for (;;) {
    const rows = dueJobs(services, now, CONCURRENCY);
    if (!rows.length) return;
    // An open setup session means the backfill is still being composed — don't race it. Push the due rows out a
    // minute (like the cap pause) so the timer loop sleeps instead of re-firing on rows that are still due.
    if (setupSessionOpen()) return pauseDue(services, now, now + SETUP_RECHECK_MS);
    // A spent daily cap pauses the queue until tomorrow, not fail-by-fail and not a 30-minute spin.
    if (!budgetOpen(services)) {
      const d = new Date(now);
      pauseDue(services, now, new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime());
      return;
    }
    // The gate covers the whole pass: no consent, AI off or a trains-on-inputs pick pauses the queue.
    const gate = backgroundGate(services, 'summaries');
    if (!gate.ok) {
      if (gate.reasonCode === 'ai.accountExcluded') {
        // Per-account gates are checked inside executeJob; run the pass.
      } else {
        pauseDue(services, now, now + PAUSE_MS);
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
