import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import type {
  SqlDatabase,
  SqlRow,
  SqlRunResult,
  SqlStatement,
  SqlValue,
} from '@aplos/engine/store/sql';

export interface OpenSqliteOptions {
  /** Read-only connections (the importer reading `aplos.db`) skip every pragma that writes. */
  readOnly?: boolean;
  busyTimeoutMs?: number;
}

/**
 * The `node:sqlite` implementation of the engine's SQL port. `node:sqlite` follows Electron's bundled SQLite, which is
 * why the engine self-test checks the version and FTS5 rather than trusting the OS (ARCH 3.1). Swapping in
 * better-sqlite3 later means rewriting only this file.
 */
export function openSqlite(path: string, options: OpenSqliteOptions = {}): SqlDatabase {
  const busy = options.busyTimeoutMs ?? 5000;
  const db = new DatabaseSync(path, {
    readOnly: options.readOnly ?? false,
    timeout: busy,
    enableForeignKeyConstraints: true,
  });
  try {
    if (!options.readOnly) {
      // auto_vacuum only takes effect before the first table exists, so it runs first; on an existing file it is a no-op.
      db.exec(`PRAGMA auto_vacuum=INCREMENTAL;
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        PRAGMA journal_size_limit=67108864;
        PRAGMA temp_store=MEMORY;`);
      if (path !== ':memory:' && !path.startsWith('file:')) chmodSync(path, 0o600);
    }
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${Math.trunc(busy)};`);
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    exec: sql => db.exec(sql),
    prepare: sql => wrap(db.prepare(sql)),
    close: () => db.close(),
  };
}

function wrap(statement: StatementSync): SqlStatement {
  return {
    run(...params: SqlValue[]): SqlRunResult {
      const result = statement.run(...params);
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    },
    get: <R extends SqlRow>(...params: SqlValue[]) => statement.get(...params) as R | undefined,
    all: <R extends SqlRow>(...params: SqlValue[]) => statement.all(...params) as R[],
    iterate: <R extends SqlRow>(...params: SqlValue[]) =>
      statement.iterate(...params) as IterableIterator<R>,
  };
}
