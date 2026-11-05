import assert from 'node:assert/strict';
import test from 'node:test';
import { listenerCaller } from '@aplos/contract/access';
import type { EngineMethodName, Frame, Input, Output } from '@aplos/contract';
import { createLogger } from '../../src/diag/log';
import { createEngine, laneExtensions } from '../../src/index';
import { defaultSettings, mergePatch, withDefaults } from '../../src/runtime/settings';
import { openStore } from '../../src/store';
import { accountWrite, T0, tempDb } from '../store/helpers';
import { manualClock } from '../runtime.helpers';

/** The real engine over a fresh database with every lane's writers, as a window (and as a listener client where asked). */
async function world(host?: Partial<Parameters<typeof createEngine>[0]['host'] & object>) {
  const file = tempDb();
  const clock = manualClock();
  const store = openStore(file.open(), { now: () => clock.now(), extensions: laneExtensions() });
  const log = createLogger({ sink: { write: () => undefined }, salt: 's', clock });
  const engine = await createEngine({
    store,
    clock,
    log,
    host: {
      appVersion: '9.9.9',
      device: { id: 'dev-1', name: 'Test Mac' },
      resident: true,
      capabilities: { desktop: true, menuBar: true },
      ...host,
    },
  });
  const window = engine.connect();
  const call = <M extends EngineMethodName>(method: M, args: Input<M>) =>
    window.call(method, args) as Promise<Output<M>>;
  const frames: Frame[] = [];
  window.subscribe(frame => void frames.push(frame));
  return { store, engine, call, frames, clock, file };
}

const sql = (w: Awaited<ReturnType<typeof world>>, text: string, ...params: (string | number)[]) =>
  w.file
    .open()
    .prepare(text)
    .all(...params) as Array<Record<string, unknown>>;

test('Session/get: the handshake facts, from the store, the clock and the host', async () => {
  const w = await world();
  const session = await w.call('Session/get', {});
  assert.equal(session.apiVersion, 1);
  assert.equal(session.appVersion, '9.9.9');
  assert.equal(session.dbEpoch, w.store.dbEpoch);
  assert.deepEqual(session.state, { dbEpoch: w.store.dbEpoch, seq: w.store.seq() });
  assert.equal(session.schemaVersion, w.store.schemaVersion);
  assert.deepEqual(session.engine, { state: 'ready', resident: true });
  assert.deepEqual(session.device, { id: 'dev-1', name: 'Test Mac' });
  assert.equal(session.now, w.clock.now());
  assert.equal(session.hasAccounts, false);
  assert.deepEqual(session.setup, {});
  assert.equal(session.capabilities.desktop, true, 'the host adds the desktop');
  assert.equal(session.capabilities.mailFrame, true, 'the engine adds its own');
  assert.equal(session.capabilities.calendarWrite, false, 'and says no to what is not built');
  assert.deepEqual(
    session.providers.map(p => [p.kind, p.available]),
    [
      ['google', true],
      ['microsoft', false],
      ['imap', false],
      ['jmap', false],
    ],
  );
});

test('Session/get: hasAccounts follows the store, setup follows meta, and a bad meta value is ignored', async () => {
  const w = await world();
  w.store.commit({ opId: 'a', origin: 'sync', writes: [{ ...accountWrite }] });
  w.file
    .open()
    .prepare(
      "INSERT INTO meta(key, value) VALUES('setup.completedAt', ?), ('setup.skippedAt', 'soon')",
    )
    .run(String(T0));
  const session = await w.call('Session/get', {});
  assert.equal(session.hasAccounts, true);
  assert.deepEqual(session.setup, { completedAt: T0 });
});

test('Session/changes: what changed since a state, deduplicated per row, filtered by type, paged by whole commits', async () => {
  const w = await world();
  const start = (await w.call('Session/get', {})).state;
  w.store.commit({ opId: 'a1', origin: 'sync', writes: [{ ...accountWrite }] });
  const mid = w.store.seq();
  w.store.commit({
    opId: 'a2',
    origin: 'sync',
    writes: [{ ...accountWrite, address: 'other@mail.example' }],
  });
  const all = await w.call('Session/changes', { since: start });
  assert.deepEqual(all.oldState, start);
  assert.equal(all.newState.seq, w.store.seq());
  assert.equal(all.hasMore, false);
  assert.deepEqual(
    all.changes.filter(c => c.type === 'Account'),
    [{ type: 'Account', id: accountWrite.id, op: 'u' }],
  );
  const none = await w.call('Session/changes', { since: start, types: ['Thread'] });
  assert.deepEqual(none.changes, []);
  assert.equal(none.newState.seq, w.store.seq(), 'the state still moves');
  const later = await w.call('Session/changes', { since: { dbEpoch: w.store.dbEpoch, seq: mid } });
  assert.equal(later.changes.length > 0, true);
  const paged = await w.call('Session/changes', { since: start, maxChanges: 1 });
  assert.equal(paged.hasMore, true, 'a small page leaves the rest');
  assert.ok(paged.newState.seq < w.store.seq());
});

test('Session/changes: another database, a seq from the future, or below the floor is cannotCalculateChanges', async () => {
  const w = await world();
  w.store.commit({ opId: 'a1', origin: 'sync', writes: [{ ...accountWrite }] });
  const bad: Array<Input<'Session/changes'>> = [
    { since: { dbEpoch: 'someone-else', seq: 0 } },
    { since: { dbEpoch: w.store.dbEpoch, seq: w.store.seq() + 5 } },
  ];
  for (const args of bad)
    await assert.rejects(
      w.call('Session/changes', args),
      (e: { type?: string }) => e.type === 'cannotCalculateChanges',
    );
  w.file
    .open()
    .prepare("UPDATE meta SET value = ? WHERE key = 'change_floor_seq'")
    .run(String(w.store.seq()));
  await assert.rejects(
    w.call('Session/changes', { since: { dbEpoch: w.store.dbEpoch, seq: 0 } }),
    (e: { type?: string }) => e.type === 'cannotCalculateChanges',
  );
});

test('Settings/get: the defaults on a fresh database, the stored sections laid over them, an unreadable row as defaults', async () => {
  const w = await world();
  assert.deepEqual(await w.call('Settings/get', {}), defaultSettings());
  w.file
    .open()
    .prepare('INSERT INTO settings(id, data) VALUES(1, ?)')
    .run(JSON.stringify({ mail: { undoSendSeconds: 20, imageAllowList: ['a@b.example'] } }));
  const got = await w.call('Settings/get', {});
  assert.equal(got.mail.undoSendSeconds, 20);
  assert.deepEqual(got.mail.imageAllowList, ['a@b.example']);
  assert.equal(got.mail.followUpDays, 3, 'a field the document lacks is the default');
  assert.deepEqual(got.ui, defaultSettings().ui);
  w.file.open().prepare("UPDATE settings SET data = 'not json' WHERE id = 1").run();
  assert.deepEqual(await w.call('Settings/get', {}), defaultSettings());
  assert.equal(defaultSettings().mail.signature, '', 'no demo signature on a real install');
});

test('Settings/set: merges by section, keeps the rest (the allow list), answers the whole document and a receipt', async () => {
  const w = await world();
  await w.call('Mail/allowImages', { opId: 'img', sender: 'ada@corp.example', allow: true });
  const out = await w.call('Settings/set', {
    opId: 's1',
    patch: { mail: { undoSendSeconds: 30 }, ui: { dock: { open: true, tab: 'ask' } } },
  });
  assert.equal(out.settings.mail.undoSendSeconds, 30);
  assert.deepEqual(
    out.settings.mail.imageAllowList,
    ['ada@corp.example'],
    "the allow-list writer's field survives",
  );
  assert.deepEqual(out.settings.ui.dock, { open: true, tab: 'ask' });
  assert.equal(out.receipt.opId, 's1');
  assert.deepEqual(out.receipt.appliedState, { dbEpoch: w.store.dbEpoch, seq: w.store.seq() });
  assert.equal(out.receipt.undoable, false);
  assert.deepEqual(await w.call('Settings/get', {}), out.settings);
});

test('Settings/set: a replayed opId changes nothing; ifInState stale is stateMismatch, current is fine', async () => {
  const w = await world();
  const first = await w.call('Settings/set', { opId: 's1', patch: { mail: { followUpDays: 5 } } });
  await w.call('Settings/set', { opId: 's2', patch: { mail: { followUpDays: 7 } } });
  const replay = await w.call('Settings/set', { opId: 's1', patch: { mail: { followUpDays: 5 } } });
  assert.equal(replay.settings.mail.followUpDays, 7, 'the replay applied nothing');
  assert.equal(
    replay.receipt.appliedState.seq,
    first.receipt.appliedState.seq,
    'it names the first commit',
  );
  await assert.rejects(
    w.call('Settings/set', {
      opId: 's3',
      patch: { mail: { followUpDays: 9 } },
      ifInState: first.receipt.appliedState,
    }),
    (e: { type?: string }) => e.type === 'stateMismatch',
  );
  const now = { dbEpoch: w.store.dbEpoch, seq: w.store.seq() };
  const ok = await w.call('Settings/set', {
    opId: 's4',
    patch: { mail: { followUpDays: 9 } },
    ifInState: now,
  });
  assert.equal(ok.settings.mail.followUpDays, 9);
  await assert.rejects(
    w.call('Settings/set', { opId: 's5', patch: {}, ifInState: { dbEpoch: 'elsewhere', seq: 99 } }),
    (e: { type?: string }) => e.type === 'stateMismatch',
  );
});

test('Settings/set: a new theme goes to main once on the host channel; an unchanged one says nothing', async () => {
  const w = await world();
  const appearance = () =>
    w.frames.filter(
      f => f.frame === 'host' && (f as { event: { type: string } }).event.type === 'appearance',
    );
  await w.call('Settings/set', { opId: 't1', patch: { ui: { theme: 'dark' } } });
  assert.equal(appearance().length, 1);
  assert.deepEqual((appearance()[0] as { event: unknown }).event, {
    type: 'appearance',
    theme: 'dark',
  });
  await w.call('Settings/set', { opId: 't2', patch: { ui: { theme: 'dark' } } });
  await w.call('Settings/set', { opId: 't1', patch: { ui: { theme: 'dark' } } });
  assert.equal(appearance().length, 1, 'same theme and a replay: no second event');
});

test("Settings/set: a listener client's change writes one content-free audit row; a window's writes none", async () => {
  const w = await world();
  await w.call('Settings/set', { opId: 'w1', patch: { mail: { followUpDays: 4 } } });
  assert.deepEqual(sql(w, 'SELECT * FROM audit_log'), []);
  const client = w.engine.connect(
    listenerCaller({ id: 'c1', kind: 'cli', scopes: ['read', 'admin'] }, 'http') as never,
  );
  await client.call('Settings/set', { opId: 'l1', patch: { mail: { followUpDays: 6 } } });
  const rows = sql(w, 'SELECT client_id, method, target FROM audit_log');
  assert.deepEqual(
    rows.map(r => ({ ...r })),
    [{ client_id: 'c1', method: 'Settings/set', target: null }],
  );
  await assert.rejects(
    client.call('Settings/set', { opId: 'l2', patch: { ai: { background: false } } }),
    (e: { type?: string }) => e.type === 'forbidden',
  );
});

test('the merge helpers: a section the patch names is merged field by field, a field replaced whole, others untouched', () => {
  const stored = {
    mail: { undoSendSeconds: 8, imageAllowList: ['x'] },
    ui: { dock: { open: false, tab: 'ask' }, zen: true },
  };
  const next = mergePatch(stored, {
    mail: { followUpDays: 2 },
    ui: { dock: { open: true, tab: 'cal' } },
  } as never) as typeof stored & { mail: Record<string, unknown> };
  assert.deepEqual(next.mail, { undoSendSeconds: 8, imageAllowList: ['x'], followUpDays: 2 });
  assert.deepEqual(next.ui, { dock: { open: true, tab: 'cal' }, zen: true });
  assert.deepEqual(withDefaults({}).notifications, defaultSettings().notifications);
});
