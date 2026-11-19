import type { SqlDatabase } from './store/sql';

/** The SQLite the engine needs: `contentless_delete` arrived in 3.43 (ARCH 3.1, plan 10 E1 item 5). */
export const MIN_SQLITE = '3.43.0';

export interface SelfTestReport {
  ok: boolean;
  sqlite: { version: string; atLeastMinimum: boolean };
  fts5: boolean;
  contentlessDelete: boolean;
  /** One short sentence per failed assertion; never database content. */
  failures: string[];
}

/** Compares dotted versions numerically (`3.9` is below `3.43`); a part that is not a number counts as 0. */
export function versionAtLeast(version: string, minimum: string): boolean {
  const have = version.split('.').map(part => Number.parseInt(part, 10) || 0);
  const need = minimum.split('.').map(part => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(have.length, need.length); i++) {
    const delta = (have[i] ?? 0) - (need[i] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return true;
}

function attempt(run: () => boolean): boolean {
  try {
    return run();
  } catch {
    return false;
  }
}

/** A plain FTS5 table can be created and matched. */
function probeFts5(db: SqlDatabase): boolean {
  db.exec('CREATE VIRTUAL TABLE temp.selftest_fts USING fts5(body)');
  try {
    db.prepare('INSERT INTO selftest_fts(rowid, body) VALUES (1, ?)').run('alpha beta');
    return (
      db.prepare('SELECT rowid FROM selftest_fts WHERE selftest_fts MATCH ?').get('alpha') != null
    );
  } finally {
    db.exec('DROP TABLE temp.selftest_fts');
  }
}

/** The index shape the store uses: contentless, and a row can be deleted (the version string alone proves neither). */
function probeContentlessDelete(db: SqlDatabase): boolean {
  db.exec(
    `CREATE VIRTUAL TABLE temp.selftest_cd USING fts5(body, content='', contentless_delete=1)`,
  );
  try {
    db.prepare('INSERT INTO selftest_cd(rowid, body) VALUES (1, ?)').run('alpha beta');
    db.prepare('DELETE FROM selftest_cd WHERE rowid = ?').run(1);
    return (
      db.prepare('SELECT rowid FROM selftest_cd WHERE selftest_cd MATCH ?').get('alpha') == null
    );
  } finally {
    db.exec('DROP TABLE temp.selftest_cd');
  }
}

/**
 * Asserts the SQLite behind `db` can run the engine: the version, FTS5, and `contentless_delete` working. Each
 * capability is probed by doing it; the version string is reported and checked, never trusted in place of a probe.
 * Uses `temp` tables only, so it is safe on a live database. The host launches it (`--selftest`, CI in Electron's Node).
 */
export function runSelfTest(db: SqlDatabase, minimum: string = MIN_SQLITE): SelfTestReport {
  const failures: string[] = [];
  let version = 'unknown';
  try {
    version = String(db.prepare('SELECT sqlite_version() AS v').get()?.v ?? 'unknown');
  } catch {
    failures.push('SQLite did not report its version.');
  }
  const atLeastMinimum = versionAtLeast(version, minimum);
  if (!atLeastMinimum) failures.push(`SQLite ${version} is older than ${minimum}.`);
  const fts5 = attempt(() => probeFts5(db));
  if (!fts5) failures.push('SQLite has no working FTS5.');
  const contentlessDelete = attempt(() => probeContentlessDelete(db));
  if (!contentlessDelete) failures.push('FTS5 contentless_delete does not work.');
  return {
    ok: failures.length === 0,
    sqlite: { version, atLeastMinimum },
    fts5,
    contentlessDelete,
    failures,
  };
}
