import type { State, Submission, SubmissionAction } from '@aplos/contract';
import type { EngineServices, LaneModule } from '../runtime/services';
import type { CommitExtension } from '../store/port';
import { STOP_GRACE_MS } from '../clock/loop';
import type { OutboxCtx, OutboxDeps } from './context';
import { outboxSource } from './runner';
import { applyStartRule, recheckUncertain } from './start';
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

declare module '../runtime/services' {
  interface EngineServices {
    /** The send state machine (time-2): `Submission/get|set` and `Outbox/pending`. */
    outbox: OutboxService;
  }
}

export interface OutboxModule {
  service: OutboxService;
  /** Pass to `openStore({ extensions })`; the same value as `outboxExtension`. */
  extension: CommitExtension;
  /** Launch: the start rule turns every lost `sending` row `uncertain` before anything sends. */
  start(): void;
  /** The Mac woke or the network returned: pauses are re-asked and lost rows are recovered at once. */
  wake(): void;
  /** Unregisters the deadline source and lets a send already running settle, for at most `STOP_GRACE_MS`. */
  close(): Promise<void>;
  /** Resolves once no send or `findSent` of this instance is running (tests and quit). */
  idle(): Promise<void>;
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

async function settled(ctx: OutboxCtx) {
  while (ctx.busy.size) await Promise.all([...ctx.busy.values()]);
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
      recheckUncertain(ctx);
      ctx.deadlines.changed('outbox');
    },
    wake() {
      ctx.paused.clear();
      applyStartRule(ctx);
      ctx.deadlines.changed('outbox');
    },
    async close() {
      unregister();
      const abort = new AbortController();
      const grace = ctx.clock.sleep(STOP_GRACE_MS, abort.signal).catch(() => {});
      await Promise.race([settled(ctx), grace]);
      abort.abort();
    },
    idle: () => settled(ctx),
  };
}

/**
 * Seam 1: lane `eng-time`'s outbox module, imported by the composition root (`src/index.ts`) from this fixed path.
 * It registers the `outbox` deadline source with the timer loop the clock module provides and serves the `submission`
 * and `outbox` areas. Drafts (time-3) and notifications (time-5) join this module later.
 */
export const lane = 'eng-time';

/** The lane's writers for its own tables (seam 2); the host passes every module's list to `openStore`. */
export const extensions: readonly CommitExtension[] = [outboxExtension];

/** Builds the outbox once the core services exist; runs once, in the root's fixed order, after the clock module. */
export function createModule(services: EngineServices): LaneModule {
  const outbox = createOutboxModule({
    store: services.store,
    send: services.send,
    clock: services.clock,
    deadlines: services.deadlines,
    log: services.log,
    randomBytes: services.randomBytes,
  });
  return {
    services: { outbox: outbox.service },
    start: () => outbox.start(),
    stop: () => outbox.close(),
  };
}
