import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIGRATIONS, openStore } from '../../../../packages/engine/src/store';
import { laneExtensions } from '../../../../packages/engine/src/index';
import { composeEngineHost } from '../../src/host/compose';
import {
  checkAside,
  checkDatabase,
  DAMAGED_DIR,
  deleteLocalCopies,
  LOW_SPACE_REASON,
  LowSpaceError,
  pruneCopies,
  PURGE_MARK,
  purgeAfterRemoval,
  RESTORED_SEND_COPY,
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
import {
  createEngineLink,
  createEngineSupervisor,
  type EngineLink,
  type FromUtility,
  type Timers,
} from '../../src/host/transports/port';
import { runEngineUtility } from '../../src/main/engine-utility';
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

test('a pre-migration backup restores in place of the damaged file; only the newest backup is kept', t => {
  const dir = folder(t);
  const path = seededDb(dir);
  const db = openSqlite(path);
  writeBackup(db, dir, 5);
  writeBackup(db, dir, 6);
  writeBackup(db, dir, 7);
  db.close();
  assert.deepEqual(
    listBackups(dir).map(b => b.name),
    ['mail.db.pre-7'],
  );
  assert.equal(statSync(join(dir, 'mail.db.pre-7')).mode & 0o777, 0o600, 'a backup is 0600');
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
  const said: string[] = [];
  const host = await composeEngineHost({
    ...options,
    onUpgrade: () => void said.push(`upgrading:${listBackups(dir).length}`),
    onUpgraded: () => void said.push(`upgraded:${listBackups(dir).length}`),
  });
  await host.close();
  assert.deepEqual(
    said,
    ['upgrading:0', 'upgraded:1'],
    'upgraded once the backup and migration returned',
  );
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

test('a current database starts without saying it is upgrading', async t => {
  const dir = folder(t);
  seededDb(dir);
  const options = await testOptions(dir, fakeClock(T0))(undefined, {
    request: async () => undefined,
    power: new (await import('node:events')).EventEmitter(),
  });
  const said: string[] = [];
  const host = await composeEngineHost({
    ...options,
    onUpgrade: () => void said.push('upgrading'),
    onUpgraded: () => void said.push('upgraded'),
  });
  await host.close();
  assert.deepEqual(said, []);
});

test('a healthy database starts as before', async t => {
  const dir = folder(t);
  seededDb(dir);
  markOpen(dir);
  assert.deepEqual(await startOn(dir), { ok: true });
  assert.equal(existsSync(join(dir, DAMAGED_DIR)), false);
});

const hash = (path: string) =>
  existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'missing';

/**
 * A crashed engine's folder: `mail.db` with committed rows still only in its write-ahead log (no connection open, as
 * after a kill). Built in `scratch`, then the three files are copied into `dir` while the writer still holds them.
 */
function crashedWithWal(t: TestContext, dir: string): void {
  const scratch = folder(t);
  const path = seededDb(scratch);
  const grow = new DatabaseSync(path);
  const insert = grow.prepare(
    `INSERT INTO drafts(id, account_id, revision, data, updated_at) VALUES(?, 'acct-1', 1, ?, ${T0})`,
  );
  for (let i = 0; i < 300; i++) insert.run(`bulk-${i}`, 'x'.repeat(2000));
  grow.close();
  const writer = new DatabaseSync(path);
  writer.exec('PRAGMA wal_autocheckpoint=0');
  writer.exec(`INSERT INTO drafts(id, account_id, revision, data, updated_at)
    VALUES('in-wal', 'acct-1', 1, '{}', ${T0})`);
  for (const side of ['', '-wal', '-shm']) copyFileSync(path + side, join(dir, 'mail.db' + side));
  writer.close();
  assert.ok(statSync(join(dir, 'mail.db-wal')).size > 0, 'the write-ahead log holds a commit');
}

test('after an unclean exit the file and its write-ahead log are copied as found, then only the copy is read', t => {
  const dir = folder(t);
  crashedWithWal(t, dir);
  const live = join(dir, 'mail.db');
  // Damage pages the log does not cover, far from the schema and the last insert.
  const fd = openSync(live, 'r+');
  writeSync(fd, Buffer.alloc(4096 * 8, 0xa5), 0, 4096 * 8, 4096 * 60);
  closeSync(fd);
  const before = { db: hash(live), wal: hash(`${live}-wal`) };
  const found = checkAside(dir, T0);
  assert.equal(found.ok, false);
  const copy = (found as { copy: string }).copy;
  assert.ok(copy);
  const kept = join(dir, DAMAGED_DIR, copy);
  assert.deepEqual(
    { db: hash(live), wal: hash(`${live}-wal`) },
    before,
    'the live file is untouched',
  );
  assert.deepEqual(
    { db: hash(kept), wal: hash(`${kept}-wal`) },
    before,
    'the copy is the file as found',
  );
  assert.equal(statSync(kept).mode & 0o777, 0o600, 'a damaged copy is 0600');
  // The screen and the report read the copy read-only: it stays the file as found.
  inspectDamaged(dir, copy);
  damagedReport(dir, copy, T0);
  assert.deepEqual({ db: hash(kept), wal: hash(`${kept}-wal`) }, before);
  assert.equal(lastCopy(dir), copy);
  assert.deepEqual(checkAside(dir, T0 + 1000), { ok: false, copy }, 'the same file is copied once');
});

test('a healthy file with a pending write-ahead log passes, unchanged, and leaves no copy behind', t => {
  const dir = folder(t);
  crashedWithWal(t, dir);
  const live = join(dir, 'mail.db');
  const before = { db: hash(live), wal: hash(`${live}-wal`) };
  assert.deepEqual(checkAside(dir, T0), { ok: true });
  assert.deepEqual({ db: hash(live), wal: hash(`${live}-wal`) }, before);
  assert.equal(existsSync(join(dir, DAMAGED_DIR)), false, 'no copy, and no folder, is left');
  // The log was checked too: its commit is readable.
  const db = new DatabaseSync(live, { readOnly: true });
  assert.ok(db.prepare("SELECT 1 FROM drafts WHERE id = 'in-wal'").get());
  db.close();
});

test('a damaged file found when the engine restarts after a crash holds the supervisor on the damaged reason', async t => {
  const dir = folder(t);
  seededDb(dir);
  const utilities: ReturnType<typeof inProcessUtility>[] = [];
  const failed: { reason: unknown; restarted: boolean }[] = [];
  let ups = 0;
  const supervisor = createEngineSupervisor({
    spawn: () => {
      const utility = inProcessUtility({ dir, clock: fakeClock(T0) });
      utilities.push(utility);
      return createEngineLink(
        utility.child,
        { dataDir: dir, appVersion: '0.3.0-test' },
        { hostEvent: () => undefined, request: async () => 'posted' },
        timers,
      );
    },
    noteExit: () => false,
    onUp: () => void ups++,
    onDown: () => undefined,
    onStartFailed: (error, restarted) => {
      const reason = (error as { reason?: unknown }).reason;
      failed.push({ reason, restarted });
      return reason === DAMAGED_REASON;
    },
    timers,
    restartDelayMs: 50,
  });
  t.after(() => supervisor.close());
  await supervisor.start();
  // The engine dies (its open mark stays), and the file is damaged before the restart.
  await utilities[0]!.crash();
  corruptPages(join(dir, 'mail.db'));
  const deadline = Date.now() + 5000;
  while (!failed.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(failed, [{ reason: DAMAGED_REASON, restarted: true }]);
  assert.ok(lastCopy(dir), 'the restart set the damaged file aside');
  await supervisor.restart();
  await new Promise(r => setTimeout(r, 300));
  assert.equal(utilities.length, 2, 'held: no restart loop, and Try again does nothing');
  assert.equal(ups, 1);
});

/** A link that never answers `ready`, saying it is upgrading when `upgrading` is set. */
function silentLink(upgrading: boolean): EngineLink & { killedAt?: number } {
  const exits: (() => void)[] = [];
  let exited = false;
  let fail!: (error: unknown) => void;
  const ready = new Promise<{ dbEpoch: string; seq: number }>((_, reject) => (fail = reject));
  ready.catch(() => undefined);
  const link: EngineLink & { killedAt?: number } = {
    ready,
    get exited() {
      return exited;
    },
    upgrading,
    call: async () => undefined,
    attach: () => undefined,
    detach: () => undefined,
    power: () => undefined,
    quit: () => undefined,
    kill: () => {
      link.killedAt = Date.now();
      exited = true;
      fail(new Error('killed'));
      exits.splice(0).forEach(run => run());
    },
    onExit: run => (exited ? run() : void exits.push(run)),
  };
  return link;
}

test('an engine backing up and migrating gets the longer start timeout', async t => {
  for (const upgrading of [false, true]) {
    const link = silentLink(upgrading);
    const started = Date.now();
    const supervisor = createEngineSupervisor({
      spawn: () => link,
      noteExit: () => false,
      onUp: () => undefined,
      onDown: () => undefined,
      timers,
      readyTimeoutMs: 30,
      upgradeTimeoutMs: 400,
    });
    t.after(() => supervisor.close());
    await assert.rejects(supervisor.start());
    const took = (link.killedAt ?? 0) - started;
    if (upgrading) assert.ok(took >= 400, `upgrading: killed after ${took} ms`);
    else assert.ok(took < 400, `plain start: killed after ${took} ms`);
  }
});

/** A link that never answers `ready` and reports `upgrading` / `upgraded` through `onUpgrading`, as the real one does. */
function reportingLink(): EngineLink & { killedAt?: number; say(on: boolean): void } {
  const listeners: ((on: boolean) => void)[] = [];
  let upgrading = false;
  const link = Object.assign(silentLink(false), {
    onUpgrading: (listener: (on: boolean) => void) => void listeners.push(listener),
    say(on: boolean) {
      upgrading = on;
      for (const listener of listeners) listener(on);
    },
  });
  Object.defineProperty(link, 'upgrading', { get: () => upgrading });
  return link;
}

test('once the migration returns, the plain start timeout applies again', async t => {
  const link = reportingLink();
  const said: boolean[] = [];
  const supervisor = createEngineSupervisor({
    spawn: () => link,
    noteExit: () => false,
    onUp: () => undefined,
    onDown: () => undefined,
    onUpgrading: on => void said.push(on),
    timers,
    readyTimeoutMs: 60,
    upgradeTimeoutMs: 5000,
  });
  t.after(() => supervisor.close());
  const started = supervisor.start();
  link.say(true);
  await new Promise(r => setTimeout(r, 150));
  assert.equal(link.killedAt, undefined, 'upgrading: the long timeout applies');
  const back = Date.now();
  link.say(false);
  await assert.rejects(started);
  const took = (link.killedAt ?? Infinity) - back;
  assert.ok(took >= 50 && took < 1000, `after the migration: killed ${took} ms later`);
  assert.deepEqual(said, [true, false], 'main heard both, to tell its windows');
});

test('the engine link reports upgrading and upgraded from the utility', () => {
  let handler: ((message: unknown) => void) | undefined;
  const child = {
    post: () => undefined,
    onMessage: (h: (message: unknown) => void) => void (handler = h),
    onExit: () => undefined,
    kill: () => undefined,
  };
  const link = createEngineLink(
    child as never,
    { dataDir: '/nowhere', appVersion: '0.3.0-test' },
    { hostEvent: () => undefined, request: async () => 'posted' },
    timers,
  );
  const heard: boolean[] = [];
  link.onUpgrading?.(on => void heard.push(on));
  handler!({ kind: 'upgrading' } satisfies FromUtility);
  assert.equal(link.upgrading, true);
  handler!({ kind: 'upgraded' } satisfies FromUtility);
  assert.equal(link.upgrading, false);
  assert.deepEqual(heard, [true, false]);
});

test('too little free space stops the update before anything changes, with how much is needed', async t => {
  const dir = folder(t);
  const path = seededDb(dir, MIGRATIONS.slice(0, 6));
  const base = testOptions(dir, fakeClock(T0));
  const bridge = {
    request: async () => undefined,
    power: new (await import('node:events')).EventEmitter(),
  };
  const options = { ...(await base(undefined, bridge)), freeBytes: () => 1000 };
  await assert.rejects(composeEngineHost(options), (error: unknown) => {
    assert.ok(error instanceof LowSpaceError);
    assert.match(error.message, /^Aplos needs about \d+\.\d GB free to update safely\./);
    return true;
  });
  assert.deepEqual(listBackups(dir), [], 'no backup was started');
  const db = new DatabaseSync(path, { readOnly: true });
  assert.equal(
    (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    6,
  );
  db.close();

  // The engine process says so to main in those words, with its own reason, not "could not start".
  const posted: FromUtility[] = [];
  let send!: (data: unknown, ports: readonly unknown[]) => void;
  runEngineUtility(
    { post: message => void posted.push(message), onMessage: handler => void (send = handler) },
    {
      options: async (init, b) => ({ ...(await base(init, b)), freeBytes: () => 1000 }),
      wrapPort: () => {
        throw new Error('no ports in this test');
      },
      exit: () => undefined,
      now: () => T0,
    },
  );
  send({ kind: 'init', init: { dataDir: dir, appVersion: '0.3.0-test' } }, []);
  const deadline = Date.now() + 5000;
  while (!posted.some(m => m.kind === 'failed') && Date.now() < deadline)
    await new Promise(r => setTimeout(r, 10));
  const failed = posted.find(m => m.kind === 'failed') as Extract<FromUtility, { kind: 'failed' }>;
  assert.equal(failed.reason, LOW_SPACE_REASON);
  assert.match(failed.message, /Aplos needs about .* GB free to update safely/);
  assert.ok(
    posted.some(m => m.kind === 'upgrading'),
    'main was told an upgrade began',
  );
  await new Promise(r => setTimeout(r, 2100)); // the process's own delayed exit
});

test('restoring a backup suspends its waiting sends for review in the Outbox', t => {
  const dir = folder(t);
  const path = seededDb(dir);
  const seed = new DatabaseSync(path);
  seed.exec(`INSERT INTO submissions(id, draft_id, account_id, internet_id, not_before, state)
    VALUES('s2', 'd1', 'acct-1', '<s2@mail.example>', ${T0}, 'queued'),
          ('s3', 'd1', 'acct-1', '<s3@mail.example>', ${T0}, 'sent')`);
  seed.close();
  const db = openSqlite(path);
  writeBackup(db, dir, 7);
  db.close();
  corruptPages(path);
  setAside(dir, T0);
  assert.deepEqual(restoreBackup(dir, 'mail.db.pre-7', T0 + 5), { suspended: 2, dropped: 1 });
  const restored = new DatabaseSync(path, { readOnly: true });
  const rows = restored.prepare('SELECT id, state, error FROM submissions ORDER BY id').all() as {
    id: string;
    state: string;
    error: string;
  }[];
  restored.close();
  assert.deepEqual(
    rows.map(r => [r.id, r.state]),
    [
      ['s1', 'suspended'],
      ['s2', 'suspended'],
      ['s3', 'sent'],
    ],
  );
  assert.deepEqual(JSON.parse(rows[0]!.error).problem, {
    reasonCode: 'send.overdue',
    message: RESTORED_SEND_COPY,
    at: T0 + 5,
  });
  assert.equal(existsSync(`${path}.restoring`), false);
});

test('restoring a backup drops the changes still waiting in it, so it never undoes newer ones', t => {
  const dir = folder(t);
  const path = seededDb(dir); // op1: an archive still queued
  const seed = new DatabaseSync(path);
  seed.exec(`INSERT INTO ops(op_id, account_id, kind, target, payload, state, created_seq, scope)
    VALUES('op2', 'acct-1', 'markRead', '[]', '{}', 'inflight', 2, 'triage'),
          ('op3', 'acct-1', 'archive', '[]', '{}', 'failed', 3, 'triage')`);
  seed.close();
  const db = openSqlite(path);
  writeBackup(db, dir, 7);
  db.close();
  corruptPages(path);
  setAside(dir, T0);
  assert.deepEqual(restoreBackup(dir, 'mail.db.pre-7', T0 + 5), { suspended: 1, dropped: 2 });
  const restored = new DatabaseSync(path, { readOnly: true });
  const ops = restored.prepare('SELECT op_id, state FROM ops ORDER BY op_id').all();
  const sends = restored.prepare('SELECT id, state FROM submissions').all();
  restored.close();
  // A failed change never goes out on its own: it stays for Retry, as it was.
  assert.deepEqual(
    ops.map(o => [o.op_id, o.state]),
    [['op3', 'failed']],
  );
  assert.deepEqual(
    sends.map(r => [r.id, r.state]),
    [['s1', 'suspended']],
    'waiting sends are still paused',
  );
  // The backup itself is unchanged: only the restored copy loses them.
  const backup = new DatabaseSync(join(dir, 'mail.db.pre-7'), { readOnly: true });
  assert.equal(backup.prepare('SELECT count(*) AS n FROM ops').get()?.n, 3);
  backup.close();
});

test('after a healthy start, backups go after 14 days (only the newest stays) and damaged copies after 30', t => {
  const dir = folder(t);
  const day = 86_400_000;
  const now = T0 + 100 * day;
  const backup = (name: string, ageDays: number) => {
    writeFileSync(join(dir, name), 'x');
    const at = (now - ageDays * day) / 1000;
    utimesSync(join(dir, name), at, at);
  };
  backup('mail.db.pre-7', 2);
  backup('mail.db.pre-6', 3);
  const damagedDir = join(dir, DAMAGED_DIR);
  mkdirSync(damagedDir);
  const copyName = (ageDays: number) =>
    `mail-${new Date(now - ageDays * day).toISOString().replace(/[:.]/g, '-')}.db`;
  const old = copyName(31);
  const recent = copyName(29);
  for (const name of [old, `${old}-wal`, recent]) writeFileSync(join(damagedDir, name), 'x');
  writeFileSync(join(damagedDir, 'last.json'), JSON.stringify({ name: old, stamp: '-' }));
  pruneCopies(dir, now);
  assert.deepEqual(
    listBackups(dir).map(b => b.name),
    ['mail.db.pre-7'],
    'only the newest backup stays',
  );
  assert.deepEqual(readdirSync(damagedDir), [recent], 'old copies and their record go');
  // Once the newest backup is 14 days old it goes too.
  pruneCopies(dir, now + 13 * day);
  assert.deepEqual(
    listBackups(dir).map(b => b.name),
    [],
  );
});

test('a healthy start prunes old copies; a start parked on a damaged file keeps them', async t => {
  const dir = folder(t);
  const path = seededDb(dir);
  const db = openSqlite(path);
  writeBackup(db, dir, 7);
  db.close();
  const stale = (Date.now() - 20 * 86_400_000) / 1000;
  utimesSync(join(dir, 'mail.db.pre-7'), stale, stale);
  corruptHeader(path);
  assert.deepEqual(await startOn(dir), { ok: false, reason: DAMAGED_REASON });
  assert.deepEqual(
    listBackups(dir).map(b => b.name),
    ['mail.db.pre-7'],
    'parked: Restore still has it',
  );
  rebuildDatabase(dir);
  assert.deepEqual(await startOn(dir), { ok: true });
  assert.deepEqual(listBackups(dir), [], 'a healthy start removed the 20-day-old backup');
});

test('deleteLocalCopies removes every backup and damaged copy and leaves the live database', t => {
  const dir = folder(t);
  const path = seededDb(dir);
  const db = openSqlite(path);
  writeBackup(db, dir, 7);
  db.close();
  corruptPages(path);
  setAside(dir, T0);
  deleteLocalCopies(dir);
  assert.deepEqual(listBackups(dir), []);
  assert.equal(existsSync(join(dir, DAMAGED_DIR)), false);
  assert.ok(existsSync(path), 'the live database is not touched');
});

/** A backup and a damaged copy in `dir`, as a migration and a parked start would leave them. */
function leaveCopies(dir: string) {
  writeFileSync(join(dir, 'mail.db.pre-6'), 'backup', { mode: 0o600 });
  mkdirSync(join(dir, DAMAGED_DIR), { recursive: true });
  writeFileSync(join(dir, DAMAGED_DIR, 'mail-2026-11-01T00-00-00-000Z.db'), 'copy');
}

test('removing an account on the desktop host deletes every backup and damaged copy after its rows are gone', async t => {
  const dir = folder(t);
  const path = join(dir, 'mail.db');
  openStore(openSqlite(path), { extensions: laneExtensions(), now: () => T0 }).close();
  const db = new DatabaseSync(path);
  db.exec(`INSERT INTO accounts(id, provider, address, capabilities, status, created_at, updated_at)
    VALUES('acct-1', 'google', 'owner@mail.example', '{}', '{"state":"ok"}', ${T0}, ${T0})`);
  db.close();
  const options = await testOptions(dir, fakeClock(T0))(undefined, {
    request: async () => undefined,
    power: new (await import('node:events')).EventEmitter(),
  });
  const host = await composeEngineHost(options);
  t.after(() => host.close());
  leaveCopies(dir);
  const { handlers } = await import('../../../../packages/engine/src/methods/account');
  const ctx = {
    caller: { kind: 'window', scopes: ['admin'] },
    signal: new AbortController().signal,
    services: host.engine.services,
    connectionId: 'c1',
  } as never;
  await handlers['Account/disconnect']({ opId: 'rm-1', accountId: 'acct-1' }, ctx);
  const rows = host.engine.services.store.read(q => q.all('SELECT id FROM accounts'));
  assert.deepEqual(rows, []);
  assert.deepEqual(listBackups(dir), [], 'the backup that held the account is gone');
  assert.equal(existsSync(join(dir, DAMAGED_DIR)), false, 'so is the damaged copy');
  assert.equal(existsSync(join(dir, PURGE_MARK)), false, 'nothing is left to finish');
  assert.ok(existsSync(path), 'the live database stays');
});

test('a purge after a removal that could not finish is finished at the next start, before anything reads a copy', async t => {
  const dir = folder(t);
  seededDb(dir);
  leaveCopies(dir);
  writeFileSync(join(dir, PURGE_MARK), '');
  assert.deepEqual(await startOn(dir), { ok: true });
  assert.deepEqual(listBackups(dir), []);
  assert.equal(existsSync(join(dir, DAMAGED_DIR)), false);
  assert.equal(existsSync(join(dir, PURGE_MARK)), false);
});

test('a purge that fails keeps its mark for the next start; one that works removes it', t => {
  const dir = folder(t);
  // A file where the damaged folder should be, inside a read-only folder: the delete fails.
  const locked = join(dir, 'locked');
  mkdirSync(join(locked, DAMAGED_DIR), { recursive: true });
  writeFileSync(join(locked, PURGE_MARK), '');
  chmodSync(locked, 0o500);
  try {
    assert.equal(purgeAfterRemoval(locked), false);
  } finally {
    chmodSync(locked, 0o700);
  }
  assert.ok(existsSync(join(locked, PURGE_MARK)), 'the next start tries again');
  assert.equal(purgeAfterRemoval(locked), true);
  assert.equal(existsSync(join(locked, PURGE_MARK)), false);
});
