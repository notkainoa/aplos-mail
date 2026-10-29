import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIGRATIONS,
  openStore,
  StoreError,
  type AccountWrite,
  type StorePort,
  type StoreWrite,
} from '../../src/store';
import { ACCOUNT, T0, accountWrite, folderWrites, msg, tempDb, withStore } from './helpers';
import { replay, snapshot } from './replay-helpers';

const OTHER = 'acct-2';
const invalid = (e: unknown) => e instanceof StoreError && e.code === 'invalid';
const row = (store: StorePort, id = ACCOUNT) =>
  store.read(q => {
    const r = q.get<{
      color_tag: string | null;
      notifications: number;
      settings: string;
      address: string;
    }>('SELECT color_tag, notifications, settings, address FROM accounts WHERE id = ?', id);
    return r && { ...r };
  });
const patch = (store: StorePort, opId: string, w: Partial<AccountWrite>) =>
  store.commit({
    opId,
    origin: 'local',
    writes: [{ kind: 'account', id: ACCOUNT, ...w }],
  });

test('colorTag, notifications and settings round-trip, default sensibly, and an update never resets an unspecified field', () => {
  withStore(store => {
    store.commit({ opId: 'a', origin: 'sync', writes: [accountWrite] });
    assert.deepEqual(row(store), {
      color_tag: null,
      notifications: 1,
      settings: '{}',
      address: 'owner@mail.example',
    });
    patch(store, 'p1', { colorTag: 'sage', notifications: false, settings: { digest: 'daily' } });
    assert.deepEqual(row(store), {
      color_tag: 'sage',
      notifications: 0,
      settings: '{"digest":"daily"}',
      address: 'owner@mail.example',
    });
    patch(store, 'p2', { displayName: 'Work' });
    assert.deepEqual(row(store)?.color_tag, 'sage', 'absent keeps the colour');
    assert.equal(row(store)?.notifications, 0, 'absent keeps the switch');
    assert.equal(row(store)?.settings, '{"digest":"daily"}', 'absent keeps the settings');
    patch(store, 'p3', { notifications: true, colorTag: null, settings: {} });
    assert.deepEqual(row(store), {
      color_tag: null,
      notifications: 1,
      settings: '{}',
      address: 'owner@mail.example',
    });
    store.commit({
      opId: 'new',
      origin: 'sync',
      writes: [{ ...accountWrite, id: OTHER, colorTag: 'ink', notifications: false }],
    });
    assert.equal(row(store, OTHER)?.color_tag, 'ink');
    assert.equal(row(store, OTHER)?.notifications, 0);
  });
});

test('settings must be a plain JSON object of at most 16 KB, and colorTag a short one-line name', () => {
  withStore(store => {
    store.commit({ opId: 'a', origin: 'sync', writes: [accountWrite] });
    const bad: Partial<AccountWrite>[] = [
      { settings: [] as unknown as Record<string, unknown> },
      { settings: 'x' as unknown as Record<string, unknown> },
      { settings: null as unknown as Record<string, unknown> },
      { settings: new Date() as unknown as Record<string, unknown> },
      { settings: { blob: 'x'.repeat(16 * 1024) } },
      { settings: { n: 1n } as unknown as Record<string, unknown> },
      { colorTag: '' },
      { colorTag: 'x'.repeat(41) },
      { colorTag: 'two\nlines' },
    ];
    bad.forEach((w, i) => assert.throws(() => patch(store, `bad-${i}`, w), invalid, String(i)));
    assert.equal(row(store)?.settings, '{}');
    assert.equal(store.seq(), 1, 'refused writes bumped nothing');
    patch(store, 'edge', {
      settings: { blob: 'x'.repeat(16 * 1024 - 11) },
      colorTag: 'x'.repeat(40),
    });
  });
});

test('the new account fields write an Account change row, so replaying the log reproduces the state', () => {
  withStore(store => {
    store.commit({ opId: 'a', origin: 'sync', writes: [accountWrite] });
    const before = snapshot(store);
    const since = store.seq();
    patch(store, 'p1', { colorTag: 'sage', notifications: false, settings: { a: 1 } });
    const after = snapshot(store);
    assert.notDeepEqual(after, before);
    assert.deepEqual(replay(before, store, since, after), after);
    const log = store.changesSince(since);
    assert.ok(
      log.status === 'ok' &&
        log.changes.some(c => c.type === 'Account' && c.id === ACCOUNT && c.op === 'u'),
    );
  });
});

// ---------------------------------------------------------------- accountRemove

/** Rows in every table the account owns, plus the raw-SQL tables other lanes write. */
function seed(store: StorePort, file: ReturnType<typeof tempDb>, id: string) {
  const own = <T extends { accountId?: string }>(w: T) =>
    w.accountId ? { ...w, accountId: id } : w;
  const writes: StoreWrite[] = [
    { ...accountWrite, id },
    ...folderWrites.map(own),
    msg('m1', 't1', 0, { hasAttachments: true }),
    msg('m2', 't1', 1),
    msg('m3', 't2', 2, { folders: [{ folder: 'Label_1' }] }),
  ].map(w => own(w as { accountId?: string }) as StoreWrite);
  writes.push(
    { kind: 'body', accountId: id, remoteId: 'm1', body: { text: 'hello' } },
    {
      kind: 'attachments',
      accountId: id,
      remoteId: 'm1',
      list: [{ remotePart: '2', name: 'a.pdf', inline: false }],
    },
    {
      kind: 'attachmentState',
      accountId: id,
      remoteId: 'm1',
      remotePart: '2',
      state: 'present',
      path: `${id}/a.pdf`,
    },
    { kind: 'workflow', accountId: id, remoteThreadId: 't1', patch: { status: 'later' } },
    { kind: 'syncState', accountId: id, scope: 'mail', generation: 2 },
    { kind: 'governor', accountId: id, budget: 'gmail', patch: { cooldownStep: 2 } },
    { kind: 'providerMemory', accountId: id, values: { k: 'v' } },
    { kind: 'syncFailure', accountId: id, item: 'x', failure: { attempts: 1, nextRetryAt: T0 } },
    {
      kind: 'calendar',
      accountId: id,
      remoteId: 'primary',
      name: 'Cal',
      hidden: false,
      readOnly: false,
    },
    {
      kind: 'event',
      accountId: id,
      calendarRemoteId: 'primary',
      remoteId: 'e1',
      rows: [{ status: 'confirmed', allDay: false, startUtc: T0, endUtc: T0 + 1, data: '{}' }],
    },
    {
      kind: 'eventHidden',
      accountId: id,
      calendarRemoteId: 'primary',
      remoteId: 'e1',
      hidden: true,
    },
    {
      kind: 'op',
      opId: `op-${id}`,
      accountId: id,
      opKind: 'archive',
      targets: [`${id}:t1`],
      payload: '{}',
      effect: [
        { kind: 'placements', target: { remoteThreadId: 't1' }, add: [], remove: ['INBOX'] },
      ],
      scope: 'triage',
    },
  );
  store.commit({ opId: `seed-${id}`, origin: 'sync', writes });
  const db = file.open();
  try {
    const mid = (r: string) =>
      Number(
        db.prepare('SELECT id FROM messages WHERE account_id = ? AND remote_id = ?').get(id, r)?.id,
      );
    const tid = Number(
      db.prepare('SELECT id FROM threads WHERE account_id = ? AND remote_id = ?').get(id, 't1')?.id,
    );
    db.prepare(
      "INSERT INTO drafts(id, account_id, revision, data, updated_at) VALUES(?, ?, 1, '{}', 1)",
    ).run(`d-${id}`, id);
    db.prepare(
      "INSERT INTO submissions(id, draft_id, account_id, internet_id, not_before, state) VALUES(?, ?, ?, 'i', 1, 'queued')",
    ).run(`s-${id}`, `d-${id}`, id);
    db.prepare(
      "INSERT INTO sender_rules(account_id, address_or_domain, action) VALUES(?, 'a.example', 'block')",
    ).run(id);
    db.prepare(
      "INSERT INTO notifications(message_id, state, created_at) VALUES(?, 'pending', 1)",
    ).run(mid('m1'));
    db.prepare(
      "INSERT INTO summaries(thread_id, input_hash, model, text, state, created_at) VALUES(?, 'h', 'm', 't', 'ok', 1)",
    ).run(tid);
    for (const r of ['m1', 'm2'])
      db.prepare('INSERT INTO messages_fts(rowid, subject, people, body) VALUES(?, ?, ?, ?)').run(
        mid(r),
        's',
        'p',
        'b',
      );
    db.prepare(
      'UPDATE messages SET parts = parts | 8 WHERE account_id = ? AND remote_id IN (?, ?)',
    ).run(id, 'm1', 'm2');
  } finally {
    db.close();
  }
}

/** Row counts of every table that belongs to an account or a message, plus the FTS index. */
function counts(file: ReturnType<typeof tempDb>) {
  const db = file.open();
  try {
    const skip = new Set(['changes', 'commits', 'meta', 'schema_migrations', 'file_removals']);
    const tables = db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>()
      .map(t => t.name)
      .filter(
        n =>
          !skip.has(n) && !n.startsWith('sqlite_') && !/^messages_fts_(data|idx|config)$/.test(n),
      );
    return Object.fromEntries(
      tables.map(n => [n, Number(db.prepare(`SELECT count(*) AS c FROM "${n}"`).get()?.c)]),
    );
  } finally {
    db.close();
  }
}

const remove = (store: StorePort, opId: string, accountId = OTHER) =>
  store.commit({ opId, origin: 'local', writes: [{ kind: 'accountRemove', accountId }] });

test('accountRemove deletes only that account, leaves no orphan in any table, and queues its attachment files', () => {
  withStore((store, file) => {
    seed(store, file, ACCOUNT);
    seed(store, file, OTHER);
    const keep = (s: Map<string, string>) =>
      [...s].filter(([k]) => k.includes(`${ACCOUNT}`) && !k.includes(OTHER));
    const before = snapshot(store);
    const since = store.seq();
    const populated = counts(file);
    assert.ok(
      Object.values(populated).filter(n => n > 0).length >= 20,
      'the seed fills the tables',
    );

    const receipt = remove(store, 'rm-1');
    assert.equal(receipt.replayed, false);
    const after = snapshot(store);
    assert.deepEqual(keep(after), keep(before), 'the other account is byte-identical');
    assert.equal(
      [...after.keys()].some(k => k.includes(OTHER)),
      false,
    );
    assert.deepEqual(replay(before, store, since, after), after, 'the change log reproduces it');

    // Same rows as a database that only ever had the first account.
    const ref = tempDb();
    const refStore = openStore(ref.open());
    try {
      seed(refStore, ref, ACCOUNT);
      assert.deepEqual(counts(file), counts(ref), 'no row of the removed account is left anywhere');
    } finally {
      refStore.close();
      ref.cleanup();
    }
    assert.deepEqual(
      store.read(q => q.all<{ path: string }>('SELECT path FROM file_removals').map(r => r.path)),
      [`${OTHER}/a.pdf`],
    );
    store.commit({
      opId: 'gc',
      origin: 'system',
      writes: [{ kind: 'fileRemoved', paths: [`${OTHER}/a.pdf`, 'nope'] }],
    });
    assert.equal(
      store.read(q => q.get('SELECT 1 FROM file_removals')),
      undefined,
    );
  });
});

test('accountRemove is idempotent by opId, and an unknown account is refused with no seq bump and no partial effect', () => {
  withStore((store, file) => {
    seed(store, file, ACCOUNT);
    seed(store, file, OTHER);
    const first = remove(store, 'rm-1');
    const seq = store.seq();
    const state = snapshot(store);
    assert.deepEqual(remove(store, 'rm-1'), { ...first, replayed: true, changed: 0 });
    assert.equal(store.seq(), seq);
    assert.deepEqual(snapshot(store), state);

    assert.throws(
      () =>
        store.commit({
          opId: 'rm-2',
          origin: 'local',
          writes: [
            { kind: 'account', id: ACCOUNT, displayName: 'Changed' },
            { kind: 'accountRemove', accountId: OTHER },
          ],
        }),
      (e: unknown) => e instanceof StoreError && e.code === 'notFound',
    );
    assert.equal(store.seq(), seq, 'the refused commit bumped nothing');
    assert.deepEqual(snapshot(store), state, 'and rolled back its earlier write');
    assert.equal(
      store.read(q => q.get('SELECT 1 FROM commits WHERE op_id = ?', 'rm-2')),
      undefined,
    );
  });
});

test('accountRemove works in the same commit as writes for other accounts and coarse commits', () => {
  withStore((store, file) => {
    seed(store, file, ACCOUNT);
    seed(store, file, OTHER);
    store.commit({
      opId: 'mix',
      origin: 'local',
      changes: 'coarse',
      writes: [
        { kind: 'accountRemove', accountId: OTHER },
        { kind: 'account', id: ACCOUNT, colorTag: 'sage' },
      ],
    });
    assert.equal(row(store)?.color_tag, 'sage');
    assert.equal(row(store, OTHER), undefined);
  });
});

// ---------------------------------------------------------------- migration 0003

test('migration 0003 applies on top of a 0002 database with data, keeps it, and is idempotent', () => {
  const file = tempDb();
  try {
    const old = openStore(file.open(), { migrations: MIGRATIONS.slice(0, 2) });
    old.commit({
      opId: 'a',
      origin: 'sync',
      writes: [{ ...accountWrite, displayName: 'Mine' }, msg('m1', 't1', 0)],
    });
    assert.equal(old.schemaVersion, 2);
    old.close();
    for (let pass = 0; pass < 2; pass++) {
      const store = openStore(file.open());
      assert.equal(store.schemaVersion, 3);
      assert.deepEqual(row(store), {
        color_tag: null,
        notifications: 1,
        settings: '{}',
        address: 'owner@mail.example',
      });
      assert.equal(
        store.read(q => q.get<{ c: number }>('SELECT count(*) AS c FROM messages')?.c),
        1,
      );
      store.close();
    }
  } finally {
    file.cleanup();
  }
});
