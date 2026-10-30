import type { DraftFields } from '@aplos/contract';
import type { CommitExtensionTx, RemoteDraftWrite, SqlValue } from '../store';
import {
  announce,
  DRAFT_IDLE_MS,
  DraftConflict,
  fingerprintOf,
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
      at: number;
    }
  | {
      kind: 'draft';
      op: 'meta';
      id: string;
      patch: MetaPatch;
      /** The patch belongs to this revision; a newer one wins. */
      ifRevision?: number;
      /** Tell the owner's other windows (`Draft/changed`). */
      announce?: true;
    }
  | { kind: 'draft'; op: 'resolve'; id: string; choice: DraftChoice; at: number; copyId: string };

export interface DraftDeleteWrite {
  kind: 'draftDelete';
  id: string;
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
  if (row.revision !== w.baseRevision) throw new DraftConflict('stale');
  const live = liveOf(tx, row.id);
  if (live) throw new DraftConflict('live', live.state);
  const { fields: current, meta } = parseData(row.data);
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
  const same = (meta.cur ?? fingerprintOf(fields)) === w.fingerprint;
  // An edit that landed during the upload keeps its own upload due; this copy is the revision that was sent.
  const done = row.revision === w.revision || same;
  const next = patched(meta, {
    fingerprint: w.fingerprint,
    uploading: null,
    problem: null,
    wrote: remembered(meta, w.internetId, w.remoteMessageId),
    dueAt: done ? null : (meta.dueAt ?? w.at),
  });
  writeRow(
    tx,
    w.id,
    {
      remote_draft_id: w.remoteDraftId,
      remote_message_id: w.remoteMessageId,
      remote_internet_id: w.internetId,
      synced_revision: w.revision,
      remote_change_key: w.changeKey ?? null,
    },
    fields,
    next,
  );
}

function setMeta(tx: CommitExtensionTx, w: Extract<DraftWrite, { op: 'meta' }>) {
  const row = readRow(tx, w.id);
  if (w.ifRevision !== undefined && row.revision !== w.ifRevision) throw new DraftConflict('stale');
  const { fields, meta } = parseData(row.data);
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
  const columns: Record<string, SqlValue> = gone ? FORGET_REMOTE : {};
  if (!gone && theirsId !== undefined) columns.remote_message_id = theirsId;
  writeRow(tx, row.id, columns, fields, patched(next, { dueAt: due ?? null }));
}

function takeTheirs(tx: CommitExtensionTx, row: DraftRow, at: number) {
  const { meta } = parseData(row.data);
  const conflict = meta.conflict!;
  if (conflict.gone) {
    tx.run('DELETE FROM drafts WHERE id = ?', row.id);
    tx.mark('Draft', row.id, 'd');
    return;
  }
  if (!conflict.theirs) throw new DraftConflict('noTheirs');
  const fp = fingerprintOf(conflict.theirs);
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
      synced_revision: row.revision + 1,
      updated_at: at,
    },
    conflict.theirs,
    next,
  );
}

function keepBoth(tx: CommitExtensionTx, row: DraftRow, w: Extract<DraftWrite, { op: 'resolve' }>) {
  const { meta } = parseData(row.data);
  const conflict = meta.conflict!;
  if (!conflict.gone) {
    if (!conflict.theirs) throw new DraftConflict('noTheirs');
    // The other version becomes a second draft of its own, uploaded as a new one.
    const copy: DraftMeta = { rev: tx.seq, cur: fingerprintOf(conflict.theirs) };
    const due = dueAfter(conflict.theirs, copy, false, w.at, false);
    if (due !== undefined) copy.dueAt = due;
    insertRow(tx, {
      id: w.copyId,
      accountId: row.account_id,
      fields: conflict.theirs,
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
  if (w.op === 'meta') return setMeta(tx, w);
  if (w.op === 'resolve') return resolve(tx, w);
  throw new Error(`Unknown draft write ${String((w as { op?: unknown }).op)}`);
}

export function applyDraftDelete(write: { kind: string }, tx: CommitExtensionTx) {
  const { id } = write as DraftDeleteWrite;
  if (!tx.get('SELECT 1 FROM drafts WHERE id = ?', id)) return;
  const live = liveOf(tx, id);
  if (live) throw new DraftConflict('live', live.state);
  tx.run('DELETE FROM drafts WHERE id = ?', id);
  tx.mark('Draft', id, 'd');
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
  const { fields } = theirsFields(w.accountId, messageOf(w));
  const thread = remoteThreadId(w);
  if (thread !== undefined) fields.threadId = thread;
  const fp = fingerprintOf(fields);
  insertRow(tx, {
    id: `${w.accountId}:${w.remoteDraftId}`,
    accountId: w.accountId,
    fields,
    meta: { rev: tx.seq, cur: fp, fingerprint: fp, announce: tx.seq },
    at: w.changedAt,
    origin: 'remote',
    remote: w,
  });
  announce(`${w.accountId}:${w.remoteDraftId}`);
}

/** An upload of this device that history reports before its result was recorded. */
function isOwnUpload(tx: CommitExtensionTx, w: RemoteDraftWrite) {
  return (
    w.internetId !== undefined &&
    !!tx.get(
      `SELECT 1 FROM drafts WHERE account_id = ?
         AND json_extract(data, '$._sync.uploading.internetId') = ? LIMIT 1`,
      w.accountId,
      w.internetId,
    )
  );
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
  if (w.remoteMessageId === row.remote_message_id) return;
  const { fields: base, meta } = parseData(row.data);
  const { fields } = theirsFields(row.account_id, messageOf(w), base);
  const fp = fingerprintOf(fields);
  writeRow(
    tx,
    row.id,
    {
      revision: row.revision + 1,
      remote_message_id: w.remoteMessageId,
      remote_internet_id: w.internetId ?? row.remote_internet_id,
      synced_revision: row.revision + 1,
      updated_at: w.changedAt,
    },
    fields,
    patched(meta, { cur: fp, fingerprint: fp, announce: tx.seq }),
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
  theirs: DraftFields | undefined,
) {
  const seen = (meta.theirsSeen ?? 0) + 1;
  const conflict: NonNullable<DraftMeta['conflict']> = {
    theirsRevision: seen,
    at: w.changedAt,
    theirsMessageId: w.remoteMessageId,
  };
  if (w.removed) conflict.gone = true;
  else if (theirs) conflict.theirs = theirs;
  writeRow(
    tx,
    row.id,
    {},
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
      remote_internet_id: w.internetId ?? row.remote_internet_id,
      synced_revision: row.revision + 1,
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
  if (meta.conflict?.theirsMessageId === w.remoteMessageId) return;
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
  raise(tx, row, meta, fields, w, theirs.fields);
}

/** A `remoteDraft` fact from the provider actor (D9). */
export function applyRemoteDraft(write: { kind: string }, tx: CommitExtensionTx) {
  const w = write as RemoteDraftWrite;
  const row = tx.get<DraftRow>(
    'SELECT * FROM drafts WHERE account_id = ? AND remote_draft_id = ?',
    w.accountId,
    w.remoteDraftId,
  );
  if (!row) return w.removed || isOwnUpload(tx, w) ? undefined : insertRemote(tx, w);
  if (row.origin === 'remote') return refreshRemote(tx, row, w);
  editedElsewhere(tx, row, w);
}
