import {
  PausedError,
  ProviderError,
  type AdapterContext,
  type AttachmentFacts,
  type AttachmentRef,
  type MessageFacts,
  type OpenedThread,
  type ProviderBody,
  type ThreadOpenRef,
} from '@aplos/engine/ports';
import { GmailClient, type GmailDeps } from './client';
import { messageFacts, type GmailMessage } from './facts';
import { decodeText, fromBase64Url, headerOf, walkPayload, type BodyLeaf } from './mime';

/**
 * Lazy bodies (plan 20 PV0 item 5, AM-1): opening a thread fetches it once, in full, on the caller's lane. A thread
 * the engine knows has exactly one message costs `messages.get` full (60); anything else `threads.get` full (120).
 * Body parts Gmail stored by attachment id are resolved in one batch on the same lane, never one by one (D15).
 */

const FULL_MESSAGE_FIELDS = 'id,threadId,labelIds,snippet,internalDate,sizeEstimate,payload';
const FULL_THREAD_FIELDS = `id,messages(${FULL_MESSAGE_FIELDS})`;

type Opened = MessageFacts & { body: ProviderBody };

/**
 * The one message a `messages.get` open may fetch: only when the server's last count AND this device both say the
 * thread holds exactly one. The stored count only moves on a `threads.get`, so a reply that arrived since (a bare
 * history fetch, such as the owner's own send) leaves it at 1 while the device holds two; trusting it alone fetched
 * `known[0]`, the original, forever, and the reply's body never arrived ("Couldn't load this email.").
 */
export function singleMessage(
  ref: Pick<ThreadOpenRef, 'knownCount'>,
  known: readonly { remoteId: string }[],
): string | undefined {
  return ref.knownCount === 1 && known.length === 1 ? known[0].remoteId : undefined;
}

export async function openThread(
  deps: GmailDeps,
  ref: ThreadOpenRef,
  lane: 'interactive' | 'prefetch',
  ctx: AdapterContext,
): Promise<OpenedThread> {
  const client = new GmailClient(deps, ctx);
  const known = await ctx.lookup.threadMessages(ref.remoteThreadId);
  let messages: GmailMessage[];
  let threadSize: number | undefined;
  const single = singleMessage(ref, known);
  try {
    if (single) {
      messages = [
        await client.call<GmailMessage>({
          method: 'gmail.messages.get',
          path: `/messages/${single}`,
          format: 'full',
          fields: FULL_MESSAGE_FIELDS,
          lane,
          item: single,
        }),
      ];
    } else {
      const thread = await client.call<{ messages?: GmailMessage[] }>({
        method: 'gmail.threads.get',
        path: `/threads/${ref.remoteThreadId}`,
        format: 'full',
        fields: FULL_THREAD_FIELDS,
        lane,
        item: ref.remoteThreadId,
      });
      messages = thread.messages ?? [];
      threadSize = messages.filter(m => !m.labelIds?.includes('DRAFT')).length;
    }
  } catch (error) {
    // The thread (or its one message) is gone at the server: everything this device holds of it is removed.
    if (error instanceof ProviderError && error.error.status === 404) {
      return { messages: [], removed: known.map(k => k.remoteId), costUnits: client.spent };
    }
    throw error;
  }

  // Drafts are never part of a conversation (D9).
  const live = messages.filter(m => !m.labelIds?.includes('DRAFT'));
  const leaves = new Map(live.map(m => [m.id, m.payload ? walkPayload(m.payload) : []]));
  const { parts: resolved, unresolved } = await resolveBodyParts(client, live, leaves, lane);

  const opened: Opened[] = live.map(m => {
    const facts = messageFacts(m, {
      self: ctx.account.address,
      // A body part that did not arrive leaves the message partial, so the engine opens it again.
      partial: unresolved.has(m.id),
      ...(threadSize !== undefined ? { threadSize } : {}),
    });
    const body: ProviderBody = { cidMap: {} };
    const attachments: AttachmentFacts[] = [];
    for (const leaf of leaves.get(m.id) ?? []) {
      if (leaf.kind === 'attachment') {
        if (!leaf.attachmentId) continue;
        attachments.push({
          part: leaf.attachmentId,
          ...(leaf.part.filename ? { name: leaf.part.filename } : {}),
          ...(leaf.part.mimeType ? { mime: leaf.part.mimeType } : {}),
          ...(leaf.part.body?.size !== undefined ? { size: leaf.part.body.size } : {}),
          ...(leaf.cid ? { cid: leaf.cid } : {}),
          inline: leaf.inline,
        });
        if (leaf.cid) body.cidMap[leaf.cid] = leaf.attachmentId;
        continue;
      }
      const data =
        leaf.data ?? (leaf.attachmentId ? resolved.get(`${m.id}/${leaf.attachmentId}`) : undefined);
      if (data === undefined) continue;
      const text = decodeText(fromBase64Url(data), headerOf(leaf.part.headers, 'Content-Type'));
      if (leaf.kind === 'text') body.text = text;
      else body.html = text;
    }
    return { ...facts, ...(attachments.length ? { attachments } : {}), body };
  });

  const present = new Set(messages.map(m => m.id));
  const removed = single ? [] : known.map(k => k.remoteId).filter(id => !present.has(id));
  return { messages: opened, ...(removed.length ? { removed } : {}), costUnits: client.spent };
}

interface BodyParts {
  /** `messageId/attachmentId` -> base64url data. */
  parts: Map<string, string>;
  /** Messages with at least one body part that is not in `parts`. */
  unresolved: Set<string>;
}

type PartWant = { messageId: string; attachmentId: string };

function wantedParts(messages: GmailMessage[], leaves: Map<string, BodyLeaf[]>): PartWant[] {
  const wanted: PartWant[] = [];
  for (const m of messages) {
    for (const leaf of leaves.get(m.id) ?? []) {
      if (leaf.kind !== 'attachment' && leaf.data === undefined && leaf.attachmentId)
        wanted.push({ messageId: m.id, attachmentId: leaf.attachmentId });
    }
  }
  return wanted;
}

/**
 * One batch (chunked to the governor's batch size) for every body part held by attachment id. The thread is already
 * paid for (120 units), so a pause, a refusal or a failed part never throws it away: whatever did not arrive leaves
 * its message in `unresolved` and the caller marks it partial. Only an abort (the adapter closing) propagates.
 */
async function resolveBodyParts(
  client: GmailClient,
  messages: GmailMessage[],
  leaves: Map<string, BodyLeaf[]>,
  lane: 'interactive' | 'prefetch',
): Promise<BodyParts> {
  const wanted = wantedParts(messages, leaves);
  const out: BodyParts = { parts: new Map(), unresolved: new Set() };
  const size = client.batchSize();
  for (let start = 0; start < wanted.length; start += size) {
    const chunk = wanted.slice(start, start + size);
    let outcomes;
    try {
      outcomes = await fetchPartChunk(client, chunk, lane);
    } catch (error) {
      if (!(error instanceof PausedError || error instanceof ProviderError)) throw error;
      // Nothing more will go out now: the rest of the parts stay unresolved.
      for (const w of wanted.slice(start)) out.unresolved.add(w.messageId);
      break;
    }
    outcomes.forEach((outcome, i) => {
      const { messageId, attachmentId } = chunk[i];
      if (outcome.ok && outcome.data.data !== undefined)
        out.parts.set(`${messageId}/${attachmentId}`, outcome.data.data);
      else if (!outcome.ok && isPermanent(outcome.error)) return;
      else out.unresolved.add(messageId);
    });
  }
  return out;
}

/** A part Google says is gone or forbidden stays empty; marking its message partial would refetch the thread on every open. */
function isPermanent(error: ProviderError): boolean {
  return error.error.class === 'permanent' || error.error.class === 'permission';
}

function fetchPartChunk(client: GmailClient, chunk: PartWant[], lane: 'interactive' | 'prefetch') {
  return client.batch<{ data?: string }>(
    chunk.map(w => ({
      method: 'gmail.messages.attachments.get' as const,
      path: `/messages/${w.messageId}/attachments/${w.attachmentId}`,
      fields: 'data',
      lane,
      item: w.messageId,
    })),
    lane,
  );
}

/** One attachment's bytes (`messages.attachments.get`, 20 units, interactive lane). */
export async function fetchAttachment(
  deps: GmailDeps,
  ref: AttachmentRef,
  ctx: AdapterContext,
): Promise<AsyncIterable<Uint8Array>> {
  const client = new GmailClient(deps, ctx);
  const reply = await client.call<{ data?: string }>({
    method: 'gmail.messages.attachments.get',
    path: `/messages/${ref.remoteMessageId}/attachments/${ref.part}`,
    fields: 'data',
    lane: 'interactive',
    item: ref.remoteMessageId,
  });
  const bytes = fromBase64Url(reply.data ?? '');
  return (async function* () {
    yield bytes;
  })();
}

/**
 * The message's raw RFC822 for `ProviderPort.original` (`messages.get format=raw`, priced as full: 60 units,
 * interactive lane), fetched live and never stored. Decoded here so the port hands bytes, not base64url. The
 * 25 MB cap is the caller's (`Message/original` `collectBytes` `overLimit` -> `tooLarge`): refusing here would hide it
 * behind a generic `unavailable`.
 */
export async function fetchOriginal(
  deps: GmailDeps,
  remoteMessageId: string,
  ctx: AdapterContext,
  opts?: { signal?: AbortSignal },
): Promise<AsyncIterable<Uint8Array>> {
  // The caller's view of the deadline (a lane stop or `Message/original`'s 120 s total) joins the account's own
  // abort set, so the HTTP read really stops instead of only the caller's wait.
  const client = new GmailClient(
    deps,
    opts?.signal ? { ...ctx, signal: AbortSignal.any([ctx.signal, opts.signal]) } : ctx,
  );
  const reply = await client.call<{ raw?: string }>({
    method: 'gmail.messages.get',
    path: `/messages/${remoteMessageId}`,
    format: 'raw',
    fields: 'raw',
    lane: 'interactive',
    item: remoteMessageId,
  });
  // `fields=raw` should carry exactly one base64url string; anything else refuses rather than decode into garbage.
  if (reply.raw !== undefined && !/^[A-Za-z0-9_-]+$/.test(reply.raw))
    throw new ProviderError({
      class: 'permanent',
      provider: 'gmail',
      method: 'gmail.messages.get',
      reason: 'malformedOriginal',
      uncertain: false,
    });
  const bytes = fromBase64Url(reply.raw ?? '');
  if (bytes.byteLength === 0)
    throw new ProviderError({
      class: 'permanent',
      provider: 'gmail',
      method: 'gmail.messages.get',
      reason: 'emptyOriginal',
      uncertain: false,
    });
  return (async function* () {
    yield bytes;
  })();
}
