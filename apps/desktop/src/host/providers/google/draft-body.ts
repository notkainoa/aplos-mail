import type { ClassifiedError } from '@aplos/contract';
import {
  ProviderError,
  type AdapterContext,
  type RemoteDraftFact,
  type SyncLane,
} from '@aplos/engine/ports';
import { GmailClient, isStop } from './client';
import { decodeText, fromBase64Url, headerOf, walkPayload, type GmailPart } from './mime';

/**
 * Bodies for the drafts another device made (`RemoteDraftFact.html` / `text`, eng-contract #153). History reports such a
 * draft by ids alone; this reads it once with `drafts.get` format=full (60 units) so the engine can edit it, take it or
 * keep both. Bounded: at most `BODY_FETCHES` reads per history pass, the rest wait in `provider_memory`
 * (`PENDING_KEY`) and go first on the next pass. A body is delivered only when it is safe for the engine to treat the
 * draft as complete: no attachment of any kind (any part, leaf or container, with a filename, an attachment or inline
 * disposition, or a type that is not text/* or multipart/*, such as message/rfc822; inline images too, the engine cannot
 * carry them), the text inside the message itself (not stored by attachment id, which would need more requests), not
 * empty, and not over `BODY_CAP` characters. Otherwise the fact stays as it was (snippet only). The same read names the
 * draft's Message-ID as the fact's `internetId` (the headers come with format=full, no extra request). A read that fails
 * for a transient reason is tried again on the next pass, `MAX_TRIES` reads in all, then dropped (the error is
 * logged as `sync.gmail.request_refused`, never content); a 404 or a message that is no longer a draft drops it at once. Content is never logged.
 */

export const BODY_FETCHES = 5;
/** The engine's local save limit, in characters; a larger body is not delivered. */
export const BODY_CAP = 1_000_000;
/** More waiting drafts than this are left without a body (the oldest first). */
const PENDING_MAX = 200;
/** Failed reads of one draft (transient errors) before it is left snippet-only. */
export const MAX_TRIES = 3;
/** provider_memory: message id -> draft id of the foreign drafts still waiting for a body read, as JSON. */
export const PENDING_KEY = 'drafts.bodyPending';

/** A foreign draft waiting for its body read: the draft id, and how many reads failed transiently so far. */
export interface Waiter {
  draftId: string;
  tries: number;
}
export type PendingBodies = ReadonlyMap<string, Waiter>;

export function readPending(memory: ReadonlyMap<string, string>): Map<string, Waiter> {
  const out = new Map<string, Waiter>();
  try {
    const raw = JSON.parse(memory.get(PENDING_KEY) ?? '{}') as Record<string, unknown>;
    for (const [messageId, value] of Object.entries(raw)) {
      if (typeof value === 'string') out.set(messageId, { draftId: value, tries: 0 });
      else if (Array.isArray(value) && typeof value[0] === 'string')
        out.set(messageId, { draftId: value[0], tries: Number(value[1]) || 0 });
    }
  } catch {
    return new Map();
  }
  return out;
}

export const pendingJson = (pending: PendingBodies): string | null =>
  pending.size
    ? JSON.stringify(Object.fromEntries([...pending].map(([id, w]) => [id, [w.draftId, w.tries]])))
    : null;

interface FullDraft {
  message?: {
    id?: unknown;
    threadId?: unknown;
    labelIds?: unknown;
    payload?: GmailPart;
  };
}

/** Why a read gave nothing: gone for good, or worth another try on a later pass. */
class Retry {
  constructor(readonly error: ClassifiedError) {}
}

/** What one draft read says: nothing usable, or the draft's message id with the body when it may be delivered. */
interface DraftRead {
  messageId: string;
  threadId?: string;
  internetId?: string;
  html?: string;
  text?: string;
}

/**
 * Whether a part, leaf or container, is (or holds) something the engine cannot carry: a filename, an attachment or inline
 * disposition, a type that is neither text/* nor multipart/* (message/rfc822, application/*, image/*), or any such part
 * below it. A container that is an attachment is never walked for "body" parts: the children of a forwarded message are
 * not the draft's text.
 */
function holdsAttachment(part: GmailPart): boolean {
  const mime = (part.mimeType ?? '').toLowerCase();
  const disposition = (headerOf(part.headers, 'Content-Disposition') ?? '').trim().toLowerCase();
  if (part.filename) return true;
  if (/^(attachment|inline)\b/.test(disposition)) return true;
  if (!mime.startsWith('text/') && !mime.startsWith('multipart/')) return true;
  return part.parts?.some(holdsAttachment) ?? false;
}

function bodyOf(payload: GmailPart): { html?: string; text?: string } | undefined {
  if (holdsAttachment(payload)) return undefined;
  const leaves = walkPayload(payload);
  if (leaves.some(leaf => leaf.kind === 'attachment')) return undefined;
  const out: { html?: string; text?: string } = {};
  for (const leaf of leaves) {
    if (leaf.data === undefined) return undefined;
    const text = decodeText(fromBase64Url(leaf.data), headerOf(leaf.part.headers, 'Content-Type'));
    if (text.length > BODY_CAP) return undefined;
    if (!text.trim()) continue;
    if (leaf.kind === 'html') out.html = text;
    else out.text = text;
  }
  return out.html !== undefined || out.text !== undefined ? out : undefined;
}

/** The draft as `drafts.get` format=full shows it, or undefined when it is gone, not a draft any more, or unreadable. */
async function readFull(
  client: GmailClient,
  lane: SyncLane,
  draftId: string,
): Promise<DraftRead | undefined> {
  const reply = await client.call<FullDraft>({
    method: 'gmail.drafts.get',
    path: `/drafts/${encodeURIComponent(draftId)}`,
    format: 'full',
    fields: 'message(id,threadId,labelIds,payload)',
    lane,
    item: draftId,
  });
  const message = reply.message;
  if (typeof message?.id !== 'string' || !Array.isArray(message.labelIds)) return undefined;
  const labels = message.labelIds;
  if (!labels.includes('DRAFT') || labels.includes('SENT') || labels.includes('TRASH'))
    return undefined;
  const body = message.payload ? bodyOf(message.payload) : undefined;
  const internetId = headerOf(message.payload?.headers, 'Message-ID')?.trim();
  return {
    messageId: message.id,
    ...(internetId ? { internetId } : {}),
    ...(typeof message.threadId === 'string' ? { threadId: message.threadId } : {}),
    ...body,
  };
}

type Outcome = 'stop' | Retry | DraftRead | undefined;

/**
 * One read. A pause or refusal is `stop` (nothing was tried); a transient failure is a `Retry` (5xx, network, timeout);
 * a 404, a message that is no longer a draft, or any other failure leaves the draft without a body for good.
 */
async function tryRead(client: GmailClient, lane: SyncLane, draftId: string): Promise<Outcome> {
  try {
    return await readFull(client, lane, draftId);
  } catch (error) {
    if (isStop(error)) return 'stop';
    if (error instanceof ProviderError && error.error.status === 404) return undefined;
    if (error instanceof ProviderError && error.error.class === 'transient')
      return new Retry(error.error);
    return undefined;
  }
}

interface Waiting {
  messageId: string;
  draftId: string;
  tries: number;
  /** The fact this pass already builds for it; absent when it was reported in an earlier pass. */
  fact?: RemoteDraftFact;
}

type DraftLog = Pick<AdapterContext['log'], 'event'>;

/**
 * Adds bodies to this pass's foreign draft facts and to the ones that waited from earlier passes (a fact for a draft
 * already reported is sent again with its body). Returns the facts and the new waiting list.
 */
export async function deliverBodies(
  client: GmailClient,
  lane: SyncLane,
  log: DraftLog,
  drafts: RemoteDraftFact[],
  pendingBefore: PendingBodies,
  now: number,
): Promise<{ drafts: RemoteDraftFact[]; pending: Map<string, Waiter> }> {
  const reported = new Set(drafts.map(d => d.remoteDraftId));
  const fresh = drafts.filter(d => !d.removed);
  // An earlier waiter is dropped when this pass says something newer about its draft (removed, or a new message).
  const waiting: Waiting[] = [
    ...[...pendingBefore]
      .filter(([, w]) => !reported.has(w.draftId))
      .map(([messageId, w]) => ({ messageId, draftId: w.draftId, tries: w.tries })),
    ...fresh.map(f => ({
      messageId: f.remoteMessageId,
      draftId: f.remoteDraftId,
      tries: 0,
      fact: f,
    })),
  ];
  const updated = new Map<string, RemoteDraftFact>();
  const pending = new Map<string, Waiter>();
  const keep = (w: Waiting, tries = w.tries) =>
    pending.set(w.messageId, { draftId: w.draftId, tries });
  let reads = 0;
  let stopped = false;
  for (const entry of waiting) {
    if (stopped || reads >= BODY_FETCHES) {
      keep(entry);
      continue;
    }
    reads++;
    const read = await tryRead(client, lane, entry.draftId);
    if (read === 'stop') {
      stopped = true;
      keep(entry);
    } else if (read instanceof Retry) {
      if (entry.tries + 1 < MAX_TRIES) keep(entry, entry.tries + 1);
      else log.event('sync.gmail.request_refused', { error: read.error, attempt: MAX_TRIES });
    } else if (read && read.messageId === entry.messageId) {
      const fact = withRead(entry, read, now);
      if (fact) updated.set(entry.messageId, fact);
    }
  }
  const kept = new Map([...pending].slice(-PENDING_MAX));
  const known = new Set(drafts.map(d => d.remoteMessageId));
  const earlier = [...updated.values()].filter(f => !known.has(f.remoteMessageId));
  const out = drafts.map(d => updated.get(d.remoteMessageId) ?? d);
  return { drafts: [...out, ...earlier], pending: kept };
}

/**
 * The fact with what the read said: the Message-ID and the body (when it may be delivered). A waiter from an earlier
 * pass is reported again only when there is a body to add.
 */
function withRead(entry: Waiting, read: DraftRead, now: number): RemoteDraftFact | undefined {
  const body = {
    ...(read.html ? { html: read.html } : {}),
    ...(read.text ? { text: read.text } : {}),
  };
  const internetId = read.internetId ? { internetId: read.internetId } : {};
  if (entry.fact) return { ...entry.fact, ...internetId, ...body };
  if (!read.html && !read.text) return undefined;
  return {
    remoteDraftId: entry.draftId,
    remoteMessageId: entry.messageId,
    ...(read.threadId ? { remoteThreadId: read.threadId } : {}),
    ...internetId,
    changedAt: now,
    ...body,
  };
}
