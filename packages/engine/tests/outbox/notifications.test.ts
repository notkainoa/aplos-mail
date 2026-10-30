import test from 'node:test';
import assert from 'node:assert/strict';
import type { NotificationItem } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { fakeClock } from '../../src/clock/module';
import { createLogger } from '../../src/diag/log';
import { dispatch, type Caller, type EngineServices } from '../../src/methods/index';
import { outboxExtension } from '../../src/outbox/extension';
import {
  CLAIM_LEASE_MS,
  createNotifications,
  ingestNotifications,
  type NotificationModule,
} from '../../src/outbox/notifications';
import type { DeadlineSource } from '../../src/ports/time';
import type { EngineFrame } from '../../src/runtime/frames';
import {
  openStore,
  type CommitExtensionTx,
  type IngestBatch,
  type IngestedMessage,
  type MessageWrite,
  type StorePort,
  type StoreWrite,
} from '../../src/store';
import { ACCOUNT, accountWrite, folderWrites, msg, tempDb } from '../store/helpers';

const T0 = Date.UTC(2026, 9, 30, 9, 0, 0);

const SPAM = {
  kind: 'folder',
  accountId: ACCOUNT,
  remoteId: 'SPAM',
  name: 'Spam',
  role: 'spam',
  folderKind: 'system',
} as const;
const SENT = {
  kind: 'folder',
  accountId: ACCOUNT,
  remoteId: 'SENT',
  name: 'Sent',
  role: 'sent',
  folderKind: 'system',
} as const;

type Step = 'baseline' | 'incremental' | 'backfill' | 'search' | 'resync' | 'prefetch';

function world(options: { account?: Record<string, unknown> } = {}) {
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
      deadlines: {
        register: s => {
          sources.push(s);
          return () => {};
        },
        changed: () => {},
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

const ids = (items: NotificationItem[]) => items.map(i => i.id);
const mail = (remoteId: string, extra: Partial<MessageWrite> = {}) =>
  msg(remoteId, `th-${remoteId}`, 1, extra);

test('a new unread Inbox message after the baseline writes one pending row', () => {
  const w = world();
  w.setup(true);
  w.commit('incremental', [mail('m1')]);
  assert.deepEqual(w.rows(), [{ remote_id: 'm1', state: 'pending' }]);
  assert.equal(w.notes.service.pending(), 1);
  w.close();
});

test('no row for backfill, baseline, resync, prefetch, search or local writes', () => {
  const w = world();
  w.setup(true);
  w.commit('baseline', [mail('a')]);
  w.commit('backfill', [mail('b')]);
  w.commit('resync', [mail('c')]);
  w.commit('prefetch', [mail('d')]);
  w.commit('search', [mail('e')]);
  w.commit(undefined, [mail('f')], 'local');
  assert.deepEqual(w.rows(), []);
  w.close();
});

test('no row for Spam, Trash, Sent, drafts, own mail, read mail or mail outside the Inbox', () => {
  const w = world();
  w.setup(true);
  w.commit('incremental', [
    mail('spam', { folders: [{ folder: 'SPAM' }] }),
    mail('trash', { folders: [{ folder: 'TRASH' }] }),
    mail('both', { folders: [{ folder: 'INBOX' }, { folder: 'SPAM' }] }),
    mail('sent', { folders: [{ folder: 'SENT' }] }),
    mail('label', { folders: [{ folder: 'Label_1' }] }),
    mail('draft', { flags: { seen: false, flagged: false, draft: true, fromMe: false } }),
    mail('mine', { flags: { seen: false, flagged: false, draft: false, fromMe: true } }),
    mail('read', { flags: { seen: true, flagged: false, draft: false, fromMe: false } }),
    mail('good'),
  ]);
  assert.deepEqual(
    w.rows().map(r => r.remote_id),
    ['good'],
  );
  w.close();
});

test('the account stays silent until its baseline is done, and when its switch is off', () => {
  const fresh = world();
  fresh.setup(false);
  fresh.commit('incremental', [mail('m1')]);
  assert.deepEqual(fresh.rows(), []);
  fresh.close();

  const off = world({ account: { notifications: false } });
  off.setup(true);
  off.commit('incremental', [mail('m1')]);
  assert.deepEqual(off.rows(), []);
  off.close();
});

test('a message seen again is not notified twice', () => {
  const w = world();
  w.setup(true);
  w.commit('incremental', [mail('m1')]);
  w.commit('incremental', [mail('m1')]);
  w.commit('incremental', [mail('m1', { subject: 'Edited' })]);
  assert.equal(w.rows().length, 1);
  const first = w.notes.service.claim();
  w.notes.service.ack(ids(first), 'posted');
  w.commit('incremental', [mail('m1', { snippet: 'again' })]);
  assert.deepEqual(w.rows(), [{ remote_id: 'm1', state: 'posted' }]);
  assert.deepEqual(w.notes.service.claim(), []);
  w.close();
});

test('exactly once: 50 syncs with a crash between written and posted', async () => {
  const w = world();
  w.setup(true);
  const posted: string[] = [];
  for (let i = 0; i < 50; i++) {
    const good = mail(`good-${i}`, { internalDate: T0 + i, date: T0 + i });
    const batch = [
      good,
      mail(`spam-${i}`, { folders: [{ folder: 'SPAM' }] }),
      mail(`sent-${i}`, {
        folders: [{ folder: 'SENT' }],
        flags: { seen: true, flagged: false, draft: false, fromMe: true },
      }),
    ];
    w.commit('incremental', batch);
    w.commit('backfill', [mail(`old-${i}`)]);
    // The same page delivered again (a retry after a lost reply).
    w.commit('incremental', [good]);
    // Every fifth round the engine dies after the commit and before anything is posted.
    if (i % 5 === 0) w.reopen();
    // Every third round main claims, posts and dies before it acknowledges.
    if (i % 3 === 0) {
      w.notes.service.claim();
      w.reopen();
    }
    if (i % 2 === 0) {
      await w.clock.set(w.clock.now() + 2 * CLAIM_LEASE_MS);
      const items = w.notes.service.claim();
      posted.push(...ids(items));
      w.notes.service.ack(ids(items), 'posted');
    }
  }
  await w.clock.set(w.clock.now() + 2 * CLAIM_LEASE_MS);
  for (;;) {
    const items = w.notes.service.claim();
    if (!items.length) break;
    posted.push(...ids(items));
    w.notes.service.ack(ids(items), 'posted');
  }
  const expected = Array.from({ length: 50 }, (_, i) => `mail:${ACCOUNT}:good-${i}`);
  assert.deepEqual([...posted].sort(), [...expected].sort());
  assert.equal(w.rows().length, 50);
  assert.ok(w.rows().every(r => r.state === 'posted' && r.remote_id.startsWith('good-')));
  w.close();
});

test('an item has a sender title, the subject as body and never more', () => {
  const w = world();
  w.setup(true);
  w.commit('incremental', [
    mail('m1', {
      from: { address: 'ann@mail.example', name: 'Ann\nLee' },
      subject: `Hello\r\nthere ${'x'.repeat(2000)}`,
      snippet: 'SECRET BODY TEXT',
    }),
  ]);
  const [item] = w.notes.service.claim();
  assert.equal(item.kind, 'mail');
  assert.equal(item.title, 'Ann Lee');
  assert.equal(item.accountId, ACCOUNT);
  assert.equal(item.threadId, `${ACCOUNT}:th-m1`);
  assert.ok(item.body!.startsWith('Hello there x'));
  assert.equal(item.body!.length, 1000);
  assert.ok(!JSON.stringify(item).includes('SECRET'));
  assert.deepEqual(Object.keys(item).sort(), [
    'accountId',
    'at',
    'body',
    'id',
    'kind',
    'threadId',
    'title',
  ]);
  w.close();
});

test('claim hands each row out once, up to max, oldest first, until its lease ends', async () => {
  const w = world();
  w.setup(true);
  for (let i = 0; i < 5; i++) {
    w.commit('incremental', [mail(`m${i}`, { internalDate: T0 + i, date: T0 + i })]);
    await w.clock.advance(1);
  }
  const first = w.notes.service.claim(2);
  assert.deepEqual(ids(first), [`mail:${ACCOUNT}:m0`, `mail:${ACCOUNT}:m1`]);
  assert.deepEqual(ids(w.notes.service.claim(10)), [
    `mail:${ACCOUNT}:m2`,
    `mail:${ACCOUNT}:m3`,
    `mail:${ACCOUNT}:m4`,
  ]);
  assert.deepEqual(w.notes.service.claim(), []);
  w.close();
});

test('a claim nobody acknowledges is offered again once its lease ends, and only once', async () => {
  const w = world();
  w.setup(true);
  w.commit('incremental', [mail('m1')]);
  const first = w.notes.service.claim();
  assert.equal(first.length, 1);
  await w.clock.advance(CLAIM_LEASE_MS - 1);
  assert.deepEqual(w.notes.service.claim(), []);
  await w.clock.advance(1);
  const again = w.notes.service.claim();
  assert.deepEqual(ids(again), ids(first));
  assert.deepEqual(w.notes.service.claim(), []);
  w.notes.service.ack(ids(again), 'posted');
  await w.clock.advance(10 * CLAIM_LEASE_MS);
  assert.deepEqual(w.notes.service.claim(), []);
  w.close();
});

test('the lease deadline source tells main to claim again', async () => {
  const w = world();
  w.setup(true);
  w.commit('incremental', [mail('m1')]);
  const [source] = w.sources;
  assert.equal(source.id, 'notifications');
  assert.equal(await source.next(), undefined);
  w.notes.service.claim();
  assert.equal(await source.next(), w.clock.now() + CLAIM_LEASE_MS);
  await w.clock.advance(CLAIM_LEASE_MS);
  w.events.length = 0;
  await source.fire(w.clock.now());
  assert.deepEqual(w.events, [{ type: 'notify', pending: 1 }]);
  assert.equal(await source.next(), undefined);
  w.close();
});

test('ack is idempotent, ignores unknown ids and does not resurrect a posted row', () => {
  const w = world();
  w.setup(true);
  w.commit('incremental', [mail('m1'), mail('m2')]);
  const items = w.notes.service.claim();
  w.notes.service.ack([...ids(items), 'nope', 'mail:nobody:x', 'reminder:a:b:1'], 'posted');
  w.notes.service.ack(ids(items), 'posted');
  w.notes.service.ack(ids(items), 'dropped');
  assert.deepEqual(
    w.rows().map(r => r.state),
    ['posted', 'posted'],
  );
  assert.deepEqual(w.notes.service.claim(), []);
  w.notes.service.ack([], 'posted');
  w.close();
});

test('mail read or moved out of the Inbox before the claim is dropped, not posted', () => {
  const w = world();
  w.setup(true);
  w.commit('incremental', [mail('read'), mail('moved'), mail('keep')]);
  w.commit('incremental', [
    mail('read', { flags: { seen: true, flagged: false, draft: false, fromMe: false } }),
  ]);
  w.commit('incremental', [mail('moved', { folders: [{ folder: 'Label_1' }] })]);
  const items = w.notes.service.claim();
  assert.deepEqual(ids(items), [`mail:${ACCOUNT}:keep`]);
  assert.deepEqual(
    w.rows().map(r => `${r.remote_id}:${r.state}`),
    ['keep:claimed', 'moved:dropped', 'read:dropped'],
  );
  w.close();
});

test('rows written before a crash are announced on the next start', () => {
  const w = world();
  w.setup(true);
  w.commit('incremental', [mail('m1')]);
  w.reopen();
  w.events.length = 0;
  w.notes.start();
  assert.deepEqual(w.events, [{ type: 'notify', pending: 1 }]);
  w.close();
});

test('a commit that writes rows sends one notify event after it lands', async () => {
  const w = world();
  w.setup(true);
  w.events.length = 0;
  w.commit('incremental', [mail('m1'), mail('m2')]);
  assert.deepEqual(w.events, []);
  await Promise.resolve();
  assert.deepEqual(w.events, [{ type: 'notify', pending: 2 }]);
  w.close();
});

test('the Dock badge is the unread Inbox count and is sent only when it changes', async () => {
  const w = world();
  w.setup(true);
  w.notes.start();
  await w.clock.advance(300);
  assert.deepEqual(w.events, [{ type: 'badge', count: 0 }]);
  // New mail: the ingest hook asks for a look at once.
  w.events.length = 0;
  w.commit('incremental', [mail('m1'), mail('m2')]);
  await w.clock.advance(300);
  assert.deepEqual(
    w.events.filter(e => e.type === 'badge'),
    [{ type: 'badge', count: 2 }],
  );
  // Reading mail changes the count with no hook; whoever sees the commit asks for a look.
  w.events.length = 0;
  w.commit('incremental', [
    mail('m1', { flags: { seen: true, flagged: false, draft: false, fromMe: false } }),
  ]);
  w.notes.service.refreshBadge();
  w.notes.service.refreshBadge();
  await w.clock.advance(300);
  assert.deepEqual(w.events, [{ type: 'badge', count: 1 }]);
  // Nothing moved: the look finds the same count and sends nothing.
  w.events.length = 0;
  w.notes.service.refreshBadge();
  await w.clock.advance(300);
  assert.deepEqual(w.events, []);
  assert.equal(w.notes.service.badge(), 1);
  w.close();
});

// ------------------------------------------------------------------ the hook on odd data

function fakeTx(failOn?: string) {
  const inserted: unknown[] = [];
  const tx = {
    now: () => T0,
    get: (sql: string) => {
      if (failOn && sql.includes(failOn)) throw new Error('boom');
      return { baseline_done_at: T0, notifications: 1 };
    },
    run: (_sql: string, ...params: unknown[]) => {
      inserted.push(params[0]);
      return { changes: 1, lastInsertRowid: 1 };
    },
  } as unknown as CommitExtensionTx;
  return { tx, inserted };
}

const good = (rowId: number): IngestedMessage => ({
  accountId: ACCOUNT,
  remoteId: `r${rowId}`,
  remoteThreadId: 't',
  rowId,
  added: true,
  origin: 'sync',
  internalDate: T0,
  flags: { seen: false, flagged: false, draft: false, fromMe: false },
  folders: ['INBOX'],
  roles: ['inbox'],
});

test('the ingest hook never throws on odd data and still handles the rest of the batch', () => {
  const odd = [
    { ...good(1), roles: undefined },
    { ...good(2), flags: undefined },
    { ...good(3), accountId: undefined },
    null,
    { ...good(4), roles: 'inbox' },
    good(5),
  ] as unknown as IngestedMessage[];
  const { tx, inserted } = fakeTx();
  const batch: IngestBatch = { origin: 'sync', step: 'incremental', messages: odd };
  assert.doesNotThrow(() => ingestNotifications(batch, tx));
  assert.ok(inserted.includes(5));
  assert.doesNotThrow(() =>
    ingestNotifications({ origin: 'sync', step: 'incremental', messages: null } as never, tx),
  );
  const failing = fakeTx('accounts');
  assert.doesNotThrow(() => ingestNotifications(batch, failing.tx));
  assert.deepEqual(failing.inserted, []);
});

test('a real commit with odd stored data still lands', () => {
  const w = world();
  w.setup(true);
  const result = w.commit('incremental', [
    mail('weird', { from: undefined, subject: undefined, snippet: undefined }),
    mail('ok'),
  ]);
  assert.equal(result.replayed, false);
  const items = w.notes.service.claim();
  assert.equal(items.length, 2);
  assert.ok(items.every(i => i.title.length > 0));
  w.close();
});

// ------------------------------------------------------------------ the methods

test('Notification/claim and /ack are for main only, and reach the service', async () => {
  const w = world();
  w.setup(true);
  w.commit('incremental', [mail('m1')]);
  const as = (caller: Caller) => ({
    caller,
    signal: new AbortController().signal,
    services: { notifications: w.notes.service } as unknown as EngineServices,
    connectionId: 'c1',
    redispatch: () => Promise.reject(new Error('no')),
  });
  const forbidden = (e: unknown) => e instanceof ContractError && e.type === 'forbidden';
  const window = as({ kind: 'window', scopes: ['read', 'triage', 'draft', 'send', 'ai', 'admin'] });
  const listener = as({ kind: 'listener', via: 'socket', scopes: ['read', 'admin', 'host'] });
  for (const c of [window, listener]) {
    await assert.rejects(dispatch('Notification/claim', {}, c), forbidden);
    await assert.rejects(
      dispatch('Notification/ack', { ids: ['x'], state: 'posted' }, c),
      forbidden,
    );
  }
  const host = as({ kind: 'host', scopes: ['host'] });
  const out = (await dispatch('Notification/claim', { max: 5 }, host)) as {
    items: NotificationItem[];
  };
  assert.equal(out.items.length, 1);
  assert.deepEqual(
    await dispatch('Notification/ack', { ids: ids(out.items), state: 'posted' }, host),
    {
      ok: true,
    },
  );
  assert.deepEqual(w.rows(), [{ remote_id: 'm1', state: 'posted' }]);
  w.close();
});
