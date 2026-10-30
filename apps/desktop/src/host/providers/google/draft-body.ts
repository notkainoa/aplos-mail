import type { RemoteDraftFact, SyncLane } from '@aplos/engine/ports';
import { GmailClient, isStop } from './client';
import { decodeText, fromBase64Url, headerOf, walkPayload, type GmailPart } from './mime';

/**
 * Bodies for the drafts another device made (`RemoteDraftFact.html` / `text`, eng-contract #153). History reports such a
 * draft by ids alone; this reads it once with `drafts.get` format=full (60 units) so the engine can edit it, take it or
 * keep both. Bounded: at most `BODY_FETCHES` reads per history pass, the rest wait in `provider_memory`
 * (`PENDING_KEY`) and go first on the next pass. A body is delivered only when it is safe for the engine to treat the
 * draft as complete: no attachment of any kind (inline images too, the engine cannot carry them), the text inside the
 * message itself (not stored by attachment id, which would need more requests), not empty, and not over `BODY_CAP`
 * characters. Otherwise the fact stays as it was (snippet only). Content is never logged.
 */

export const BODY_FETCHES = 5;
/** The engine's local save limit, in characters; a larger body is not delivered. */
export const BODY_CAP = 1_000_000;
/** More waiting drafts than this are left without a body (the oldest first). */
const PENDING_MAX = 200;
/** provider_memory: message id -> draft id of the foreign drafts still waiting for a body read, as JSON. */
export const PENDING_KEY = 'drafts.bodyPending';

export function readPending(memory: ReadonlyMap<string, string>): Map<string, string> {
  try {
    return new Map(
      Object.entries(JSON.parse(memory.get(PENDING_KEY) ?? '{}') as Record<string, string>),
    );
  } catch {
    return new Map();
  }
}

export const pendingJson = (pending: ReadonlyMap<string, string>): string | null =>
  pending.size ? JSON.stringify(Object.fromEntries(pending)) : null;

interface FullDraft {
  message?: {
    id?: unknown;
    threadId?: unknown;
    labelIds?: unknown;
    payload?: GmailPart;
  };
}

/** What one draft read says: nothing usable, or the draft's message id with the body when it may be delivered. */
interface DraftRead {
  messageId: string;
  threadId?: string;
  html?: string;
  text?: string;
}

function bodyOf(payload: GmailPart): { html?: string; text?: string } | undefined {
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
  return {
    messageId: message.id,
    ...(typeof message.threadId === 'string' ? { threadId: message.threadId } : {}),
    ...body,
  };
}

type Outcome = 'stop' | DraftRead | undefined;

/** One read; a pause or refusal is `stop`, any other failure leaves the draft without a body (never fatal to the pass). */
async function tryRead(client: GmailClient, lane: SyncLane, draftId: string): Promise<Outcome> {
  try {
    return await readFull(client, lane, draftId);
  } catch (error) {
    if (isStop(error)) return 'stop';
    return undefined;
  }
}

interface Waiting {
  messageId: string;
  draftId: string;
  /** The fact this pass already builds for it; absent when it was reported in an earlier pass. */
  fact?: RemoteDraftFact;
}

/**
 * Adds bodies to this pass's foreign draft facts and to the ones that waited from earlier passes (a fact for a draft
 * already reported is sent again with its body). Returns the facts and the new waiting list.
 */
export async function deliverBodies(
  client: GmailClient,
  lane: SyncLane,
  drafts: RemoteDraftFact[],
  pendingBefore: ReadonlyMap<string, string>,
  now: number,
): Promise<{ drafts: RemoteDraftFact[]; pending: Map<string, string> }> {
  const reported = new Set(drafts.map(d => d.remoteDraftId));
  const fresh = drafts.filter(d => !d.removed);
  // An earlier waiter is dropped when this pass says something newer about its draft (removed, or a new message).
  const waiting: Waiting[] = [
    ...[...pendingBefore]
      .filter(([, draftId]) => !reported.has(draftId))
      .map(([messageId, draftId]) => ({ messageId, draftId })),
    ...fresh.map(f => ({ messageId: f.remoteMessageId, draftId: f.remoteDraftId, fact: f })),
  ];
  const withBody = new Map<string, RemoteDraftFact>();
  const pending = new Map<string, string>();
  let reads = 0;
  let stopped = false;
  for (const entry of waiting) {
    if (stopped || reads >= BODY_FETCHES) {
      pending.set(entry.messageId, entry.draftId);
      continue;
    }
    reads++;
    const read = await tryRead(client, lane, entry.draftId);
    if (read === 'stop') {
      stopped = true;
      pending.set(entry.messageId, entry.draftId);
    } else if (read && read.messageId === entry.messageId && (read.html || read.text)) {
      withBody.set(entry.messageId, factWithBody(entry, read, now));
    }
  }
  const kept = new Map([...pending].slice(-PENDING_MAX));
  const known = new Set(drafts.map(d => d.remoteMessageId));
  const earlier = [...withBody.values()].filter(f => !known.has(f.remoteMessageId));
  const out = drafts.map(d => withBody.get(d.remoteMessageId) ?? d);
  return { drafts: [...out, ...earlier], pending: kept };
}

function factWithBody(entry: Waiting, read: DraftRead, now: number): RemoteDraftFact {
  const body = {
    ...(read.html ? { html: read.html } : {}),
    ...(read.text ? { text: read.text } : {}),
  };
  if (entry.fact) return { ...entry.fact, ...body };
  return {
    remoteDraftId: entry.draftId,
    remoteMessageId: entry.messageId,
    ...(read.threadId ? { remoteThreadId: read.threadId } : {}),
    changedAt: now,
    ...body,
  };
}
