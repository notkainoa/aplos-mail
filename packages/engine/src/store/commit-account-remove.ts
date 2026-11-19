import { StoreError, type AccountRemoveWrite, type FileRemovedWrite } from './port';
import type { CommitRun } from './commit';

/*
 * Account removal (`Account/disconnect`). Foreign keys cascade from `accounts` through threads and messages to every
 * table the account owns, so one `DELETE FROM accounts` is the data delete. What a cascade cannot do is done first:
 * the contentless FTS rows (rowid = messages.id), the project-wide `governor_state` rows (no foreign key), and the
 * attachment file paths, which are queued for the host because the neutral engine cannot delete files.
 */

const SENDING =
  "SELECT 1 FROM submissions WHERE account_id = ? AND state IN ('sending', 'uncertain') LIMIT 1";

export function accountRemove(run: CommitRun, w: AccountRemoveWrite) {
  const id = w.accountId;
  if (!run.q('SELECT 1 FROM accounts WHERE id = ?').get(id))
    throw new StoreError('notFound', `Account ${id} is not in the store`);
  if (run.q(SENDING).get(id))
    throw new StoreError('conflict', `Account ${id} has a message that is sending`);
  const folders = run
    .q('SELECT remote_id FROM folders WHERE account_id = ?')
    .all<{ remote_id: string }>(id);
  const calendars = run
    .q('SELECT remote_id FROM calendars WHERE account_id = ?')
    .all<{ remote_id: string }>(id);
  const rules = run.q('SELECT id FROM sender_rules WHERE account_id = ?').all<{ id: number }>(id);
  queueFiles(run, id);
  run
    .q(
      'DELETE FROM messages_fts WHERE rowid IN (SELECT id FROM messages WHERE account_id = ? AND (parts & 8) <> 0)',
    )
    .run(id);
  run.q('DELETE FROM governor_state WHERE account_id = ?').run(id);
  // Plans cascade with the account; a `*` row re-reads the type like Thread's, cheaper than per-row marks.
  run.markId('Plan', id, '*');
  run
    .q(
      'DELETE FROM meta WHERE substr(key, 1, ?) = ? OR substr(key, 1, ?) = ? OR substr(key, 1, ?) = ?',
    )
    .run(
      `replydraft:${id}:`.length,
      `replydraft:${id}:`,
      `followup:${id}:`.length,
      `followup:${id}:`,
      `plans-empty:${id}:`.length,
      `plans-empty:${id}:`,
    );
  run.q('DELETE FROM accounts WHERE id = ?').run(id); // cascades the rest
  // Clients re-read what they hold for the account: one `*` row per bulk type, a `d` row for the few folders.
  run.markId('Thread', id, '*');
  run.markId('Message', id, '*');
  run.markId('Event', id, '*');
  run.markId('Draft', id, '*');
  run.markId('Submission', id, '*');
  for (const r of rules) run.markId('SenderRule', String(r.id), 'd');
  for (const f of folders) run.mark('Folder', id, f.remote_id, 'd');
  for (const c of calendars) run.mark('Calendar', id, c.remote_id, 'd');
  run.mark('Account', id, null, 'd');
  run.removedAccounts.add(id);
}

function queueFiles(run: CommitRun, accountId: string) {
  run
    .q(
      `INSERT OR IGNORE INTO file_removals(path, queued_at)
      SELECT DISTINCT a.path, ? FROM attachments a JOIN messages m ON m.id = a.message_id
      WHERE m.account_id = ? AND a.path IS NOT NULL`,
    )
    .run(run.now(), accountId);
}

/** The host removed these files (idempotent). */
export function fileRemoved(run: CommitRun, w: FileRemovedWrite) {
  if (!Array.isArray(w.paths) || w.paths.some(p => typeof p !== 'string'))
    throw new StoreError('invalid', 'fileRemoved needs a list of paths');
  const drop = run.q('DELETE FROM file_removals WHERE path = ?');
  for (const path of w.paths) drop.run(path);
}
