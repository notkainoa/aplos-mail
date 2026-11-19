import assert from 'node:assert/strict';
import type { DraftFields } from '@aplos/contract';
import type { LogRecord } from '@aplos/contract/log/events';
import type { SubmissionAction } from '@aplos/contract';
import { createTimerLoop, fakeClock, type FakeClock, type TimerLoop } from '../../src/clock/module';
import { createLogger } from '../../src/diag/log';
import {
  createOutboxModule,
  outboxExtension,
  SubmissionConflict,
  type BlobSource,
  type OutboxModule,
} from '../../src/outbox/module';
import type { Admission } from '../../src/ports/base';
import { NotSentError, PausedError } from '../../src/ports/base';
import type { DraftSyncPort, SendPort, SubmissionPayload } from '../../src/ports';
import type { DraftSaveResult, DraftUpload } from '../../src/ports/provider';
import type { DeadlineSource } from '../../src/ports/time';
import type { EngineFrame } from '../../src/runtime/frames';
import { openStore, type CommitInput, type StorePort, type StoreWrite } from '../../src/store';
import { ACCOUNT, accountWrite, tempDb } from '../store/helpers';

export { ACCOUNT };
export const T0 = Date.UTC(2026, 9, 28, 9, 0, 0);
export const SEC = 1_000;
export const MIN = 60 * SEC;

/** What one `send` call does. Deliveries are what a real server would have accepted; that is what is counted. */
export interface Step {
  /** Default `ok`. `lost`: throws a plain Error (outcome unknown). `hang`: never settles (the app dies meanwhile). */
  result?: 'ok' | 'notSent' | 'paused' | 'sendLimit' | 'lost' | 'hang';
  /** The `ClassifiedError` class a `notSent` step throws (default `transient`). */
  notSentClass?: string;
  /** Whether the server accepted the bytes (default: only for `ok`). */
  delivered?: boolean;
  until?: number;
  /** Awaited before anything else happens. */
  wait?: Promise<void>;
  /** Called with the payload the moment `send` starts, before anything else (a test reads the store here). */
  observe?: (payload: SubmissionPayload) => void;
}

/** The counting fake `SendPort` (plan 10 E6): every delivery per Message-ID is counted, across engine instances. */
export function countingSend(clock: FakeClock) {
  const deliveries = new Map<string, number>();
  /** The server's Sent folder: Message-ID -> when it arrived. Only a message that really left is in it. */
  const sent = new Map<string, number>();
  /** The server's Drafts folder: Message-ID -> remote draft id. A draft copy is not a sent message, same id or not. */
  const drafts = new Map<string, string>();
  const payloads: SubmissionPayload[] = [];
  /** Remote drafts a `drafts.send` consumed: the provider's Drafts folder no longer has them. */
  const consumed: string[] = [];
  const calls: { op: 'send' | 'findSent'; internetId: string; at: number; since?: number }[] = [];
  /** `findSent` reports a delivery only from this time on (a search index that lags). */
  let visibleAt = 0;
  /** `findSent` throws instead of answering (offline). */
  let findFails = false;
  /** `findSent` waits for this before answering (the process dies meanwhile). */
  let findHold: Promise<void> | undefined;
  const script: Step[] = [];
  let admission: Admission = { ok: true };
  /** Runs inside every `admission()` call: a test makes the caller slow by moving the clock here. */
  let onAdmission: (() => void) | undefined;
  const deliver = (p: SubmissionPayload) => {
    deliveries.set(p.internetId, (deliveries.get(p.internetId) ?? 0) + 1);
    sent.set(p.internetId, clock.now());
    // `drafts.send` consumes the draft it sends; a plain `messages.send` leaves any draft copy where it was.
    if (p.remoteDraftId) {
      drafts.delete(p.internetId);
      consumed.push(p.remoteDraftId);
    }
    payloads.push(p);
  };
  const classified = (cls: string) => ({
    class: cls,
    provider: 'gmail',
    method: 'gmail.messages.send',
    reason: cls,
  });
  const port: SendPort = {
    admission: () => {
      onAdmission?.();
      return admission;
    },
    async send(_account, payload) {
      calls.push({ op: 'send', internetId: payload.internetId, at: clock.now() });
      const step = script.shift() ?? {};
      step.observe?.(payload);
      if (step.wait) await step.wait;
      const result = step.result ?? 'ok';
      if (step.delivered ?? result === 'ok') deliver(payload);
      if (result === 'ok')
        return {
          acceptedAt: clock.now(),
          remoteMessageId: `r-${payload.submissionId}`,
          // `drafts.send` consumes the draft it sends; the receipt says so.
          ...(payload.remoteDraftId ? { draftConsumed: true } : {}),
        };
      if (result === 'notSent')
        throw new NotSentError(classified(step.notSentClass ?? 'transient'));
      if (result === 'paused')
        throw new PausedError(_account, 'gmail', 'throttle', 'rateLimitExceeded', step.until);
      if (result === 'sendLimit')
        throw new PausedError(_account, 'gmail', 'send_limit', 'dailyLimitExceeded', step.until);
      if (result === 'hang') return new Promise(() => {});
      throw new Error('socket hang up');
    },
    async findSent(_account, internetId, since) {
      calls.push({ op: 'findSent', internetId, at: clock.now(), since });
      if (findHold) await findHold;
      if (findFails) throw new Error('offline');
      // Sent only (the SendPort rule): a draft carrying the same Message-ID is never a match.
      const arrived = sent.get(internetId);
      return arrived !== undefined && arrived >= since && clock.now() >= visibleAt
        ? { kind: 'found', remoteMessageId: `found-${internetId}` }
        : { kind: 'absent', checkedAt: clock.now() };
    },
  };
  return {
    port,
    script,
    deliveries,
    sent,
    drafts,
    payloads,
    consumed,
    calls,
    setAdmission: (a: Admission) => {
      admission = a;
    },
    onAdmission: (fn: (() => void) | undefined) => {
      onAdmission = fn;
    },
    /** A draft upload: the draft copy now exists under this Message-ID, unsent. */
    uploadDraft: (internetId: string, remoteDraftId = `rd-${internetId}`) => {
      drafts.set(internetId, remoteDraftId);
    },
    /** A message in Sent that did not come through `send` (another device, an earlier session). */
    seedSent: (internetId: string, at: number) => {
      sent.set(internetId, at);
    },
    hideDeliveriesUntil: (at: number) => {
      visibleAt = at;
    },
    holdFindSent: (hold: Promise<void> | undefined) => {
      findHold = hold;
    },
    failFindSent: (fails: boolean) => {
      findFails = fails;
    },
    sends: () => calls.filter(c => c.op === 'send'),
    /** The highest delivery count of any one Message-ID: must never pass 1. */
    worst: () => Math.max(0, ...deliveries.values()),
  };
}

export type CountingSend = ReturnType<typeof countingSend>;

/**
 * What one `save` call does (default `ok`). `lost` throws a plain Error before anything is written; `landedLost` writes the
 * copy and then throws the same Error (a timeout whose request got through). `conflictBare` answers `conflict` with no id.
 */
export interface DraftStep {
  result?:
    | 'ok'
    | 'paused'
    | 'notSent'
    | 'lost'
    | 'landedLost'
    | 'conflictBare'
    | 'gone'
    | 'conflictExisting'
    | 'conflictForeign'
    | 'conflictUnproven'
    | 'conflictRename';
  /** The `ClassifiedError` class a `notSent` step throws (default `permanent`). */
  notSentClass?: string;
  until?: number;
  /** Awaited before anything else happens. */
  wait?: Promise<void>;
  /** A `conflict*` step leaves the copy's message id out (an adapter that cannot read it). */
  omitMessageId?: true;
  /** The save is answered with this remote draft id (a provider whose update makes a new draft: JMAP, IMAP). */
  renameTo?: string;
}

/**
 * The fake `DraftSyncPort`: a provider Drafts folder that applies the port's rules (a stale `baseRemoteMessageId` is a
 * `conflict`, a missing remote draft is `gone`). Every upload is recorded, so tests count them. `remove` honours
 * `expectedMessageId`: a draft that holds another message id (a phone edit) is left alone and the call resolves.
 * `conflictExisting` answers a CREATE with a `conflict` that names the remote draft already carrying this upload's
 * Message-ID (an earlier create whose reply was lost did land) and says so (`remoteInternetId`), as `DraftSaveResult`
 * documents. `conflictForeign` names the first remote draft whatever its Message-ID (another message, not ours);
 * `conflictUnproven` names the copy without saying which Message-ID it carries; `conflictRename` answers any upload
 * (create or update) naming a draft that claims our Message-ID, to prove the engine adopts only on a create.
 */
export function fakeDrafts(server: CountingSend) {
  const remote = new Map<string, { messageId: string; internetId: string; revision: number }>();
  const saves: DraftUpload[] = [];
  const removes: string[] = [];
  /** Every `remove` call, whether it worked or not. */
  const removeAttempts: string[] = [];
  /** The `expectedMessageId` each `remove` call carried (`undefined`: none was passed). */
  const removeExpected: (string | undefined)[] = [];
  /** Calls the guard turned into a no-op: the draft held another message id. */
  const removeGuarded: string[] = [];
  /**
   * `gmailIds`: the provider shows its own Message-ID for every copy it stores (Gmail's draft id survives saves, the
   * Message-ID does not); `reportCopy` also names it in the `saved` answer (`copyInternetId`).
   */
  const state = {
    ignoreExpected: false,
    honourSupersedes: false,
    gmailIds: false,
    reportCopy: false,
  };
  /** The Message-ID the provider shows for a copy stored under `uploaded`: its own (Gmail) or the upload's. */
  const shownId = (uploaded: string) =>
    state.gmailIds ? `<gmail-${++counter}@mail.gmail.com>` : uploaded;
  const copyField = (shown: string) =>
    state.gmailIds && state.reportCopy ? { copyInternetId: shown } : {};
  const script: DraftStep[] = [];
  /** What each `remove` call does (the same steps as `script`; `ok` is the default). */
  const removeScript: DraftStep[] = [];
  let counter = 0;
  const classified = (cls: string) => ({
    class: cls,
    provider: 'gmail',
    method: 'gmail.drafts.update',
    reason: cls,
  });
  const named = (
    [remoteDraftId, copy]: [string, { messageId: string; internetId: string }],
    proves: boolean,
    step: DraftStep,
  ): DraftSaveResult => ({
    kind: 'conflict',
    remoteDraftId,
    ...(step.omitMessageId ? {} : { remoteMessageId: copy.messageId }),
    ...(proves ? { remoteInternetId: copy.internetId } : {}),
  });
  /** The `conflict*` steps: what the provider answers, or undefined when the step does not apply to this upload. */
  const scriptedConflict = (step: DraftStep, upload: DraftUpload): DraftSaveResult | undefined => {
    const mine = [...remote.entries()].find(([, r]) => r.internetId === upload.internetId);
    const create = !upload.remoteDraftId;
    if (step.result === 'conflictExisting' && create && mine) return named(mine, true, step);
    if (step.result === 'conflictUnproven' && create && mine) return named(mine, false, step);
    const first = [...remote.entries()][0];
    if (step.result === 'conflictForeign' && create && first) return named(first, true, step);
    if (step.result !== 'conflictRename') return undefined;
    return {
      kind: 'conflict',
      remoteDraftId: 'rd-other',
      remoteMessageId: 'msg-other',
      remoteInternetId: upload.internetId,
    };
  };
  const port: DraftSyncPort = {
    async save(account, upload): Promise<DraftSaveResult> {
      saves.push(upload);
      const step = script.shift() ?? {};
      if (step.wait) await step.wait;
      if (step.result === 'paused')
        throw new PausedError(account, 'gmail', 'throttle', 'rateLimitExceeded', step.until);
      if (step.result === 'notSent')
        throw new NotSentError(classified(step.notSentClass ?? 'permanent'));
      if (step.result === 'lost') throw new Error('socket hang up');
      // The copy is gone (deleted or sent elsewhere), whatever the upload was.
      if (step.result === 'gone') return { kind: 'gone' };
      // A conflict that names no remote message id (an adapter that cannot read it).
      if (step.result === 'conflictBare') return { kind: 'conflict' };
      const conflict = scriptedConflict(step, upload);
      if (conflict) return conflict;
      const known = upload.remoteDraftId ? remote.get(upload.remoteDraftId) : undefined;
      if (upload.remoteDraftId && !known) return { kind: 'gone' };
      if (known && upload.baseRemoteMessageId && known.messageId !== upload.baseRemoteMessageId)
        return { kind: 'conflict', remoteMessageId: known.messageId };
      // A create that names earlier Message-IDs replaces the copy carrying one (a provider that honours `supersedes`).
      const replaced = upload.remoteDraftId
        ? undefined
        : state.honourSupersedes
          ? [...remote.entries()].find(([, r]) => upload.supersedes?.includes(r.internetId))?.[0]
          : undefined;
      const remoteDraftId = step.renameTo ?? upload.remoteDraftId ?? replaced ?? `rd${++counter}`;
      const messageId = `msg${++counter}`;
      const shown = shownId(upload.internetId);
      remote.set(remoteDraftId, { messageId, internetId: shown, revision: upload.revision });
      server.uploadDraft(upload.internetId, remoteDraftId);
      if (step.result === 'landedLost') throw new Error('socket hang up');
      return {
        kind: 'saved',
        remoteDraftId,
        remoteMessageId: messageId,
        revision: upload.revision,
        ...copyField(shown),
      };
    },
    async remove(account, remoteDraftId, expectedMessageId) {
      removeAttempts.push(remoteDraftId);
      removeExpected.push(expectedMessageId);
      const step = removeScript.shift() ?? {};
      if (step.wait) await step.wait;
      if (step.result === 'paused')
        throw new PausedError(account, 'gmail', 'throttle', 'rateLimitExceeded', step.until);
      if (step.result === 'notSent')
        throw new NotSentError(classified(step.notSentClass ?? 'permanent'));
      if (step.result === 'lost' || step.result === 'landedLost') throw new Error('socket hang up');
      const held = remote.get(remoteDraftId);
      if (
        !state.ignoreExpected &&
        held &&
        expectedMessageId !== undefined &&
        held.messageId !== expectedMessageId
      )
        return void removeGuarded.push(remoteDraftId);
      removes.push(remoteDraftId);
      remote.delete(remoteDraftId);
    },
  };
  return {
    port,
    script,
    removeScript,
    remote,
    saves,
    removes,
    removeAttempts,
    removeExpected,
    removeGuarded,
    /** An old provider: `remove` takes two arguments and ignores the expected message id the engine passes. */
    state,
    /** The owner edits the draft on a phone: its message id changes, as history will report. */
    phoneEdit(remoteDraftId: string) {
      const copy = remote.get(remoteDraftId)!;
      const messageId = `msg${++counter}`;
      remote.set(remoteDraftId, { ...copy, messageId });
      return messageId;
    },
  };
}

export type FakeDrafts = ReturnType<typeof fakeDrafts>;

/** A gate a test opens by hand. */
export function gate() {
  let open!: () => void;
  const wait = new Promise<void>(resolve => {
    open = resolve;
  });
  return { wait, open };
}

export interface Instance {
  store: StorePort;
  loop: TimerLoop;
  outbox: OutboxModule;
  /** The deadline sources this instance's modules registered, by id. */
  sources: Map<string, DeadlineSource>;
  /** Simulates the process dying: the loop stops and nothing of this instance runs again (its hung send stays hung). */
  kill(): void;
}

export function fields(extra: Partial<DraftFields> = {}): DraftFields {
  return {
    accountId: ACCOUNT,
    mode: 'new',
    to: [{ address: 'jordan@mail.example', name: 'Jordan' }],
    cc: [],
    bcc: [],
    subject: 'Lunch',
    html: '<p>Lunch at noon?</p>',
    attachments: [],
    signature: false,
    ...extra,
  };
}

/** One `mail.db`, any number of engine instances on it, one fake clock and one counting server. */
export function outboxWorld(
  options: {
    settings?: () => { undoSendSeconds?: number };
    provider?: string;
    /** Wire a `DraftSyncPort` fake (and its frames): the module then has local drafts. */
    drafts?: boolean;
    /** A real adapter's `SendPort` in place of the counting fake (`world.server` then sees nothing). */
    send?: SendPort;
    /** Recorded in `world.sent`, in place of the sync wake a send's settle fires. */
    afterSend?(accountId: string): void;
  } = {},
) {
  const file = tempDb();
  const clock = fakeClock(T0);
  const records: LogRecord[] = [];
  const log = createLogger({
    sink: { write: r => records.push(r) },
    salt: 'test-salt',
    clock,
    level: 'debug',
  });
  /**
   * A real clock moves between two reads. `perCall` makes every `now()` return a little later than the one before;
   * `jump` adds once (a slow call). Both are zero unless a test sets them.
   */
  const skew = { perCall: 0, jump: 0 };
  const exactNow = clock.now.bind(clock);
  let drift = 0;
  clock.now = () => {
    drift += skew.perCall + skew.jump;
    skew.jump = 0;
    return exactNow() + drift;
  };
  const server = countingSend(clock);
  const remoteDrafts = fakeDrafts(server);
  /** Every `Draft/changed` frame the modules sent. */
  const frames: EngineFrame[] = [];
  const blobs = new Map<string, Uint8Array>();
  /**
   * The blob source every instance reads through: `blobs` behind the sync adapter, with a log of the ids asked for, an
   * optional gate the read waits on (`hold`) and an optional failure it rejects with (`fail`), both read at call time.
   */
  const blobReads = {
    calls: [] as string[],
    hold: undefined as Promise<void> | undefined,
    fail: undefined as Error | undefined,
  };
  const syncBlobs = syncBlobSource(blobs);
  const blobSource = {
    async get(id: string) {
      blobReads.calls.push(id);
      const { hold, fail } = blobReads;
      if (hold) await hold;
      if (fail) throw fail;
      return syncBlobs.get(id);
    },
  };
  const instances: Instance[] = [];
  let opSeq = 0;

  /** Compare-and-set losses across every instance: proof two writers really raced. */
  const conflicts: string[] = [];
  /** One-shot commit failures: the first commit a predicate matches throws, then the predicate is dropped. */
  const faults: ((input: CommitInput) => boolean)[] = [];
  /** Dead instances: their hung sends never settle, so `settle` stops waiting for them. */
  const killed = new Set<Instance>();
  const open = (start = true): Instance => {
    const store = openStore(file.open(), { extensions: [outboxExtension], now: () => clock.now() });
    const commit = store.commit.bind(store);
    store.commit = input => {
      const fault = faults.findIndex(f => f(input));
      if (fault >= 0) {
        faults.splice(fault, 1);
        throw new Error('disk I/O error');
      }
      try {
        return commit(input);
      } catch (error) {
        if (error instanceof SubmissionConflict) conflicts.push(input.opId);
        throw error;
      }
    };
    const loop = createTimerLoop({ clock, log });
    const sources = new Map<string, DeadlineSource>();
    const outbox = createOutboxModule({
      store,
      send: options.send ?? server.port,
      clock,
      // The loop, with every registered source kept so a test can ask one for its next deadline.
      deadlines: {
        register: source => {
          sources.set(source.id, source);
          return loop.register(source);
        },
        changed: id => loop.changed(id),
      },
      log,
      blobs: blobSource,
      settings: options.settings,
      ...(options.afterSend ? { afterSend: options.afterSend } : {}),
      ...(options.drafts
        ? { drafts: remoteDrafts.port, frames: { emit: f => frames.push(f) } }
        : {}),
    });
    const instance: Instance = {
      store,
      loop,
      outbox,
      sources,
      kill() {
        loop.stop();
        void outbox.close();
        killed.add(instance);
      },
    };
    if (start) {
      outbox.start();
      loop.start();
    }
    instances.push(instance);
    return instance;
  };

  const first = open(false);
  first.store.commit({
    opId: 'setup',
    origin: 'sync',
    writes: [{ ...accountWrite, provider: options.provider ?? 'google' }],
  });
  first.outbox.start();
  first.loop.start();

  /** Drafts belong to time-3's `Draft/set`; a second connection stands in for it here. */
  const draft = (
    id: string,
    f: DraftFields = fields(),
    extra: {
      revision?: number;
      remoteDraftId?: string;
      remoteMessageId?: string;
      remoteInternetId?: string;
      syncedRevision?: number;
    } = {},
  ) => {
    const db = file.open();
    db.prepare(
      `INSERT INTO drafts(id, account_id, revision, data, remote_draft_id, remote_message_id, remote_internet_id, synced_revision, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, data = excluded.data,
         remote_draft_id = excluded.remote_draft_id, remote_message_id = excluded.remote_message_id,
         remote_internet_id = excluded.remote_internet_id, synced_revision = excluded.synced_revision`,
    ).run(
      id,
      ACCOUNT,
      extra.revision ?? 1,
      JSON.stringify(f),
      extra.remoteDraftId ?? null,
      extra.remoteMessageId ?? null,
      extra.remoteInternetId ?? null,
      extra.syncedRevision ?? null,
      clock.now(),
    );
    db.close();
    // The synced copy exists on the server too, under the Message-ID it was uploaded with.
    if (extra.remoteInternetId) server.uploadDraft(extra.remoteInternetId, extra.remoteDraftId);
    return { id, revision: extra.revision ?? 1 };
  };

  const act = (instance: Instance, action: SubmissionAction, opId = `op-${++opSeq}`) =>
    instance.outbox.service.set(opId, action);

  const send = async (
    instance: Instance,
    draftId: string,
    extra: { notBefore?: number; revision?: number } = {},
  ) =>
    (
      await act(instance, {
        type: 'send',
        draftId,
        revision: extra.revision ?? 1,
        ...(extra.notBefore !== undefined ? { notBefore: extra.notBefore } : {}),
      })
    ).submission;

  const get = (id: string, instance: Instance = first) => {
    const s = instance.outbox.service.get([id]).list[0];
    if (!s) throw new Error(`no submission ${id}`);
    return s;
  };

  const raw = (id: string) => {
    const db = file.open();
    const row = db.prepare('SELECT * FROM submissions WHERE id = ?').get(id);
    db.close();
    return row;
  };

  /**
   * Lets every instance's loop and running jobs settle without moving time. A job hung on purpose (a send that never
   * returns) must not block it, so the outbox's own idle is raced against one more turn of the event loop.
   */
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await clock.flush();
      const alive = instances.filter(x => !killed.has(x));
      await Promise.all(alive.map(x => x.loop.idle()));
      await Promise.race([Promise.all(alive.map(x => x.outbox.idle())), clock.flush()]);
    }
  };

  const events = (id: string) => records.filter(r => r.event === id);

  const cleanup = () => {
    for (const x of instances) {
      x.loop.stop();
      try {
        x.store.close();
      } catch {
        /* already closed */
      }
    }
    file.cleanup();
  };

  return {
    file,
    clock,
    server,
    remoteDrafts,
    frames,
    skew,
    blobs,
    blobReads,
    records,
    events,
    conflicts,
    faults,
    first,
    open,
    draft,
    act,
    send,
    get,
    raw,
    settle,
    cleanup,
  };
}

export type World = ReturnType<typeof outboxWorld>;

/** Runs `fn` on a fresh world and always cleans up. */
export async function inWorld(
  fn: (w: World) => Promise<void> | void,
  options?: Parameters<typeof outboxWorld>[0],
) {
  const w = outboxWorld(options);
  try {
    await fn(w);
  } finally {
    w.cleanup();
  }
}

/** Message-IDs are per revision: no two submissions of different revisions of one draft share an id. */
export function assertIdsPerRevision(w: World, draftId: string) {
  const rows = w.first.store.read(q =>
    q.all<{ revision: number; internet_id: string }>(
      'SELECT revision, internet_id FROM submissions WHERE draft_id = ?',
      draftId,
    ),
  );
  const owner = new Map<string, number>();
  for (const r of rows) {
    const prior = owner.get(r.internet_id);
    assert.ok(
      prior === undefined || prior === r.revision,
      `Message-ID ${r.internet_id} was used by revision ${prior} and revision ${r.revision}`,
    );
    owner.set(r.internet_id, r.revision);
  }
}

/**
 * What history reports for the copy of THIS device's upload (default content of `fields()`): the body and every field a
 * copy has to show, so the engine can prove the copy is its own.
 */
export function copyWrite(f: {
  remoteDraftId: string;
  remoteMessageId: string;
  internetId: string;
  changedAt: number;
  content?: DraftFields;
}): StoreWrite {
  const c = f.content ?? fields();
  return {
    kind: 'remoteDraft',
    accountId: ACCOUNT,
    remoteDraftId: f.remoteDraftId,
    remoteMessageId: f.remoteMessageId,
    internetId: f.internetId,
    changedAt: f.changedAt,
    html: c.html,
    message: {
      remoteId: f.remoteMessageId,
      remoteThreadId: 'copy-thread',
      from: { address: 'owner@mail.example' },
      to: c.to,
      cc: c.cc,
      bcc: c.bcc,
      subject: c.subject,
      snippet: 'copy',
      hasAttachments: false,
      date: f.changedAt,
      internalDate: f.changedAt,
      flags: { seen: true, flagged: false, draft: true, fromMe: true },
    },
  } as StoreWrite;
}

/** A `BlobSource` over bytes held in memory, or a synchronous lookup: the old synchronous reads behind the async shape. */
export function syncBlobSource(
  from: ReadonlyMap<string, Uint8Array> | ((blobId: string) => Uint8Array | undefined),
): BlobSource {
  const lookup = typeof from === 'function' ? from : (id: string) => from.get(id);
  return { get: async id => lookup(id) };
}
