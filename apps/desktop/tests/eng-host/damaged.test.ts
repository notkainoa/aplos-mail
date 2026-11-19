import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, openStore } from '../../../../packages/engine/src/store';
import { laneExtensions } from '../../../../packages/engine/src/index';
import { composeEngineHost } from '../../src/host/compose';
import {
  checkDatabase,
  DAMAGED_DIR,
  DAMAGED_REASON,
  damagedReport,
  inspectDamaged,
  isCorruptError,
  lastCopy,
  listBackups,
  markOpen,
  needsCheck,
  OPEN_MARK,
  rebuildDatabase,
  restoreBackup,
  setAside,
  writeBackup,
} from '../../src/host/damaged';
import { openSqlite } from '../../src/host/sqlite';
import { createEngineLink, type Timers } from '../../src/host/transports/port';
import { fakeClock, inProcessUtility, T0, testOptions } from '../eng-contract/rig';

// The damaged-database path (plan 10 Decision 6): a deliberately corrupted temp `mail.db` parks the engine, the file is
// copied aside, and the screen's facts, report, Restore and Rebuild work from there. Test data only.

const timers: Timers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: handle => clearTimeout(handle as NodeJS.Timeout),
};

function folder(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'aplos-damaged-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A current-schema `mail.db` holding one of each thing only this Mac has: a draft, a scheduled send, a Done, a change. */
function seededDb(dir: string, migrations = MIGRATIONS): string {
  const path = join(dir, 'mail.db');
  const store = openStore(openSqlite(path), {
    migrations,
    extensions: laneExtensions(),
    now: () => T0,
  });
  store.close();
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=OFF');
  db.exec(`INSERT INTO accounts(id, provider, address, capabilities, status, created_at, updated_at)
    VALUES('acct-1', 'google', 'owner@mail.example', '{}', '{"state":"ok"}', ${T0}, ${T0})`);
  const draft = JSON.stringify({
    to: [{ address: 'friend@mail.example', name: 'A Friend' }],
    subject: 'Dinner plans',
    html: '<p>Shall we meet on Friday?</p><p>See you &amp; soon</p>',
  });
  db.prepare(
    `INSERT INTO drafts(id, account_id, revision, data, updated_at) VALUES('d1', 'acct-1', 3, ?, ${T0})`,
  ).run(draft);
  db.exec(`INSERT INTO drafts(id, account_id, revision, data, synced_revision, remote_draft_id, updated_at)
    VALUES('d2', 'acct-1', 2, '{}', 2, 'r-d2', ${T0})`);
  db.exec(`INSERT INTO submissions(id, draft_id, account_id, internet_id, not_before, state)
    VALUES('s1', 'd1', 'acct-1', '<s1@mail.example>', ${T0 + 3_600_000}, 'scheduled')`);
  db.exec(`INSERT INTO threads(id, account_id, remote_id, subject, last_date, msg_count, unread_count, flagged, has_attach, rev)
    VALUES(1, 'acct-1', 't1', 'Quarterly numbers', ${T0}, 1, 0, 0, 0, 1)`);
  db.exec(`INSERT INTO thread_workflow(thread_id, account_id, sync_key, status, last_date)
    VALUES(1, 'acct-1', 't1', 'done', ${T0})`);
  db.exec(`INSERT INTO ops(op_id, account_id, kind, target, payload, state, created_seq, scope)
    VALUES('op1', 'acct-1', 'archive', '[]', '{}', 'queued', 1, 'triage')`);
  db.close();
  return path;
}

/** Overwrites pages in the middle of the file with garbage: SQLite's own check finds it. */
function corruptPages(path: string) {
  const fd = openSync(path, 'r+');
  try {
    writeSync(fd, Buffer.alloc(4096 * 6, 0xa5), 0, 4096 * 6, 4096 * 2);
  } finally {
    closeSync(fd);
  }
}

/** Overwrites the header: SQLite no longer knows the file as a database (SQLITE_NOTADB). */
function corruptHeader(path: string) {
  const fd = openSync(path, 'r+');
  try {
    writeSync(fd, Buffer.alloc(100, 0x41), 0, 100, 0);
  } finally {
    closeSync(fd);
  }
}

test('a healthy file passes the check; a file with damaged pages fails it', t => {
  const dir = folder(t);
  const path = seededDb(dir);
  assert.deepEqual(checkDatabase(path), { ok: true });
  assert.deepEqual(checkDatabase(join(dir, 'missing.db')), { ok: true }, 'a fresh start is fine');
  corruptPages(path);
  assert.equal(checkDatabase(path).ok, false);
  corruptHeader(path);
  assert.equal(checkDatabase(path).ok, false);
});

test('SQLITE_CORRUPT and SQLITE_NOTADB are recognised from node:sqlite errors', t => {
  const dir = folder(t);
  const path = seededDb(dir);
  corruptHeader(path);
  let caught: unknown;
  try {
    const db = new DatabaseSync(path);
    db.prepare('SELECT count(*) FROM drafts').get();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'reading the damaged file throws');
  assert.ok(isCorruptError(caught));
  assert.equal(isCorruptError(new Error('disk I/O error')), false);
});

test('the damaged file is copied aside once, and the original is left where it is', t => {
  const dir = folder(t);
  const path = seededDb(dir);
  corruptPages(path);
  const first = setAside(dir, T0);
  assert.equal(setAside(dir, T0 + 60_000), first, 'the same damaged file is not copied twice');
  assert.equal(lastCopy(dir), first);
  assert.ok(existsSync(join(dir, DAMAGED_DIR, first)));
  assert.ok(existsSync(path), 'nothing is deleted');
});

test('the screen lists what exists only on this Mac, read from the copy', t => {
  const dir = folder(t);
  seededDb(dir);
  const copy = setAside(dir, T0);
  const facts = inspectDamaged(dir, copy);
  assert.deepEqual(facts.localOnly, { drafts: 1, scheduled: 1, workflow: 1, changes: 1 });
  assert.deepEqual(facts.backups, []);
  // A copy SQLite cannot read at all says so, field by field.
  corruptHeader(join(dir, DAMAGED_DIR, copy));
  assert.deepEqual(inspectDamaged(dir, copy).localOnly, {
    drafts: null,
    scheduled: null,
    workflow: null,
    changes: null,
  });
});

test('the report keeps the words of drafts and scheduled sends, and the Done choices', t => {
  const dir = folder(t);
  seededDb(dir);
  const copy = setAside(dir, T0);
  const report = damagedReport(dir, copy, T0);
  assert.match(report, /Drafts not yet saved to Google: 1/);
  assert.match(report, /To: A Friend <friend@mail\.example>/);
  assert.match(report, /Subject: Dinner plans/);
  assert.match(report, /Shall we meet on Friday\?\nSee you & soon/);
  assert.match(report, /Scheduled sends\n-+\nSend at: /);
  assert.match(report, /Quarterly numbers: Done/);
  assert.ok(report.includes(`${DAMAGED_DIR}/${copy}`));
  assert.doesNotMatch(report, /<p>/, 'plain text, no markup');
});

test('a pre-migration backup restores in place of the damaged file; old backups are pruned', t => {
  const dir = folder(t);
  const path = seededDb(dir);
  const db = openSqlite(path);
  writeBackup(db, dir, 5);
  writeBackup(db, dir, 6);
  writeBackup(db, dir, 7);
  db.close();
  assert.deepEqual(
    listBackups(dir).map(b => b.name),
    ['mail.db.pre-7', 'mail.db.pre-6'],
  );
  corruptPages(path);
  setAside(dir, T0);
  markOpen(dir);
  assert.throws(() => restoreBackup(dir, '../mail.db'), /not on this Mac/);
  restoreBackup(dir, 'mail.db.pre-7');
  assert.deepEqual(checkDatabase(path), { ok: true });
  assert.equal(needsCheck(dir), false);
  const restored = new DatabaseSync(path);
  assert.equal((restored.prepare('SELECT count(*) AS n FROM drafts').get() as { n: number }).n, 2);
  restored.close();
});

test('a backup that is damaged too is refused', t => {
  const dir = folder(t);
  const path = seededDb(dir);
  const db = openSqlite(path);
  writeBackup(db, dir, 7);
  db.close();
  corruptPages(join(dir, 'mail.db.pre-7'));
  assert.throws(() => restoreBackup(dir, 'mail.db.pre-7'), /damaged too/);
});

test('Rebuild removes the damaged file and keeps its copy', t => {
  const dir = folder(t);
  const path = seededDb(dir);
  corruptPages(path);
  const copy = setAside(dir, T0);
  markOpen(dir);
  rebuildDatabase(dir);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(join(dir, OPEN_MARK)), false);
  assert.ok(existsSync(join(dir, DAMAGED_DIR, copy)));
});

test('opening an older database writes mail.db.pre-<from> before it migrates', async t => {
  const dir = folder(t);
  seededDb(dir, MIGRATIONS.slice(0, 6));
  const options = await testOptions(dir, fakeClock(T0))(undefined, {
    request: async () => undefined,
    power: new (await import('node:events')).EventEmitter(),
  });
  const host = await composeEngineHost(options);
  await host.close();
  assert.deepEqual(
    listBackups(dir).map(b => [b.name, b.schema]),
    [['mail.db.pre-6', 6]],
  );
  assert.deepEqual(checkDatabase(join(dir, 'mail.db.pre-6')), { ok: true });
});

/** Starts the engine "process" on `dir` and returns how its start ended. */
async function startOn(dir: string): Promise<{ ok: true } | { ok: false; reason?: unknown }> {
  const utility = inProcessUtility({ dir, clock: fakeClock(T0) });
  const link = createEngineLink(
    utility.child,
    { dataDir: dir, appVersion: '0.3.0-test' },
    { hostEvent: () => undefined, request: async () => 'posted' },
    timers,
  );
  try {
    await link.ready;
    await utility.crash();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: (error as { reason?: unknown }).reason };
  }
}

test('after an unclean exit, damaged pages park the engine with the damaged reason and a copy aside', async t => {
  const dir = folder(t);
  const path = seededDb(dir);
  corruptPages(path);
  markOpen(dir); // the last engine did not close the file
  assert.deepEqual(await startOn(dir), { ok: false, reason: DAMAGED_REASON });
  assert.equal(readdirSync(join(dir, DAMAGED_DIR)).filter(n => n.endsWith('.db')).length, 1);
  assert.ok(existsSync(path), 'the engine never rebuilds on its own');
});

test('a file SQLite cannot read parks at open even after a clean exit', async t => {
  const dir = folder(t);
  const path = seededDb(dir);
  corruptHeader(path);
  assert.equal(needsCheck(dir), false);
  assert.deepEqual(await startOn(dir), { ok: false, reason: DAMAGED_REASON });
  assert.ok(lastCopy(dir));
  assert.ok(existsSync(path));
});

test('a healthy database starts as before', async t => {
  const dir = folder(t);
  seededDb(dir);
  markOpen(dir);
  assert.deepEqual(await startOn(dir), { ok: true });
  assert.equal(existsSync(join(dir, DAMAGED_DIR)), false);
});
