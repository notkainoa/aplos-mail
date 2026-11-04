import type { DraftFields } from '@aplos/contract';
import type { CommitExtensionTx, RemoteDraftWrite } from '../store';
import { bodyOf, completes, messageOf } from './draft-body';
import type { DraftWrite } from './draft-writes';
import {
  fingerprintOf,
  sameAddress,
  keepsMine,
  remembered,
  packData,
  LIVE_SQL,
  parseData,
  theirsFields,
  type DraftMeta,
  type DraftRow,
  type ShownField,
} from './draft-state';

/**
 * Proof that a remote draft copy is this device's own upload (seam 2, the closed-world rule in `DRAFT_CONTENT_FIELDS`):
 * its Message-ID is not enough, so its content has to match the fingerprint of an upload this engine made. Split out of
 * `draft-writes.ts` (the line limit); nothing here writes.
 */

/**
 * The fact is about the very draft this row already holds a copy of. The provider's draft id survives edits (Gmail keeps
 * it across saves while the message id and the Message-ID change), so it names the copy whatever Message-ID the copy now
 * shows. It says WHICH draft, never whose content: every use below still needs the content proof.
 */
export const sameDraft = (row: DraftRow, w: RemoteDraftWrite) =>
  row.remote_draft_id !== null && w.remoteDraftId === row.remote_draft_id;

/** A Message-ID this row's uploads used, or that the provider told us a copy of ours shows (`copyInternetId`). */
const known = (row: DraftRow, meta: DraftMeta, id: string | undefined) =>
  id !== undefined &&
  ((meta.wrote ?? []).includes(id) ||
    meta.uploading?.internetId === id ||
    row.remote_internet_id === id);

/**
 * The draft id alone names the copy (and an upload's content may prove it) only when the copy shows a Message-ID this
 * row never used: a provider that keeps ours shows the very one the attempt used, which names that attempt, so a phone
 * edit that restores older content of ours is still another device's edit there.
 */
export const namedByDraftId = (row: DraftRow, meta: DraftMeta, w: RemoteDraftWrite) =>
  sameDraft(row, w) && !known(row, meta, w.internetId);

/**
 * Is this copy one this row's uploads made: same content, and it shows every field? Named by the Message-ID the copy
 * shows (`w.internetId`) when an upload was made under it (or the provider told us it shows it, `copyInternetId`); and,
 * for the draft this row already holds, by the draft id, in which case the content may be that of the running upload or
 * of any recent attempt (the provider rewrote the Message-ID, so the attempt cannot be told by it).
 */
export function provenOurs(
  tx: CommitExtensionTx,
  row: DraftRow,
  meta: DraftMeta,
  fields: DraftFields,
  w: RemoteDraftWrite,
) {
  const id = w.internetId ?? '';
  const byId = meta.uploading?.internetId === id ? meta.uploading.fingerprint : meta.prints?.[id];
  const own = accountAddress(tx, row.account_id);
  if (own === undefined) return false;
  // By the draft id the content of the running upload proves the copy, and so does that of an attempt set aside while
  // it runs. Once no upload is running, an older attempt's content is nothing a phone edit could not also restore.
  const byDraft = namedByDraftId(row, meta, w);
  const prints = !byDraft
    ? [byId]
    : meta.uploading === undefined
      ? []
      : [meta.uploading.fingerprint, ...Object.values(meta.prints ?? {})];
  return prints.some(print => hasFingerprint(w, row, fields, print, own));
}

/**
 * Is this fact the copy this device uploaded, judged by its content? The body (and the fields it carries) must hash to
 * the fingerprint of what the provider holds. A provider keeps a draft's Message-ID across edits, so the Message-ID alone
 * does not tell a phone edit from our own copy. No body, attachments or a body over the limit: no proof.
 */
export function holdsOurContent(
  w: RemoteDraftWrite,
  row: DraftRow,
  meta: DraftMeta,
  base: DraftFields,
  own: string,
) {
  return hasFingerprint(w, row, base, meta.fingerprint, own);
}

/**
 * Closed world (see `DRAFT_CONTENT_FIELDS`): can this copy show everything the fingerprint covers? Each `shown` field
 * must be on the copy (a Bcc the provider cannot show is not an empty Bcc), the sender must be the account's own
 * address, and each `notShown` field must be empty here and not reported by the copy (attachments).
 */
function showsEveryField(w: RemoteDraftWrite, base: DraftFields, own: string) {
  const m = w.message;
  if (!m) return false;
  const shown: Record<ShownField, boolean> = {
    from: m.from !== undefined && m.from.address.trim().toLowerCase() === own.trim().toLowerCase(),
    to: m.to !== undefined,
    cc: m.cc !== undefined,
    bcc: m.bcc !== undefined,
    subject: m.subject !== undefined,
    html: bodyOf(w) !== undefined,
  };
  // A copy that does not say whether it has attachments is not shown to have none: adapters must always report.
  const emptyHere = !keepsMine(base) && m.hasAttachments === false;
  return Object.values(shown).every(Boolean) && emptyHere;
}

/**
 * Does the fact's delivered content hash to `fingerprint`? Only a copy that shows every field (`showsEveryField`) can
 * prove it: the comparison fills in the rest from the local draft, so anything else could differ from ours without the
 * hash noticing. No fingerprint, or no body: no proof; no proof is a conflict, the safe direction. */
function hasFingerprint(
  w: RemoteDraftWrite,
  row: DraftRow,
  base: DraftFields,
  fingerprint: string | undefined,
  own: string,
) {
  if (fingerprint === undefined || !completes(w)) return false;
  if (!showsEveryField(w, base, own)) return false;
  const theirs = theirsFields(row.account_id, messageOf(w), base);
  return fingerprintOf(theirs.fields) === fingerprint;
}

/**
 * The running (or unanswered) upload's echo: the same Message-ID (or draft id) and content that hashes to what the upload sends. The
 * Message-ID alone proves nothing (a phone edit can keep it, and a retry of the same revision reuses it), so there is
 * no "one move per attempt" rule to get wrong: a fact whose content differs, or that delivers no body, is never
 * explained by the upload and goes the ordinary way (a conflict is the safe direction).
 */
export function explainedByAttempt(
  w: RemoteDraftWrite,
  row: DraftRow,
  meta: DraftMeta,
  base: DraftFields,
  own: string,
) {
  const attempt = meta.uploading;
  // The running upload's copy: by its Message-ID, or, for a draft that already has a copy, by the draft id (a provider
  // that rewrites the Message-ID shows another one). The content must still be the upload's.
  if (!attempt || !(attempt.internetId === w.internetId || namedByDraftId(row, meta, w)))
    return false;
  return hasFingerprint(w, row, base, attempt.fingerprint, own);
}

export const accountAddress = (tx: CommitExtensionTx, accountId: string) =>
  tx.get<{ address: string }>('SELECT address FROM accounts WHERE id = ?', accountId)?.address;

/**
 * The stored message a foreign draft answers (by its In-Reply-To), as a contract id; reply-all cannot be known. A
 * Message-ID is not unique (a forward or a copy of the same mail can be stored twice), so the one in the draft's own
 * thread wins, then the earliest-dated stored one (`messages.id` orders by date), never an arbitrary row.
 */
export function repliedTo(tx: CommitExtensionTx, w: RemoteDraftWrite) {
  const id = w.message?.inReplyTo;
  const found =
    id === undefined
      ? undefined
      : tx.get<{ remote_id: string }>(
          `SELECT m.remote_id FROM messages m JOIN threads t ON t.id = m.thread_id
             WHERE m.account_id = ? AND m.internet_id = ?
             ORDER BY t.remote_id IS ? DESC, m.id LIMIT 1`,
          w.accountId,
          id,
          w.remoteThreadId ?? null,
        );
  return found && `${w.accountId}:${found.remote_id}`;
}

/** A phone reply whose parent message was not stored yet: once it is, the draft becomes a reply to it. */
export function withParent(tx: CommitExtensionTx, fields: DraftFields, w: RemoteDraftWrite) {
  if (fields.replyToMessageId !== undefined || fields.mode !== 'new') return fields;
  const target = repliedTo(tx, w);
  return target === undefined
    ? fields
    : { ...fields, mode: 'reply' as const, replyToMessageId: target };
}

/** Is a send of this draft live, or has one gone out? */
export function hasSend(tx: Pick<CommitExtensionTx, 'get'>, draftId: string) {
  return (
    tx.get(
      `SELECT 1 FROM submissions WHERE draft_id = ? AND state IN (${LIVE_SQL}, 'sent') LIMIT 1`,
      draftId,
    ) !== undefined
  );
}

/**
 * Does a send hold this draft's current content still? A live send of any revision does; a send that went out does only
 * when it is of the revision the draft is at now (an older sent revision left a newer edit in Drafts, which may change).
 */
export function sendPins(
  tx: Pick<CommitExtensionTx, 'get'>,
  row: Pick<DraftRow, 'id' | 'revision'>,
) {
  return (
    tx.get(
      `SELECT 1 FROM submissions WHERE draft_id = ?
         AND (state IN (${LIVE_SQL}) OR (state = 'sent' AND revision = ?)) LIMIT 1`,
      row.id,
      row.revision,
    ) !== undefined
  );
}

/** The other rows that show this remote draft. */
export function holdersOf(tx: CommitExtensionTx, row: DraftRow, remoteDraftId: string) {
  return tx.all<DraftRow>(
    'SELECT * FROM drafts WHERE account_id = ? AND remote_draft_id = ? AND id <> ?',
    row.account_id,
    remoteDraftId,
    row.id,
  );
}

/**
 * History may report the copy of an upload before its reply arrives and, when it could not be proven ours (no body,
 * other content), shows it as a remote draft. The reply then names the same remote draft. That row is the same copy only
 * if nobody touched it (`origin: 'remote'`), it is not being discarded, it holds the very message id the reply names, and
 * no send is queued on it or done with it (a sent copy's id may name the sent message); then it goes (two rows must
 * never share a remote draft).
 */
export function sameCopy(tx: CommitExtensionTx, copy: DraftRow, remoteMessageId: string) {
  return (
    copy.origin === 'remote' &&
    copy.remote_message_id === remoteMessageId &&
    !parseData(copy.data).meta.removing &&
    !hasSend(tx, copy.id)
  );
}

export function markChangedElsewhere(
  tx: CommitExtensionTx,
  row: DraftRow,
  fields: DraftFields,
  meta: DraftMeta,
  w: RemoteDraftWrite,
) {
  const held = meta.changedElsewhere;
  if (typeof held === 'object') {
    // A held removal stays: the copy is gone, and a later report of it (an older one arriving late) must not bring it back.
    if (held.removed) return;
    // The same version again changes nothing, but a removal reports the last known id and is always news.
    if (held.remoteMessageId === w.remoteMessageId && !w.removed) return;
  }
  // The newest report is kept: a send that ends without going out applies it (`releaseHeld`), so it is not lost.
  const data = packData(fields, { ...meta, changedElsewhere: w });
  tx.run('UPDATE drafts SET data = ? WHERE id = ?', data, row.id);
}

/**
 * The meta of a draft whose copy a newer report is about to REPLACE or ask about (the one write that makes the held
 * report older news): the copy stays marked (`true`: a discard forgets it instead of deleting it), the stored report goes,
 * so it can never be replayed over the newer one. Echoes and repeats of known versions do not call this: they change
 * nothing, and the held report must still be released.
 */
export const dropHeld = (meta: DraftMeta): DraftMeta =>
  typeof meta.changedElsewhere === 'object' ? { ...meta, changedElsewhere: true } : meta;

/** Does this draft hold something no copy carries (so a copy can never replace it without losing that)? */
export const holdsOnlyHere = (fields: DraftFields) =>
  fields.bcc.length > 0 || fields.signatureSource !== undefined || fields.attachments.length > 0;

/** Does the copy go out under another sender than this draft does (its `from`, else the account's own address)? */
export const changesSender = (theirs: DraftFields, mine: DraftFields, own: string | undefined) => {
  const [then, now] = [theirs.from?.address ?? own, mine.from?.address ?? own];
  return then !== undefined && now !== undefined && !sameAddress(then, now);
};

/**
 * The draft whose upload (not yet recorded) history reports: the Message-ID is the one that upload was made under,
 * whether it is still running (`uploading`) or was set aside for a newer revision (`wrote`).
 */
export function ownUpload(tx: CommitExtensionTx, w: RemoteDraftWrite) {
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

/** The echo of our own upload under a new message id: the row's base moves to it, nothing else changes. */
export function advanceBase(
  tx: CommitExtensionTx,
  row: DraftRow,
  meta: DraftMeta,
  w: RemoteDraftWrite,
) {
  const { fields } = parseData(row.data);
  const data = packData(fields, { ...meta, wrote: remembered(meta, w.remoteMessageId) });
  tx.run(
    'UPDATE drafts SET remote_message_id = ?, data = ? WHERE id = ?',
    w.remoteMessageId,
    data,
    row.id,
  );
}

/**
 * The copy a create-path conflict names becomes the row's own copy (see `remoteDraftId` on the write), only when the
 * provider proved it carries this upload's Message-ID. Its message id is left out of the row: until the owner keeps
 * theirs or mine it is not a version of ours (and a discard of the row then forgets it instead of deleting it).
 */
export function adoptedByConflict(
  tx: CommitExtensionTx,
  row: DraftRow,
  meta: DraftMeta,
  w: Extract<DraftWrite, { op: 'conflict' }>,
) {
  if (w.gone || w.remoteDraftId === undefined || row.remote_draft_id !== null) return undefined;
  // Another row already shows that copy (history reported it): two rows never share a remote draft.
  if (holdersOf(tx, row, w.remoteDraftId).length) return undefined;
  if (w.remoteInternetId !== w.internetId) return undefined;
  return { columns: { remote_draft_id: w.remoteDraftId }, wrote: remembered(meta, w.internetId) };
}
