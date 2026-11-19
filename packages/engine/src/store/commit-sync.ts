import { StoreError, type MetaWrite, type SweepWrite, type SyncStateWrite } from './port';
import { MESSAGE_COLS, RESERVED_META, type CommitRun, type MessageRow } from './commit';

// ------------------------------------------------------------ bookkeeping

const MAX_PENDING = 500;

export function syncState(run: CommitRun, w: SyncStateWrite) {
  if (w.pending && w.pending.length > MAX_PENDING)
    throw new StoreError('invalid', `sync_state.pending holds at most ${MAX_PENDING} ids`);
  run
    .q(
      `INSERT INTO sync_state(account_id, scope, cursor, page_token, phase, oldest_loaded, generation, pending, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, scope) DO UPDATE SET cursor = excluded.cursor,
      page_token = excluded.page_token, phase = excluded.phase, oldest_loaded = excluded.oldest_loaded,
      generation = excluded.generation, pending = excluded.pending, updated_at = excluded.updated_at`,
    )
    .run(
      w.accountId,
      w.scope,
      w.cursor ?? null,
      w.pageToken ?? null,
      w.phase ?? null,
      w.oldestLoaded ?? null,
      w.generation,
      w.pending?.length ? JSON.stringify(w.pending) : null,
      run.now(),
    );
}

/** Placements the covering round did not re-stamp, inside its bound; NULL stamps (history, open, search) stay. */
export function sweep(run: CommitRun, w: SweepWrite) {
  if (!Number.isInteger(w.generation))
    throw new StoreError('invalid', 'A sweep needs an integer generation');
  const folder = run.q('SELECT id FROM folders WHERE account_id = ? AND remote_id = ?').get<{
    id: number;
  }>(w.accountId, w.folder);
  if (!folder) return;
  const gone = run
    .q(
      `SELECT ${MESSAGE_COLS} FROM message_folders mf JOIN messages m ON m.id = mf.message_id
    WHERE mf.folder_id = ?1 AND mf.seen_gen IS NOT NULL AND mf.seen_gen < ?2
      AND (?3 IS NULL OR m.internal_date > ?3) AND (?4 IS NULL OR m.internal_date < ?4)
      AND (?5 IS NULL OR mf.uid >= ?5) AND (?6 IS NULL OR mf.uid <= ?6)`,
    )
    .all<MessageRow>(
      folder.id,
      w.generation,
      w.since ?? null,
      w.until ?? null,
      w.uidFrom ?? null,
      w.uidTo ?? null,
    );
  const remove = run.q('DELETE FROM message_folders WHERE message_id = ? AND folder_id = ?');
  for (const m of gone) {
    if (run.fenced(m.local_seq)) continue;
    remove.run(m.id, folder.id);
    run.touchMessage(w.accountId, m);
  }
}

export function meta(run: CommitRun, w: MetaWrite) {
  if (RESERVED_META.has(w.key))
    throw new StoreError('invalid', `meta.${w.key} is written by the store only`);
  if (w.value === null) run.q('DELETE FROM meta WHERE key = ?').run(w.key);
  else
    run
      .q(
        'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(w.key, w.value);
}
