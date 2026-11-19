import assert from 'node:assert/strict';
import type { NotificationItem } from '@aplos/contract';
import { fakeClock } from '../../src/clock/module';
import { createLogger } from '../../src/diag/log';
import { outboxExtension } from '../../src/outbox/extension';
import {
  CLAIM_LEASE_MS,
  createNotifications,
  type NotificationModule,
} from '../../src/outbox/notifications';
import type { DeadlineSource } from '../../src/ports/time';
import type { EngineFrame } from '../../src/runtime/frames';
import { openStore, type MessageWrite, type StorePort, type StoreWrite } from '../../src/store';
import { ACCOUNT, accountWrite, folderWrites, msg, tempDb } from '../store/helpers';

export const T0 = Date.UTC(2026, 9, 30, 9, 0, 0);

export const SPAM = {
  kind: 'folder',
  accountId: ACCOUNT,
  remoteId: 'SPAM',
  name: 'Spam',
  role: 'spam',
  folderKind: 'system',
} as const;
export const SENT = {
  kind: 'folder',
  accountId: ACCOUNT,
  remoteId: 'SENT',
  name: 'Sent',
  role: 'sent',
  folderKind: 'system',
} as const;

type Step = 'baseline' | 'incremental' | 'backfill' | 'search' | 'resync' | 'prefetch';

export function world(options: { account?: Record<string, unknown> } = {}) {
  const file = tempDb();
  const clock = fakeClock(T0);
  const log = createLogger({ sink: { write: () => {} }, salt: 's', clock });
  const events: Extract<EngineFrame, { frame: 'host' }>['event'][] = [];
  const sources: DeadlineSource[] = [];
  let store: StorePort;
  let notes: NotificationModule;
  let opSeq = 0;
  const open = () => {
    store = openStore(file.open(), { extensions: [outboxExtension], now: () => clock.now() });
    const frames = {
      emit: (f: EngineFrame) => void events.push((f as never as { event: never }).event),
    };
    notes = createNotifications({
      store,
      clock,
      log,
      randomBytes: n => globalThis.crypto.getRandomValues(new Uint8Array(n)),
      // Like the timer loop: a source is read again after `changed`, and `register` hands back its unregister.
      deadlines: {
        register: s => {
          sources.push(s);
          return () => void sources.splice(sources.indexOf(s), 1);
        },
        changed: id => void sources.find(s => s.id === id)?.next(),
      },
      frames,
    });
  };
  open();
  const commit = (
    step: Step | undefined,
    writes: StoreWrite[],
    origin: 'sync' | 'local' = 'sync',
  ) => store.commit({ opId: `t${opSeq++}`, origin, ...(step ? { step } : {}), writes });
  const setup = (baselineDone: boolean) =>
    commit('baseline', [
      {
        ...accountWrite,
        ...options.account,
        ...(baselineDone ? { baselineDoneAt: clock.now() } : {}),
      },
      ...folderWrites,
      SPAM,
      SENT,
    ] as unknown as StoreWrite[]);
  return {
    file,
    clock,
    events,
    sources,
    commit,
    setup,
    get store() {
      return store;
    },
    get notes() {
      return notes;
    },
    /** The process dies: the store closes with whatever state it was in, and a new engine opens the same file. */
    reopen() {
      notes.stop();
      store.close();
      open();
    },
    rows: () =>
      store.read(q =>
        q
          .all<{ remote_id: string; state: string }>(
            'SELECT m.remote_id, n.state FROM notifications n JOIN messages m ON m.id = n.message_id ORDER BY m.remote_id',
          )
          .map(r => ({ ...r })),
      ),
    close() {
      notes.stop();
      store.close();
      file.cleanup();
    },
  };
}

export const ids = (items: NotificationItem[]) => items.map(i => i.id);
/** Mail that just arrived: dated at the test clock, not at the store helpers' older `T0`. */
export const mail = (remoteId: string, extra: Partial<MessageWrite> = {}) =>
  msg(remoteId, `th-${remoteId}`, 1, { internalDate: T0, date: T0, ...extra });
export const SEEN = { seen: true, flagged: false, draft: false, fromMe: false };
export const HOUR = 3_600_000;

/** A host that posts every item it claims and records each post, to check what the outbox really promises. */
export function simulatedHost(w: { notes: NotificationModule; clock: { now(): number } }) {
  const posts: string[] = [];
  const leasedUntil = new Map<string, number>();
  const acked = new Set<string>();
  return {
    posts,
    claim(max?: number) {
      const items = w.notes.service.claim(max);
      assert.equal(new Set(ids(items)).size, items.length, 'one claim never repeats an id');
      for (const id of ids(items)) {
        const until = leasedUntil.get(id);
        assert.ok(!acked.has(id), `${id} was offered again after its ack`);
        assert.ok(
          until === undefined || until <= w.clock.now(),
          `${id} was offered inside a lease`,
        );
        leasedUntil.set(id, w.clock.now() + CLAIM_LEASE_MS);
        posts.push(id);
      }
      return items;
    },
    ack(items: NotificationItem[], state: 'posted' | 'dropped' = 'posted') {
      w.notes.service.ack(ids(items), state);
      for (const id of ids(items)) acked.add(id);
    },
    /** Claims and acknowledges until nothing is left; a broken claim fails here instead of hanging. */
    drain() {
      for (let round = 0; round < 100; round++) {
        const items = this.claim();
        if (!items.length) return;
        this.ack(items);
      }
      assert.fail('claim kept returning items after 100 rounds');
    },
  };
}
