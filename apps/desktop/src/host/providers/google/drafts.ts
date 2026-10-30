import {
  ProviderError,
  type AdapterContext,
  type DraftSaveResult,
  type DraftUpload,
} from '@aplos/engine/ports';
import { GmailClient, type GmailDeps } from './client';
import { rawMessageId, sameDraftBytes } from './draft-compare';
import { checkDraftMime } from './draft-mime';
import { uploadDraft, type DraftResource } from './draft-upload';

/**
 * The Gmail drafts API behind `ProviderAdapter.saveDraft` and `deleteDraft` (plan 20 PV4, ARCH 7.4). The local draft is
 * the truth; this keeps one remote copy of it, and the rules are about never losing or overwriting text and never
 * touching a message that has been sent.
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
 * A hit in (a) or (b) is not trusted by its header: the draft is read with `drafts.get` format=raw and its decoded bytes
 * are compared with `draft.mime` (`draft-compare.ts`: line endings normalised and the multipart boundaries blanked,
 * because the engine rebuilds the MIME on every attempt with fresh random boundaries; otherwise byte for byte). Equal: `saved` with its CURRENT
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
 * Bytes: `DraftUpload.mime` goes up as it is, after `checkDraftMime` (size cap, header allow-list, no Bcc, Message-ID
 * is the per-revision one). Threading: `remoteThreadId` becomes the upload's `threadId`; In-Reply-To and References
 * stay as the engine wrote them. Pacing: create 10 units, update 15 (`GMAIL_COSTS`), the `drafts.get` before a replace
 * 20 and the lookup before a create at least 15 (`drafts.list` x2 and `messages.list`, 5 each). Each draft or message the
 * lookup has to read adds 20 (`drafts.get`, `messages.get` metadata): about 215 with 10 drafts in the first page, at most
 * about 615 (10 reads in each of (a), (b) and (c)). A verified hit adds one `drafts.get` format=raw (60, priced as full),
 * and then (b) and (c) are skipped. all through the governor on the `opFlush` lane. A create is `write`, never
 * re-sent by the governor; an update is `idempotentWrite`.
 *
 * Remote drafts Aplos did not write (a phone, Gmail web): `history.ts` reports every DRAFT message whose id is not in
 * `KnownLookup.draftsByMessageId` as a `RemoteDraftFact` (id, message id, thread, no body, no fetch), which is the
 * engine's conflict candidate (`drafts.remote_message_id` differs). The ports cannot deliver more, and "take theirs" /
 * "keep both" need more:
 *   - Body delivery (history.ts, `RemoteDraftFact.html`/`text`): for a foreign draft the history pass reads the draft with
 *     `drafts.get` format=full (60 units, at most `BODY_FETCHES` = 5 per pass, the rest on the next pass) and delivers
 *     the decoded text/html parts when it has no attachment (inline images count), the body sits in the message (not by
 *     attachment id), is not empty and not over 1,000,000 characters; otherwise it is reported without a body (snippet
 *     only). It also names the draft's Message-ID as `internetId`. Attachments are NOT delivered (PORT GAP 1 remainder):
 *     such a draft stays incomplete in the engine. Content is never logged.
 *   - `supersedes` (history.ts): the previous message ids of the same draft id, from this adapter's own message-to-draft
 *     map; the engine decides whether the fact is our echo (it needs its own proof).
 *   - PORT GAP 2 (OPEN, eng-contract): `DraftUpload` carries only this revision's Message-ID. The engine keeps the
 *     Message-IDs of earlier, unanswered creates (`meta.wrote`), but a create of revision N+1 cannot tell the adapter to
 *     look for revision N's copy first, so an uncertain create followed by an edit can leave two remote copies (a
 *     duplicate, not a loss). Needed: `DraftUpload.supersedes?: string[]` (earlier `internetId`s) that the create looks
 *     up and, when found, replaces instead of creating.
 * RULE: a create-lookup hit whose bytes differ from `draft.mime` is a conflict, never `saved` (the comparison is exact apart
 * from line endings and boundaries, so a harmless rewrite by Gmail also shows as a conflict: known limit, tested). A
 * delete never removes a draft it cannot prove is the copy the caller holds (expected message id). Provider draft sync
 * must not be switched on for real accounts until PORT GAP 2 (`supersedes`, so orphans are removed) is closed too.
 * The upload session URI must be https on `googleapis.com` or a subdomain (deliberate: the bytes and the token go there).
 * Search lags the index: lookup (b) above reads the newest drafts without `q` to cover it. A duplicate that still gets
 * made is NOT cleaned up by the engine yet (`adoptCopy` returns early when the row already has a remote draft id, and
 * DECISIONS says the orphan is not deleted): a duplicate remote draft stays until the owner removes it.
 */

const DRAFT = 'DRAFT';
const SENT = 'SENT';
const TRASH = 'TRASH';
/** Hits verified per Message-ID search: a Message-ID is unique, so more than one is already unusual. */
const CANDIDATES = 10;
/** Message-ID characters that are plain words to Gmail search: no quote, brace, parenthesis, bar or space. */
const SEARCHABLE_ID = /^<([A-Za-z0-9.!#$%&'*+/=?^_`~@-]{1,900})>$/;

const bareId = (id: string): string => id.trim().replace(/^<|>$/g, '').toLowerCase();

/** A draft as `drafts.get` shows it: its message id, whether it is still a draft, and the Message-ID header. */
interface RemoteCopy {
  draftId: string;
  messageId: string;
  threadId?: string;
  isDraft: boolean;
  internetId?: string;
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
  const header = message.payload?.headers?.find(
    h => typeof h.name === 'string' && h.name.toLowerCase() === 'message-id',
  );
  return {
    draftId: draft.id,
    messageId: message.id,
    isDraft: labels.includes(DRAFT) && !labels.includes(SENT) && !labels.includes(TRASH),
    ...(typeof message.threadId === 'string' ? { threadId: message.threadId } : {}),
    ...(typeof header?.value === 'string' ? { internetId: header.value.trim() } : {}),
  };
}

/** The remote copy as it is now, or undefined when Gmail says the draft does not exist. */
async function readCopy(client: GmailClient, draftId: string): Promise<RemoteCopy | undefined> {
  let reply: DraftGet;
  try {
    reply = await client.call<DraftGet>({
      method: 'gmail.drafts.get',
      path: `/drafts/${encodeURIComponent(draftId)}`,
      format: 'metadata',
      query: { metadataHeaders: ['Message-ID'] },
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

/** The first of `ids` that is a draft holding `internetId`; a hit that vanished before it could be read is reported. */
async function verifyDrafts(
  client: GmailClient,
  ids: string[],
  internetId: string,
): Promise<{ found?: RemoteCopy; vanished: boolean }> {
  let vanished = false;
  for (const id of ids) {
    const copy = await readCopy(client, id);
    if (!copy) vanished = true;
    else if (copy.isDraft && copy.internetId && bareId(copy.internetId) === bareId(internetId))
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
    const labels = await holdingLabels(client, hit.id, internetId);
    if (labels?.includes(SENT) || labels?.includes(TRASH)) return 'gone';
    if (labels?.includes(DRAFT)) verdict = 'indexLag';
  }
  if (page.nextPageToken) throw incomplete('gmail.messages.list', 'draftSearchPartial');
  return verdict;
}

/**
 * The labels of message `id` when its Message-ID header is `internetId`; undefined for another message. A hit that
 * returns 404 is thrown (`draftHitVanished`): its id changed or it was deleted since the search listed it, and a copy that
 * was sent or discarded elsewhere may be exactly that, so "nothing found" would create the draft again.
 */
async function holdingLabels(
  client: GmailClient,
  id: string,
  internetId: string,
): Promise<string[] | undefined> {
  let message: MessageHit;
  try {
    message = await client.call<MessageHit>({
      method: 'gmail.messages.get',
      path: `/messages/${encodeURIComponent(id)}`,
      format: 'metadata',
      query: { metadataHeaders: ['Message-ID'] },
      fields: 'labelIds,payload/headers',
      lane: 'opFlush',
      item: id,
    });
  } catch (error) {
    if (is404(error)) throw incomplete('gmail.messages.get', 'draftHitVanished');
    throw error;
  }
  const header = message.payload?.headers?.find(
    h => typeof h.name === 'string' && h.name.toLowerCase() === 'message-id',
  );
  if (typeof header?.value !== 'string' || bareId(header.value) !== bareId(internetId))
    return undefined;
  return Array.isArray(message.labelIds) ? (message.labelIds as string[]) : [];
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
 * A hit found by its Message-ID header, checked against our bytes: equal is our copy (`saved` with its current message
 * id), different is somebody else's edit under our Message-ID (a conflict, nothing written).
 */
async function verifiedHit(
  client: GmailClient,
  found: RemoteCopy,
  draft: DraftUpload,
): Promise<Lookup> {
  const current = await readRaw(client, found.draftId);
  const differs = current.messageId !== found.messageId || !sameDraftBytes(current.raw, draft.mime);
  if (!differs) return { kind: 'draft', copy: found };
  const internetId = rawMessageId(current.raw);
  return {
    kind: 'conflict',
    draftId: found.draftId,
    messageId: current.messageId,
    ...(internetId ? { internetId } : {}),
  };
}

/** What the lookups before a create found: our copy, proof that it was sent or deleted elsewhere, or nothing. */
type Lookup =
  | { kind: 'draft'; copy: RemoteCopy }
  | { kind: 'conflict'; draftId: string; messageId: string; internetId?: string }
  | { kind: 'gone' }
  | undefined;

/**
 * Where a create's copy may already be (see the header): (a) the search, (b) the newest drafts without `q`, (c) all
 * mail. A hit in (a) or (b) is compared with our bytes (`verifiedHit`). An answer that is not complete (more hits than one page of the search, a hit that vanished before it could be
 * checked) is thrown, never reported as absent.
 */
async function findByInternetId(client: GmailClient, draft: DraftUpload): Promise<Lookup> {
  const internetId = draft.internetId;
  const searched = await listDraftIds(client, searchQuery(internetId));
  const first = await verifyDrafts(client, searched.ids, internetId);
  if (first.found) return verifiedHit(client, first.found, draft);
  if (first.vanished) throw incomplete('gmail.drafts.list', 'draftHitVanished');
  if (searched.more) throw incomplete('gmail.drafts.list', 'draftSearchPartial');
  // The search lags the index: the newest drafts, read without it, cover a copy made a moment ago.
  const newest = await listDraftIds(client);
  const fresh = newest.ids.filter(id => !searched.ids.includes(id));
  const second = await verifyDrafts(client, fresh, internetId);
  if (second.found) return verifiedHit(client, second.found, draft);
  if (second.vanished) throw incomplete('gmail.drafts.list', 'draftHitVanished');
  const verdict = await allMailVerdict(client, internetId);
  if (verdict === 'gone') return { kind: 'gone' };
  if (verdict === 'indexLag') throw incomplete('gmail.drafts.list', 'draftIndexLag');
  return undefined;
}

function saved(draft: { draftId: string; messageId: string }, revision: number): DraftSaveResult {
  return {
    kind: 'saved',
    remoteDraftId: draft.draftId,
    remoteMessageId: draft.messageId,
    revision,
  };
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
  return saved(found.copy, draft.revision);
}

/** After an uncertain create: one more look by Message-ID. A lookup that fails too leaves the original error standing. */
async function recheck(
  client: GmailClient,
  draft: DraftUpload,
  failure: ProviderError,
): Promise<DraftSaveResult> {
  if (!failure.error.uncertain) throw failure;
  let found: Lookup;
  try {
    found = await findByInternetId(client, draft);
  } catch {
    throw failure;
  }
  if (found) return answered(found, draft);
  throw failure;
}

async function createCopy(
  deps: GmailDeps,
  draft: DraftUpload,
  ctx: AdapterContext,
  client: GmailClient,
): Promise<DraftSaveResult> {
  const existing = await findByInternetId(client, draft);
  if (existing) return answered(existing, draft);
  try {
    const created = await uploadDraft(deps, ctx, {
      method: 'gmail.drafts.create',
      raw: draft.mime,
      ...(draft.remoteThreadId ? { threadId: draft.remoteThreadId } : {}),
    });
    return saved(fromResource(created), draft.revision);
  } catch (error) {
    if (error instanceof ProviderError) return recheck(client, draft, error);
    throw error;
  }
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
  try {
    const updated = await uploadDraft(deps, ctx, {
      method: 'gmail.drafts.update',
      draftId: remoteDraftId,
      raw: draft.mime,
      ...(draft.remoteThreadId ? { threadId: draft.remoteThreadId } : {}),
    });
    return saved(fromResource(updated), draft.revision);
  } catch (error) {
    if (is404(error)) return confirmGone(client, remoteDraftId, error);
    throw error;
  }
}

/** `ProviderAdapter.saveDraft` for Gmail. `ctx` is the paced context; see the file header for the rules. */
export async function saveDraftCopy(
  deps: GmailDeps,
  draft: DraftUpload,
  ctx: AdapterContext,
): Promise<DraftSaveResult> {
  const create = draft.remoteDraftId === undefined;
  checkDraftMime(create ? 'gmail.drafts.create' : 'gmail.drafts.update', draft);
  const client = new GmailClient(deps, ctx);
  return create
    ? createCopy(deps, draft, ctx, client)
    : replaceCopy(deps, draft, draft.remoteDraftId!, ctx, client);
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
