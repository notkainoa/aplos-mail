import {
  PausedError,
  ProviderError,
  type AdapterContext,
  type DraftSaveResult,
  type DraftUpload,
} from '@aplos/engine/ports';
import { GmailClient, type GmailDeps } from './client';
import { DraftAttempts, rawIdentity, sameDraftContent } from './draft-compare';
import { checkDraftMime } from './draft-mime';
import {
  DRAFT_TOKEN_HEADER,
  identityOf,
  shownMessageId,
  tokenOf,
  withDraftToken,
} from './draft-token';
import { uploadDraft, type DraftResource } from './draft-upload';

/**
 * The Gmail drafts API behind `ProviderAdapter.saveDraft` and `deleteDraft` (plan 20 PV4, ARCH 7.4). The local draft is
 * the truth; this keeps one remote copy of it, and the rules are about never losing or overwriting text and never
 * touching a message that has been sent.
 *
 * IDENTITY (2026-11-04, `draft-token.ts`, plans/engine/draft-identity.md item 3): real Gmail gives every draft it saves
 * through the API its own `<...@mail.gmail.com>` Message-ID, so ours never survives on a draft and `rfc822msgid:<ours>`
 * finds nothing; the draft id survives, the message id changes on every save. So every upload carries
 * `X-Aplos-Draft: <DraftUpload.internetId>` as its first header (the engine's draft MIME and the pinned send MIME never
 * do), and every read of a draft names the copy by its IDENTITY: that token when the copy carries exactly one
 * well-formed (`<local@domain>`) token, else the Message-ID header it shows. Below, "Message-ID" of a copy means this
 * identity; the history facts (`draft-body.ts`) report it as `internetId` too. The token only FINDS and NAMES a copy:
 * a phone can keep it on its edit and anyone can forge it, so every adoption and replace still needs the content proof.
 * The content comparison (`draft-compare.ts`) leaves out exactly the two identity headers (Message-ID and the token)
 * and compares the identity on its own. A `saved` result carries `copyInternetId`, the Message-ID Gmail shows for the
 * copy when it is not ours (one `drafts.get` metadata read after a create or replace, 20 units; a lookup hit uses the
 * metadata it already read; a failed read leaves the field out and never fails the save).
 *
 * saveDraft, create (`remoteDraftId` absent): the copy is first looked up by its per-revision Message-ID, so a retry
 * after an uncertain create (a timeout after the request left, a crash before the engine recorded the answer) finds
 * the copy the first try made instead of creating a second. Three lookups, cheapest first, every hit verified by its own
 * Message-ID header: (a) `drafts.list` with `rfc822msgid:<id> in:drafts`; (b) because that search lags the index, the
 * newest `CANDIDATES` drafts listed without `q` (a plain list is not search-backed); (c) `messages.list` for the
 * Message-ID across all mail including Spam and Trash: a SENT or TRASH message that holds it means the copy this create
 * made was sent or deleted from another device before history saw it, so the answer is `{kind:'gone'}` and it is not
 * created again (a DRAFT-only hit that (a) and (b) missed is index lag: thrown as transient, never created over). A hit
 * in (c) that returns 404 when read is thrown as `draftHitVanished` (its id changed, so the answer is unknown), never
 * counted as "nothing found". A draft hard-deleted (not trashed) from another device leaves nothing to find; that case
 * cannot be caught and the retry creates the copy again. Lookup (c) is a search too, so it lags the same way: a message
 * sent or trashed a moment ago may not be listed yet, and until it is the lookup answers absent and the draft is created
 * again (the same limit as a hard delete). A create that comes back uncertain re-checks once the same way.
 * On Gmail (a) and (c) never match our own copy (Gmail replaced the Message-ID) and (b) finds it by its token. Only when
 * an attempt under this same Message-ID by this process may have landed (`DraftAttempts.mayHaveLanded`: it was
 * answered, or ended uncertain; a definite refusal does not count) and (a) to (c) found nothing, two more: (d) the newest `CANDIDATES` messages of
 * `in:sent OR in:trash` (one `messages.list`, metadata reads with the token): a SENT or TRASH copy carrying our identity
 * is `{kind:'gone'}` (the case (c) answers where the Message-ID is kept); (e) the CONTENT-MATCHED FALLBACK for a copy
 * whose token Gmail dropped (it shows only Gmail's id): each draft (b) listed and read that carries no well-formed token
 * (in the upload's thread when it names one) is read raw, and it is our copy, `saved`, only when its message id is
 * unchanged and its content equals the upload this adapter recorded for this local draft under this Message-ID. A copy
 * that differs (a phone edit) or that nobody recorded (after a restart) is never adopted: the create goes ahead and
 * makes a visible duplicate; nothing is overwritten or deleted. Known limit on Gmail: a copy outside the newest page
 * whose token search cannot see (search cannot find a custom header) is created again (a visible duplicate) where a
 * provider that keeps the Message-ID would have answered index lag through (c).
 * A hit in (a) or (b) is not trusted by its header: the draft is read with `drafts.get` format=raw and its decoded bytes
 * are compared with `draft.mime` (`draft-compare.ts`: line endings normalised, the multipart boundaries blanked,
 * because the engine rebuilds the MIME on every attempt with fresh random boundaries, and the identity headers compared
 * on their own: the raw identity must be exactly the upload's; otherwise byte for byte). Equal: `saved` with its CURRENT
 * message id. Different (the owner edited the copy on another device and Gmail kept our Message-ID): `{kind:'conflict'}`
 * with its message id and nothing is written, so the retry never adopts a phone edit as its base. PORT GAP 4 (closed by
 * #153): that create-path conflict names the copy: `remoteDraftId`, `remoteMessageId` and `remoteInternetId`, the
 * Message-ID header the copy carries, read from the raw bytes just compared (left out when the raw has none). The engine
 * adopts the copy only when that equals the upload's Message-ID, and it stays "theirs": nothing here deletes or
 * overwrites it. TODO(live): try it on a real account before provider draft sync is switched on. A raw read that fails,
 * a draft that vanished or stopped being a draft between the two reads: thrown (transient), never `saved`. A message id
 * that changed between the reads is a conflict. TODO(live): Gmail may rewrite headers or line wrapping of an uploaded
 * draft; then the bytes differ for our own copy, and the retry yields a conflict about our own text (safe, "keep mine"
 * recovers it), never a silent overwrite.
 * saveDraft, replace: `drafts.get` first (metadata, with the Message-ID header). A draft that is gone (404), or is no
 * longer a draft (no DRAFT label, or SENT or TRASH), is `{kind:'gone'}` and is never recreated or written; a reply
 * without `labelIds` is an invalid response, not "not a draft". A message id other than `baseRemoteMessageId` is
 * `{kind:'conflict'}` and nothing is written, always, even when the copy's Message-ID header is ours. So an update
 * whose answer was lost (or a new revision after it) yields a conflict about our own text: safe by design, and "keep
 * mine" recovers it. TODO(live): verify whether Gmail rewrites the Message-ID when another client edits a draft (the
 * create lookup above does not trust the header either: it compares the bytes); only then could a lost update ack be
 * recognised without risk of adopting a foreign edit. A 404 on the update itself is re-read
 * with `drafts.get` and is `gone` only if that also 404s or the draft is no longer one; a draft that still exists
 * makes it a transient, uncertain error.
 * Otherwise `drafts.update` replaces the copy and the new message id is returned: it is the precondition of the next
 * save and of `sendsRemoteDraft`. Gmail has no etag, so an edit made between the `get` and the `update` (milliseconds)
 * still wins the race; the next save sees the new id and raises the conflict. The update is an `idempotentWrite` the
 * governor may re-send after a transient failure: a lost reply followed by a re-send can therefore overwrite a phone
 * edit made in those few seconds (the re-send does not repeat the `get`). With no `baseRemoteMessageId` the replace is
 * unconditional; the engine sets that only for "keep mine".
 * deleteDraft (PORT GAP 3, closed by #153): `deleteDraft(remoteDraftId, ctx, expectedMessageId?)`. WITHOUT an expected
 * message id nothing is deleted and no request goes out (a caller that cannot prove which copy it holds never deletes;
 * there is no unguarded delete any more). With one: idempotent; `drafts.get` first (metadata); absent is success; a
 * message that is no longer a draft (sent, trashed) is left alone; a draft whose CURRENT message id differs from the
 * expected one (another device edited it, Gmail gave it a new message id) is left alone and the call resolves; only a
 * draft that still holds the expected message id gets `drafts.delete`. Gmail has no precondition on the delete, so an
 * edit made in the milliseconds between the `get` and the `delete` is still lost (the same window as the replace).
 * `GoogleProviderOptions.deleteDrafts` defaults to true (guarded removal); false turns every removal off.
 *
 * Bytes: `DraftUpload.mime` goes up with only the `X-Aplos-Draft` line added in front, after `checkDraftMime` on
 * exactly those bytes (size cap, header allow-list, no Bcc, Message-ID and token are the per-revision id). Threading:
 * `remoteThreadId` becomes the upload's `threadId`; In-Reply-To and References stay as the engine wrote them. Pacing:
 * create 10 units, update 15 (`GMAIL_COSTS`), the `drafts.get` before a replace 20, the `copyInternetId` read after a
 * create or replace 20, and the lookup before a create at least 15 (`drafts.list` x2 and `messages.list`, 5 each).
 * Each draft or message the lookup has to read adds 20 (`drafts.get`, `messages.get` metadata): about 215 with 10
 * drafts in the first page, at most about 615 (10 reads in each of (a), (b) and (c)). A verified hit adds one
 * `drafts.get` format=raw (60, priced as full), and then (b) and (c) are skipped. Only after an attempt that may have landed (a
 * retry): (d) adds 5 plus 20 per message read (at most 205) and (e) 60 per draft read raw (at most 600), so a retry
 * that finds nothing costs at most about 1,420. All through the governor on the `opFlush` lane. A create is `write`,
 * never re-sent by the governor; an update is `idempotentWrite`.
 *
 * Remote drafts Aplos did not write (a phone, Gmail web): `history.ts` reports every DRAFT message whose id is not in
 * `KnownLookup.draftsByMessageId` as a `RemoteDraftFact` (id, message id, thread, no body, no fetch), which is the
 * engine's conflict candidate (`drafts.remote_message_id` differs). The ports cannot deliver more, and "take theirs" /
 * "keep both" need more:
 *   - Body delivery (history.ts, `RemoteDraftFact.html`/`text`): for a foreign draft the history pass reads the draft with
 *     `drafts.get` format=full (60 units, at most `BODY_FETCHES` = 5 per history pass across its pages, the rest on the next pass) and delivers
 *     the decoded text/html parts when it has no attachment (any part, leaf or container, with a filename, an
 *     attachment or inline disposition, or a type that is not text/* or multipart/*, such as message/rfc822; inline
 *     images count), the body sits in the message (not by attachment id), is not empty and not over 1,000,000
 *     characters; otherwise it is reported without a body (snippet only). The same read sets the fact's `internetId`
 *     from the draft's identity (the token, else the Message-ID header) and `message` (from, to, cc, bcc, subject, snippet, attachments); html/text are never
 *     delivered without `message`, nor from an unknown or invalid charset. A transient read failure is retried on later passes (3 reads in all), then
 *     dropped; a 404 or a non-draft drops it at once. Attachments are NOT delivered (PORT GAP 1 remainder): such a
 *     draft stays incomplete in the engine. Content is never logged.
 *   - `supersedes` (history.ts): the previous message ids of the same draft id, from this adapter's own message-to-draft
 *     map; the engine decides whether the fact is our echo (it needs its own proof).
 *   - PORT GAP 2 (CLOSED on the Gmail side by `DraftUpload.supersedes`, #157): an uncertain create of revision N may
 *     have landed, and revision N+1 (a new Message-ID) must not make a second copy. When the lookups above find nothing
 *     for this upload's own Message-ID, the create looks up each Message-ID in `supersedes` (at most the last five,
 *     never its own; the search per id, the newest drafts once, then all mail, then, after an attempt under one
 *     of them that may have landed, the Sent/Trash scan (d); no content-matched fallback). A draft found by one of them is
 *     REPLACED (`drafts.update`, the result names its draftId) only with proof it is our own earlier upload, all of:
 *     it is still a DRAFT (not SENT or TRASH) with the message id the search showed, its raw Message-ID header is one
 *     of `supersedes`, its thread is the upload's `remoteThreadId` when that is set, and its raw bytes canonicalise
 *     (`draft-compare.ts`) to an upload this adapter recorded for this local draft under that same Message-ID
 *     (`DraftAttempts`: the last five per draft, recorded BEFORE every create request and every replace of an earlier copy goes out). Otherwise
 *     (a phone edit of that copy, a copy from before a restart, a Gmail rewrite) the answer is `{kind:'conflict'}` with
 *     remoteDraftId, remoteMessageId and remoteInternetId, and nothing is written. A SENT or TRASH message holding a
 *     listed Message-ID (and no draft found) is `{kind:'gone'}`, never recreated; a DRAFT-only hit that the lookups missed
 *     is index lag, thrown. A draft with any other Message-ID is never read as ours, replaced or deleted. Nothing is
 *     ever deleted here. On Gmail with the token dropped no earlier copy can be found by identity, so the create makes a
 *     visible duplicate (never a replace). LIMIT: `saveDraft` has no channel to `provider_memory` (only a sync step's result writes it), so
 *     the record lives in process memory; after a restart no copy is provable, the create answers `conflict` (the
 *     owner's "keep mine" recovers) and never replaces. Absent or empty `supersedes`: exactly the lookups above.
 *     Pacing: each listed id adds a search (5) plus the reads of its hits (20 each), and one raw read (60) and an update
 *     (15) when a copy is replaced. The replace has the same millisecond window as any update (no etag).
 * RULE: a create-lookup hit whose bytes differ from `draft.mime` is a conflict, never `saved` (the comparison is exact apart
 * from line endings, boundaries and the identity headers, so a harmless rewrite by Gmail also shows as a conflict: known
 * limit, tested). The content-matched fallback adopts only bytes equal to an upload this process recorded. A
 * delete never removes a draft it cannot prove is the copy the caller holds (expected message id). A create offered
 * `supersedes` replaces a found copy only with the proof above (PORT GAP 2); a duplicate copy that is not provably ours
 * is left alone.
 * The upload session URI must be https on `googleapis.com` or a subdomain (deliberate: the bytes and the token go there).
 * Search lags the index: lookup (b) above reads the newest drafts without `q` to cover it. A duplicate that still gets
 * made (a copy found by neither lookup, or a second earlier copy beyond the one replaced) is NOT cleaned up by the engine
 * yet (`adoptCopy` returns early when the row already has a remote draft id, and DECISIONS says the orphan is not
 * deleted): a duplicate remote draft stays until the owner removes it.
 */

const DRAFT = 'DRAFT';
const SENT = 'SENT';
const TRASH = 'TRASH';
/** Hits verified per Message-ID search: a Message-ID is unique, so more than one is already unusual. */
const CANDIDATES = 10;
/** Message-ID characters that are plain words to Gmail search: no quote, brace, parenthesis, bar or space. */
const SEARCHABLE_ID = /^<([A-Za-z0-9.!#$%&'*+/=?^_`~@-]{1,900})>$/;

const bareId = (id: string): string => id.trim().replace(/^<|>$/g, '').toLowerCase();

/**
 * A draft as `drafts.get` shows it: its message id, whether it is still a draft, its identity (`internetId`: the
 * `X-Aplos-Draft` token when well-formed, else the Message-ID header, `draft-token.ts`), whether it carries a token, and
 * the Message-ID header Gmail shows (`shownId`).
 */
interface RemoteCopy {
  draftId: string;
  messageId: string;
  threadId?: string;
  isDraft: boolean;
  internetId?: string;
  tokened: boolean;
  shownId?: string;
}

interface DraftGet {
  id?: unknown;
  message?: {
    id?: unknown;
    threadId?: unknown;
    labelIds?: unknown;
    payload?: { headers?: { name?: unknown; value?: unknown }[] };
  };
}

const is404 = (error: unknown): boolean =>
  error instanceof ProviderError && error.error.status === 404;

const incomplete = (method: string, reason: string): ProviderError =>
  new ProviderError({ class: 'transient', provider: 'gmail', method, reason });

function copyOf(draft: DraftGet): RemoteCopy | undefined {
  const message = draft.message;
  if (typeof draft.id !== 'string' || typeof message?.id !== 'string') return undefined;
  // Asked for with a `fields` mask: a reply without labels cannot say whether this is a draft, so it says nothing.
  if (!Array.isArray(message.labelIds)) return undefined;
  const labels = message.labelIds;
  const headers = message.payload?.headers;
  const internetId = identityOf(headers);
  const shownId = shownMessageId(headers);
  return {
    draftId: draft.id,
    messageId: message.id,
    isDraft: labels.includes(DRAFT) && !labels.includes(SENT) && !labels.includes(TRASH),
    ...(typeof message.threadId === 'string' ? { threadId: message.threadId } : {}),
    ...(internetId ? { internetId } : {}),
    tokened: tokenOf(headers) !== undefined,
    ...(shownId ? { shownId } : {}),
  };
}

/** The headers every metadata read of a draft or a message asks for: the token and the Message-ID. */
const IDENTITY_HEADERS = [DRAFT_TOKEN_HEADER, 'Message-ID'];

/** The remote copy as it is now, or undefined when Gmail says the draft does not exist. */
async function readCopy(client: GmailClient, draftId: string): Promise<RemoteCopy | undefined> {
  let reply: DraftGet;
  try {
    reply = await client.call<DraftGet>({
      method: 'gmail.drafts.get',
      path: `/drafts/${encodeURIComponent(draftId)}`,
      format: 'metadata',
      query: { metadataHeaders: IDENTITY_HEADERS },
      fields: 'id,message(id,threadId,labelIds,payload/headers)',
      lane: 'opFlush',
      item: draftId,
    });
  } catch (error) {
    if (is404(error)) return undefined;
    throw error;
  }
  // A reply that names no message is not provably a draft and not provably gone: say so, change nothing.
  const copy = copyOf(reply);
  if (!copy) throw incomplete('gmail.drafts.get', 'invalidResponse');
  return copy;
}

function bareSearchId(internetId: string): string {
  const bare = SEARCHABLE_ID.exec(internetId)?.[1];
  if (!bare) {
    throw new ProviderError({
      class: 'permanent',
      provider: 'gmail',
      method: 'gmail.drafts.list',
      reason: 'unsearchableMessageId',
    });
  }
  return bare;
}

const searchQuery = (internetId: string): string =>
  `rfc822msgid:${bareSearchId(internetId)} in:drafts`;

/** Ids of the drafts a `drafts.list` page names (with `q` when given) and whether more pages exist. */
async function listDraftIds(
  client: GmailClient,
  q?: string,
): Promise<{ ids: string[]; more: boolean }> {
  const page = await client.call<{ drafts?: { id?: unknown }[]; nextPageToken?: string }>({
    method: 'gmail.drafts.list',
    path: '/drafts',
    query: { ...(q ? { q } : {}), maxResults: CANDIDATES },
    fields: 'drafts(id),nextPageToken',
    lane: 'opFlush',
  });
  const ids = (page.drafts ?? [])
    .map(d => d.id)
    .filter((id): id is string => typeof id === 'string');
  return { ids, more: Boolean(page.nextPageToken) };
}

/**
 * The drafts one create has already read (`drafts.get`, metadata), by draft id. A later lookup of the same create
 * checks these copies against its own Message-IDs instead of reading them again; nothing is kept between creates.
 */
type DraftReads = Map<string, RemoteCopy>;

/**
 * The first of `ids` that is a draft holding one of `internetIds`; a hit that vanished before it could be read is
 * reported. A draft in `reads` is not read again (its copy is checked); a copy read here is added to it.
 */
async function verifyDrafts(
  client: GmailClient,
  ids: string[],
  internetIds: string | string[],
  reads: DraftReads = new Map(),
): Promise<{ found?: RemoteCopy; vanished: boolean }> {
  const wanted = new Set([internetIds].flat().map(bareId));
  let vanished = false;
  for (const id of ids) {
    const copy = reads.get(id) ?? (await readCopy(client, id));
    if (copy) reads.set(id, copy);
    if (!copy) vanished = true;
    else if (copy.isDraft && copy.internetId && wanted.has(bareId(copy.internetId)))
      return { found: copy, vanished };
  }
  return { vanished };
}

interface MessageHit {
  labelIds?: unknown;
  payload?: { headers?: { name?: unknown; value?: unknown }[] };
}

/** What a message holding `internetId` anywhere in the mailbox (Spam and Trash included) says about our copy. */
async function allMailVerdict(
  client: GmailClient,
  internetId: string,
): Promise<'gone' | 'indexLag' | 'absent'> {
  const page = await client.call<{ messages?: { id?: unknown }[]; nextPageToken?: string }>({
    method: 'gmail.messages.list',
    path: '/messages',
    query: {
      q: `rfc822msgid:${bareSearchId(internetId)}`,
      maxResults: CANDIDATES,
      includeSpamTrash: 'true',
    },
    fields: 'messages(id),nextPageToken',
    lane: 'opFlush',
  });
  let verdict: 'gone' | 'indexLag' | 'absent' = 'absent';
  for (const hit of page.messages ?? []) {
    if (typeof hit.id !== 'string') continue;
    const labels = await holdingLabels(client, hit.id, [internetId]);
    if (labels?.includes(SENT) || labels?.includes(TRASH)) return 'gone';
    if (labels?.includes(DRAFT)) verdict = 'indexLag';
  }
  if (page.nextPageToken) throw incomplete('gmail.messages.list', 'draftSearchPartial');
  return verdict;
}

/**
 * The labels of message `id` when its identity (token, else Message-ID header) is one of `internetIds`; undefined for
 * another message. A hit that returns 404 is thrown (`draftHitVanished`): its id changed or it was deleted since the
 * search listed it, and a copy that was sent or discarded elsewhere may be exactly that, so "nothing found" would
 * create the draft again.
 */
async function holdingLabels(
  client: GmailClient,
  id: string,
  internetIds: string[],
): Promise<string[] | undefined> {
  let message: MessageHit;
  try {
    message = await client.call<MessageHit>({
      method: 'gmail.messages.get',
      path: `/messages/${encodeURIComponent(id)}`,
      format: 'metadata',
      query: { metadataHeaders: IDENTITY_HEADERS },
      fields: 'labelIds,payload/headers',
      lane: 'opFlush',
      item: id,
    });
  } catch (error) {
    if (is404(error)) throw incomplete('gmail.messages.get', 'draftHitVanished');
    throw error;
  }
  const identity = identityOf(message.payload?.headers);
  if (!identity || !internetIds.some(id => bareId(id) === bareId(identity))) return undefined;
  return Array.isArray(message.labelIds) ? (message.labelIds as string[]) : [];
}

/**
 * (d) Whether a message among the newest in Sent or Trash carries one of `internetIds` as its identity: the copy an
 * earlier attempt made was sent or discarded from another device. Gmail search cannot find a custom header, so on
 * Gmail (which replaces our Message-ID on a draft) lookup (c) never sees such a copy; this reads the newest
 * `CANDIDATES` messages of `in:sent OR in:trash` (one list, 5 units, plus 20 per read) and matches the token. Only
 * after an attempt that may have landed (see `findByInternetId`). Search-backed, so a copy sent a moment ago may not be
 * listed yet; then it is created again (the same limit as lookup (c)).
 */
async function sentOrTrashed(client: GmailClient, internetIds: string[]): Promise<boolean> {
  const page = await client.call<{ messages?: { id?: unknown }[] }>({
    method: 'gmail.messages.list',
    path: '/messages',
    query: { q: 'in:sent OR in:trash', maxResults: CANDIDATES, includeSpamTrash: 'true' },
    fields: 'messages(id)',
    lane: 'opFlush',
  });
  for (const hit of page.messages ?? []) {
    if (typeof hit.id !== 'string') continue;
    const labels = await holdingLabels(client, hit.id, internetIds);
    if (labels?.includes(SENT) || labels?.includes(TRASH)) return true;
  }
  return false;
}

interface RawDraft {
  message?: { id?: unknown; labelIds?: unknown; raw?: unknown };
}

/** The draft's current message as `drafts.get` format=raw says it; anything unclear is thrown, never guessed. */
async function readRaw(
  client: GmailClient,
  draftId: string,
): Promise<{ messageId: string; raw: Buffer }> {
  let reply: RawDraft;
  try {
    reply = await client.call<RawDraft>({
      method: 'gmail.drafts.get',
      path: `/drafts/${encodeURIComponent(draftId)}`,
      format: 'raw',
      fields: 'message(id,labelIds,raw)',
      lane: 'opFlush',
      item: draftId,
    });
  } catch (error) {
    if (is404(error)) throw incomplete('gmail.drafts.get', 'draftHitVanished');
    throw error;
  }
  const message = reply.message;
  if (typeof message?.id !== 'string' || typeof message.raw !== 'string' || !message.raw)
    throw incomplete('gmail.drafts.get', 'invalidResponse');
  const labels = message.labelIds;
  if (!Array.isArray(labels)) throw incomplete('gmail.drafts.get', 'invalidResponse');
  if (!labels.includes(DRAFT) || labels.includes(SENT) || labels.includes(TRASH))
    throw incomplete('gmail.drafts.get', 'draftHitChanged');
  return { messageId: message.id, raw: Buffer.from(message.raw, 'base64url') };
}

/**
 * A hit found by its identity (token or Message-ID header), checked against our bytes: the same message id, the raw
 * identity exactly this upload's `internetId`, and the same content (`sameDraftContent`) is our copy (`saved` with its
 * current message id); anything else is somebody else's edit under our identity (a conflict, nothing written).
 */
async function verifiedHit(
  client: GmailClient,
  found: RemoteCopy,
  draft: DraftUpload,
): Promise<Lookup> {
  const current = await readRaw(client, found.draftId);
  const internetId = rawIdentity(current.raw);
  const ours =
    current.messageId === found.messageId &&
    internetId === draft.internetId &&
    sameDraftContent(current.raw, draft.mime);
  if (ours) return { kind: 'draft', copy: found };
  return {
    kind: 'conflict',
    draftId: found.draftId,
    messageId: current.messageId,
    ...(internetId ? { internetId } : {}),
  };
}

/**
 * The drafts in `ids` that show this create's identity, judged one at a time: the first whose bytes prove it is our copy
 * is the answer. Two drafts can carry one token (a phone duplicate, a copied header): the first listed must not hide
 * ours behind a conflict, so a match that is NOT ours is set aside and the next match is looked at (an extra raw read
 * only after a mismatch, at most `CANDIDATES` matches); when none proves ours, the FIRST mismatch is the answer, a
 * conflict naming it, and nothing is written. A hit that vanished before it could be read is reported only when
 * nothing conflicted.
 */
async function matchByIdentity(
  client: GmailClient,
  ids: string[],
  internetId: string,
  reads: DraftReads,
  draft: DraftUpload,
): Promise<{ lookup?: Lookup; vanished: boolean }> {
  const judged = new Set<string>();
  let conflict: Lookup;
  for (let round = 0; round < CANDIDATES; round++) {
    const hit = await verifyDrafts(
      client,
      ids.filter(id => !judged.has(id)),
      internetId,
      reads,
    );
    if (!hit.found)
      return conflict ? { lookup: conflict, vanished: false } : { vanished: hit.vanished };
    const verified = await verifiedHit(client, hit.found, draft);
    if (verified?.kind === 'draft') return { lookup: verified, vanished: false };
    conflict ??= verified;
    judged.add(hit.found.draftId);
  }
  return { lookup: conflict, vanished: false };
}

/** What the lookups before a create found: our copy, proof that it was sent or deleted elsewhere, or nothing. */
type Lookup =
  | { kind: 'draft'; copy: RemoteCopy }
  | { kind: 'conflict'; draftId: string; messageId: string; internetId?: string }
  | { kind: 'gone' }
  | undefined;

/**
 * (e) The content-matched fallback, only for a create whose earlier attempt under this same `internetId` may have
 * landed (`DraftAttempts.mayHaveLanded`) and only when (a) to (d) found nothing: Gmail may have dropped the token, so the copy
 * shows Gmail's own Message-ID and no identity of ours. Among the drafts lookup (b) listed and read, each draft with no
 * well-formed token (in the upload's thread when it names one) is read raw (60 units, at most `CANDIDATES`), and it is
 * our copy only when its message id is unchanged since the metadata read and its content equals the upload this
 * adapter recorded for this local draft under this `internetId` (`DraftAttempts.wrote`). Nothing else is ever adopted:
 * a phone edit differs in content, so at worst the create makes a visible duplicate.
 */
async function contentMatch(
  client: GmailClient,
  draft: DraftUpload,
  ids: string[],
  reads: DraftReads,
  attempts: DraftAttempts,
): Promise<Lookup> {
  for (const id of ids.slice(0, CANDIDATES)) {
    const copy = reads.get(id);
    if (!copy?.isDraft || copy.tokened) continue;
    if (draft.remoteThreadId && copy.threadId !== draft.remoteThreadId) continue;
    const current = await readRaw(client, id);
    const proven =
      current.messageId === copy.messageId &&
      attempts.wrote(draft.draftId, draft.internetId, current.raw);
    if (proven) return { kind: 'draft', copy };
  }
  return undefined;
}

/**
 * Where a create's copy may already be (see the header): (a) the search, (b) the newest drafts without `q` (matched by
 * identity, so the `X-Aplos-Draft` token finds our copy on Gmail), (c) all mail by Message-ID; and, only after an
 * attempt under this `internetId` that may have landed (`attempts`), (d) the newest Sent and Trash matched by identity
 * and (e) the content-matched fallback. A hit in (a) or (b) is compared with our bytes (`verifiedHit`). An answer that
 * is not complete (more hits than one page of the search, a hit that vanished before it could be checked) is thrown,
 * never reported as absent.
 */
async function findByInternetId(
  client: GmailClient,
  draft: DraftUpload,
  reads: DraftReads = new Map(),
  attempts?: DraftAttempts,
): Promise<Lookup> {
  const internetId = draft.internetId;
  const searched = await listDraftIds(client, searchQuery(internetId));
  const first = await matchByIdentity(client, searched.ids, internetId, reads, draft);
  if (first.lookup) return first.lookup;
  if (first.vanished) throw incomplete('gmail.drafts.list', 'draftHitVanished');
  if (searched.more) throw incomplete('gmail.drafts.list', 'draftSearchPartial');
  // The search lags the index: the newest drafts, read without it, cover a copy made a moment ago.
  const newest = await listDraftIds(client);
  const fresh = newest.ids.filter(id => !searched.ids.includes(id));
  const second = await matchByIdentity(client, fresh, internetId, reads, draft);
  if (second.lookup) return second.lookup;
  if (second.vanished) throw incomplete('gmail.drafts.list', 'draftHitVanished');
  const verdict = await allMailVerdict(client, internetId);
  if (verdict === 'gone') return { kind: 'gone' };
  if (verdict === 'indexLag') throw incomplete('gmail.drafts.list', 'draftIndexLag');
  if (!attempts?.mayHaveLanded(draft.draftId, internetId)) return undefined;
  if (await sentOrTrashed(client, [internetId])) return { kind: 'gone' };
  return contentMatch(client, draft, newest.ids, reads, attempts);
}

/** What the lookup for `supersedes` found: as `Lookup`, or one of our own earlier copies, proven, to be replaced. */
type EarlierLookup = Lookup | { kind: 'earlier'; copy: RemoteCopy };

/** At most this many earlier Message-IDs are looked up (the engine offers its last five). */
const EARLIER = 5;

/** The earlier Message-IDs worth a lookup: unique, not this upload's own, searchable; the newest `EARLIER`. */
function earlierIds(draft: DraftUpload): string[] {
  const own = bareId(draft.internetId);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of draft.supersedes ?? []) {
    const key = bareId(id);
    if (key === own || seen.has(key) || !SEARCHABLE_ID.test(id.trim())) continue;
    seen.add(key);
    ids.push(id.trim());
  }
  return ids.slice(-EARLIER);
}

/**
 * Where an earlier, unanswered create of this draft may have landed (`DraftUpload.supersedes`): the same three lookups as
 * `findByInternetId` for each listed Message-ID, the drafts search per id and the newest drafts once. A draft carrying
 * one of them is `earlier` only after `verifiedEarlier`; a SENT or TRASH message holding one (and no draft found) is
 * `gone`. Nothing else is matched: an unrelated draft is never read as ours. `reads` holds the drafts `findByInternetId`
 * of the same create already read: they are matched against `supersedes` from those reads, not read a second time.
 */
async function findEarlier(
  client: GmailClient,
  draft: DraftUpload,
  attempts: DraftAttempts,
  reads: DraftReads,
): Promise<EarlierLookup> {
  const ids = earlierIds(draft);
  if (ids.length === 0) return undefined;
  const searchedIds: string[] = [];
  for (const id of ids) {
    const searched = await listDraftIds(client, searchQuery(id));
    const hit = await verifyDrafts(client, searched.ids, id, reads);
    if (hit.found) return verifiedEarlier(client, hit.found, draft, attempts, ids);
    if (hit.vanished) throw incomplete('gmail.drafts.list', 'draftHitVanished');
    if (searched.more) throw incomplete('gmail.drafts.list', 'draftSearchPartial');
    searchedIds.push(...searched.ids);
  }
  const newest = await listDraftIds(client);
  const hit = await verifyDrafts(
    client,
    newest.ids.filter(id => !searchedIds.includes(id)),
    ids,
    reads,
  );
  if (hit.found) return verifiedEarlier(client, hit.found, draft, attempts, ids);
  if (hit.vanished) throw incomplete('gmail.drafts.list', 'draftHitVanished');
  let lagging = false;
  for (const id of ids) {
    const verdict = await allMailVerdict(client, id);
    if (verdict === 'gone') return { kind: 'gone' };
    lagging ||= verdict === 'indexLag';
  }
  if (lagging) throw incomplete('gmail.drafts.list', 'draftIndexLag');
  const tried = ids.some(id => attempts.mayHaveLanded(draft.draftId, id));
  if (tried && (await sentOrTrashed(client, ids))) return { kind: 'gone' };
  return undefined;
}

/**
 * A draft found by an earlier Message-ID is replaced only when it is provably the copy of our own earlier upload: it
 * is still a draft with the message id the search showed, its raw Message-ID is one of `supersedes`, its thread is the
 * upload's when the upload names one, and its raw bytes canonicalise to an upload this adapter recorded for this draft
 * under that same Message-ID (`DraftAttempts`). Anything else (a phone edit, a copy from before a restart, a Gmail
 * rewrite) is a conflict that names the copy, and nothing is written.
 */
async function verifiedEarlier(
  client: GmailClient,
  found: RemoteCopy,
  draft: DraftUpload,
  attempts: DraftAttempts,
  ids: string[],
): Promise<EarlierLookup> {
  const current = await readRaw(client, found.draftId);
  const internetId = rawIdentity(current.raw);
  const listed = internetId !== undefined && ids.some(id => bareId(id) === bareId(internetId));
  const sameThread = !draft.remoteThreadId || found.threadId === draft.remoteThreadId;
  const ours =
    listed &&
    sameThread &&
    current.messageId === found.messageId &&
    attempts.wrote(draft.draftId, internetId, current.raw);
  if (ours) return { kind: 'earlier', copy: found };
  return {
    kind: 'conflict',
    draftId: found.draftId,
    messageId: current.messageId,
    ...(internetId ? { internetId } : {}),
  };
}

function saved(
  draft: { draftId: string; messageId: string },
  revision: number,
  copyInternetId?: string,
): DraftSaveResult {
  return {
    kind: 'saved',
    remoteDraftId: draft.draftId,
    remoteMessageId: draft.messageId,
    revision,
    ...(copyInternetId ? { copyInternetId } : {}),
  };
}

/** `copyInternetId`: the Message-ID the copy shows, when it is not the upload's own. */
const otherId = (shown: string | undefined, draft: DraftUpload): string | undefined =>
  shown && shown !== draft.internetId ? shown : undefined;

/**
 * A copy just stored by `drafts.create` or `drafts.update`, with the Message-ID Gmail shows for it (`copyInternetId`,
 * when it is not ours): ONE `drafts.get` metadata read (20 units). A read that fails, or that shows another message id
 * (the copy changed since), leaves the field out: the save never fails for it and nothing is guessed.
 */
async function storedCopy(
  client: GmailClient,
  resource: DraftResource,
  draft: DraftUpload,
): Promise<DraftSaveResult> {
  const copy = fromResource(resource);
  let reply: DraftGet;
  try {
    reply = await client.call<DraftGet>({
      method: 'gmail.drafts.get',
      path: `/drafts/${encodeURIComponent(copy.draftId)}`,
      format: 'metadata',
      query: { metadataHeaders: ['Message-ID'] },
      fields: 'id,message(id,payload/headers)',
      lane: 'opFlush',
      item: copy.draftId,
    });
  } catch {
    return saved(copy, draft.revision);
  }
  if (reply.message?.id !== copy.messageId) return saved(copy, draft.revision);
  const shown = shownMessageId(reply.message.payload?.headers);
  return saved(copy, draft.revision, otherId(shown, draft));
}

const fromResource = (resource: DraftResource): { draftId: string; messageId: string } => ({
  draftId: resource.id,
  messageId: resource.message.id,
});

/** A lookup's answer as the save result: our copy, a conflict (the copy holds other bytes), or `gone` (sent or deleted elsewhere). */
function answered(found: NonNullable<Lookup>, draft: DraftUpload): DraftSaveResult {
  if (found.kind === 'gone') return { kind: 'gone' };
  if (found.kind === 'conflict') {
    return {
      kind: 'conflict',
      remoteMessageId: found.messageId,
      remoteDraftId: found.draftId,
      ...(found.internetId ? { remoteInternetId: found.internetId } : {}),
    };
  }
  return saved(found.copy, draft.revision, otherId(found.copy.shownId, draft));
}

/** After an uncertain create: one more look by Message-ID. A lookup that fails too leaves the original error standing. */
async function recheck(
  client: GmailClient,
  draft: DraftUpload,
  failure: ProviderError,
  attempts: DraftAttempts,
): Promise<DraftSaveResult> {
  if (!failure.error.uncertain) throw failure;
  let found: Lookup;
  try {
    found = await findByInternetId(client, draft, new Map(), attempts);
  } catch {
    throw failure;
  }
  if (found) return answered(found, draft);
  throw failure;
}

/** What this adapter wrote per draft, for the proof an earlier copy needs (`DraftAttempts`); one per adapter. */
const attemptsOf = new WeakMap<GmailDeps, DraftAttempts>();

function attemptsFor(deps: GmailDeps): DraftAttempts {
  const known = attemptsOf.get(deps) ?? new DraftAttempts();
  attemptsOf.set(deps, known);
  return known;
}

async function createCopy(
  deps: GmailDeps,
  draft: DraftUpload,
  ctx: AdapterContext,
  client: GmailClient,
): Promise<DraftSaveResult> {
  const reads: DraftReads = new Map();
  const attempts = attemptsFor(deps);
  const existing = await findByInternetId(client, draft, reads, attempts);
  if (existing) return answered(existing, draft);
  const earlier = await findEarlier(client, draft, attempts, reads);
  if (earlier?.kind === 'earlier') return replaceEarlier(deps, draft, ctx, client, earlier.copy);
  if (earlier) return answered(earlier, draft);
  // Remembered before the request goes out: a reply lost after the copy landed still leaves the proof for the next revision.
  attempts.record(draft.draftId, draft.internetId, draft.mime);
  let created: DraftResource;
  try {
    created = await uploadDraft(deps, ctx, {
      method: 'gmail.drafts.create',
      raw: draft.mime,
      ...(draft.remoteThreadId ? { threadId: draft.remoteThreadId } : {}),
    });
  } catch (error) {
    // Only an uncertain end leaves a copy that may exist: a definite refusal (a 429, a 4xx, a pause before the request)
    // keeps the retry on the cheap lookups. A 5xx is never definite, whatever reason it carries (a 503 with
    // `rateLimitExceeded` is classified `throttle` but the server may have stored the copy). Anything that is not a
    // classified refusal is treated as uncertain.
    const status = error instanceof ProviderError ? error.error.status : undefined;
    const definite =
      error instanceof PausedError ||
      (error instanceof ProviderError &&
        !error.error.uncertain &&
        !(status !== undefined && status >= 500));
    if (!definite) attempts.markMayHaveLanded(draft.draftId, draft.internetId);
    if (error instanceof ProviderError) return recheck(client, draft, error, attempts);
    throw error;
  }
  // Answered: the copy exists, and a lost record of this answer would leave it for the retry to find.
  attempts.markMayHaveLanded(draft.draftId, draft.internetId);
  return storedCopy(client, created, draft);
}

/** The precondition: nothing is written when the copy is not the one this device last synced. */
function precondition(draft: DraftUpload, current: RemoteCopy): DraftSaveResult | undefined {
  const base = draft.baseRemoteMessageId;
  if (base === undefined || current.messageId === base) return undefined;
  // Any other message id is a conflict, even when its Message-ID header is ours: a header is not proof of who wrote
  // the bytes. TODO(live): verify on real Gmail whether it rewrites the Message-ID when another client edits a draft;
  // only if it never keeps ours could a lost update ack be recognised safely.
  return { kind: 'conflict', remoteMessageId: current.messageId };
}

/**
 * A 404 on the update: gone only when the draft is really gone or no longer a draft. A draft that still exists means the
 * 404 was something else (a stale session, an upstream hiccup): throw it as uncertain, never `gone` (the engine would
 * forget a copy that is still there, and a later save could create a second).
 */
async function confirmGone(
  client: GmailClient,
  draftId: string,
  failure: unknown,
): Promise<DraftSaveResult> {
  const again = await readCopy(client, draftId);
  if (!again?.isDraft) return { kind: 'gone' };
  const cause = failure instanceof ProviderError ? failure.error : undefined;
  throw new ProviderError({
    class: 'transient',
    provider: 'gmail',
    method: 'gmail.drafts.update',
    reason: 'updateNotFoundButDraftExists',
    ...(cause?.status !== undefined ? { status: cause.status } : {}),
    uncertain: true,
  });
}

async function replaceCopy(
  deps: GmailDeps,
  draft: DraftUpload,
  remoteDraftId: string,
  ctx: AdapterContext,
  client: GmailClient,
): Promise<DraftSaveResult> {
  const current = await readCopy(client, remoteDraftId);
  if (!current?.isDraft) return { kind: 'gone' };
  const refused = precondition(draft, current);
  if (refused) return refused;
  return writeUpdate(deps, draft, remoteDraftId, ctx, client);
}

async function writeUpdate(
  deps: GmailDeps,
  draft: DraftUpload,
  remoteDraftId: string,
  ctx: AdapterContext,
  client: GmailClient,
): Promise<DraftSaveResult> {
  let updated: DraftResource;
  try {
    updated = await uploadDraft(deps, ctx, {
      method: 'gmail.drafts.update',
      draftId: remoteDraftId,
      raw: draft.mime,
      ...(draft.remoteThreadId ? { threadId: draft.remoteThreadId } : {}),
    });
  } catch (error) {
    if (is404(error)) return confirmGone(client, remoteDraftId, error);
    throw error;
  }
  return storedCopy(client, updated, draft);
}

/** The create found our own earlier copy (proven in `verifiedEarlier`): this revision replaces it, no second draft. */
function replaceEarlier(
  deps: GmailDeps,
  draft: DraftUpload,
  ctx: AdapterContext,
  client: GmailClient,
  copy: RemoteCopy,
): Promise<DraftSaveResult> {
  // Remembered before the request goes out, so a revision after a lost reply can again prove the copy holds ours.
  attemptsFor(deps).record(draft.draftId, draft.internetId, draft.mime);
  return writeUpdate(deps, draft, copy.draftId, ctx, client);
}

/** `ProviderAdapter.saveDraft` for Gmail. `ctx` is the paced context; see the file header for the rules. */
export async function saveDraftCopy(
  deps: GmailDeps,
  draft: DraftUpload,
  ctx: AdapterContext,
): Promise<DraftSaveResult> {
  const create = draft.remoteDraftId === undefined;
  // What goes up, compared and recorded from here on: the engine's MIME plus the `X-Aplos-Draft` token.
  const stored: DraftUpload = { ...draft, mime: withDraftToken(draft) };
  checkDraftMime(create ? 'gmail.drafts.create' : 'gmail.drafts.update', draft, stored.mime);
  const client = new GmailClient(deps, ctx);
  return create
    ? createCopy(deps, stored, ctx, client)
    : replaceCopy(deps, stored, draft.remoteDraftId!, ctx, client);
}

/**
 * `ProviderAdapter.deleteDraft` for Gmail: idempotent, guarded by the expected message id, and a message that is no
 * longer a draft is never touched. Without an expected id nothing happens.
 */
export async function deleteDraftCopy(
  deps: GmailDeps,
  remoteDraftId: string,
  ctx: AdapterContext,
  expectedMessageId?: string,
): Promise<void> {
  if (expectedMessageId === undefined) return;
  const client = new GmailClient(deps, ctx);
  const current = await readCopy(client, remoteDraftId);
  if (!current?.isDraft) return;
  // Another device edited the draft (or replaced it): that version is theirs, the discard must not destroy it.
  if (current.messageId !== expectedMessageId) return;
  try {
    await client.call<void>({
      method: 'gmail.drafts.delete',
      path: `/drafts/${encodeURIComponent(remoteDraftId)}`,
      httpMethod: 'DELETE',
      kind: 'idempotentWrite',
      lane: 'opFlush',
      item: remoteDraftId,
    });
  } catch (error) {
    if (!is404(error)) throw error;
  }
}
