/**
 * The only database surface the engine depends on. Desktop backs it with `node:sqlite`;
 * a mobile build can back it with any synchronous SQLite binding (op-sqlite, expo-sqlite).
 */
export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;
export interface SqlStatement {
  run(...params: SqlValue[]): unknown;
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): SqlRow[];
}
export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

export function transaction<T>(db: SqlDatabase, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
