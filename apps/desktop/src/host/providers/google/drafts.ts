import {
  ProviderError,
  type AdapterContext,
  type DraftSaveResult,
  type DraftUpload,
} from '@aplos/engine/ports';
import { GmailClient, type GmailDeps } from './client';
import { checkDraftMime } from './draft-mime';
import { uploadDraft, type DraftResource } from './draft-upload';

/**
 * The Gmail drafts API behind `ProviderAdapter.saveDraft` and `deleteDraft` (plan 20 PV4, ARCH 7.4). The local draft is
 * the truth; this keeps one remote copy of it, and the rules are about never losing or overwriting text and never
 * touching a message that has been sent.
 *
 * saveDraft, create (`remoteDraftId` absent): the copy is first looked up by its per-revision Message-ID
 * (`drafts.list` with `rfc822msgid:<id> in:drafts`, each hit verified by its own Message-ID header), so a retry after an
 * uncertain create (a timeout after the request left, a crash before the engine recorded the answer) finds the copy
 * the first try made instead of creating a second. A create that comes back uncertain re-checks once the same way.
 * saveDraft, replace: `drafts.get` first (metadata, with the Message-ID header). A draft that is gone (404), or is no
 * longer a draft (no DRAFT label, or SENT or TRASH), is `{kind:'gone'}` and is never recreated or written; a reply
 * without `labelIds` is an invalid response, not "not a draft". A message id other than `baseRemoteMessageId` is
 * `{kind:'conflict'}` and nothing is written, always, even when the copy's Message-ID header is ours. So an update
 * whose answer was lost (or a new revision after it) yields a conflict about our own text: safe by design, and "keep
 * mine" recovers it. TODO(live): verify whether Gmail rewrites the Message-ID when another client edits a draft; only
 * then could a lost ack be recognised without risk of adopting a foreign edit. A 404 on the update itself is re-read
 * with `drafts.get` and is `gone` only if that also 404s or the draft is no longer one; a draft that still exists
 * makes it a transient, uncertain error.
 * Otherwise `drafts.update` replaces the copy and the new message id is returned: it is the precondition of the next
 * save and of `sendsRemoteDraft`. Gmail has no etag, so an edit made between the `get` and the `update` (milliseconds)
 * still wins the race; the next save sees the new id and raises the conflict.
 * deleteDraft: idempotent. `drafts.get` first; absent is success; a message that is no longer a draft (sent) is left
 * alone; otherwise `drafts.delete`.
 *
 * Bytes: `DraftUpload.mime` goes up as it is, after `checkDraftMime` (size cap, header allow-list, no Bcc, Message-ID
 * is the per-revision one). Threading: `remoteThreadId` becomes the upload's `threadId`; In-Reply-To and References
 * stay as the engine wrote them. Pacing: create 10 units, update 15 (`GMAIL_COSTS`), the `drafts.get` before a replace
 * 20 and the lookup before a create 5; all through the governor on the `opFlush` lane. A create is `write`, never
 * re-sent by the governor; an update is `idempotentWrite`.
 *
 * Remote drafts Aplos did not write (a phone, Gmail web): `history.ts` reports every DRAFT message whose id is not in
 * `KnownLookup.draftsByMessageId` as a `RemoteDraftFact` (id, message id, thread, no body, no fetch), which is the
 * engine's conflict candidate (`drafts.remote_message_id` differs). The ports cannot deliver more, and "take theirs" /
 * "keep both" need more:
 *   - PORT GAP 1: `RemoteDraftFact.message` is `MessageFacts`, which has no body (text or html) and no attachments'
 *     bytes, and `ProviderAdapter` has no `fetchDraft(remoteDraftId)`. So a conflict can show the metadata (subject,
 *     recipients, snippet) but the engine cannot obtain the other device's text to keep or merge it. Needed: either
 *     `RemoteDraftFact.body?: { text?: string; html?: string }` or `ProviderAdapter.openDraft?(remoteDraftId, ctx)`
 *     returning the parsed message (the adapter already has `bodies.ts` to parse a `format=full` message).
 *   - PORT GAP 2: `DraftUpload` carries only this revision's Message-ID. The engine keeps the Message-IDs of earlier,
 *     unanswered creates (`meta.wrote`), but a create of revision N+1 cannot tell the adapter to look for revision N's
 *     copy first, so an uncertain create followed by an edit can leave two remote copies (a duplicate, not a loss).
 *     Needed: `DraftUpload.supersedes?: string[]` (earlier `internetId`s) that the create looks up and, when found,
 *     replaces instead of creating.
 * The upload session URI must be https on `googleapis.com` or a subdomain (deliberate: the bytes and the token go there).
 * Search lags the index: a copy created a moment ago can be missing from the `q` search; the lookup then misses it and
 * an immediate retry creates a second copy (the duplicate is found and cleaned up by the engine's `wrote` handling).
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

function searchQuery(internetId: string): string {
  const bare = SEARCHABLE_ID.exec(internetId)?.[1];
  if (!bare) {
    throw new ProviderError({
      class: 'permanent',
      provider: 'gmail',
      method: 'gmail.drafts.list',
      reason: 'unsearchableMessageId',
    });
  }
  return `rfc822msgid:${bare} in:drafts`;
}

/**
 * The draft that already holds `internetId`, or undefined when Gmail has none. An answer that is not complete (more
 * hits than one page, a hit that vanished before it could be checked) is thrown, never reported as absent.
 */
async function findByInternetId(
  client: GmailClient,
  internetId: string,
): Promise<RemoteCopy | undefined> {
  const page = await client.call<{ drafts?: { id?: unknown }[]; nextPageToken?: string }>({
    method: 'gmail.drafts.list',
    path: '/drafts',
    query: { q: searchQuery(internetId), maxResults: CANDIDATES },
    fields: 'drafts(id),nextPageToken',
    lane: 'opFlush',
  });
  let vanished = false;
  for (const hit of page.drafts ?? []) {
    if (typeof hit.id !== 'string') continue;
    const copy = await readCopy(client, hit.id);
    if (!copy) vanished = true;
    else if (copy.isDraft && copy.internetId && bareId(copy.internetId) === bareId(internetId))
      return copy;
  }
  if (vanished) throw incomplete('gmail.drafts.list', 'draftHitVanished');
  if (page.nextPageToken) throw incomplete('gmail.drafts.list', 'draftSearchPartial');
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

/** After an uncertain create: one more look by Message-ID. A lookup that fails too leaves the original error standing. */
async function recheck(
  client: GmailClient,
  draft: DraftUpload,
  failure: ProviderError,
): Promise<DraftSaveResult> {
  if (!failure.error.uncertain) throw failure;
  let found: RemoteCopy | undefined;
  try {
    found = await findByInternetId(client, draft.internetId);
  } catch {
    throw failure;
  }
  if (found) return saved(found, draft.revision);
  throw failure;
}

async function createCopy(
  deps: GmailDeps,
  draft: DraftUpload,
  ctx: AdapterContext,
  client: GmailClient,
): Promise<DraftSaveResult> {
  const existing = await findByInternetId(client, draft.internetId);
  if (existing) return saved(existing, draft.revision);
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

/** `ProviderAdapter.deleteDraft` for Gmail: idempotent, and a message that is no longer a draft is never touched. */
export async function deleteDraftCopy(
  deps: GmailDeps,
  remoteDraftId: string,
  ctx: AdapterContext,
): Promise<void> {
  const client = new GmailClient(deps, ctx);
  const current = await readCopy(client, remoteDraftId);
  if (!current?.isDraft) return;
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
