import type { KnownLookup, Placement } from '../ports/provider';
import type { StorePort, StoreReader } from './port';

const IDS = 'SELECT value FROM json_each(?)';

/**
 * F3's `KnownLookup` for one account, read-only over `StorePort.read` (FR-26). Every answer is one short synchronous
 * read, resolved as a promise because the port is async for hosts whose store is remote. Never writes.
 */
export function createKnownLookup(store: StorePort, accountId: string): KnownLookup {
  const read = <T>(fn: (q: StoreReader) => T) => Promise.resolve().then(() => store.read(fn));
  return {
    knownThreads: ids =>
      read(q =>
        idSet(q, 'SELECT remote_id AS v FROM threads WHERE account_id = ? AND remote_id IN', ids),
      ),
    knownMessages: ids =>
      read(q =>
        idSet(q, 'SELECT remote_id AS v FROM messages WHERE account_id = ? AND remote_id IN', ids),
      ),
    trackedDraftIds: ids =>
      read(q =>
        idSet(
          q,
          'SELECT remote_draft_id AS v FROM drafts WHERE account_id = ? AND remote_draft_id IN',
          ids,
        ),
      ),
    draftsByMessageId: ids => read(q => draftsByMessageId(q, accountId, ids)),
    threadMessages: remoteThreadId => read(q => threadMessages(q, accountId, remoteThreadId)),
    placements: ids => read(q => placements(q, accountId, ids)),
    folderUids: (folder, uidFrom, uidTo) =>
      read(q =>
        q
          .all<{ uid: number }>(
            `SELECT mf.uid FROM message_folders mf JOIN folders f ON f.id = mf.folder_id
            WHERE f.account_id = ? AND f.remote_id = ? AND mf.uid BETWEEN ? AND ? ORDER BY mf.uid`,
            accountId,
            folder,
            uidFrom,
            uidTo,
          )
          .map(r => r.uid),
      ),
    eventEtags: (calendarRemoteId, ids) =>
      read(q => eventEtags(q, accountId, calendarRemoteId, ids)),
  };

  function idSet(q: StoreReader, select: string, ids: string[]): ReadonlySet<string> {
    if (!ids.length) return new Set();
    return new Set(
      q.all<{ v: string }>(`${select} (${IDS})`, accountId, JSON.stringify(ids)).map(r => r.v),
    );
  }
}

/** Only drafts this device synced have both ids; a remote message id maps to one remote draft id. */
function draftsByMessageId(
  q: StoreReader,
  accountId: string,
  ids: string[],
): ReadonlyMap<string, string> {
  if (!ids.length) return new Map();
  return new Map(
    q
      .all<{ m: string; d: string }>(
        `SELECT remote_message_id AS m, remote_draft_id AS d FROM drafts
        WHERE account_id = ? AND remote_draft_id IS NOT NULL AND remote_message_id IN (${IDS})`,
        accountId,
        JSON.stringify(ids),
      )
      .map(r => [r.m, r.d]),
  );
}

interface PlacementRow {
  remote_id: string;
  folder: string | null;
  uid: number | null;
  [k: string]: string | number | null;
}

function groupPlacements(rows: PlacementRow[]): Map<string, Placement[]> {
  const out = new Map<string, Placement[]>();
  for (const r of rows) {
    let list = out.get(r.remote_id);
    if (!list) out.set(r.remote_id, (list = []));
    if (r.folder === null) continue;
    list.push(r.uid === null ? { folder: r.folder } : { folder: r.folder, uid: r.uid });
  }
  return out;
}

const PLACEMENTS = `SELECT m.remote_id, f.remote_id AS folder, mf.uid FROM messages m
  LEFT JOIN message_folders mf ON mf.message_id = m.id LEFT JOIN folders f ON f.id = mf.folder_id`;

/** Every stored message of the thread, oldest first, with its placements (an unplaced message has none). */
function threadMessages(q: StoreReader, accountId: string, remoteThreadId: string) {
  const rows = q.all<PlacementRow>(
    `${PLACEMENTS} JOIN threads t ON t.id = m.thread_id WHERE t.account_id = ? AND t.remote_id = ?
    ORDER BY m.id, f.remote_id`,
    accountId,
    remoteThreadId,
  );
  return [...groupPlacements(rows)].map(([remoteId, placements]) => ({ remoteId, placements }));
}

/** Stored messages only: an unknown id is absent from the map, a known unplaced one maps to []. */
function placements(
  q: StoreReader,
  accountId: string,
  ids: string[],
): ReadonlyMap<string, Placement[]> {
  if (!ids.length) return new Map();
  return groupPlacements(
    q.all<PlacementRow>(
      `${PLACEMENTS} WHERE m.account_id = ? AND m.remote_id IN (${IDS}) ORDER BY m.id, f.remote_id`,
      accountId,
      JSON.stringify(ids),
    ),
  );
}

/** The ETag of each resource's master or single row (CalDAV resync keeps unchanged ones). */
function eventEtags(
  q: StoreReader,
  accountId: string,
  calendarRemoteId: string,
  ids: string[],
): ReadonlyMap<string, string> {
  if (!ids.length) return new Map();
  return new Map(
    q
      .all<{ remote_id: string; etag: string }>(
        `SELECT e.remote_id, e.etag FROM events e JOIN calendars c ON c.id = e.calendar_id
        WHERE c.account_id = ? AND c.remote_id = ? AND e.recurrence_id = '' AND e.etag IS NOT NULL
          AND e.remote_id IN (${IDS})`,
        accountId,
        calendarRemoteId,
        JSON.stringify(ids),
      )
      .map(r => [r.remote_id, r.etag]),
  );
}
