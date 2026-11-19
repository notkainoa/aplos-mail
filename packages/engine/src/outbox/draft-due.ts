import type { Clock } from '../ports/time';
import type { StorePort } from '../store';
import { LIVE_SQL, liveOf } from './draft-state';

/**
 * What the `drafts` deadline source knows about the table without reading all of it. The due times live inside each
 * row's JSON (`_sync.dueAt`, `_sync.removeAt`), so finding the earliest one is a scan of every draft. The source is asked
 * for its deadline after every save, so it keeps the answer here: a full scan fills it, a write this engine makes
 * re-reads just that row (`touchDue`), and a full scan repeats at most every `FULL_SCAN_MS` when the source is asked
 * (what another process wrote is found then; an entry that is too late or too early only fires a source that finds
 * nothing to do, never an upload that should not happen: the upload itself re-reads the row).
 */

export const FULL_SCAN_MS = 60_000;

export interface SentRow {
  id: string;
  account_id: string;
  remote_draft_id: string | null;
  [k: string]: string | null;
}

export interface Removal {
  /** When the copy's removal is next tried. */
  at: number;
  /** The draft's first upload has no result yet: the removal waits for it or for the grace period to end. */
  waiting: boolean;
}

export interface DueIndex {
  scannedAt: number | undefined;
  /** Draft id to the time its next upload is due. */
  uploads: Map<string, number>;
  /** Draft id to the removal of its copy (a discarded or sent draft whose row is still there). */
  removals: Map<string, Removal>;
  /** Drafts whose current revision went out; undefined means look again. */
  sent: SentRow[] | undefined;
}

export function createDueIndex(): DueIndex {
  return { scannedAt: undefined, uploads: new Map(), removals: new Map(), sent: undefined };
}

export interface DueScope {
  store: StorePort;
  clock: Clock;
  index: DueIndex;
}

interface DueRow {
  id: string;
  due: number | null;
  remove_at: number | null;
  removing: number | null;
  has_copy: number;
  [k: string]: string | number | null;
}

const COLUMNS = `id, json_extract(data, '$._sync.dueAt') AS due, json_extract(data, '$._sync.removeAt') AS remove_at,
  json_extract(data, '$._sync.removing') AS removing, remote_draft_id IS NOT NULL AS has_copy`;

function enter(index: DueIndex, row: DueRow) {
  if (row.due !== null) index.uploads.set(row.id, row.due);
  else index.uploads.delete(row.id);
  if (row.removing !== null)
    index.removals.set(row.id, { at: row.remove_at ?? 0, waiting: row.has_copy === 0 });
  else index.removals.delete(row.id);
}

/** Reads every draft that has an upload or a removal pending. */
export function scanDue(scope: DueScope) {
  const rows = scope.store.read(q =>
    q.all<DueRow>(
      `SELECT ${COLUMNS} FROM drafts
       WHERE json_extract(data, '$._sync.dueAt') IS NOT NULL OR json_extract(data, '$._sync.removing') IS NOT NULL`,
    ),
  );
  const { index } = scope;
  index.uploads.clear();
  index.removals.clear();
  for (const row of rows) enter(index, row);
  index.scannedAt = scope.clock.now();
}

/** A write to this draft was made here: read just its row. */
export function touchDue(scope: DueScope, id: string) {
  const row = scope.store.read(q =>
    q.get<DueRow>(`SELECT ${COLUMNS} FROM drafts WHERE id = ?`, id),
  );
  if (row) enter(scope.index, row);
  else {
    scope.index.uploads.delete(id);
    scope.index.removals.delete(id);
  }
}

/** Looks at the whole table again when the last full scan is old (or there was none). */
export function refreshDue(scope: DueScope) {
  const { scannedAt } = scope.index;
  if (scannedAt === undefined || scope.clock.now() - scannedAt >= FULL_SCAN_MS) {
    scanDue(scope);
    scope.index.sent = undefined;
  }
}

/** A send changed state: which drafts are sent may have changed. */
export function sentChanged(scope: Pick<DueScope, 'index'>) {
  scope.index.sent = undefined;
}

/** Drafts whose current revision went out and that have no live send; read again only after `sentChanged`. */
export function sentDrafts(scope: DueScope, fresh = false): SentRow[] {
  if (!fresh && scope.index.sent) return scope.index.sent;
  const rows = scope.store.read(q =>
    q.all<SentRow>(
      `SELECT d.id, d.account_id, d.remote_draft_id FROM drafts d
       WHERE EXISTS (SELECT 1 FROM submissions s WHERE s.draft_id = d.id AND s.state = 'sent' AND s.revision = d.revision)
         AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.draft_id = d.id AND s.state IN (${LIVE_SQL}))
         AND json_extract(d.data, '$._sync.removing') IS NULL`,
    ),
  );
  scope.index.sent = rows;
  return rows;
}

/** The ids of `ids` that have no live send (a send pins its draft: the upload waits for it to end). */
export function withoutLiveSend(scope: DueScope, ids: readonly string[]): Set<string> {
  if (!ids.length) return new Set();
  return scope.store.read(q => new Set(ids.filter(id => !liveOf(q, id))));
}
