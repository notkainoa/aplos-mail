import type { EngineServices } from '../runtime/services';
import { parseStored, withDefaults } from '../runtime/settings';
import type { BodyEvictWrite } from '../host/retention-ext';

/*
 * Body retention (ARCH 3.6, Decision 6), the lazy half: `host/module.ts` loads this on a desktop host and runs a pass
 * a while after start and then every few hours. Message text is kept for `retention.bodyDays` plus anything opened in
 * Aplos, starred or unread, and all of it under `retention.maxBodyBytes`; older text is dropped and fetched again from
 * the provider when the message is opened (`mail/render.ts loadBody`). Metadata, folders and the search index stay.
 *
 * Never dropped: drafts, messages only on this Mac (`origin = 'local'`), and anything not yet in the search index (its
 * words would be lost to search). The outbox and drafts tables are never touched. A pass never runs while an account
 * is backfilling, reads and writes in small batches with a yield between them, so the engine is never held for long,
 * and hands the freed pages back to the disk with paced `incremental_vacuum` steps.
 */

const DAY = 86_400_000;
/** Body rows read per scan step. */
export const SCAN_BATCH = 2000;
/** Bodies dropped per commit. */
export const EVICT_BATCH = 200;
/** Pages one `incremental_vacuum` step frees (4 KB pages: 8 MB). */
export const VACUUM_PAGES = 2048;
/** First pass after start, then the interval between passes. */
export const FIRST_PASS_MS = 10 * 60_000;
export const PASS_EVERY_MS = 6 * 3_600_000;

export interface RetentionResult {
  /** Why nothing ran, when nothing did. */
  skipped?: 'backfill' | 'aborted';
  /** Bodies stored when the pass began, and their bytes on disk. */
  bodies: number;
  bytes: number;
  /** Dropped by the age rule, and by the size cap. */
  byAge: number;
  byCap: number;
  vacuumSteps: number;
}

export interface RetentionOptions {
  signal?: AbortSignal;
  /** Between batches; defaults to a zero sleep on the engine clock. */
  pause?: () => Promise<void>;
  /** Tests: smaller steps than `SCAN_BATCH` and `EVICT_BATCH`. */
  scanBatch?: number;
  evictBatch?: number;
}

interface Candidate {
  id: number;
  size: number;
  /** Starred, unread or opened: dropped by the cap only after every unmarked body. */
  marked: boolean;
  /** Least recently read first; never-opened mail by its date. */
  key: number;
}

type ScanRow = {
  id: number;
  size: number;
  flags: number;
  parts: number;
  origin: string;
  internal_date: number;
  last_read_at: number | null;
};

/** What one scan of every stored body found. */
interface Scan {
  bodies: number;
  bytes: number;
  /** Bytes the cap may never drop: drafts, local-only and unindexed mail. */
  kept: number;
  byAge: number[];
  candidates: Candidate[];
}

/** One retention pass. Safe to run at any time and idempotent: a second pass right after finds nothing to drop. */
export async function retainBodies(
  services: EngineServices,
  options: RetentionOptions = {},
): Promise<RetentionResult> {
  const { store, clock } = services;
  const signal = options.signal;
  const pause = options.pause ?? (() => clock.sleep(0, signal));
  const result: RetentionResult = { bodies: 0, bytes: 0, byAge: 0, byCap: 0, vacuumSteps: 0 };
  if (backfilling(services)) return { ...result, skipped: 'backfill' };
  const { bodyDays, maxBodyBytes } = withDefaults(
    parseStored(
      store.read(q => q.get<{ data: string }>('SELECT data FROM settings WHERE id = 1')?.data),
    ),
  ).retention;
  const started = clock.now();
  const scan = await scanBodies(services, started - bodyDays * DAY, options, pause);
  if (!scan) return { ...result, skipped: 'aborted' };
  result.bodies = scan.bodies;
  result.bytes = scan.bytes;
  const byCap = overCap(scan, maxBodyBytes);

  // Drop in small commits; the writer checks every row again.
  const step = { size: options.evictBatch ?? EVICT_BATCH, pause, signal };
  result.byAge = await evict(services, scan.byAge, { before: started, rule: true }, step);
  result.byCap = await evict(services, byCap, { before: started, rule: false }, step);
  if (result.byAge || result.byCap) result.vacuumSteps = await vacuum(services, pause, signal);
  return result;
}

/** Every stored body in keyset steps, a yield after each: the age rule's drops, and the rest as cap candidates. */
async function scanBodies(
  services: EngineServices,
  cutoff: number,
  options: RetentionOptions,
  pause: () => Promise<void>,
): Promise<Scan | undefined> {
  const scan: Scan = { bodies: 0, bytes: 0, kept: 0, byAge: [], candidates: [] };
  let after = -1;
  for (;;) {
    if (options.signal?.aborted) return undefined;
    const rows = services.store.read(q =>
      q.all<ScanRow>(
        `SELECT b.message_id AS id, length(b.data) AS size, m.flags, m.parts, m.origin, m.internal_date, m.last_read_at
          FROM bodies b JOIN messages m ON m.id = b.message_id WHERE b.message_id > ? ORDER BY b.message_id LIMIT ?`,
        after,
        options.scanBatch ?? SCAN_BATCH,
      ),
    );
    if (!rows.length) return scan;
    after = rows[rows.length - 1].id;
    for (const r of rows) sort(scan, r, cutoff);
    await pause();
  }
}

function sort(scan: Scan, r: ScanRow, cutoff: number) {
  scan.bodies++;
  scan.bytes += r.size;
  // Drafts, local-only mail and anything search has not indexed yet are never dropped, by the cap either.
  if (r.flags & 8 || r.origin === 'local' || !(r.parts & 8)) {
    scan.kept += r.size;
    return;
  }
  const marked = !(r.flags & 1) || (r.flags & 2) !== 0 || r.last_read_at !== null;
  if (!marked && r.internal_date < cutoff) scan.byAge.push(r.id);
  else
    scan.candidates.push({
      id: r.id,
      size: r.size,
      marked,
      key: r.last_read_at ?? r.internal_date,
    });
}

/** Over the cap: unmarked bodies go first, then marked ones, least recently read first, until the rest fits. */
function overCap(scan: Scan, maxBodyBytes: number): number[] {
  let total = scan.kept + scan.candidates.reduce((sum, c) => sum + c.size, 0);
  const byCap: number[] = [];
  if (total <= maxBodyBytes) return byCap;
  const order = [...scan.candidates].sort(
    (a, b) => Number(a.marked) - Number(b.marked) || a.key - b.key || a.id - b.id,
  );
  for (const c of order) {
    if (total <= maxBodyBytes) break;
    byCap.push(c.id);
    total -= c.size;
  }
  return byCap;
}

/** Hands the freed pages back, a bounded step per commit; returns the steps taken. */
async function vacuum(
  services: EngineServices,
  pause: () => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<number> {
  let steps = 0;
  while (!signal?.aborted && freePages(services) > 0) {
    services.store.commit({
      opId: opId(services, 'vacuum'),
      origin: 'system',
      writes: [{ kind: 'bodyVacuum', pages: VACUUM_PAGES }],
    });
    steps++;
    await pause();
  }
  return steps;
}

async function evict(
  services: EngineServices,
  ids: readonly number[],
  how: Pick<BodyEvictWrite, 'before' | 'rule'>,
  step: { size: number; pause: () => Promise<void>; signal: AbortSignal | undefined },
): Promise<number> {
  const { size, pause, signal } = step;
  let done = 0;
  for (let i = 0; i < ids.length && !signal?.aborted; i += size) {
    const { changed } = services.store.commit({
      opId: opId(services, 'evict'),
      origin: 'system',
      writes: [{ kind: 'bodyEvict', ids: ids.slice(i, i + size), ...how }],
    });
    done += changed;
    await pause();
  }
  return done;
}

function freePages(services: EngineServices): number {
  return services.store.read(
    q => q.get<{ freelist_count: number }>('PRAGMA freelist_count')?.freelist_count ?? 0,
  );
}

/** First sync fills the store; dropping text it just fetched would only cost a refetch. */
function backfilling(services: EngineServices): boolean {
  const ids = services.store.read(q => q.all<{ id: string }>('SELECT id FROM accounts'));
  return ids.some(({ id }) => {
    const state = services.accounts.status(id)?.status?.state;
    return state === 'backfilling' || state === 'starting';
  });
}

function opId(services: EngineServices, what: string) {
  const hex = Array.from(services.randomBytes(8), b => b.toString(16).padStart(2, '0')).join('');
  return `retention-${what}:${hex}`;
}

/** The schedule: a pass a while after start, then every few hours, until `signal` aborts. Failures are logged. */
export async function retentionLoop(services: EngineServices, signal: AbortSignal): Promise<void> {
  let wait = FIRST_PASS_MS;
  while (!signal.aborted) {
    try {
      await services.clock.sleep(wait, signal);
      await retainBodies(services, { signal });
    } catch {
      if (signal.aborted) return;
      services.log.event('rpc.failed', { method: 'Store/retention', reason: 'pass' });
    }
    wait = PASS_EVERY_MS;
  }
}
