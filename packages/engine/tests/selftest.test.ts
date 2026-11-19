import test from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../../../apps/desktop/src/host/sqlite';
import { runSelfTest, versionAtLeast } from '../src/selftest';
import type { SqlDatabase } from '../src/store/sql';

test('self-test passes on this build, reports JSON-safe data and leaves no table behind', () => {
  const db = openSqlite(':memory:');
  try {
    const report = runSelfTest(db);
    assert.equal(report.ok, true, report.failures.join(' '));
    assert.equal(report.sqlite.atLeastMinimum && report.fts5 && report.contentlessDelete, true);
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
    const left = db
      .prepare("SELECT name FROM sqlite_temp_master WHERE name LIKE 'selftest%'")
      .all();
    assert.deepEqual(left, []);
  } finally {
    db.close();
  }
});

test('version compare is numeric per part, not textual', () => {
  assert.equal(versionAtLeast('3.43.0', '3.43.0'), true);
  assert.equal(versionAtLeast('3.50.4', '3.43.0'), true);
  assert.equal(versionAtLeast('3.9.2', '3.43.0'), false);
  assert.equal(versionAtLeast('3.42.9', '3.43.0'), false);
  assert.equal(versionAtLeast('4', '3.43.0'), true);
  assert.equal(versionAtLeast('unknown', '3.43.0'), false);
});

// A real database whose version string lies and whose FTS5 rejects contentless_delete, like a SQLite built before 3.43.
function oldSqliteLyingAboutItsVersion(real: SqlDatabase): SqlDatabase {
  return {
    ...real,
    exec: sql => {
      if (/contentless_delete/.test(sql))
        throw new Error('unrecognized option: "contentless_delete"');
      real.exec(sql);
    },
    prepare: sql =>
      /sqlite_version\(\)/.test(sql) ? real.prepare("SELECT '3.45.0' AS v") : real.prepare(sql),
    close: () => real.close(),
  };
}

test('false pass: a stubbed version string cannot hide a missing contentless_delete', () => {
  const real = openSqlite(':memory:');
  try {
    const report = runSelfTest(oldSqliteLyingAboutItsVersion(real));
    assert.equal(report.sqlite.version, '3.45.0');
    assert.equal(report.sqlite.atLeastMinimum, true, 'the lie passes the version check');
    assert.equal(report.contentlessDelete, false);
    assert.equal(report.ok, false);
    assert.match(report.failures.join(' '), /contentless_delete/);
  } finally {
    real.close();
  }
});

test('false pass: no FTS5 at all fails; an old version fails even when probes work', () => {
  const real = openSqlite(':memory:');
  try {
    const noFts: SqlDatabase = {
      ...real,
      exec: sql => {
        if (/fts5/i.test(sql)) throw new Error('no such module: fts5');
        real.exec(sql);
      },
      prepare: sql => real.prepare(sql),
      close: () => real.close(),
    };
    const report = runSelfTest(noFts);
    assert.deepEqual([report.fts5, report.contentlessDelete, report.ok], [false, false, false]);
    assert.equal(runSelfTest(real, '99.0.0').ok, false);
  } finally {
    real.close();
  }
});
