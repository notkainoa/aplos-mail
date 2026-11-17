import type { EngineServices } from '../../runtime/services';
import { setupSessionOpen } from '../../methods/setup';
import { StoreError } from '../../store/port';
import { splitId } from '../../views/compile';
import { catchUpSummaries, sweepFollowups } from './backfill';
import { hexId } from '../../sync/connect-sessions';
import type { ModelRef } from '@aplos/contract';
import { aiSettings, backgroundGate } from './gate';
import { budgetOpen, dailyUsage } from './runtime';
import { executeJob, type JobOutcome } from './execute';
import { featureOf, nextFollowAt, queueSummary, type JobRow } from './jobs';

/**
 * The `jobs` deadline source's fire (ARCH 8.1): drains due queued jobs in priority order, 1-2 concurrent, behind the
 * background gate and the daily cap. Claims are commits, so a crash mid-run leaves the row `running` and module
 * start's `reset` queues it again — a job may retry, never run twice at once.
 *
 * A gate refusal does not fail rows: it pauses the whole pass to a later `next_at` (reconsent, AI off) or skips
 * this job (an account turned off). Provider failures back off per attempt and dead-letter after 5.
 */

const CONCURRENCY = 2;
/** Due rows read per round: provider jobs still cap at CONCURRENCY, but wake sentinels batch in one pass. */
const ROUND_LIMIT = 128;
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
    // Unique per settle, like the claim's seq suffix: a replayed commit opId is a silent no-op, and
    // without a nonce a second settle of this row inside the same clock tick would leave it `running`.
    opId: `ai-settle-${row.id}-${services.clock.now()}-${hexId(services.randomBytes, 's')}`,
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
/**
 * Arms the Follow up lane's wake sentinel: exactly one `wake`-kind row under key `followup-wake` carries
 * `nextFollowAt` as its `next_at`, so the plain `next()` SQL wakes the queue when a thread ages into the lane
 * (runJobs settles a due wake row `done` and the sweep at pass top queues the new thread's job). No candidates
 * and the row settles; a moved deadline re-arms via `defer`. Call it after every sweep/pass.
 */
function ensureFollowWake(services: EngineServices): void {
  services.store.commit({
    opId: `ai-wake-${hexId(services.randomBytes, 'w')}`,
    origin: 'system',
    writes: services.store.read(q => {
      const existing = q.get<{ id: number; next_at: number }>(
        "SELECT id, next_at FROM jobs WHERE key = 'followup-wake' AND state IN ('queued','failed')",
      );
      const at = nextFollowAt(q);
      if (at === undefined)
        return existing
          ? [
              {
                kind: 'job' as const,
                action: 'settle' as const,
                id: existing.id,
                state: 'done' as const,
              },
            ]
          : [];
      if (!existing)
        return [
          {
            kind: 'job' as const,
            action: 'enqueue' as const,
            job: { kind: 'wake', key: 'followup-wake', priority: 9, payload: '{}', nextAt: at },
          },
        ];
      return existing.next_at === at
        ? []
        : [{ kind: 'job' as const, action: 'defer' as const, id: existing.id, nextAt: at }];
    }),
  });
  services.deadlines.changed('jobs');
}

/** The reasonCode a settled row recorded, or the generic one — provider text never lands in the log. */
const reasonOf = (raw: string | null | undefined): string => {
  try {
    const code = raw ? (JSON.parse(raw) as { reasonCode?: unknown })?.reasonCode : undefined;
    return typeof code === 'string' && code.length <= 60 ? code : 'ai.failed';
  } catch {
    return 'ai.failed';
  }
};

/**
 * One log event per settled job: `done` at debug, a 'failed' attempt and a dead-letter at warn — a quiet
 * failure would leave the card's "Summarizing…" collapse with no recorded reason; 'release' and 'skipped' are
 * by-design pauses, not failures. Provider text never reaches the log: the fields carry codes and the
 * feature's configured model only.
 */
function logOutcome(
  services: EngineServices,
  row: JobRow,
  outcome: JobOutcome,
  started: number,
): void {
  const feature = featureOf(row.kind);
  // The model the job was queued under, not whatever Settings holds at settle time — the payload stamp is
  // what `AiJob.model` already surfaces; a job enqueued without one falls back to the configured feature.
  let model: ModelRef | undefined;
  try {
    const stamped = (JSON.parse(row.payload) as { model?: unknown }).model;
    if (typeof stamped === 'object' && stamped !== null) model = stamped as ModelRef;
  } catch {
    /* a malformed payload falls through to the settings read */
  }
  model ??= aiSettings(services).features[feature];
  if (outcome.state === 'done')
    services.log.event('ai.job.done', {
      job: String(row.id),
      feature,
      provider: model?.provider ?? 'unknown',
      model: model?.model ?? 'unknown',
      durationMs: Math.max(0, services.clock.now() - started),
    });
  if (outcome.state === 'failed' || outcome.state === 'dead')
    services.log.event('ai.job.failed', {
      job: String(row.id),
      feature,
      provider: model?.provider ?? 'unknown',
      model: model?.model ?? 'unknown',
      attempt: row.attempts + 1,
      ...(outcome.nextAt !== undefined
        ? { nextInMs: Math.max(0, outcome.nextAt - services.clock.now()) }
        : {}),
      error: {
        class: outcome.state === 'dead' ? 'permanent' : 'transient',
        provider: 'ai',
        method: 'chat',
        reason: reasonOf(outcome.lastError),
      },
    });
}

/**
 * A dead/skipped summary job settles its `pending` placeholder: text it carried survives as `stale` (the Home
 * row keeps the older summary instead of collapsing to nothing), an empty one becomes `failed`. Only the
 * placeholder flips — a `ready` row is never overwritten, and a failure with no placeholder (the gate was
 * closed at queue time) writes nothing, so an empty `failed` row can never hide a good older summary.
 */
function failSummary(services: EngineServices, row: JobRow): void {
  try {
    const p = JSON.parse(row.payload) as {
      accountId?: unknown;
      remoteThreadId?: unknown;
      inputHash?: unknown;
    };
    if (
      typeof p.accountId !== 'string' ||
      typeof p.remoteThreadId !== 'string' ||
      typeof p.inputHash !== 'string'
    )
      return;
    const held = services.store.read(q => {
      const t = q.get<{ id: number }>(
        'SELECT id FROM threads WHERE account_id = ? AND remote_id = ?',
        p.accountId as string,
        p.remoteThreadId as string,
      );
      if (!t) return undefined;
      return q.get<{ state: string; text: string; model: string; action: string | null }>(
        'SELECT state, text, model, action FROM summaries WHERE thread_id = ? AND input_hash = ?',
        t.id,
        p.inputHash as string,
      );
    });
    if (held?.state !== 'pending') return;
    services.store.commit({
      opId: `ai-failed-${row.id}-${hexId(services.randomBytes, 'f')}`,
      origin: 'system',
      writes: [
        {
          kind: 'summary',
          accountId: p.accountId,
          remoteThreadId: p.remoteThreadId,
          inputHash: p.inputHash,
          model: held.model,
          text: held.text,
          action: held.action,
          state: held.text ? 'stale' : 'failed',
        },
      ],
    });
  } catch {
    // The job row's own settle already recorded the loss; a stale placeholder is the only cost of a failure here.
  }
}

/**
 * Nothing coming means the card collapses, not "Summarizing…" forever: a `pending` placeholder flips to
 * `failed` (or `stale` when it carried text), the same settle `failSummary` makes before a job could ever be
 * attempted, whenever its work cannot run — the Summaries gate closed for every account, the row's own
 * account kept out of AI, or the `summary:…` singleton-keyed job row gone entirely (orphan: `classify`
 * shares that key, so one key check covers both kinds). The live-state list keeps `running` defensively —
 * a claimed job owns its placeholder — but the check never actually sees one: `runJobs` is sequential, the
 * sweep only runs before the loop or inside a pause branch (never while claimed work is mid-flight), and
 * the per-store crash reset requeues stranded `running` rows up front. `force` closes every placeholder —
 * the queue's own pauses (spent day cap, open setup session) hold all due jobs past the card's patience,
 * and a settled row re-queues when the pause lifts (catch-up and wake sentinels skip only `ready`).
 * Bounded to `summaries` placeholders; other features have none.
 */
function closePendingSummaries(services: EngineServices, now: number, force = false): void {
  const gateOff = backgroundGate(services, 'summaries').ok ? 0 : 1;
  // Each pass settles at most 200 rows in one commit — the periodic sweep stays bounded — but `force`
  // drains: the pause that calls it may not fire again until tomorrow, so every held card must collapse
  // now. Settled rows fall out of the WHERE, so the next read continues where the last stopped.
  for (let pass = 0; ; pass++) {
    const rows = services.store.read(q =>
      q.all<{
        account_id: string;
        remote_id: string;
        input_hash: string;
        model: string;
        text: string;
        action: string | null;
      }>(
        `SELECT t.account_id, t.remote_id, s.input_hash, s.model, s.text, s.action
         FROM summaries s JOIN threads t ON t.id = s.thread_id
         JOIN accounts a ON a.id = t.account_id
         WHERE s.state = 'pending' AND (
           ? = 1 OR ? = 1 OR a.ai_allowed != 1
           OR NOT EXISTS (
             SELECT 1 FROM jobs j
             WHERE j.state IN ('queued','running','failed')
               AND j.key = 'summary:' || t.account_id || ':' || t.remote_id || ':' || s.input_hash
           )
         )
         ORDER BY s.created_at LIMIT 200`,
        force ? 1 : 0,
        gateOff,
      ),
    );
    if (!rows.length) return;
    services.store.commit({
      opId: `ai-pending-closed-${now}-${hexId(services.randomBytes, 'p')}`,
      origin: 'system',
      writes: rows.map(r => ({
        kind: 'summary' as const,
        accountId: r.account_id,
        remoteThreadId: r.remote_id,
        inputHash: r.input_hash,
        model: r.model,
        text: r.text,
        ...(r.action !== null ? { action: r.action } : {}),
        state: (r.text ? 'stale' : 'failed') as 'stale' | 'failed',
      })),
    });
    // A non-force pass is one bounded sweep. `force` loops until the backlog is gone; the absurd ceiling
    // exists so a store that lies about changed counts still returns control instead of spinning.
    if (!force || pass >= 99) return;
  }
}

/**
 * The release reasons whose card's "nothing is coming" is already true: no key, no provider, no AI on this
 * build — and a spent day cap, which waits until tomorrow but holds the card on "Summarizing…" for the rest
 * of today, so it settles the same way (the queue's own cap pause force-closes any placeholder it missed).
 * `gatePaused` alone stays a real wait: a paused gate lifts in minutes, not overnight. The job keeps its
 * queue slot either way — the subset of `RELEASE_CODES` (execute.ts) that collapses the placeholder now.
 */
const AI_OFF_RELEASE: ReadonlySet<string> = new Set([
  'missingKey',
  'unavailable',
  'noProvider',
  'dailyLimit',
]);

const resetDone = new WeakSet<object>();
/** The day a `budget_exhausted` event was last logged, per engine — a spent cap warns once, then sleeps till tomorrow. */
const budgetWarned = new WeakMap<object, string>();

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
  // bounded sweep's singleton keys make the repeat pass a no-op when nothing moved. A sweep failure must
  // never block due jobs — it retries at the next wake.
  try {
    sweepFollowups(services);
    ensureFollowWake(services);
  } catch {
    /* the wake sentinel and the sweep re-arm together at the next pass */
  }
  // AI off is a collapse, not a wait: a placeholder whose gate is closed settles up front rather than hanging
  // on a queued job that may sit hours out on backoff — a reopened gate re-queues it from wakes.
  closePendingSummaries(services, now);
  for (;;) {
    const rows = dueJobs(services, now, ROUND_LIMIT);
    if (!rows.length) return;
    // An open setup session means the backfill is still being composed — don't race it. Push the due rows out a
    // minute (like the cap pause) so the timer loop sleeps instead of re-firing on rows that are still due —
    // and a held placeholder settles first, since the session can stay open far past the card's patience.
    if (setupSessionOpen()) {
      closePendingSummaries(services, now, true);
      return pauseDue(services, now, now + SETUP_RECHECK_MS);
    }
    // A spent daily cap pauses the queue until tomorrow, not fail-by-fail and not a 30-minute spin — and every
    // held placeholder settles first: "Summarizing…" for the rest of the day reads as a hang, not a wait.
    if (!budgetOpen(services)) {
      closePendingSummaries(services, now, true);
      const d = new Date(now);
      const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (budgetWarned.get(services) !== day) {
        budgetWarned.set(services, day);
        const { spent, cap } = dailyUsage(services);
        services.log.event('ai.budget_exhausted', { used: spent, limit: cap ?? spent });
      }
      pauseDue(services, now, new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime());
      return;
    }
    // The gate pauses the queue only when every due kind's own feature is closed: a broken Summaries
    // provider must not sit in front of open Plans or Drafts work (per-executor gates still re-check
    // the feature and the job's account before any mail is read).
    const features = [...new Set(rows.filter(r => r.kind !== 'wake').map(r => featureOf(r.kind)))];
    const open = features.filter(f => {
      const g = backgroundGate(services, f);
      return g.ok || g.reasonCode === 'ai.accountExcluded';
    });
    if (features.length && !open.length) {
      pauseDue(services, now, now + PAUSE_MS);
      return;
    }
    let handled = 0;
    // Due 'wake' sentinels run in one batched pass: every wake action is idempotent under the job/summary
    // singleton keys, so there is no claim, and the whole set is deleted in a single commit — a delivery
    // burst must not spend a claim-plus-settle pair per touched thread. Deleting (not settling) is the whole
    // lifecycle: a sentinel has no retry state worth keeping, `settle` only writes over `running` rows, and
    // every re-arm path (`aiIngest`'s upsert, `ensureFollowWake`, `requestAiCatchUp`) inserts fresh anyway —
    // so a fired wake row is dropped, not left to accumulate.
    const wakes = rows.filter(r => r.kind === 'wake');
    if (wakes.length) {
      const drops: { kind: 'job'; action: 'delete'; id: number }[] = [];
      for (const row of wakes) {
        try {
          if (row.key.startsWith('ingest:')) {
            // `splitId`, not a delimiter cut: account ids may carry a ':' of their own.
            const ref = services.store.read(q => splitId(q, row.key.slice(7)));
            if (ref) queueSummary(services, ref.accountId, ref.remoteId);
          } else if (row.key === 'ai:backfill') catchUpSummaries(services);
        } catch (error) {
          try {
            services.log.event('ai.backfill_failed', {
              code: error instanceof StoreError ? error.code : 'ai.ingest',
            });
          } catch {
            /* a logless host keeps the pass moving */
          }
        }
        drops.push({ kind: 'job', action: 'delete', id: row.id });
      }
      try {
        services.store.commit({
          opId: `ai-wakes-${now}-${hexId(services.randomBytes, 'w')}`,
          origin: 'system',
          writes: drops,
        });
        handled += wakes.length;
      } catch {
        // The rows stay queued and fire again next pass (every wake action is idempotent); NOT counting them
        // also means a store that persistently refuses the commit ends the run instead of spinning.
      }
    }
    await Promise.all(
      rows
        .filter(row => row.kind !== 'wake')
        .slice(0, CONCURRENCY)
        .map(async row => {
          if (!claim(services, row, now)) return;
          handled++;
          const started = services.clock.now();
          const outcome = await executeJob(services, row);
          logOutcome(services, row, outcome, started);
          settle(services, row, outcome);
          // A summary job that will not run again clears its `pending` placeholder to `failed` (a Home row
          // collapses); a retryable 'failed' attempt keeps it while the queue retries. So does a release for
          // an AI-off reason — the job stays queued for the owner's fix but nothing is coming now — while a
          // release for a short wait (a paused gate) holds the placeholder.
          if (
            (row.kind === 'summary' || row.kind === 'classify') &&
            (outcome.state === 'dead' ||
              outcome.state === 'skipped' ||
              (outcome.state === 'release' && AI_OFF_RELEASE.has(outcome.code ?? '')))
          )
            failSummary(services, row);
        }),
    );
    if (!handled) return;
    // A round finished; loop while more work is due right now — an ingest sentinel's `summary` job lands here.
    // The yield is a real timer turn, not a microtask: a pass of only sentinels awaits nothing else, and a
    // first sync's sentinel storm must not starve the event loop between rounds.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
}

export { BACKOFF_MS, MAX_ATTEMPTS };
