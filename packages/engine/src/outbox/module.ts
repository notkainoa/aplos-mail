import type { State, Submission, SubmissionAction } from '@aplos/contract';
import type { EngineServices, LaneModule } from '../runtime/services';
import type { CommitExtension } from '../store/port';
import { STOP_GRACE_MS } from '../clock/loop';
import type { DeadlineRegistry } from '../ports/time';
import type { OutboxCtx, OutboxDeps } from './context';
import { sentChanged, touchDue } from './draft-due';
import { onDraftAnnounced } from './draft-state';
import {
  announceDraft,
  closeDraft,
  createDraftsCtx,
  draftsSource,
  settledDrafts,
  wakeDrafts,
  type DraftsCtx,
} from './draft-sync';
import { createDraftService, type DraftService } from './drafts';
import { outboxExtension } from './extension';
import { killableSend } from './killpoints';
import { outboxSource } from './runner';
import { applyStartRule, recheckUncertain } from './start';
import { getSubmissions, setSubmission, type SetResult } from './submissions';

export type { BlobSource, OutboxDeps } from './context';
export type { DraftService } from './drafts';
export { outboxExtension } from './extension';
export { SubmissionConflict, type SubmissionWrite } from './store';
export { DraftConflict } from './draft-state';
export type { DraftWrite } from './draft-writes';

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
    /** The local drafts (time-3): `Draft/get|set|destroy|resolve`. */
    draftBox: DraftService;
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
  /** Resolves once no send, `findSent` or draft upload of this instance is running (tests and quit). */
  idle(): Promise<void>;
  /** The local drafts; present when the host gave a `DraftSyncPort`. */
  drafts?: DraftService;
  /** The editor closed: upload that draft now instead of after the idle wait. */
  closeDraft(id: string): void;
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

async function settled(ctx: OutboxCtx, drafts?: DraftsCtx) {
  while (ctx.busy.size) await Promise.all([...ctx.busy.values()]);
  if (drafts) await settledDrafts(drafts);
}

/** A send that ends moves the drafts' deadlines too (a sent draft is cleaned up, a cancelled one syncs again). */
function alsoDrafts(deadlines: DeadlineRegistry, sendChanged: () => void): DeadlineRegistry {
  return {
    register: source => deadlines.register(source),
    changed(id) {
      deadlines.changed(id);
      if (id !== 'outbox') return;
      sendChanged();
      deadlines.changed('drafts');
    },
  };
}

/**
 * The outbox (time-2): the submission state machine, its `outbox` deadline source and the service its handlers use.
 * Open the store with `outboxExtension` first, then build this over it; the runtime calls `start()` at launch and
 * `wake()` on the host's wake.
 */
export function createOutboxModule(deps: OutboxDeps): OutboxModule {
  const random = deps.randomBytes ?? (n => globalThis.crypto.getRandomValues(new Uint8Array(n)));
  const hooks: { draftsCtx?: DraftsCtx } = {};
  // Test builds only: the kill points inside the provider call wrap the port (see killpoints.ts).
  const send =
    typeof __APLOS_TEST_MODE__ === 'undefined' || __APLOS_TEST_MODE__
      ? killableSend(deps.send)
      : deps.send;
  const ctx: OutboxCtx = {
    ...deps,
    send,
    deadlines: deps.drafts
      ? alsoDrafts(deps.deadlines, () => hooks.draftsCtx && sentChanged(hooks.draftsCtx))
      : deps.deadlines,
    random,
    busy: new Map(),
    inflight: new Set(),
    paused: new Map(),
  };
  const unregister = [deps.deadlines.register(outboxSource(ctx))];
  const draftsCtx = deps.drafts
    ? createDraftsCtx({
        store: deps.store,
        clock: deps.clock,
        deadlines: ctx.deadlines,
        log: deps.log,
        random,
        blobs: deps.blobs,
        port: deps.drafts,
        frames: deps.frames,
      })
    : undefined;
  hooks.draftsCtx = draftsCtx;
  if (draftsCtx) {
    unregister.push(deps.deadlines.register(draftsSource(draftsCtx)));
    unregister.push(
      onDraftAnnounced(id => {
        try {
          // A fact from the provider changed this draft behind the source's back: look at its row again.
          touchDue(draftsCtx, id);
          draftsCtx.deadlines.changed('drafts');
          announceDraft(draftsCtx, id);
        } catch {
          // A frame is best effort: the store may be closing, and the state frame carries the change anyway.
        }
      }),
    );
  }
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
    ...(draftsCtx ? { drafts: createDraftService(draftsCtx, service) } : {}),
    start() {
      applyStartRule(ctx);
      recheckUncertain(ctx);
      ctx.deadlines.changed('outbox');
    },
    wake() {
      ctx.paused.clear();
      applyStartRule(ctx);
      if (draftsCtx) wakeDrafts(draftsCtx);
      ctx.deadlines.changed('outbox');
    },
    async close() {
      for (const off of unregister) off();
      const abort = new AbortController();
      const grace = ctx.clock.sleep(STOP_GRACE_MS, abort.signal).catch(() => {});
      await Promise.race([settled(ctx, draftsCtx), grace]);
      abort.abort();
    },
    idle: () => settled(ctx, draftsCtx),
    closeDraft(id) {
      if (draftsCtx) closeDraft(draftsCtx, id);
    },
  };
}

/**
 * Seam 1: lane `eng-time`'s outbox module, imported by the composition root (`src/index.ts`) from this fixed path.
 * It registers the `outbox` deadline source with the timer loop the clock module provides and serves the `submission`
 * and `outbox` areas, and (time-3) the local drafts and their `drafts` deadline source. Notifications (time-5) join later.
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
    drafts: services.drafts,
    frames: services.frames,
  });
  return {
    services: { outbox: outbox.service, draftBox: outbox.drafts! },
    start: () => outbox.start(),
    stop: () => outbox.close(),
  };
}
