import type { State, Submission, SubmissionAction } from '@aplos/contract';
import type { CommitExtension } from '../store';
import type { OutboxCtx, OutboxDeps } from './context';
import { outboxSource } from './runner';
import { applyStartRule } from './start';
import { outboxExtension } from './store';
import { getSubmissions, setSubmission, type SetResult } from './submissions';

export type { BlobSource, OutboxDeps } from './context';
export { outboxExtension, SubmissionConflict, type SubmissionWrite } from './store';

/** `Outbox/pending`: what will not happen while Aplos is quit, for the quit warning. */
export interface OutboxPending {
  scheduledSends: number;
  reminders: number;
  uncertain: number;
  nextAt?: number;
}

/** What the `submission` and `outbox` handlers call (`EngineServices.outbox`). */
export interface OutboxService {
  get(ids: readonly string[]): { state: State; list: Submission[]; notFound: string[] };
  set(opId: string, action: SubmissionAction): SetResult;
  pending(): OutboxPending;
}

export interface OutboxModule {
  service: OutboxService;
  /** Pass to `openStore({ extensions })`; the same value as `outboxExtension`. */
  extension: CommitExtension;
  /** Launch: the start rule turns every lost `sending` row `uncertain` before anything sends. */
  start(): void;
  /** The Mac woke or the network returned: pauses are re-asked and the start rule runs again. */
  wake(): void;
  /** Unregisters the deadline source. */
  stop(): void;
  /** Resolves once no send or `findSent` of this instance is running (tests and quit). */
  idle(): Promise<void>;
}

declare module '../methods/types' {
  interface EngineServices {
    outbox: OutboxService;
  }
}

function pendingOf(ctx: OutboxCtx): OutboxPending {
  return ctx.store.read(q => {
    const subs = q.get<{ waiting: number; uncertain: number; next: number | null }>(
      `SELECT count(*) FILTER (WHERE state IN ('queued', 'scheduled')) AS waiting,
              count(*) FILTER (WHERE state = 'uncertain') AS uncertain,
              min(not_before) FILTER (WHERE state IN ('queued', 'scheduled')) AS next
       FROM submissions`,
    )!;
    const reminders = q.get<{ n: number; next: number | null }>(
      `SELECT count(*) AS n, min(reminder_at) AS next FROM thread_workflow
       WHERE reminder_at IS NOT NULL AND reminder_fired_at IS NULL`,
    )!;
    const times = [subs.next, reminders.next].filter((t): t is number => t !== null);
    const out: OutboxPending = {
      scheduledSends: subs.waiting,
      reminders: reminders.n,
      uncertain: subs.uncertain,
    };
    if (times.length) out.nextAt = Math.min(...times);
    return out;
  });
}

/**
 * The outbox (time-2): the submission state machine, its `outbox` deadline source and the service its handlers use.
 * Open the store with `outboxExtension` first, then build this over it; the runtime calls `start()` at launch and
 * `wake()` on the host's wake.
 */
export function createOutboxModule(deps: OutboxDeps): OutboxModule {
  const ctx: OutboxCtx = {
    ...deps,
    random: deps.randomBytes ?? (n => globalThis.crypto.getRandomValues(new Uint8Array(n))),
    busy: new Map(),
    inflight: new Set(),
    paused: new Map(),
    startRulePending: true,
  };
  const unregister = deps.deadlines.register(outboxSource(ctx));
  const service: OutboxService = {
    get: ids => {
      const state = { dbEpoch: ctx.store.dbEpoch, seq: ctx.store.seq() };
      return { state, ...getSubmissions(ctx, ids) };
    },
    set: (opId, action) => setSubmission(ctx, opId, action),
    pending: () => pendingOf(ctx),
  };
  return {
    service,
    extension: outboxExtension,
    start() {
      applyStartRule(ctx);
      ctx.deadlines.changed('outbox');
    },
    wake() {
      ctx.paused.clear();
      applyStartRule(ctx);
      ctx.deadlines.changed('outbox');
    },
    stop: unregister,
    async idle() {
      while (ctx.busy.size) await Promise.all([...ctx.busy.values()]);
    },
  };
}
