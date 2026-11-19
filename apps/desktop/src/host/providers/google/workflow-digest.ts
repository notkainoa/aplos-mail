import { createHash } from 'node:crypto';
import { canonical, compareStamp, type Stamp, type WorkflowRecord } from './workflow-merge';

/**
 * What an own-only compaction remembers of a copy this device wrote (`workflow-state.ts`): per key, the record's stamp
 * and a short hash of its value, never the value itself. It is enough for the matching rule (a new copy whose floor
 * readers do not honour may trash an own copy only if it holds every record of it, equal or with a later stamp):
 * a later stamp covers; an equal stamp covers only with the same value hash (an equal stamp with another value, which
 * no honest writer makes, is never treated as covered, so the rule only errs towards keeping a copy).
 */

export interface RecordDigest {
  stamp: Stamp;
  /** The first 16 base64url characters of the SHA-256 of the value's canonical JSON. */
  value: string;
}

export type CopyDigest = ReadonlyMap<string, RecordDigest>;

const valueHash = (record: WorkflowRecord): string =>
  createHash('sha256').update(canonical(record.value)).digest('base64url').slice(0, 16);

/** The digest of a copy's records. */
export function digestOf(records: readonly WorkflowRecord[]): CopyDigest {
  return new Map(records.map(r => [r.key, { stamp: r.stamp, value: valueHash(r) }] as const));
}

/** True when `held` is the same record as `old` or a later one. */
function coversRecord(held: RecordDigest | undefined, old: RecordDigest): boolean {
  if (!held) return false;
  const byStamp = compareStamp(held.stamp, old.stamp);
  return byStamp > 0 || (byStamp === 0 && held.value === old.value);
}

/** True when `newer` holds every record `older` holds, equal or with a later stamp. */
export function digestCovers(newer: CopyDigest, older: CopyDigest): boolean {
  for (const [key, old] of older) if (!coversRecord(newer.get(key), old)) return false;
  return true;
}

/**
 * Own copies' digests, bounded twice: at most `maxCopies` copies and `maxEntries` records over all of them (the
 * oldest remembered copy goes first; the newest is always kept). `remember` returns the copies it forgot, so the
 * channel can keep their ids (`workflow-state.ts` re-reads a few of them per own-only compaction).
 */
export class OwnDigests {
  private readonly copies = new Map<string, CopyDigest>();
  private total = 0;

  constructor(
    private readonly maxCopies: number,
    private readonly maxEntries: number,
  ) {}

  /** Copies remembered. */
  get size(): number {
    return this.copies.size;
  }

  /** Records remembered over every copy. */
  get entries(): number {
    return this.total;
  }

  get(id: string): CopyDigest | undefined {
    return this.copies.get(id);
  }

  delete(id: string): void {
    const digest = this.copies.get(id);
    if (!digest) return;
    this.total -= digest.size;
    this.copies.delete(id);
  }

  /** Remembers `id` as the newest copy, evicting the oldest past either bound; returns the ids evicted. */
  remember(id: string, digest: CopyDigest): string[] {
    this.delete(id);
    this.copies.set(id, digest);
    this.total += digest.size;
    const evicted: string[] = [];
    while (this.copies.size > 1 && this.overBound()) {
      const oldest = this.oldest();
      this.delete(oldest);
      evicted.push(oldest);
    }
    return evicted;
  }

  private overBound(): boolean {
    return this.copies.size > this.maxCopies || this.total > this.maxEntries;
  }

  private oldest(): string {
    return this.copies.keys().next().value as string;
  }
}
