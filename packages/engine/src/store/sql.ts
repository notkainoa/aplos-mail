/**
 * The only database surface the engine depends on (ARCH 3.1, plan 10 E1 item 5). Desktop backs it with `node:sqlite`
 * (`apps/desktop/src/host/sqlite.ts`); a phone build can back it with any synchronous SQLite binding that has FTS5 and
 * SQLite 3.43 or later. Synchronous on purpose: one writer connection, no transaction or iterator held across an await
 * (ARCH 3.7).
 */
export type SqlValue = string | number | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;
export interface SqlRunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface SqlStatement {
  run(...params: SqlValue[]): SqlRunResult;
  get<R extends SqlRow = SqlRow>(...params: SqlValue[]): R | undefined;
  all<R extends SqlRow = SqlRow>(...params: SqlValue[]): R[];
  /** Streams rows. Finish (or `return()`) the iterator before the next await: a live statement pins the WAL. */
  iterate<R extends SqlRow = SqlRow>(...params: SqlValue[]): IterableIterator<R>;
}

export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

export class NestedTransactionError extends Error {
  constructor() {
    super('transaction() does not nest: every store write is one transaction');
  }
}

const open = new WeakSet<SqlDatabase>();

/**
 * Runs `fn` in one `BEGIN IMMEDIATE` transaction (takes the write lock up front, so a busy reader can never turn it
 * into a deadlock halfway). Throws roll back; nesting and async callbacks are refused, because both hide writes that
 * would escape the transaction.
 */
export function transaction<T>(db: SqlDatabase, fn: () => T): T {
  if (open.has(db)) throw new NestedTransactionError();
  db.exec('BEGIN IMMEDIATE');
  open.add(db);
  try {
    const result = fn();
    if (result && typeof (result as { then?: unknown }).then === 'function')
      throw new Error('transaction() callbacks must be synchronous');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    // SQLite may already have rolled back on its own (SQLITE_FULL, SQLITE_IOERR); keep the original error.
    try {
      db.exec('ROLLBACK');
    } catch {
      /* no transaction left to roll back */
    }
    throw error;
  } finally {
    open.delete(db);
  }
}
