import { transaction, type SqlDatabase } from './sql';

/** One forward-only schema step. Never edit a shipped migration: the checksum row catches it. */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** The database was written by a newer engine. The sentence is today's (`legacy/store.ts:13`), so the UI copy holds. */
export class SchemaTooNewError extends Error {
  readonly code = 'schemaTooNew';
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super('This mailbox was saved by a newer version of Aplos Mail. Update the app to open it.');
  }
}

/** A migration failed or shipped history was edited. The engine parks on this (ARCH 3.7); nothing was changed. */
export class MigrationError extends Error {
  readonly code = 'migrationFailed';
  constructor(
    readonly version: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface MigrateOptions {
  now?: () => number;
  /** Called once before upgrading an existing database (not a fresh one), so the host can copy `mail.db.pre-<from>`. */
  beforeUpgrade?: (from: number, to: number) => void;
}
export interface MigrateResult {
  from: number;
  to: number;
  applied: number[];
}

/**
 * Brings the database to the newest migration, each step in its own transaction together with its
 * `schema_migrations` row and `PRAGMA user_version`, so a crash leaves the previous version intact. Refuses a newer
 * database and never downgrades.
 */
export function migrate(
  db: SqlDatabase,
  migrations: readonly Migration[],
  options: MigrateOptions = {},
): MigrateResult {
  const now = options.now ?? Date.now;
  migrations.forEach((m, i) => {
    if (m.version !== i + 1)
      throw new MigrationError(
        m.version,
        `Migrations must be numbered 1..n without gaps; found ${m.version} at position ${i + 1}`,
      );
  });
  const latest = migrations.length;
  const from = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  if (from > latest) throw new SchemaTooNewError(from, latest);
  if (from > 0) verifyHistory(db, migrations.slice(0, from));
  if (from === latest) return { from, to: from, applied: [] };
  if (from > 0) options.beforeUpgrade?.(from, latest);
  const applied: number[] = [];
  for (const m of migrations.slice(from)) {
    try {
      transaction(db, () => {
        db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL,
          checksum TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT`);
        db.exec(m.sql);
        db.prepare(
          'INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES(?, ?, ?, ?)',
        ).run(m.version, m.name, checksum(m.sql), now());
        db.exec(`PRAGMA user_version=${m.version}`);
      });
    } catch (error) {
      throw new MigrationError(
        m.version,
        `Migration ${m.version} (${m.name}) failed; the database is unchanged at version ${m.version - 1}`,
        { cause: error },
      );
    }
    applied.push(m.version);
  }
  return { from, to: latest, applied };
}

function verifyHistory(db: SqlDatabase, shipped: readonly Migration[]) {
  const rows = db
    .prepare('SELECT version, checksum FROM schema_migrations ORDER BY version')
    .all<{ version: number; checksum: string }>();
  const byVersion = new Map(rows.map(r => [r.version, r.checksum]));
  for (const m of shipped) {
    const recorded = byVersion.get(m.version);
    if (recorded !== checksum(m.sql)) {
      throw new MigrationError(
        m.version,
        recorded === undefined
          ? `Migration ${m.version} (${m.name}) is marked applied but has no history row`
          : `Migration ${m.version} (${m.name}) was edited after it shipped; add a new migration instead`,
      );
    }
  }
}

/** FNV-1a over UTF-16 code units, two 32-bit lanes. Catches edits, not attacks; no `node:crypto` in the neutral core. */
export function checksum(text: string): string {
  let a = 0x811c9dc5,
    b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}
