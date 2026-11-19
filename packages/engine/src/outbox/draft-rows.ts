import type { DraftFields } from '@aplos/contract';
import type { CommitExtensionTx, RemoteDraftWrite, SqlValue } from '../store';
import {
  announce,
  DRAFT_IDLE_MS,
  DraftConflict,
  fingerprintOf,
  needsUpload,
  packData,
  type DraftMeta,
  type DraftRow,
} from './draft-state';

/**
 * The row-level helpers of the drafts' writers: read, rewrite and insert a draft row, the next upload's due time, and
 * the ids of rows made from another device's version. Split out of `draft-writes.ts` (the line limit); no policy here.
 */

export function readRow(tx: CommitExtensionTx, id: string): DraftRow {
  const row = tx.get<DraftRow>('SELECT * FROM drafts WHERE id = ?', id);
  if (!row) throw new DraftConflict('missing');
  return row;
}

/** Rewrites a row's data (with a fresh `rev`) and the given columns, and records the change. */
export function writeRow(
  tx: CommitExtensionTx,
  id: string,
  columns: Record<string, SqlValue>,
  fields: DraftFields,
  meta: DraftMeta,
) {
  const set = { ...columns, data: packData(fields, { ...meta, rev: tx.seq }) };
  tx.run(
    `UPDATE drafts SET ${Object.keys(set)
      .map(k => `${k} = ?`)
      .join(', ')} WHERE id = ?`,
    ...Object.values(set),
    id,
  );
  tx.mark('Draft', id, 'u');
}

export function remotePart(accountId: string, contractId: string | undefined) {
  const prefix = `${accountId}:`;
  return contractId?.startsWith(prefix) ? contractId.slice(prefix.length) : undefined;
}

/** The internal thread row a reply belongs to, when the thread is stored. */
export function threadRow(tx: CommitExtensionTx, accountId: string, fields: DraftFields) {
  const remote = remotePart(accountId, fields.threadId);
  return (remote !== undefined ? tx.threadRowId(accountId, remote) : undefined) ?? null;
}

export function insertRow(
  tx: CommitExtensionTx,
  row: {
    id: string;
    accountId: string;
    fields: DraftFields;
    meta: DraftMeta;
    at: number;
    origin: 'local' | 'remote';
    remote?: Pick<RemoteDraftWrite, 'remoteDraftId' | 'remoteMessageId' | 'internetId'>;
  },
) {
  tx.run(
    `INSERT INTO drafts(id, account_id, thread_id, revision, data, remote_draft_id, remote_message_id,
       remote_internet_id, synced_revision, origin, updated_at)
     VALUES(?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.accountId,
    threadRow(tx, row.accountId, row.fields),
    packData(row.fields, { ...row.meta, rev: tx.seq }),
    row.remote?.remoteDraftId ?? null,
    row.remote?.remoteMessageId ?? null,
    row.remote?.internetId ?? null,
    row.remote ? 1 : null,
    row.origin,
    row.at,
  );
  tx.mark('Draft', row.id, 'u');
}

/** When the next upload is due after a change, or undefined when the remote copy already holds this content. */
export function dueAfter(
  fields: DraftFields,
  meta: DraftMeta,
  hasRemote: boolean,
  at: number,
  close: boolean,
) {
  if (meta.conflict || !needsUpload(fields, meta, hasRemote)) return undefined;
  return close ? at : at + DRAFT_IDLE_MS;
}

/**
 * The version keep mine just stepped away from stays on the provider, and nothing would show it here until another
 * report: it becomes an incomplete remote draft of its own (a discard never deletes an incomplete draft's copy).
 */
export function showUnseen(tx: CommitExtensionTx, row: DraftRow, conflict: DraftMeta['conflict']) {
  const { theirs, theirsMessageId: messageId } = conflict ?? {};
  if (!theirs || !messageId || row.remote_draft_id === null) return;
  const fp = fingerprintOf(theirs);
  const id = freshId(tx, `${row.account_id}:${row.remote_draft_id}`);
  const meta: DraftMeta = {
    rev: tx.seq,
    cur: fp,
    fingerprint: fp,
    incomplete: true,
    announce: tx.seq,
  };
  const remote = { remoteDraftId: row.remote_draft_id, remoteMessageId: messageId };
  insertRow(tx, {
    id,
    accountId: row.account_id,
    fields: theirs,
    meta,
    at: row.updated_at,
    origin: 'remote',
    remote,
  });
  announce(id);
}

/** `usual`, or a fresh id when a draft or a submission already carries it (a phone draft that was sent has it). */
export function freshId(tx: CommitExtensionTx, usual: string) {
  const taken =
    tx.get('SELECT 1 FROM drafts WHERE id = ?', usual) ??
    tx.get('SELECT 1 FROM submissions WHERE draft_id = ?', usual);
  return taken ? `${usual}~${tx.seq}` : usual;
}
