import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../../../../apps/desktop/src/host/sqlite';
import { MIGRATIONS, MigrationError, openStore, SchemaTooNewError } from '../../src/store';
import { migrate } from '../../src/store/migrate';
import { accountWrite, tempDb, withStore } from './helpers';

const TABLES = [
  'meta',
  'changes',
  'commits',
  'accounts',
  'folders',
  'threads',
  'messages',
  'message_folders',
  'thread_folders',
  'bodies',
  'attachments',
  'messages_fts',
  'correspondents',
  'thread_workflow',
  'summaries',
  'sender_rules',
  'conversations',
  'settings',
  'ops',
  'drafts',
  'submissions',
  'jobs',
  'notifications',
  'sync_state',
  'sync_failures',
  'governor_state',
  'provider_memory',
  'ai_usage',
  'consent',
  'calendars',
  'events',
  'event_hidden',
  'clients',
  'audit_log',
  'schema_migrations',
];

test('a new mail.db migrates from empty with the ARCH 3.7 pragmas, STRICT tables and a stamped epoch', () => {
  const file = tempDb();
  try {
    const db = file.open();
    const store = openStore(db);
    assert.equal(store.schemaVersion, MIGRATIONS.length);
    assert.equal(store.seq(), 0);
    assert.match(
      store.dbEpoch,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    const names = new Set(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all()
        .map(r => r.name),
    );
    for (const t of TABLES) assert.ok(names.has(t), `table ${t}`);
    const pragma = (p: string) => Object.values(db.prepare(`PRAGMA ${p}`).get()!)[0];
    assert.equal(pragma('journal_mode'), 'wal');
    assert.equal(pragma('synchronous'), 1);
    assert.equal(pragma('foreign_keys'), 1);
    assert.equal(
      pragma('auto_vacuum'),
      2,
      'INCREMENTAL, which cannot be added later without VACUUM',
    );
    assert.equal(pragma('busy_timeout'), 5000);
    assert.equal(pragma('user_version'), MIGRATIONS.length);
    const strict = db
      .prepare(
        "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND strict = 0 AND name NOT LIKE 'messages_fts%' AND name NOT LIKE 'sqlite_%'",
      )
      .all();
    assert.deepEqual(strict, [], 'every table is STRICT');
    assert.throws(
      () => db.prepare("INSERT INTO consent(scope, version) VALUES('ai', 'one')").run(),
      /cannot store TEXT value in INTEGER column/,
    );
    const history = db.prepare('SELECT version, name, checksum FROM schema_migrations').all();
    assert.deepEqual(
      history.map(h => h.name),
      MIGRATIONS.map(m => m.name),
    );
    store.close();

    // Reopening is a no-op and keeps the epoch: a restart never forces windows to re-snapshot (ARCH 3.5).
    const again = openStore(file.open());
    assert.equal(again.dbEpoch, store.dbEpoch);
    again.close();
  } finally {
    file.cleanup();
  }
});

test('a database from a newer engine is refused with the UI sentence and left untouched', () => {
  const file = tempDb();
  try {
    const db = file.open();
    db.exec('PRAGMA user_version=99');
    assert.throws(
      () => openStore(db),
      (error: unknown) =>
        error instanceof SchemaTooNewError &&
        error.found === 99 &&
        error.supported === MIGRATIONS.length &&
        error.message ===
          'This mailbox was saved by a newer version of Aplos Mail. Update the app to open it.',
    );
    assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 99, 'never downgraded');
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM sqlite_schema').get()!.n,
      0,
      'nothing created',
    );
    db.close();
  } finally {
    file.cleanup();
  }
});

test('a failing migration rolls back whole and an edited shipped migration is caught', () => {
  const file = tempDb();
  try {
    const db = file.open();
    const top = MIGRATIONS.length,
      next1 = top + 1;
    const broken = [
      ...MIGRATIONS,
      {
        version: next1,
        name: 'broken',
        sql: 'CREATE TABLE half(a INTEGER) STRICT; INSERT INTO nowhere VALUES(1);',
      },
    ];
    assert.throws(
      () => migrate(db, broken),
      (e: unknown) => e instanceof MigrationError && e.version === next1,
    );
    assert.equal(
      db.prepare('PRAGMA user_version').get()!.user_version,
      top,
      'still at the shipped version',
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'half'").get()!.n,
      0,
      'no half-applied table',
    );

    let upgradedFrom = -1;
    const next = [
      ...MIGRATIONS,
      { version: next1, name: 'extra', sql: 'CREATE TABLE extra(a INTEGER) STRICT;' },
    ];
    assert.deepEqual(
      migrate(db, next, {
        beforeUpgrade: from => {
          upgradedFrom = from;
        },
      }).applied,
      [next1],
    );
    assert.equal(upgradedFrom, top, 'the host gets its chance to copy mail.db.pre-<from>');

    const edited = [...MIGRATIONS, { ...next[top], sql: next[top].sql + ' -- edited' }];
    assert.throws(() => migrate(db, edited), /was edited after it shipped/);
    db.close();
  } finally {
    file.cleanup();
  }
});

test('the host adapter carries BLOBs as Uint8Array and streams rows with iterate()', () => {
  const db = openSqlite(':memory:');
  db.exec('CREATE TABLE b(id INTEGER PRIMARY KEY, data BLOB NOT NULL) STRICT');
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  db.prepare('INSERT INTO b(id, data) VALUES(?, ?)').run(1, bytes);
  db.prepare('INSERT INTO b(id, data) VALUES(?, ?)').run(2, new Uint8Array(0));
  const back = db.prepare('SELECT data FROM b WHERE id = 1').get()!.data;
  assert.ok(back instanceof Uint8Array);
  assert.deepEqual([...back], [...bytes]);
  assert.deepEqual(
    [...db.prepare('SELECT id FROM b ORDER BY id').iterate()].map(r => r.id),
    [1, 2],
  );
  db.close();
});

test("this runtime's SQLite is 3.43 or later and FTS5 contentless_delete works", t => {
  const db = openSqlite(':memory:');
  const version = String(db.prepare('SELECT sqlite_version() AS v').get()!.v);
  t.diagnostic(`sqlite_version() = ${version}`);
  const [major, minor] = version.split('.').map(Number);
  assert.ok(
    major > 3 || (major === 3 && minor >= 43),
    `SQLite ${version} lacks contentless_delete`,
  );
  openStore(db);
  const add = db.prepare(
    'INSERT INTO messages_fts(rowid, subject, people, body) VALUES(?, ?, ?, ?)',
  );
  add.run(7, 'Quarterly invoice', 'Ana Example', 'Please find the invoice attached');
  add.run(8, 'Lunch', 'Bo Example', 'Café on Friday?');
  const hits = (q: string) =>
    db
      .prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rowid DESC')
      .all(q)
      .map(r => r.rowid);
  assert.deepEqual(hits('invoice'), [7]);
  assert.deepEqual(hits('cafe'), [8], 'remove_diacritics folds é');
  db.prepare('DELETE FROM messages_fts WHERE rowid = ?').run(7);
  assert.deepEqual(hits('invoice'), [], 'deleted by rowid from a contentless table');
  assert.deepEqual(hits('lunch'), [8]);
  db.close();
});

test('correspondents are per account: one address in two accounts, purged with its account (R2G-3)', () => {
  withStore((store, file) => {
    store.commit({
      opId: 'accounts',
      origin: 'sync',
      writes: [accountWrite, { ...accountWrite, id: 'acct-2', address: 'other@mail.example' }],
    });
    const db = file.open();
    try {
      const add = db.prepare(
        'INSERT INTO correspondents(account_id, address, name, sent_to, received_from) VALUES(?, ?, ?, ?, ?)',
      );
      add.run('acct-1', 'friend@mail.example', 'Friend', 3, 1);
      add.run('acct-2', 'friend@mail.example', 'Friend', 1, 4);
      add.run('acct-2', 'shop@mail.example', null, 0, 9);
      // Contact/suggest with an accountId reads that account's rows; without one it sums them per address.
      const total = db
        .prepare(
          `SELECT sum(sent_to) AS sent, sum(received_from) AS received FROM correspondents WHERE address = ?`,
        )
        .get('friend@mail.example');
      assert.deepEqual({ ...total }, { sent: 4, received: 5 });
      assert.throws(() => add.run('acct-9', 'x@mail.example', null, 0, 0), /FOREIGN KEY/);
      // Account/disconnect deletes the account row; its correspondents go with it.
      db.prepare("DELETE FROM accounts WHERE id = 'acct-2'").run();
      const left = db
        .prepare('SELECT account_id AS a, address FROM correspondents ORDER BY a, address')
        .all()
        .map(r => `${r.a} ${r.address}`);
      assert.deepEqual(left, ['acct-1 friend@mail.example']);
    } finally {
      db.close();
    }
  });
});

test('v6 to v7 keeps existing threads and creates plans with the claim columns', () => {
  const file = tempDb();
  try {
    const db = file.open();
    migrate(db, MIGRATIONS.slice(0, 6));
    db.prepare(
      `INSERT INTO accounts(id, provider, address, capabilities, status, created_at, updated_at)
       VALUES('acct-1', 'google', 'a@b.c', '{}', 'ok', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO threads(account_id, remote_id, last_date, msg_count, unread_count, flagged, has_attach, rev)
       VALUES('acct-1', 'T-1', 100, 1, 0, 0, 0, 1)`,
    ).run();
    db.close();

    const db2 = file.open();
    const applied = migrate(db2, MIGRATIONS);
    assert.equal(applied.applied[applied.applied.length - 1], 7);
    assert.equal(
      db2.prepare("SELECT count(*) AS n FROM threads WHERE remote_id = 'T-1'").get()!.n,
      1,
      'the existing thread survives',
    );
    const cols = db2
      .prepare('PRAGMA table_info(plans)')
      .all()!
      .map(c => c.name);
    for (const c of ['op_id', 'calendar_id', 'input_hash', 'state'])
      assert.ok(cols.includes(c), `plans.${c} exists`);
    db2.close();
  } finally {
    file.cleanup();
  }
});
