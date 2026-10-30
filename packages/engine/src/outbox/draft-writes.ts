import type { DraftFields } from '@aplos/contract';
import type { CommitExtensionTx, RemoteDraftWrite, SqlValue } from '../store';
import {
  announce,
  DRAFT_IDLE_MS,
  DRAFT_REMOVE_GRACE_MS,
  DraftConflict,
  fingerprintOf,
  keepsMine,
  liveOf,
  LIVE_SQL,
  needsUpload,
  packData,
  parseData,
  patched,
  remembered,
  theirsFields,
  type DraftMeta,
  type DraftRow,
  type MetaPatch,
} from './draft-state';

/**
 * The drafts' writers for the eng-time extension (seam 2): every change to a draft goes through `store.commit` as one of
 * these, inside the commit transaction. A save is a compare-and-set on `revision` (`UPDATE ... WHERE revision = ?` in
 * effect: the loser throws `DraftConflict` and the commit rolls back whole), so two saves on one base can never both
 * win, and a draft with a live submission cannot change (FR-7). The provider actor's `remoteDraft` facts land here too,
 * where another device's edit either replaces a draft nobody changed here or raises the conflict state.
 */

export type DraftChoice = 'keepMine' | 'takeTheirs' | 'keepBoth';

export type DraftWrite =
  | {
      kind: 'draft';
      op: 'save';
      id: string;
      accountId: string;
      /** Absent: create. */
      baseRevision?: number;
      fields: DraftFields;
      fingerprint: string;
      at: number;
      /** The editor closed: upload now instead of after the idle wait. */
      close?: true;
    }
  | {
      kind: 'draft';
      op: 'synced';
      id: string;
      /** The revision whose bytes the provider now holds. */
      revision: number;
      fingerprint: string;
      remoteDraftId: string;
      remoteMessageId: string;
      internetId: string;
      changeKey?: string;
      /** The copy left something out (an attachment it could not read): it is the draft's copy, but not this revision. */
      partial?: true;
      at: number;
    }
  | {
      /**
       * The upload of `revision` under `internetId` was answered `conflict` or `gone`. Only the attempt the row still
       * expects (`uploading.internetId`) raises it; an answer from an attempt a choice or a newer conflict replaced
       * is dropped, and an existing conflict is never replaced by it.
       */
      kind: 'draft';
      op: 'conflict';
      id: string;
      revision: number;
      internetId: string;
      gone: boolean;
      remoteMessageId?: string;
      at: number;
    }
  | {
      /**
       * An upload of `revision` was refused or got no answer; `at` is when to ask again. A refusal that wrote nothing
       * (`uncertain` false) for a revision that has since changed needs nothing: the newer revision has its own upload
       * due. A reply that may have been written leaves the copy unknown, so the current content is uploaded again.
       */
      kind: 'draft';
      op: 'retry';
      id: string;
      revision: number;
      at: number;
      uncertain: boolean;
    }
  | {
      kind: 'draft';
      op: 'meta';
      id: string;
      patch: MetaPatch;
      /** The patch belongs to this revision; a newer one wins. */
      ifRevision?: number;
      /** The patch belongs to the upload attempt under this Message-ID; once a choice or a newer attempt replaced it, it is dropped. */
      ifUploading?: string;
      /** Tell the owner's other windows (`Draft/changed`). */
      announce?: true;
    }
  | { kind: 'draft'; op: 'resolve'; id: string; choice: DraftChoice; at: number; copyId: string };

export interface DraftDeleteWrite {
  kind: 'draftDelete';
  id: string;
  at: number;
  /** The provider confirmed the copy is gone: the hidden row goes too. */
  final?: true;
}

declare module '../store/port' {
  interface ExtensionWrites {
    draft: DraftWrite;
    draftDelete: DraftDeleteWrite;
  }
}

// ---------------------------------------------------------------- helpers

function readRow(tx: CommitExtensionTx, id: string): DraftRow {
  const row = tx.get<DraftRow>('SELECT * FROM drafts WHERE id = ?', id);
  if (!row) throw new DraftConflict('missing');
  return row;
}

/** Rewrites a row's data (with a fresh `rev`) and the given columns, and records the change. */
function writeRow(
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

function remotePart(accountId: string, contractId: string | undefined) {
  const prefix = `${accountId}:`;
  return contractId?.startsWith(prefix) ? contractId.slice(prefix.length) : undefined;
}

/** The internal thread row a reply belongs to, when the thread is stored. */
function threadRow(tx: CommitExtensionTx, accountId: string, fields: DraftFields) {
  const remote = remotePart(accountId, fields.threadId);
  return (remote !== undefined ? tx.threadRowId(accountId, remote) : undefined) ?? null;
}

function insertRow(
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
function dueAfter(
  fields: DraftFields,
  meta: DraftMeta,
  hasRemote: boolean,
  at: number,
  close: boolean,
) {
  if (meta.conflict || !needsUpload(fields, meta, hasRemote)) return undefined;
  return close ? at : at + DRAFT_IDLE_MS;
}

// ---------------------------------------------------------------- save

function insertSaved(tx: CommitExtensionTx, w: Extract<DraftWrite, { op: 'save' }>) {
  const meta: DraftMeta = { rev: tx.seq, cur: w.fingerprint };
  const due = dueAfter(w.fields, meta, false, w.at, w.close === true);
  if (due !== undefined) meta.dueAt = due;
  insertRow(tx, {
    id: w.id,
    accountId: w.accountId,
    fields: w.fields,
    meta,
    at: w.at,
    origin: 'local',
  });
}

function save(tx: CommitExtensionTx, w: Extract<DraftWrite, { op: 'save' }>) {
  const row = tx.get<DraftRow>('SELECT * FROM drafts WHERE id = ?', w.id);
  if (w.baseRevision === undefined) {
    if (row) throw new DraftConflict('exists');
    return insertSaved(tx, w);
  }
  if (!row) throw new DraftConflict('missing');
  const { fields: current, meta } = parseData(row.data);
  if (meta.removing) throw new DraftConflict('missing');
  // Editing a snippet would upload it over the full draft on the other device.
  if (meta.incomplete) throw new DraftConflict('bodyPending');
  if (row.revision !== w.baseRevision) throw new DraftConflict('stale');
  const live = liveOf(tx, row.id);
  if (live) throw new DraftConflict('live', live.state);
  const hasRemote = row.remote_draft_id !== null;
  const next = patched(meta, { cur: w.fingerprint, problem: null });
  const due = dueAfter(w.fields, next, hasRemote, w.at, w.close === true);
  // The same content again is not a new revision (other windows would see a change that is not one), but a close still
  // asks for the upload now.
  if (row.origin === 'local' && meta.cur === w.fingerprint) {
    if (due === undefined || (meta.dueAt !== undefined && meta.dueAt <= due)) return;
    return writeRow(tx, row.id, {}, current, { ...meta, dueAt: due });
  }
  writeRow(
    tx,
    row.id,
    {
      revision: row.revision + 1,
      thread_id: threadRow(tx, row.account_id, w.fields),
      origin: 'local',
      updated_at: w.at,
    },
    w.fields,
    patched(next, { dueAt: due ?? null }),
  );
}

// ---------------------------------------------------------------- sync results

function synced(tx: CommitExtensionTx, w: Extract<DraftWrite, { op: 'synced' }>) {
  const row = readRow(tx, w.id);
  const { fields, meta } = parseData(row.data);
  // An ack for an upload this row no longer expects (a conflict, a choice or a newer attempt cleared `uploading`) says
  // what the provider now holds, not what this draft is: only its ids are kept, to recognise their echo in history.
  if (meta.uploading?.internetId !== w.internetId) {
    const wrote = remembered(meta, w.internetId, w.remoteMessageId);
    return writeRow(tx, w.id, {}, fields, patched(meta, { wrote }));
  }
  const same = (meta.cur ?? fingerprintOf(fields)) === w.fingerprint;
  // An edit that landed during the upload keeps its own upload due; this copy is the revision that was sent.
  const done = row.revision === w.revision || same;
  // A draft waiting for a choice, or for its copy to be deleted, uploads nothing more.
  const idle = done || meta.conflict !== undefined || meta.removing === true;
  const next = patched(meta, {
    // A copy that left something out is not the content this fingerprint names.
    fingerprint: w.partial ? null : w.fingerprint,
    uploading: null,
    problem: null,
    wrote: remembered(meta, w.internetId, w.remoteMessageId),
    dueAt: idle ? null : (meta.dueAt ?? w.at),
    // A discarded draft's upload landed: the copy it made is the one to delete, now.
    removeAt: meta.removing ? w.at : null,
  });
  writeRow(
    tx,
    w.id,
    {
      remote_draft_id: w.remoteDraftId,
      remote_message_id: w.remoteMessageId,
      remote_internet_id: w.internetId,
      synced_revision: w.partial ? null : w.revision,
      remote_change_key: w.changeKey ?? null,
    },
    fields,
    next,
  );
}

function uploadConflict(tx: CommitExtensionTx, w: Extract<DraftWrite, { op: 'conflict' }>) {
  const row = readRow(tx, w.id);
  if (row.revision !== w.revision) throw new DraftConflict('stale');
  const { fields, meta } = parseData(row.data);
  if (meta.uploading?.internetId !== w.internetId) return;
  const gone = w.gone;
  // The copy is gone: its id names nothing a delete or a replace may touch (on some providers it is now the sent message).
  const columns = gone ? FORGET_REMOTE : {};
  if (meta.removing || meta.conflict)
    return writeRow(tx, row.id, columns, fields, patched(meta, { uploading: null }));
  const seen = (meta.theirsSeen ?? 0) + 1;
  const conflict: NonNullable<DraftMeta['conflict']> = { theirsRevision: seen, at: w.at };
  if (gone) conflict.gone = true;
  else if (w.remoteMessageId !== undefined) conflict.theirsMessageId = w.remoteMessageId;
  const patch = { conflict, theirsSeen: seen, dueAt: null, uploading: null, announce: tx.seq };
  writeRow(tx, row.id, columns, fields, patched(meta, patch));
  announce(row.id);
}

function retry(tx: CommitExtensionTx, w: Extract<DraftWrite, { op: 'retry' }>) {
  const row = readRow(tx, w.id);
  const { fields, meta } = parseData(row.data);
  if (meta.removing) {
    // A discarded draft with no copy and no upload coming has nothing left to wait for.
    if (!w.uncertain && row.remote_draft_id === null) deleteHidden(tx, row.id);
    return;
  }
  if (meta.conflict) return;
  if (row.revision === w.revision)
    return writeRow(tx, w.id, {}, fields, patched(meta, { dueAt: w.at }));
  if (!w.uncertain) return;
  // The reply may hide a write of the old revision: the copy is not the one the fingerprint names. Upload what the
  // draft holds now. The old attempt's Message-ID is kept in `wrote`, so history reporting that copy is recognised.
  const old = meta.uploading ? [meta.uploading.internetId] : [];
  writeRow(
    tx,
    w.id,
    {},
    fields,
    patched(meta, {
      fingerprint: null,
      uploading: null,
      wrote: remembered(meta, ...old),
      dueAt: meta.dueAt ?? w.at,
    }),
  );
}

function setMeta(tx: CommitExtensionTx, w: Extract<DraftWrite, { op: 'meta' }>) {
  const row = readRow(tx, w.id);
  if (w.ifRevision !== undefined && row.revision !== w.ifRevision) throw new DraftConflict('stale');
  const { fields, meta } = parseData(row.data);
  if (w.ifUploading !== undefined && meta.uploading?.internetId !== w.ifUploading)
    throw new DraftConflict('stale');
  const base = w.announce ? { ...meta, announce: tx.seq } : meta;
  writeRow(tx, w.id, {}, fields, patched(base, w.patch));
  if (w.announce) announce(w.id);
}

// ---------------------------------------------------------------- resolve

const FORGET_REMOTE = {
  remote_draft_id: null,
  remote_message_id: null,
  remote_internet_id: null,
  synced_revision: null,
  remote_change_key: null,
};

function keepMine(tx: CommitExtensionTx, row: DraftRow, at: number) {
  const { fields, meta } = parseData(row.data);
  const gone = meta.conflict?.gone === true;
  const theirsId = meta.conflict?.theirsMessageId;
  // The remote copy is theirs now, so what this device holds replaces it: its fingerprint no longer applies.
  const next = patched(meta, { conflict: null, fingerprint: null, announce: tx.seq });
  const due = dueAfter(fields, next, !gone, at, true);
  // Until the upload lands the copy is theirs: it is not this revision, and our Message-ID does not name it, so a send
  // right now leaves the pinned MIME instead of their copy.
  const columns: Record<string, SqlValue> = gone
    ? FORGET_REMOTE
    : { synced_revision: null, remote_internet_id: null, remote_change_key: null };
  // A conflict that named no copy leaves no base: the upload replaces whatever is there, as the owner chose.
  if (!gone) columns.remote_message_id = theirsId ?? null;
  writeRow(tx, row.id, columns, fields, patched(next, { dueAt: due ?? null }));
}

/** The other version, when it can be shown whole; a snippet is not a version to keep. */
function readableTheirs(conflict: NonNullable<DraftMeta['conflict']>): DraftFields {
  if (!conflict.theirs) throw new DraftConflict('noTheirs');
  if (conflict.complete !== true) throw new DraftConflict('incomplete');
  return conflict.theirs;
}

function takeTheirs(tx: CommitExtensionTx, row: DraftRow, at: number) {
  const { meta } = parseData(row.data);
  const conflict = meta.conflict!;
  if (conflict.gone) {
    tx.run('DELETE FROM drafts WHERE id = ?', row.id);
    tx.mark('Draft', row.id, 'd');
    return;
  }
  const theirs = readableTheirs(conflict);
  const fp = fingerprintOf(theirs);
  // The copy is theirs, so its Message-ID is theirs too; when history did not report one nothing may claim ours.
  const known = conflict.theirsInternetId !== undefined;
  const next = patched(meta, {
    conflict: null,
    cur: fp,
    fingerprint: fp,
    dueAt: null,
    problem: null,
    announce: tx.seq,
  });
  writeRow(
    tx,
    row.id,
    {
      revision: row.revision + 1,
      remote_message_id: conflict.theirsMessageId ?? row.remote_message_id,
      remote_internet_id: conflict.theirsInternetId ?? null,
      synced_revision: known && !keepsMine(theirs) ? row.revision + 1 : null,
      remote_change_key: null,
      updated_at: at,
    },
    theirs,
    next,
  );
}

function keepBoth(tx: CommitExtensionTx, row: DraftRow, w: Extract<DraftWrite, { op: 'resolve' }>) {
  const { meta } = parseData(row.data);
  const conflict = meta.conflict!;
  if (!conflict.gone) {
    const theirs = readableTheirs(conflict);
    // The other version becomes a second draft of its own, uploaded as a new one.
    const copy: DraftMeta = { rev: tx.seq, cur: fingerprintOf(theirs) };
    const due = dueAfter(theirs, copy, false, w.at, false);
    if (due !== undefined) copy.dueAt = due;
    insertRow(tx, {
      id: w.copyId,
      accountId: row.account_id,
      fields: theirs,
      meta: copy,
      at: w.at,
      origin: 'local',
    });
  }
  keepMine(tx, row, w.at);
}

function resolve(tx: CommitExtensionTx, w: Extract<DraftWrite, { op: 'resolve' }>) {
  const row = readRow(tx, w.id);
  const { meta } = parseData(row.data);
  if (meta.removing) throw new DraftConflict('missing');
  if (!meta.conflict) throw new DraftConflict('stale');
  const live = liveOf(tx, row.id);
  if (live) throw new DraftConflict('live', live.state);
  if (w.choice === 'keepMine') keepMine(tx, row, w.at);
  else if (w.choice === 'takeTheirs') takeTheirs(tx, row, w.at);
  else keepBoth(tx, row, w);
  announce(w.id);
}

export function applyDraft(write: { kind: string }, tx: CommitExtensionTx) {
  const w = write as DraftWrite;
  if (w.op === 'save') return save(tx, w);
  if (w.op === 'synced') return synced(tx, w);
  if (w.op === 'conflict') return uploadConflict(tx, w);
  if (w.op === 'retry') return retry(tx, w);
  if (w.op === 'meta') return setMeta(tx, w);
  if (w.op === 'resolve') return resolve(tx, w);
  throw new Error(`Unknown draft write ${String((w as { op?: unknown }).op)}`);
}

function deleteHidden(tx: CommitExtensionTx, id: string) {
  tx.run('DELETE FROM drafts WHERE id = ?', id);
  tx.mark('Draft', id, 'd');
}

/**
 * A discarded or sent draft leaves every reader at once. When a remote copy exists (or an upload that may make one is
 * running) the row stays, hidden, until the provider confirms the copy is gone; `final` is that confirmation.
 */
export function applyDraftDelete(write: { kind: string }, tx: CommitExtensionTx) {
  const w = write as DraftDeleteWrite;
  const row = tx.get<DraftRow>('SELECT * FROM drafts WHERE id = ?', w.id);
  if (!row) return;
  const { fields, meta } = parseData(row.data);
  if (w.final) return meta.removing ? deleteHidden(tx, w.id) : undefined;
  if (meta.removing) return;
  const live = liveOf(tx, w.id);
  if (live) throw new DraftConflict('live', live.state);
  if (row.remote_draft_id === null && !meta.uploading) return deleteHidden(tx, w.id);
  // Before the copy is known the removal waits for the upload's result, or for history to report the copy.
  const removeAt = row.remote_draft_id !== null ? w.at : w.at + DRAFT_REMOVE_GRACE_MS;
  const hidden = patched(meta, {
    removing: true,
    removeAt,
    removeTries: null,
    dueAt: null,
    conflict: null,
    problem: null,
  });
  tx.run(
    'UPDATE drafts SET data = ? WHERE id = ?',
    packData(fields, { ...hidden, rev: tx.seq }),
    w.id,
  );
  tx.mark('Draft', w.id, 'd');
}

// ---------------------------------------------------------------- remote facts

type RemoteMessage = NonNullable<RemoteDraftWrite['message']>;

/** The write's metadata in the shape `theirsFields` reads. `html` is read when a provider delivers the body with it. */
function messageOf(w: RemoteDraftWrite) {
  return w.message as (RemoteMessage & { html?: string }) | undefined;
}

function remoteThreadId(w: RemoteDraftWrite) {
  return w.remoteThreadId === undefined ? undefined : `${w.accountId}:${w.remoteThreadId}`;
}

function insertRemote(tx: CommitExtensionTx, w: RemoteDraftWrite) {
  const { fields, complete } = theirsFields(w.accountId, messageOf(w));
  const thread = remoteThreadId(w);
  if (thread !== undefined) fields.threadId = thread;
  const fp = fingerprintOf(fields);
  const meta: DraftMeta = { rev: tx.seq, cur: fp, fingerprint: fp, announce: tx.seq };
  if (!complete) meta.incomplete = true;
  insertRow(tx, {
    id: `${w.accountId}:${w.remoteDraftId}`,
    accountId: w.accountId,
    fields,
    meta,
    at: w.changedAt,
    origin: 'remote',
    remote: w,
  });
  announce(`${w.accountId}:${w.remoteDraftId}`);
}

/**
 * The draft whose upload (not yet recorded) history reports: the Message-ID is the one that upload was made under,
 * whether it is still running (`uploading`) or was set aside for a newer revision (`wrote`).
 */
function ownUpload(tx: CommitExtensionTx, w: RemoteDraftWrite) {
  if (w.internetId === undefined) return undefined;
  return tx.get<DraftRow>(
    `SELECT * FROM drafts WHERE account_id = ?
       AND (json_extract(data, '$._sync.uploading.internetId') = ?
         OR EXISTS (SELECT 1 FROM json_each(data, '$._sync.wrote') WHERE value = ?)) LIMIT 1`,
    w.accountId,
    w.internetId,
    w.internetId,
  );
}

/**
 * An upload landed without its result being recorded. A discarded draft's copy is the one to delete; a live draft with
 * no copy yet takes it as its own, so its next upload replaces it instead of making a second one.
 */
function adoptCopy(tx: CommitExtensionTx, row: DraftRow, w: RemoteDraftWrite) {
  const { fields, meta } = parseData(row.data);
  if (row.remote_draft_id !== null || w.removed) return;
  writeRow(
    tx,
    row.id,
    { remote_draft_id: w.remoteDraftId, remote_message_id: w.remoteMessageId },
    fields,
    patched(
      meta,
      meta.removing ? { removeAt: w.changedAt } : { wrote: remembered(meta, w.remoteMessageId) },
    ),
  );
  announce(row.id);
}

function isEcho(w: RemoteDraftWrite, row: DraftRow, meta: DraftMeta) {
  const wrote = meta.wrote ?? [];
  return (
    w.remoteMessageId === row.remote_message_id ||
    wrote.includes(w.remoteMessageId) ||
    (w.internetId !== undefined &&
      (wrote.includes(w.internetId) || meta.uploading?.internetId === w.internetId))
  );
}

function deleteRow(tx: CommitExtensionTx, row: DraftRow) {
  tx.run('DELETE FROM drafts WHERE id = ?', row.id);
  tx.mark('Draft', row.id, 'd');
  announce(row.id);
}

function refreshRemote(tx: CommitExtensionTx, row: DraftRow, w: RemoteDraftWrite) {
  if (w.removed) return deleteRow(tx, row);
  const { fields: base, meta } = parseData(row.data);
  const same = w.remoteMessageId === row.remote_message_id;
  // The same version again changes nothing, unless it brings the text a snippet-only draft was waiting for.
  if (same && !(meta.incomplete && messageOf(w)?.html !== undefined)) return;
  const { fields, complete } = theirsFields(row.account_id, messageOf(w), base);
  const fp = fingerprintOf(fields);
  // Their copy's Message-ID, or none: the previous copy's id does not name a newer one.
  const internetId = w.internetId ?? (same ? row.remote_internet_id : null);
  writeRow(
    tx,
    row.id,
    {
      revision: row.revision + 1,
      remote_message_id: w.remoteMessageId,
      remote_internet_id: internetId,
      synced_revision: internetId !== null && !keepsMine(fields) ? row.revision + 1 : null,
      updated_at: w.changedAt,
    },
    fields,
    patched(meta, {
      cur: fp,
      fingerprint: fp,
      incomplete: complete ? null : true,
      announce: tx.seq,
    }),
  );
  announce(row.id);
}

/** The other device changed (or removed) a draft this device also holds: replace it, or ask. */
function raise(
  tx: CommitExtensionTx,
  row: DraftRow,
  meta: DraftMeta,
  fields: DraftFields,
  w: RemoteDraftWrite,
  theirs: { fields: DraftFields; complete: boolean } | undefined,
) {
  // The same copy described again (an upload's bare conflict, then history) completes the conflict; it is not a new one.
  const prior = meta.conflict?.theirsMessageId === w.remoteMessageId ? meta.conflict : undefined;
  const seen = prior ? prior.theirsRevision : (meta.theirsSeen ?? 0) + 1;
  const conflict: NonNullable<DraftMeta['conflict']> = {
    ...prior,
    theirsRevision: seen,
    at: w.changedAt,
    theirsMessageId: w.remoteMessageId,
  };
  if (w.internetId !== undefined) conflict.theirsInternetId = w.internetId;
  if (w.removed) conflict.gone = true;
  else if (theirs) {
    conflict.theirs = theirs.fields;
    conflict.complete = theirs.complete;
  }
  // A copy that is gone is forgotten before the row can be hidden: its id may now name a sent message, and a delete or a
  // replace of it must never be asked.
  writeRow(
    tx,
    row.id,
    w.removed ? FORGET_REMOTE : {},
    fields,
    patched(meta, { conflict, theirsSeen: seen, dueAt: null, uploading: null, announce: tx.seq }),
  );
  announce(row.id);
}

function replaceWithTheirs(
  tx: CommitExtensionTx,
  row: DraftRow,
  meta: DraftMeta,
  theirs: DraftFields,
  w: RemoteDraftWrite,
) {
  const fp = fingerprintOf(theirs);
  writeRow(
    tx,
    row.id,
    {
      revision: row.revision + 1,
      remote_message_id: w.remoteMessageId,
      remote_internet_id: w.internetId ?? null,
      synced_revision: w.internetId !== undefined && !keepsMine(theirs) ? row.revision + 1 : null,
      remote_change_key: null,
      updated_at: w.changedAt,
    },
    theirs,
    patched(meta, {
      cur: fp,
      fingerprint: fp,
      theirsSeen: (meta.theirsSeen ?? 0) + 1,
      announce: tx.seq,
    }),
  );
  announce(row.id);
}

function editedElsewhere(tx: CommitExtensionTx, row: DraftRow, w: RemoteDraftWrite) {
  const { fields, meta } = parseData(row.data);
  if (isEcho(w, row, meta)) return;
  // A send of this draft (or one that just went out) removes or changes its copy itself.
  if (
    tx.get(
      `SELECT 1 FROM submissions WHERE draft_id = ? AND state IN (${LIVE_SQL}, 'sent') LIMIT 1`,
      row.id,
    )
  )
    return;
  // The same version again is known, unless it brings what the conflict lacks (their body).
  const known = meta.conflict;
  if (
    known?.theirsMessageId === w.remoteMessageId &&
    (known.complete === true || (known.theirs !== undefined && messageOf(w)?.html === undefined))
  )
    return;
  const clean =
    !meta.conflict &&
    meta.dueAt === undefined &&
    !meta.problem &&
    meta.fingerprint !== undefined &&
    (meta.cur ?? fingerprintOf(fields)) === meta.fingerprint;
  if (w.removed) return clean ? deleteRow(tx, row) : raise(tx, row, meta, fields, w, undefined);
  const theirs = theirsFields(row.account_id, messageOf(w), fields);
  // Without the body (metadata only) nothing is replaced silently: the owner chooses.
  if (clean && theirs.complete) return replaceWithTheirs(tx, row, meta, theirs.fields, w);
  raise(tx, row, meta, fields, w, theirs);
}

/** A `remoteDraft` fact from the provider actor (D9). */
export function applyRemoteDraft(write: { kind: string }, tx: CommitExtensionTx) {
  const w = write as RemoteDraftWrite;
  const row = tx.get<DraftRow>(
    'SELECT * FROM drafts WHERE account_id = ? AND remote_draft_id = ?',
    w.accountId,
    w.remoteDraftId,
  );
  if (!row) {
    if (w.removed) return;
    const own = ownUpload(tx, w);
    return own ? adoptCopy(tx, own, w) : insertRemote(tx, w);
  }
  if (parseData(row.data).meta.removing) {
    // Discarded here: a fact for its copy is not another device's draft. The copy being gone ends the wait.
    return w.removed ? deleteHidden(tx, row.id) : undefined;
  }
  if (row.origin === 'remote') return refreshRemote(tx, row, w);
  editedElsewhere(tx, row, w);
}
