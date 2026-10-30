import type { DraftFields } from '@aplos/contract';
import type { LogRecord } from '@aplos/contract/log/events';
import type { SubmissionAction } from '@aplos/contract';
import { createTimerLoop, fakeClock, type FakeClock, type TimerLoop } from '../../src/clock/module';
import { createLogger } from '../../src/diag/log';
import {
  createOutboxModule,
  outboxExtension,
  SubmissionConflict,
  type OutboxModule,
} from '../../src/outbox/module';
import type { Admission } from '../../src/ports/base';
import { NotSentError, PausedError } from '../../src/ports/base';
import type { SendPort, SubmissionPayload } from '../../src/ports';
import { openStore, type CommitInput, type StorePort } from '../../src/store';
import { ACCOUNT, accountWrite, tempDb } from '../store/helpers';

export { ACCOUNT };
export const T0 = Date.UTC(2026, 9, 28, 9, 0, 0);
export const SEC = 1_000;
export const MIN = 60 * SEC;

/** What one `send` call does. Deliveries are what a real server would have accepted; that is what is counted. */
export interface Step {
  /** Default `ok`. `lost`: throws a plain Error (outcome unknown). `hang`: never settles (the app dies meanwhile). */
  result?: 'ok' | 'notSent' | 'paused' | 'sendLimit' | 'lost' | 'hang';
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
  const payloads: SubmissionPayload[] = [];
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
        return { acceptedAt: clock.now(), remoteMessageId: `r-${payload.submissionId}` };
      if (result === 'notSent') throw new NotSentError(classified('transient'));
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
      return deliveries.has(internetId) && clock.now() >= visibleAt
        ? { kind: 'found', remoteMessageId: `found-${internetId}` }
        : { kind: 'absent', checkedAt: clock.now() };
    },
  };
  return {
    port,
    script,
    deliveries,
    payloads,
    calls,
    setAdmission: (a: Admission) => {
      admission = a;
    },
    onAdmission: (fn: (() => void) | undefined) => {
      onAdmission = fn;
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
  options: { settings?: () => { undoSendSeconds?: number }; provider?: string } = {},
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
  const blobs = new Map<string, Uint8Array>();
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
    const outbox = createOutboxModule({
      store,
      send: server.port,
      clock,
      deadlines: loop,
      log,
      blobs: { get: id => blobs.get(id) },
      settings: options.settings,
    });
    const instance: Instance = {
      store,
      loop,
      outbox,
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
      syncedRevision?: number;
    } = {},
  ) => {
    const db = file.open();
    db.prepare(
      `INSERT INTO drafts(id, account_id, revision, data, remote_draft_id, remote_message_id, synced_revision, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, data = excluded.data,
         remote_draft_id = excluded.remote_draft_id, remote_message_id = excluded.remote_message_id,
         synced_revision = excluded.synced_revision`,
    ).run(
      id,
      ACCOUNT,
      extra.revision ?? 1,
      JSON.stringify(f),
      extra.remoteDraftId ?? null,
      extra.remoteMessageId ?? null,
      extra.syncedRevision ?? null,
      clock.now(),
    );
    db.close();
    return { id, revision: extra.revision ?? 1 };
  };

  const act = (instance: Instance, action: SubmissionAction, opId = `op-${++opSeq}`) =>
    instance.outbox.service.set(opId, action);

  const send = (
    instance: Instance,
    draftId: string,
    extra: { notBefore?: number; revision?: number } = {},
  ) =>
    act(instance, {
      type: 'send',
      draftId,
      revision: extra.revision ?? 1,
      ...(extra.notBefore !== undefined ? { notBefore: extra.notBefore } : {}),
    }).submission;

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
    skew,
    blobs,
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
