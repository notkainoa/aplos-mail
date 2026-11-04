import { applyCommit } from './commit';
import { compactChanges } from './compact';
import { registerExtensions } from './extend';
import { migrate, type Migration } from './migrate';
import { MIGRATIONS } from './migrations';
import type {
  BodyCodec,
  Change,
  ChangesSince,
  CommitExtension,
  IngestHooks,
  StorePort,
  StoreReader,
} from './port';
import { transaction, type SqlDatabase, type SqlStatement } from './sql';

export * from './port';
export { CORE_WRITE_KINDS, FLAG, HDR, PART } from './commit';
export { readBody } from './bodies';
export { createKnownLookup } from './known';
export { LANE_TEXT_CAP, STORED_HEADER } from './ingest';
export { eventChangeKey } from './calendar';
export * from './due';
export { MigrationError, SchemaTooNewError, type Migration } from './migrate';
export { MIGRATIONS } from './migrations';
export type { SqlDatabase, SqlRow, SqlStatement, SqlValue } from './sql';

export interface OpenStoreOptions {
  now?: () => number;
  /** Randomness for `db_epoch` and `install_salt`; defaults to Web Crypto, which a phone host may have to supply. */
  randomBytes?: (n: number) => Uint8Array;
  migrations?: readonly Migration[];
  /** See `MigrateOptions.beforeUpgrade`: the host copies `mail.db.pre-<from>` here. */
  beforeUpgrade?: (from: number, to: number) => void;
  /** The lanes' writers for their own tables (seam 2), applied inside `commit`. Validated here; a clash throws. */
  extensions?: readonly CommitExtension[];
  /** The host's synchronous body compressor; codec 0 (raw) without one. */
  bodyCodec?: BodyCodec;
  /** `laneFor` (eng-ai), run at ingest inside `commit` (seam 2). */
  ingest?: IngestHooks;
}

const DEFAULT_PAGE = 1000;

/**
 * Opens `mail.db` on an already-open connection (the host applies pragmas): migrates, stamps a new database with its
 * epoch, salt and seq 0, and returns the store. Throws `SchemaTooNewError` or `MigrationError`; the engine parks.
 */
export function openStore(db: SqlDatabase, options: OpenStoreOptions = {}): StorePort {
  const now = options.now ?? Date.now;
  requireForeignKeys(db);
  const extensions = registerExtensions(options.extensions);
  const random = options.randomBytes ?? (n => globalThis.crypto.getRandomValues(new Uint8Array(n)));
  const { to } = migrate(db, options.migrations ?? MIGRATIONS, {
    now,
    beforeUpgrade: options.beforeUpgrade,
  });
  const cache = new Map<string, SqlStatement>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  const meta = (key: string) =>
    stmt('SELECT value FROM meta WHERE key = ?').get<{ value: string }>(key)?.value;
  transaction(db, () => {
    if (meta('db_epoch') !== undefined) return;
    const put = stmt('INSERT INTO meta(key, value) VALUES(?, ?)');
    put.run('db_epoch', uuid(random(16)));
    put.run('install_salt', hex(random(32)));
    put.run('seq', '0');
    put.run('change_floor_seq', '0');
    put.run('created_at', String(now()));
  });
  const dbEpoch = meta('db_epoch')!;
  const seq = () => Number(meta('seq'));
  const reader: StoreReader = {
    bodyCodec: options.bodyCodec,
    get: (sql, ...params) => stmt(sql).get(...params),
    all: (sql, ...params) => stmt(sql).all(...params),
    iterate: (sql, ...params) => stmt(sql).iterate(...params),
  };
  return {
    dbEpoch,
    schemaVersion: to,
    seq,
    commit: input =>
      applyCommit(
        {
          db,
          dbEpoch,
          now,
          stmt,
          extensions,
          bodyCodec: options.bodyCodec,
          ingest: options.ingest,
        },
        input,
      ),
    changesSince(since, { limit = DEFAULT_PAGE } = {}): ChangesSince {
      const floorSeq = Number(meta('change_floor_seq')),
        current = seq();
      if (!Number.isSafeInteger(since) || since < floorSeq || since > current)
        return { status: 'cannotCalculateChanges', floorSeq, seq: current };
      const page = Math.max(1, Math.trunc(limit));
      const changes = stmt(
        'SELECT seq, type, id, op FROM changes WHERE seq > ? ORDER BY seq, type, id LIMIT ?',
      ).all<Change & Record<string, string | number>>(since, page + 1);
      if (changes.length <= page)
        return { status: 'ok', fromSeq: since, toSeq: current, hasMore: false, changes };
      // Never split a commit: finish the last seq on this page, then report whether later commits remain.
      changes.length = page;
      const last = changes[page - 1];
      changes.push(
        ...stmt(
          'SELECT seq, type, id, op FROM changes WHERE seq = ? AND (type, id) > (?, ?) ORDER BY type, id',
        ).all<Change & Record<string, string | number>>(last.seq, last.type, last.id),
      );
      const hasMore =
        stmt('SELECT 1 FROM changes WHERE seq > ? LIMIT 1').get(last.seq) !== undefined;
      return {
        status: 'ok',
        fromSeq: since,
        toSeq: hasMore ? last.seq : current,
        hasMore,
        changes,
      };
    },
    compact: options => compactChanges(db, { ...options, now: now() }),
    read(fn) {
      // query_only makes the "commit is the only write path" rule hold at runtime, not just in the types.
      db.exec('PRAGMA query_only=1');
      try {
        const result = fn(reader);
        if (result && typeof (result as { then?: unknown }).then === 'function')
          throw new Error('store.read() callbacks must be synchronous');
        return result;
      } finally {
        db.exec('PRAGMA query_only=0');
      }
    },
    close: () => db.close(),
  };
}

/** The cascades behind `accountRemove` and every other delete are foreign keys: without them rows are orphaned silently. */
function requireForeignKeys(db: SqlDatabase) {
  const on = db.prepare('PRAGMA foreign_keys').get<{ foreign_keys: number }>()?.foreign_keys;
  if (on !== 1)
    throw new Error(
      'openStore needs PRAGMA foreign_keys=ON on the connection (the host opener sets it)',
    );
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** RFC 4122 version 4 from 16 random bytes. */
function uuid(b: Uint8Array) {
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
