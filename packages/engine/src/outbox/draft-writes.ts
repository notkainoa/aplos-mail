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
  earlierWith,
  REMOTE_BODY_MAX,
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
      /**
       * Saves an edit of a draft whose text never arrived as a NEW draft under this id (no remote ids, origin local) and
       * leaves the other device's draft as it is. Without it such a draft cannot be saved.
       */
      forkId?: string;
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
      /**
       * The create path only: the provider found an earlier create of this upload's Message-ID and names its draft, and
       * says the copy carries `remoteInternetId`. Only when that equals `internetId` (proof the copy is this draft's own)
       * and the row has no remote draft and is not being discarded, the row stores the draft id (so keep mine updates it
       * instead of creating a second one) and remembers the Message-ID as its own. The copy's message id is NOT stored
       * as the row's or remembered as ours: its bytes differ from ours, so it is theirs until the owner chooses, and its
       * history fact must still be able to bring their version.
       */
      remoteDraftId?: string;
      remoteInternetId?: string;
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

function fork(tx: CommitExtensionTx, w: Extract<DraftWrite, { op: 'save' }>) {
  if (!w.forkId) throw new DraftConflict('bodyPending');
  if (tx.get('SELECT 1 FROM drafts WHERE id = ?', w.forkId)) throw new DraftConflict('exists');
  insertSaved(tx, { ...w, id: w.forkId });
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
  if (row.revision !== w.baseRevision) throw new DraftConflict('stale');
  // Editing a snippet would upload it over the full draft on the other device: the edit becomes a draft of its own.
  if (meta.incomplete) return fork(tx, w);
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
    earlier: null,
    wrote: remembered(meta, w.internetId, w.remoteMessageId),
    changedElsewhere: null,
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

/**
 * The copy a create-path conflict names becomes the row's own copy (see `remoteDraftId` on the write), only when the
 * provider proved it carries this upload's Message-ID. Its message id is left out of the row: until the owner keeps
 * theirs or mine it is not a version of ours (and a discard of the row then forgets it instead of deleting it).
 */
function adoptedByConflict(
  row: DraftRow,
  meta: DraftMeta,
  w: Extract<DraftWrite, { op: 'conflict' }>,
) {
  if (w.gone || w.remoteDraftId === undefined || row.remote_draft_id !== null) return undefined;
  if (w.remoteInternetId !== w.internetId) return undefined;
  return { columns: { remote_draft_id: w.remoteDraftId }, wrote: remembered(meta, w.internetId) };
}

function uploadConflict(tx: CommitExtensionTx, w: Extract<DraftWrite, { op: 'conflict' }>) {
  const row = readRow(tx, w.id);
  if (row.revision !== w.revision) throw new DraftConflict('stale');
  const { fields, meta } = parseData(row.data);
  if (meta.uploading?.internetId !== w.internetId) return;
  const gone = w.gone;
  // A discarded draft adopts nothing: the copy differs from ours, so it is not to be deleted either.
  const adopted = meta.removing ? undefined : adoptedByConflict(row, meta, w);
  // The copy is gone: its id names nothing a delete or a replace may touch (on some providers it is now the sent message).
  const columns = gone ? FORGET_REMOTE : (adopted?.columns ?? {});
  const wrote = adopted ? { wrote: adopted.wrote } : {};
  if (meta.removing) {
    // With no copy known (a create) there is nothing to delete or wait for: the hidden row ends, the other copy stays.
    const done = !gone && row.remote_draft_id === null ? { removeAt: w.at } : {};
    return writeRow(tx, row.id, columns, fields, patched(meta, { uploading: null, ...done }));
  }
  // A conflict already open stays, but a copy that is gone is gone: keep mine then has no base to overwrite.
  if (meta.conflict) {
    const conflict = gone ? { ...meta.conflict, gone: true as const } : meta.conflict;
    return writeRow(
      tx,
      row.id,
      columns,
      fields,
      patched(meta, { uploading: null, conflict, ...wrote }),
    );
  }
  const seen = (meta.theirsSeen ?? 0) + 1;
  const conflict: NonNullable<DraftMeta['conflict']> = { theirsRevision: seen, at: w.at };
  if (gone) conflict.gone = true;
  else if (w.remoteMessageId !== undefined) conflict.theirsMessageId = w.remoteMessageId;
  const patch = {
    conflict,
    theirsSeen: seen,
    dueAt: null,
    uploading: null,
    announce: tx.seq,
    ...wrote,
  };
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
      ...(row.remote_draft_id === null && old.length ? { earlier: earlierWith(meta, ...old) } : {}),
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
  const next = patched(meta, {
    conflict: null,
    fingerprint: null,
    changedElsewhere: null,
    announce: tx.seq,
  });
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
    changedElsewhere: null,
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

/** Has the draft's current revision gone out? */
function sentAt(tx: CommitExtensionTx, row: DraftRow) {
  return (
    tx.get(
      `SELECT 1 FROM submissions WHERE draft_id = ? AND revision = ? AND state = 'sent' LIMIT 1`,
      row.id,
      row.revision,
    ) !== undefined
  );
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
  // The text of this draft never arrived: the copy is the other device's draft and is not this device's to delete.
  if (meta.incomplete) return deleteHidden(tx, w.id);
  // A draft whose copy holds another device's version forgets the copy: deleting it would delete that version, and on
  // some providers the id is the sent message. That is an edit made while a send held the draft (even when the owner then
  // cancels the send and discards: the other device's copy is left alone, no conflict is asked), or a conflict on a sent draft.
  // A conflict on a copy adopted from the provider's answer (no message id of ours for it) is the same: the copy differs.
  const theirs =
    meta.changedElsewhere || (meta.conflict && (row.remote_message_id === null || sentAt(tx, row)));
  const columns = theirs ? FORGET_REMOTE : {};
  if ((theirs || row.remote_draft_id === null) && !meta.uploading) return deleteHidden(tx, w.id);
  // Before the copy is known the removal waits for the upload's result, or for history to report the copy.
  const removeAt = row.remote_draft_id !== null && !theirs ? w.at : w.at + DRAFT_REMOVE_GRACE_MS;
  const hidden = patched(meta, {
    removing: true,
    removeAt,
    removeTries: null,
    dueAt: null,
    conflict: null,
    problem: null,
  });
  const set = { ...columns, data: packData(fields, { ...hidden, rev: tx.seq }) };
  const assignments = Object.keys(set).map(k => `${k} = ?`);
  tx.run(`UPDATE drafts SET ${assignments.join(', ')} WHERE id = ?`, ...Object.values(set), w.id);
  tx.mark('Draft', w.id, 'd');
}

// ---------------------------------------------------------------- remote facts

type RemoteMessage = NonNullable<RemoteDraftWrite['message']>;
type MessageWithBody = RemoteMessage & { html?: string };

function paragraphs(text: string) {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped
    .split(/\r?\n\r?\n/)
    .map(p => `<p>${p.replace(/\r?\n/g, '<br>')}</p>`)
    .join('');
}

interface Candidate {
  html: string;
  blank: boolean;
  /** Over the limit: not escaped or kept, only remembered so that it still counts as the body on offer. */
  over?: boolean;
}

/** Escaping only grows a text, so a source already over the limit is dropped before any work is done on it. */
function candidate(body: string, build: (body: string) => string = b => b): Candidate {
  if (body.length > REMOTE_BODY_MAX) return { html: '', blank: false, over: true };
  return { html: build(body), blank: body === '' };
}

/** The bodies the fact offers, best first: top-level `html`, then `text`, then an `html` on the message. */
function candidates(w: RemoteDraftWrite): Candidate[] {
  const found: Candidate[] = [];
  if (w.html !== undefined) found.push(candidate(w.html));
  if (w.text !== undefined) found.push(candidate(w.text, paragraphs));
  const inMessage = (w.message as MessageWithBody | undefined)?.html;
  if (inMessage !== undefined) found.push(candidate(inMessage));
  return found;
}

const bodies = new WeakMap<RemoteDraftWrite, string | undefined>();

/**
 * The draft's body when the provider delivered a usable one, as it would be stored. An empty body next to a snippet that
 * says there is text is a provider that sent nothing, not an empty draft; a body over the local limit (counted after
 * escaping and wrapping) is left out, so the draft stays snippet-only and a remote draft cannot hold more than a local
 * save may. Worked out once per fact: it is asked for several times.
 */
function bodyOf(w: RemoteDraftWrite): string | undefined {
  if (bodies.has(w)) return bodies.get(w);
  const found = candidates(w);
  // A source over the limit means the provider's real body is too big to keep: never settle for another source then.
  if (found.some(c => c.over)) return void bodies.set(w, undefined);
  const snippet = w.message?.snippet;
  const body = found.find(c => !c.blank) ?? (snippet ? undefined : found[0]);
  const html = body && !body.over && body.html.length <= REMOTE_BODY_MAX ? body.html : undefined;
  bodies.set(w, html);
  return html;
}

/** Does this fact make the draft complete: a usable body and no attachments (those are not delivered)? */
function completes(w: RemoteDraftWrite) {
  return bodyOf(w) !== undefined && w.message?.hasAttachments !== true;
}

/** The write's metadata in the shape `theirsFields` reads, with the usable body when there is one. */
function messageOf(w: RemoteDraftWrite) {
  const { html: _offered, ...message } = (w.message ?? {}) as MessageWithBody;
  const html = bodyOf(w);
  return html === undefined ? message : { ...message, html };
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
  // The copy an open conflict names is theirs, whatever Message-ID it carries: it completes the conflict (their body).
  if (meta.conflict?.theirsMessageId === w.remoteMessageId) return false;
  return (
    w.remoteMessageId === row.remote_message_id ||
    wrote.includes(w.remoteMessageId) ||
    (w.internetId !== undefined &&
      (wrote.includes(w.internetId) || meta.uploading?.internetId === w.internetId))
  );
}

/**
 * Is this fact the copy this device uploaded, judged by its content? The body (and the fields it carries) must hash to
 * the fingerprint of what the provider holds. A provider keeps a draft's Message-ID across edits, so the Message-ID alone
 * does not tell a phone edit from our own copy. No body, attachments or a body over the limit: no proof.
 */
function holdsOurContent(
  w: RemoteDraftWrite,
  row: DraftRow,
  meta: DraftMeta,
  base: DraftFields,
  own: string,
) {
  return hasFingerprint(w, row, base, meta.fingerprint, own);
}

/**
 * Does the fact's delivered content hash to `fingerprint`? The comparison fills in what a fact cannot show from the
 * local draft (attachments, signature, from), so it is a proof only when none of that is in play: a draft with
 * attachments or a sign-off, a copy that says it has attachments, or a sender other than the account's own address
 * (`own`) could differ from ours without the hash noticing, and gets no proof (a conflict is the safe direction). No
 * fingerprint, or no body: no proof.
 */
function hasFingerprint(
  w: RemoteDraftWrite,
  row: DraftRow,
  base: DraftFields,
  fingerprint: string | undefined,
  own: string,
) {
  if (fingerprint === undefined || !completes(w)) return false;
  if (keepsMine(base) || w.message?.hasAttachments === true) return false;
  const from = w.message?.from?.address;
  if (from === undefined || from.trim().toLowerCase() !== own.trim().toLowerCase()) return false;
  const theirs = theirsFields(row.account_id, messageOf(w), base);
  return fingerprintOf(theirs.fields) === fingerprint;
}

/**
 * A fact that replaces the message id this row holds (or one it wrote) and is the copy of this row's own upload is that
 * upload's echo, under the new message id a create-then-destroy update gave it. It is ours only when an upload under its
 * Message-ID is still running, or when its content is the content we uploaded; a Message-ID alone is not proof (Graph,
 * JMAP and IMAP clients keep it across edits), so the same replacement with other content is another device's edit and
 * goes the ordinary way. A removal that supersedes something is not handled here: it is a removal.
 */
function supersedesOwn(
  tx: CommitExtensionTx,
  w: RemoteDraftWrite,
  row: DraftRow,
  meta: DraftMeta,
  fields: DraftFields,
) {
  if (w.removed || !w.supersedes?.length || w.internetId === undefined) return false;
  const wrote = meta.wrote ?? [];
  const replaces = w.supersedes.some(id => id === row.remote_message_id || wrote.includes(id));
  if (!replaces) return false;
  const own = tx.get<{ address: string }>(
    'SELECT address FROM accounts WHERE id = ?',
    row.account_id,
  )?.address;
  if (own === undefined) return false;
  return (
    explainedByAttempt(w, row, meta, fields, own) || holdsOurContent(w, row, meta, fields, own)
  );
}

/**
 * The running (or unanswered) upload's echo: the same Message-ID and content that hashes to what the upload sends. The
 * Message-ID alone proves nothing (a phone edit can keep it, and a retry of the same revision reuses it), so there is
 * no "one move per attempt" rule to get wrong: a fact whose content differs, or that delivers no body, is never
 * explained by the upload and goes the ordinary way (a conflict is the safe direction).
 */
function explainedByAttempt(
  w: RemoteDraftWrite,
  row: DraftRow,
  meta: DraftMeta,
  base: DraftFields,
  own: string,
) {
  const attempt = meta.uploading;
  if (!attempt || attempt.internetId !== w.internetId) return false;
  return hasFingerprint(w, row, base, attempt.fingerprint, own);
}

/** The echo of our own upload under a new message id: the row's base moves to it, nothing else changes. */
function advanceBase(tx: CommitExtensionTx, row: DraftRow, meta: DraftMeta, w: RemoteDraftWrite) {
  const { fields } = parseData(row.data);
  const data = packData(fields, { ...meta, wrote: remembered(meta, w.remoteMessageId) });
  tx.run(
    'UPDATE drafts SET remote_message_id = ?, data = ? WHERE id = ?',
    w.remoteMessageId,
    data,
    row.id,
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
  if (same && !(meta.incomplete && completes(w))) return;
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

function markChangedElsewhere(
  tx: CommitExtensionTx,
  row: DraftRow,
  fields: DraftFields,
  meta: DraftMeta,
) {
  if (meta.changedElsewhere) return;
  const data = packData(fields, { ...meta, changedElsewhere: true });
  tx.run('UPDATE drafts SET data = ? WHERE id = ?', data, row.id);
}

function editedElsewhere(tx: CommitExtensionTx, row: DraftRow, w: RemoteDraftWrite) {
  const { fields, meta } = parseData(row.data);
  // First: our own upload's Message-ID makes `isEcho` true too, but only this moves the base to the new message id.
  if (w.remoteMessageId !== row.remote_message_id && supersedesOwn(tx, w, row, meta, fields))
    return advanceBase(tx, row, meta, w);
  if (isEcho(w, row, meta)) return;
  // A send of this draft (or one that just went out) removes or changes its copy itself. A change made meanwhile cannot
  // be asked about now, but it is remembered: the copy then holds another device's version and is not deleted. That
  // includes a removal (the other device sent it): the id may now name its sent message.
  if (
    tx.get(
      `SELECT 1 FROM submissions WHERE draft_id = ? AND state IN (${LIVE_SQL}, 'sent') LIMIT 1`,
      row.id,
    )
  )
    return markChangedElsewhere(tx, row, fields, meta);
  // The same version again is known, unless it brings what the conflict lacks (their body). A removal is always news:
  // the other device sent or deleted the copy, and its id must be forgotten.
  const known = meta.conflict;
  if (
    !w.removed &&
    known?.theirsMessageId === w.remoteMessageId &&
    (known.complete === true || (known.theirs !== undefined && !completes(w)))
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
