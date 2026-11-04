import type { DraftFields } from '@aplos/contract';
import type { CommitExtensionTx, RemoteDraftWrite, SqlValue } from '../store';
import {
  announce,
  DRAFT_REMOVE_GRACE_MS,
  DraftConflict,
  fingerprintOf,
  keepsMine,
  liveOf,
  packData,
  parseData,
  patched,
  abandoned,
  remembered,
  withPrints,
  theirsFields,
  type DraftMeta,
  type DraftRow,
  type MetaPatch,
} from './draft-state';
import { completes, messageOf } from './draft-body';
import {
  dueAfter,
  freshId,
  insertRow,
  readRow,
  showUnseen,
  threadRow,
  writeRow,
} from './draft-rows';
import {
  accountAddress,
  adoptedByConflict,
  advanceBase,
  changesSender,
  explainedByAttempt,
  holdsOnlyHere,
  ownUpload,
  sendPins,
  holdersOf,
  dropHeld,
  holdsOurContent,
  markChangedElsewhere,
  namedByDraftId,
  provenOurs,
  repliedTo,
  sameCopy,
  withParent,
} from './draft-proof';

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
      /** The Message-ID the provider shows for the copy when it is not `internetId`: remembered as ours too. */
      copyInternetId?: string;
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
  const next = patched(meta, { cur: w.fingerprint, problem: null, readFails: null });
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

type Synced = Extract<DraftWrite, { op: 'synced' }>;

/** The ids an upload's answer makes ours: its Message-ID, the copy's message id and the Message-ID the copy shows. */
const ours = (w: Synced) => [
  w.internetId,
  w.remoteMessageId,
  ...(w.copyInternetId !== undefined && w.copyInternetId !== w.internetId
    ? [w.copyInternetId]
    : []),
];

/** The Message-ID the copy shows when it is not the upload's, with the upload's content: what proves its echo later. */
const copyPrint = (w: Synced) =>
  w.copyInternetId !== undefined && w.copyInternetId !== w.internetId
    ? [{ internetId: w.copyInternetId, fingerprint: w.fingerprint }]
    : [];

function synced(tx: CommitExtensionTx, w: Synced) {
  const row = readRow(tx, w.id);
  const { fields, meta: stored } = parseData(row.data);
  // History may report our own update's copy (no body yet) before this ack and open a conflict about it. The ack names
  // that very copy under our Message-ID: it was our write, so the conflict was spurious and ends here.
  const ownReport =
    stored.conflict?.theirsMessageId === w.remoteMessageId &&
    stored.conflict.theirsInternetId === w.internetId;
  const meta = ownReport ? patched(stored, { conflict: null }) : stored;
  // An ack for an upload this row no longer expects (a conflict, a choice or a newer attempt cleared `uploading`) says
  // what the provider now holds, not what this draft is: only its ids are kept, to recognise their echo in history.
  if (meta.uploading?.internetId !== w.internetId && !ownReport) {
    const wrote = remembered(meta, ...ours(w));
    const prints = withPrints(
      meta,
      { internetId: w.internetId, fingerprint: w.fingerprint },
      ...copyPrint(w),
    );
    return writeRow(tx, w.id, {}, fields, patched(meta, { wrote, prints }));
  }
  // The reply names a remote draft that another row already shows (history was faster, and could not prove the copy
  // ours). Only the very same untouched version is the same copy; anything else (a newer version, a draft the owner
  // edited, one with a send queued) keeps its row, and this row is NOT bound to it: the upload is done with, nothing is
  // lost, and the next upload makes its own copy.
  const holders =
    row.remote_draft_id === w.remoteDraftId ? [] : holdersOf(tx, row, w.remoteDraftId);
  if (!holders.every(h => sameCopy(tx, h, w.remoteMessageId))) {
    // A discarded draft with no copy of its own has nothing else to delete (the other row's copy is not ours).
    if (meta.removing && row.remote_draft_id === null) return deleteHidden(tx, row.id);
    // Not into `earlier`: the next create must not point back at the copy the other row holds (an adapter would replace it).
    const given = abandoned(meta, w.remoteDraftId, {
      internetId: w.internetId,
      fingerprint: w.fingerprint,
    });
    // A discarded draft that already holds a copy (an adopted one) still has it to delete: the hidden row stays and
    // removes it now; ending it here would leave that copy on the provider for good.
    const next = meta.removing ? { removeAt: w.at } : { dueAt: meta.dueAt ?? w.at };
    return writeRow(
      tx,
      w.id,
      {},
      fields,
      patched(meta, { uploading: null, problem: null, ...next, ...given }),
    );
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
    wrote: remembered(meta, ...ours(w)),
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
  for (const copy of holders) deleteRow(tx, copy);
}

function uploadConflict(tx: CommitExtensionTx, w: Extract<DraftWrite, { op: 'conflict' }>) {
  const row = readRow(tx, w.id);
  if (row.revision !== w.revision) throw new DraftConflict('stale');
  const { fields, meta } = parseData(row.data);
  if (meta.uploading?.internetId !== w.internetId) return;
  const gone = w.gone;
  // A conflict, or a copy that is gone, is an answer: the create is over, so no earlier Message-ID is offered again.
  const answered = { uploading: null, earlier: null };
  // A discarded draft adopts nothing: the copy differs from ours, so it is not to be deleted either.
  const adopted = meta.removing ? undefined : adoptedByConflict(tx, row, meta, w);
  // The copy is gone: its id names nothing a delete or a replace may touch (on some providers it is now the sent message).
  const columns = gone ? FORGET_REMOTE : (adopted?.columns ?? {});
  const wrote = adopted ? { wrote: adopted.wrote } : {};
  if (meta.removing) {
    // With no copy known (a create) there is nothing to delete or wait for: the hidden row ends, the other copy stays.
    const done = !gone && row.remote_draft_id === null ? { removeAt: w.at } : {};
    return writeRow(tx, row.id, columns, fields, patched(meta, { ...answered, ...done }));
  }
  // A conflict already open stays, but a copy that is gone is gone: keep mine then has no base to overwrite.
  if (meta.conflict) {
    const conflict = gone ? { ...meta.conflict, gone: true as const } : meta.conflict;
    return writeRow(
      tx,
      row.id,
      columns,
      fields,
      patched(meta, { ...answered, conflict, ...wrote }),
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
    ...answered,
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
  const old = meta.uploading ? [meta.uploading] : [];
  writeRow(
    tx,
    w.id,
    {},
    fields,
    patched(meta, {
      fingerprint: null,
      uploading: null,
      ...abandoned(meta, row.remote_draft_id, ...old),
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
  // Backstop: a hidden row only waits for its copy's removal; an upload's due time or read count on it would be stale.
  if (meta.removing && (w.patch.dueAt != null || w.patch.readFails != null))
    throw new DraftConflict('missing');
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
  // The other version was never shown whole (no body arrived): replacing the copy would overwrite a version nobody has
  // seen. Like a copy that is gone, the remote ids are forgotten and the upload makes a NEW copy; the other version stays
  // where it is and is shown if history reports it again.
  const unseen = !gone && meta.conflict?.complete !== true;
  const forget = gone || unseen;
  // The remote copy is theirs now, so what this device holds replaces it: its fingerprint no longer applies.
  const next = patched(meta, {
    conflict: null,
    fingerprint: null,
    changedElsewhere: null,
    announce: tx.seq,
  });
  const due = dueAfter(fields, next, !forget, at, true);
  // Until the upload lands the copy is theirs: it is not this revision, and our Message-ID does not name it, so a send
  // right now leaves the pinned MIME instead of their copy.
  const columns: Record<string, SqlValue> = forget
    ? FORGET_REMOTE
    : { synced_revision: null, remote_internet_id: null, remote_change_key: null };
  // A version the owner has seen whole is replaced on purpose: the upload is checked against it.
  if (!forget) columns.remote_message_id = theirsId ?? null;
  writeRow(tx, row.id, columns, fields, patched(next, { dueAt: due ?? null }));
  if (unseen) showUnseen(tx, row, meta.conflict);
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
  // The newer version a send held back (`changedElsewhere` as a report) is not lost with the draft: it is shown as the
  // other device's own draft once this one is gone, instead of staying on the provider unseen.
  const heldReport = typeof meta.changedElsewhere === 'object' ? meta.changedElsewhere : undefined;
  const held = heldReport?.remoteDraftId === row.remote_draft_id ? heldReport : undefined;
  if ((theirs || row.remote_draft_id === null) && !meta.uploading) {
    deleteHidden(tx, w.id);
    return resurface(tx, held);
  }
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
  if (theirs) resurface(tx, held);
}

/**
 * Shows a held report as a remote draft of its own (a removal report has nothing to show). A draft that came from the
 * phone already has the usual id, and its sent submission points at it, so a fresh one is used then.
 */
function resurface(tx: CommitExtensionTx, held: RemoteDraftWrite | undefined) {
  if (!held || held.removed) return;
  insertRemote(tx, held, freshId(tx, `${held.accountId}:${held.remoteDraftId}`));
}

// ---------------------------------------------------------------- remote facts

function remoteThreadId(w: RemoteDraftWrite) {
  return w.remoteThreadId === undefined ? undefined : `${w.accountId}:${w.remoteThreadId}`;
}

function insertRemote(
  tx: CommitExtensionTx,
  w: RemoteDraftWrite,
  id = `${w.accountId}:${w.remoteDraftId}`,
) {
  const { fields, complete } = theirsFields(
    w.accountId,
    messageOf(w),
    undefined,
    accountAddress(tx, w.accountId),
  );
  const thread = remoteThreadId(w);
  if (thread !== undefined) fields.threadId = thread;
  // A reply written elsewhere: its In-Reply-To names the message it answers, so an edit re-uploaded from here stays in
  // the thread (the reply headers are rebuilt from `replyToMessageId`).
  const target = repliedTo(tx, w);
  if (target !== undefined) Object.assign(fields, { mode: 'reply', replyToMessageId: target });
  const fp = fingerprintOf(fields);
  const meta: DraftMeta = { rev: tx.seq, cur: fp, fingerprint: fp, announce: tx.seq };
  if (!complete) meta.incomplete = true;
  insertRow(tx, {
    id,
    accountId: w.accountId,
    fields,
    meta,
    at: w.changedAt,
    origin: 'remote',
    remote: w,
  });
  announce(id);
}

/**
 * An upload landed without its result being recorded. A discarded draft's copy is the one to delete; a live draft with
 * no copy yet takes it as its own, so its next upload replaces it instead of making a second one.
 */
function adoptCopy(tx: CommitExtensionTx, row: DraftRow, w: RemoteDraftWrite) {
  const { fields, meta } = parseData(row.data);
  if (w.removed) return;
  // This row already has its own copy: a report of ANOTHER remote draft under one of our Message-IDs is either the old
  // copy of an attempt (ours, nothing to show) or another device's version (shown, never replaced or deleted from here).
  if (row.remote_draft_id !== null)
    return provenOurs(tx, row, meta, fields, w) ? undefined : insertRemote(tx, w);
  // A Message-ID alone proves nothing (a provider keeps it across edits, so a phone-edited copy carries it too): the copy
  // must also have the content of an upload this engine made under it. Otherwise it is shown as a remote draft, a
  // visible duplicate the owner can discard, and is never replaced or deleted from here.
  if (!provenOurs(tx, row, meta, fields, w)) {
    // Shown as a remote draft: the next create must not offer its id as `supersedes`.
    const rest = (meta.earlier ?? []).filter(id => id !== w.internetId);
    if (rest.length !== (meta.earlier ?? []).length)
      writeRow(tx, row.id, {}, fields, patched(meta, { earlier: rest.length ? rest : null }));
    return insertRemote(tx, w);
  }
  writeRow(
    tx,
    row.id,
    { remote_draft_id: w.remoteDraftId, remote_message_id: w.remoteMessageId },
    fields,
    patched(
      meta,
      meta.removing
        ? { removeAt: w.changedAt }
        : { wrote: remembered(meta, w.remoteMessageId), earlier: null },
    ),
  );
  announce(row.id);
}

function isEcho(
  tx: CommitExtensionTx,
  w: RemoteDraftWrite,
  row: DraftRow,
  meta: DraftMeta,
  fields: DraftFields,
) {
  // A removal is never an echo, whatever id it carries (Gmail reports it under the last known one): the other device sent
  // or deleted the copy. Our own removals meet a hidden `removing` row first and never get here.
  if (w.removed) return false;
  const wrote = meta.wrote ?? [];
  // The copy an open conflict names is theirs, whatever Message-ID it carries: it completes the conflict (their body).
  if (meta.conflict?.theirsMessageId === w.remoteMessageId) return false;
  // The very message id this row holds or wrote is our own copy.
  if (w.remoteMessageId === row.remote_message_id || wrote.includes(w.remoteMessageId)) return true;
  // A NEW message id under a Message-ID we used proves nothing by itself: a provider may keep the Message-ID across a
  // phone edit (Gmail is believed to), and dropping that edit as an echo hides it for good. It is ours only with the
  // content of an upload this engine made (the running one, a superseded attempt, or the last synced one).
  const id = w.internetId;
  const own = accountAddress(tx, row.account_id);
  if (own === undefined) return false;
  if (id !== undefined && (wrote.includes(id) || meta.uploading?.internetId === id))
    return provenOurs(tx, row, meta, fields, w) || holdsOurContent(w, row, meta, fields, own);
  // A provider that rewrites the Message-ID (Gmail) shows none of ours: the draft id names the copy, and only the content
  // of an upload of ours proves it (never "unchanged", which a touch from another device would also be).
  return namedByDraftId(row, meta, w) && provenOurs(tx, row, meta, fields, w);
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
  const own = accountAddress(tx, row.account_id);
  if (own === undefined) return false;
  return (
    explainedByAttempt(w, row, meta, fields, own) ||
    holdsOurContent(w, row, meta, fields, own) ||
    (namedByDraftId(row, meta, w) && provenOurs(tx, row, meta, fields, w))
  );
}

function deleteRow(tx: CommitExtensionTx, row: DraftRow) {
  tx.run('DELETE FROM drafts WHERE id = ?', row.id);
  tx.mark('Draft', row.id, 'd');
  announce(row.id);
}

/** The parent of a phone reply was found: the stored draft gains its reply target and keeps every other field. */
function relink(tx: CommitExtensionTx, row: DraftRow, meta: DraftMeta, fields: DraftFields) {
  const fp = fingerprintOf(fields);
  const synced = row.synced_revision === row.revision ? row.revision + 1 : row.synced_revision;
  writeRow(
    tx,
    row.id,
    { revision: row.revision + 1, synced_revision: synced },
    fields,
    patched(meta, { cur: fp, fingerprint: fp, announce: tx.seq }),
  );
  announce(row.id);
}

function refreshRemote(tx: CommitExtensionTx, row: DraftRow, w: RemoteDraftWrite) {
  if (w.removed) return deleteRow(tx, row);
  const { fields: stored, meta } = parseData(row.data);
  // A draft held by a send (queued, running, or gone out at this revision) does not change: its revision is what the
  // send is checked against, and the send names the copy it was queued against. A newer version of the copy is
  // remembered like any change made meanwhile (the copy is then another device's and is never deleted from here), and
  // is applied when the send ends without going out (`releaseHeld`).
  if (sendPins(tx, row))
    return w.remoteMessageId === row.remote_message_id
      ? undefined
      : markChangedElsewhere(tx, row, stored, meta, w);
  const base = withParent(tx, stored, w);
  const same = w.remoteMessageId === row.remote_message_id;
  // The same version again changes nothing, unless it brings the text a snippet-only draft was waiting for, or the
  // message it answers (which may have synced after the draft did: then only the reply target is added, never a body
  // rebuilt from a report that may carry none).
  if (same && !(meta.incomplete && completes(w)))
    return base === stored ? undefined : relink(tx, row, meta, base);
  const { fields, complete } = theirsFields(
    row.account_id,
    messageOf(w),
    base,
    accountAddress(tx, row.account_id),
  );
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
      // The row now names the version that was reported: a discard deletes the copy again, guarded on this id.
      changedElsewhere: null,
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
    patched(meta, {
      conflict,
      theirsSeen: seen,
      dueAt: null,
      uploading: null,
      ...abandoned(meta, row.remote_draft_id, ...(meta.uploading ? [meta.uploading] : [])),
      announce: tx.seq,
    }),
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
      // The row names the reported version again: a discard deletes the copy, guarded on its id.
      changedElsewhere: null,
      announce: tx.seq,
    }),
  );
  announce(row.id);
}

function editedElsewhere(tx: CommitExtensionTx, row: DraftRow, w: RemoteDraftWrite) {
  const { fields, meta } = parseData(row.data);
  // First: our own upload's Message-ID makes `isEcho` true too, but only this moves the base to the new message id.
  if (w.remoteMessageId !== row.remote_message_id && supersedesOwn(tx, w, row, meta, fields))
    return advanceBase(tx, row, meta, w);
  if (isEcho(tx, w, row, meta, fields)) return;
  // A send of this draft (or one that just went out) removes or changes its copy itself. A change made meanwhile cannot
  // be asked about now, but it is remembered: the copy then holds another device's version and is not deleted. That
  // includes a removal (the other device sent it): the id may now name its sent message.
  if (sendPins(tx, row)) return markChangedElsewhere(tx, row, fields, meta, w);
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
  // The report is news that replaces or questions the copy: whatever was held is older than it from here on.
  const now = dropHeld(meta);
  if (w.removed) return clean ? deleteRow(tx, row) : raise(tx, row, now, fields, w, undefined);
  const own = accountAddress(tx, row.account_id);
  const theirs = theirsFields(row.account_id, messageOf(w), fields, own);
  // Without the body (metadata only) nothing is replaced silently: the owner chooses. Nor when the copy cannot hold
  // something this draft has (no Bcc by design, no sign-off source, and attachments the phone may have removed): a
  // silent replace would drop or resurrect it, and the copy's own Bcc is not merged in either (a phone that removed one
  // it added would be hidden). Nor when the copy was sent from another address: the sender is send-relevant.
  if (
    clean &&
    theirs.complete &&
    !holdsOnlyHere(fields) &&
    !changesSender(theirs.fields, fields, own)
  )
    return replaceWithTheirs(tx, row, now, theirs.fields, w);
  raise(tx, row, now, fields, w, theirs);
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
