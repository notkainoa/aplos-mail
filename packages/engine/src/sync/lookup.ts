import type { AccountId, KnownLookup, Placement, StorePort } from '../ports';

/**
 * F3 `KnownLookup` over `store.read`, read-only. The port names `eng-store` as its implementer; none exists yet, so the
 * actor host uses this stand-in unless one is injected (`ActorHostOptions.lookup`). Id lists go in as one JSON array
 * parameter (`json_each`), so every query is one cached statement whatever the list length.
 */
export function storeLookup(store: StorePort, account: AccountId): KnownLookup {
  const ids = (values: readonly string[]) => JSON.stringify(values);
  const set = (sql: string, values: readonly string[]) =>
    Promise.resolve(
      values.length
        ? new Set(store.read(q => q.all<{ id: string }>(sql, account, ids(values)).map(r => r.id)))
        : new Set<string>(),
    );
  const placements = (remoteIds: readonly string[]) => {
    const rows = remoteIds.length
      ? store.read(q =>
          q.all<{ id: string; folder: string; uid: number | null }>(
            `SELECT m.remote_id AS id, f.remote_id AS folder, mf.uid AS uid FROM messages m
            JOIN message_folders mf ON mf.message_id = m.id JOIN folders f ON f.id = mf.folder_id
            WHERE m.account_id = ? AND m.remote_id IN (SELECT value FROM json_each(?)) ORDER BY m.id, f.remote_id`,
            account,
            ids(remoteIds),
          ),
        )
      : [];
    const map = new Map<string, Placement[]>();
    for (const r of rows) {
      const list = map.get(r.id) ?? [];
      list.push(r.uid === null ? { folder: r.folder } : { folder: r.folder, uid: r.uid });
      map.set(r.id, list);
    }
    return map;
  };
  return {
    knownThreads: remoteThreadIds =>
      set(
        'SELECT remote_id AS id FROM threads WHERE account_id = ? AND remote_id IN (SELECT value FROM json_each(?))',
        remoteThreadIds,
      ),
    knownMessages: remoteIds =>
      set(
        'SELECT remote_id AS id FROM messages WHERE account_id = ? AND remote_id IN (SELECT value FROM json_each(?))',
        remoteIds,
      ),
    trackedDraftIds: remoteDraftIds =>
      set(
        'SELECT remote_draft_id AS id FROM drafts WHERE account_id = ? AND remote_draft_id IN (SELECT value FROM json_each(?))',
        remoteDraftIds,
      ),
    async draftsByMessageId(remoteMessageIds) {
      if (!remoteMessageIds.length) return new Map();
      const rows = store.read(q =>
        q.all<{ message: string; draft: string }>(
          `SELECT remote_message_id AS message, remote_draft_id AS draft FROM drafts
          WHERE account_id = ? AND remote_draft_id IS NOT NULL AND remote_message_id IN (SELECT value FROM json_each(?))`,
          account,
          ids(remoteMessageIds),
        ),
      );
      return new Map(rows.map(r => [r.message, r.draft]));
    },
    async threadMessages(remoteThreadId) {
      const remoteIds = store
        .read(q =>
          q.all<{ id: string }>(
            `SELECT m.remote_id AS id FROM messages m JOIN threads t ON t.id = m.thread_id
            WHERE t.account_id = ? AND t.remote_id = ? ORDER BY m.id`,
            account,
            remoteThreadId,
          ),
        )
        .map(r => r.id);
      const map = placements(remoteIds);
      return remoteIds.map(remoteId => ({ remoteId, placements: map.get(remoteId) ?? [] }));
    },
    placements: async remoteIds => placements(remoteIds),
    async folderUids(folder, uidFrom, uidTo) {
      return store
        .read(q =>
          q.all<{ uid: number }>(
            `SELECT mf.uid AS uid FROM message_folders mf JOIN folders f ON f.id = mf.folder_id
            WHERE f.account_id = ? AND f.remote_id = ? AND mf.uid BETWEEN ? AND ? ORDER BY mf.uid`,
            account,
            folder,
            uidFrom,
            uidTo,
          ),
        )
        .map(r => r.uid);
    },
    async eventEtags(calendarRemoteId, remoteIds) {
      if (!remoteIds.length) return new Map();
      const rows = store.read(q =>
        q.all<{ id: string; etag: string }>(
          `SELECT e.remote_id AS id, e.etag AS etag FROM events e JOIN calendars c ON c.id = e.calendar_id
          WHERE c.account_id = ? AND c.remote_id = ? AND e.recurrence_id = '' AND e.etag IS NOT NULL
            AND e.remote_id IN (SELECT value FROM json_each(?))`,
          account,
          calendarRemoteId,
          ids(remoteIds),
        ),
      );
      return new Map(rows.map(r => [r.id, r.etag]));
    },
  };
}
