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
  assert.equal(
    session.capabilities.calendarWrite,
    true,
    'the engine can write events (each grant decides)',
  );
  assert.equal(session.capabilities.remoteSearch, false, 'and says no to what is not built');
  // Settings hides "Allow tools on this Mac", Connected tools and the queue inspector while these are off (GO-LIVE 15):
  // no socket or loopback listener exists, so none of them may report true until it is built.
  for (const key of ['listener', 'clients', 'mcp', 'queueInspector'])
    assert.equal(session.capabilities[key], false, `${key} stays off until it is built`);
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

test('Settings/get stays valid after a damaged or newer document: wrong types, unknown values and keys, partial nested objects', async () => {
  const w = await world();
  const damaged = {
    ui: { theme: 'purple', holdMs: 'fast', dock: { open: true }, newerField: 1 },
    mail: {
      undoSendSeconds: 'eight',
      remoteImages: 'maybe',
      imageAllowList: 'nope',
      unknown: true,
    },
    ai: { features: { ask: { provider: 'groq' } }, dailyCap: [] },
    notifications: 'off',
    host: { menuBar: false },
    surprise: { a: 1 },
  };
  w.file.open().prepare('INSERT INTO settings(id, data) VALUES(1, ?)').run(JSON.stringify(damaged));
  const got = await w.call('Settings/get', {});
  const defaults = defaultSettings();
  assert.equal(got.ui.theme, defaults.ui.theme, 'an enum value outside its set');
  assert.equal(got.ui.holdMs, defaults.ui.holdMs, 'a string where a number belongs');
  assert.deepEqual(
    got.ui.dock,
    { open: true, tab: 'ask' },
    'a partial nested object: the stored field stays, the missing one is the default',
  );
  assert.equal('newerField' in got.ui, false, 'an unknown key is dropped');
  assert.equal(got.mail.undoSendSeconds, defaults.mail.undoSendSeconds);
  assert.equal(got.mail.remoteImages, 'block');
  assert.deepEqual(got.mail.imageAllowList, []);
  assert.deepEqual(
    got.ai.features,
    defaults.ai.features,
    'one feature stored of five: the whole shape is the default',
  );
  assert.deepEqual(got.ai.dailyCap, defaults.ai.dailyCap);
  assert.deepEqual(got.notifications, defaults.notifications, 'a section that is not an object');
  assert.equal(got.host.menuBar, false, 'a valid stored field survives');
  assert.equal('surprise' in got, false);
  w.file
    .open()
    .prepare('UPDATE settings SET data = ? WHERE id = 1')
    .run(JSON.stringify({ ui: { dock: { open: true, tab: 'today', width: 400 } } }));
  assert.deepEqual((await w.call('Settings/get', {})).ui.dock, {
    open: true,
    tab: 'today',
    width: 400,
  });
});

test('Settings/set: ifInState survives compaction of the change log, and a retry of an applied opId is not a mismatch', async () => {
  const w = await world();
  const first = await w.call('Settings/set', { opId: 'c1', patch: { mail: { followUpDays: 5 } } });
  w.store.compact({ maxRows: 0 });
  await assert.rejects(
    w.call('Settings/set', {
      opId: 'c2',
      patch: { mail: { followUpDays: 6 } },
      ifInState: { dbEpoch: w.store.dbEpoch, seq: 0 },
    }),
    (e: { type?: string }) => e.type === 'stateMismatch',
  );
  const retry = await w.call('Settings/set', {
    opId: 'c1',
    patch: { mail: { followUpDays: 5 } },
    ifInState: { dbEpoch: w.store.dbEpoch, seq: 0 },
  });
  assert.equal(
    retry.receipt.appliedState.seq,
    first.receipt.appliedState.seq,
    'the first receipt, not a mismatch',
  );
});

test('Settings/set: a change that changes nothing writes nothing and tells no window', async () => {
  const w = await world();
  await w.call('Settings/set', { opId: 'n1', patch: { mail: { followUpDays: 5 } } });
  const seq = w.store.seq();
  await w.call('Settings/set', { opId: 'n2', patch: { mail: { followUpDays: 5 } } });
  await w.call('Settings/set', { opId: 'n3', patch: {} });
  assert.equal(w.store.seq(), seq, 'no commit seq moved');
});

test('Session/changes: a type filter can leave an empty page with hasMore, and the state still moves forward', async () => {
  const w = await world();
  const start = (await w.call('Session/get', {})).state;
  for (let i = 0; i < 3; i++)
    await w.call('Settings/set', { opId: `p${i}`, patch: { mail: { followUpDays: 2 + i } } });
  const page = await w.call('Session/changes', { since: start, types: ['Thread'], maxChanges: 1 });
  assert.deepEqual(page.changes, []);
  assert.equal(page.hasMore, true);
  assert.ok(page.newState.seq > start.seq, 'so a client that loops makes progress');
});

test('Later/presets reads the week start from ui.calendar.weekStart in the settings document', async () => {
  const w = await world();
  const at = async () =>
    (
      (await w.engine.connect().call('Later/presets', {})) as {
        presets: Array<{ key: string; until?: number }>;
      }
    ).presets.find(p => p.key === 'nextWeek')!.until;
  const monday = await at();
  await w.call('Settings/set', { opId: 'ws', patch: { ui: { calendar: { weekStart: 0 } } } });
  const sunday = await at();
  assert.notEqual(sunday, monday, 'the owner\'s Sunday start moves "Next week"');
});

test('Settings: calendar.defaultCalendarId round-trips (an optional string the defaults do not carry)', async () => {
  const w = await world();
  const out = await w.call('Settings/set', {
    opId: 'cal',
    patch: { calendar: { defaultCalendarId: 'cal-1' } },
  });
  assert.equal(out.settings.calendar.defaultCalendarId, 'cal-1');
  assert.equal((await w.call('Settings/get', {})).calendar.defaultCalendarId, 'cal-1');
  w.file
    .open()
    .prepare('UPDATE settings SET data = ? WHERE id = 1')
    .run(JSON.stringify({ calendar: { defaultCalendarId: 7 } }));
  assert.equal(
    'defaultCalendarId' in (await w.call('Settings/get', {})).calendar,
    false,
    'a wrong type is dropped',
  );
});

test('Settings/set: a listener client cannot change what the owner is exposed to or can undo; a window can', async () => {
  const w = await world();
  const client = w.engine.connect(
    listenerCaller({ id: 'c1', kind: 'cli', scopes: ['read', 'admin'] }, 'http') as never,
  );
  for (const patch of [
    { mail: { remoteImages: 'allow' } },
    { mail: { imageAllowList: ['a@b.example'] } },
    { mail: { undoSendSeconds: 0 } },
    { ai: { background: false } },
  ] as const)
    await assert.rejects(
      client.call('Settings/set', { opId: `x-${JSON.stringify(patch).length}`, patch } as never),
      (e: { type?: string }) => e.type === 'forbidden',
      JSON.stringify(patch),
    );
  await client.call('Settings/set', { opId: 'ok', patch: { mail: { followUpDays: 6 } } });
  const out = await w.call('Settings/set', {
    opId: 'win',
    patch: { mail: { remoteImages: 'allow', undoSendSeconds: 20 } },
  });
  assert.equal(out.settings.mail.remoteImages, 'allow');
});

test('Settings/set: ifInState from the future is a mismatch', async () => {
  const w = await world();
  await assert.rejects(
    w.call('Settings/set', {
      opId: 'f',
      patch: {},
      ifInState: { dbEpoch: w.store.dbEpoch, seq: w.store.seq() + 50 },
    }),
    (e: { type?: string }) => e.type === 'stateMismatch',
  );
});

test("Session/get: the Mac's own name goes to the app, a listener client is told a generic one", async () => {
  const w = await world();
  assert.equal((await w.call('Session/get', {})).device.name, 'Test Mac');
  const client = w.engine.connect(
    listenerCaller({ id: 'c1', kind: 'cli', scopes: ['read'] }, 'http') as never,
  );
  assert.equal(
    ((await client.call('Session/get', {})) as { device: { name: string; id: string } }).device
      .name,
    'This Mac',
  );
});

test('Session/changes: one commit too big to send is cannotCalculateChanges (reload), a normal one is not', async () => {
  const w = await world();
  const start = (await w.call('Session/get', {})).state;
  const many = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => ({
      ...accountWrite,
      id: `${tag}-${i}`,
      address: `${tag}${i}@mail.example`,
    }));
  w.store.commit({ opId: 'small', origin: 'sync', writes: many(50, 'small') });
  assert.equal((await w.call('Session/changes', { since: start })).changes.length, 50);
  const mid = (await w.call('Session/get', {})).state;
  w.store.commit({ opId: 'huge', origin: 'sync', writes: many(2100, 'huge') });
  await assert.rejects(
    w.call('Session/changes', { since: mid }),
    (e: { type?: string }) => e.type === 'cannotCalculateChanges',
  );
});

test('mergePatch ignores keys that are not sections and cannot be turned into a prototype write', () => {
  const hostile = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"x":1},"mail":{"__proto__":{"y":2},"followUpDays":4}}',
  );
  const next = mergePatch({}, hostile) as Record<string, unknown>;
  assert.equal(
    ({} as Record<string, unknown>).polluted,
    undefined,
    'Object.prototype is untouched',
  );
  assert.deepEqual(Object.keys(next), ['mail']);
  assert.equal(Object.getPrototypeOf(next), Object.prototype);
  assert.equal((next.mail as Record<string, unknown>).followUpDays, 4);
  assert.equal(
    Object.getPrototypeOf(next.mail),
    Object.prototype,
    'a __proto__ field is an own property, not a prototype',
  );
});
