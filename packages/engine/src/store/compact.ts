import { StoreError, type CompactOptions, type CompactResult } from './port';
import { transaction, type SqlDatabase } from './sql';

/** ARCH 3.5: the change log keeps at most 50,000 rows and nothing older than 30 days. */
export const COMPACT_MAX_ROWS = 50_000;
export const COMPACT_MAX_AGE_MS = 30 * 86_400_000;

export interface CompactChangesOptions extends CompactOptions {
  now: number;
}

/**
 * Raises `meta.change_floor_seq` and deletes the `changes` rows at or below it, in one transaction. The floor never
 * moves down and never passes `meta.seq`, and it always lands on a whole commit's seq. `changesSince` already refuses
 * a seq below the floor (`cannotCalculateChanges`); the `commits` table stays, it is the opId idempotency record.
 */
export function compactChanges(db: SqlDatabase, opts: CompactChangesOptions): CompactResult {
  const maxRows = limit(opts.maxRows ?? COMPACT_MAX_ROWS, 'maxRows');
  const maxAgeMs = limit(opts.maxAgeMs ?? COMPACT_MAX_AGE_MS, 'maxAgeMs');
  if (!Number.isFinite(opts.now)) throw new StoreError('invalid', 'compact needs a finite now');
  return transaction(db, () => {
    const current = metaNumber(db, 'change_floor_seq');
    const target = Math.max(current, ageFloor(db, opts.now - maxAgeMs), rowFloor(db, maxRows));
    const floorSeq = Math.min(target, metaNumber(db, 'seq'));
    if (floorSeq <= current) return { floorSeq: current, deleted: 0 };
    const deleted = db.prepare('DELETE FROM changes WHERE seq <= ?').run(floorSeq).changes;
    db.prepare("UPDATE meta SET value = ? WHERE key = 'change_floor_seq'").run(String(floorSeq));
    return { floorSeq, deleted };
  });
}

function limit(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0)
    throw new StoreError('invalid', `compact ${name} must be a non-negative number`);
  return Math.trunc(value);
}

function metaNumber(db: SqlDatabase, key: string): number {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get<{ value: string }>(key);
  return Number(row?.value ?? 0);
}

/** The newest commit made before the cutoff; everything up to its seq is older than the age limit. */
export function ageFloor(db: SqlDatabase, cutoff: number): number {
  const row = db
    .prepare('SELECT max(seq) AS s FROM commits WHERE at < ?')
    .get<{ s: number | null }>(cutoff);
  return row?.s ?? 0;
}

/**
 * The smallest seq S with at most `maxRows` change rows after it: the seq of the (maxRows + 1)-th newest row. Rows that
 * share that seq go with it, so a commit is never split.
 */
export function rowFloor(db: SqlDatabase, maxRows: number): number {
  const row = db
    .prepare('SELECT seq FROM changes ORDER BY seq DESC LIMIT 1 OFFSET ?')
    .get<{ seq: number }>(maxRows);
  return row?.seq ?? 0;
}
