import {
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
  try {
    const single = ref.knownCount === 1 ? known[0]?.remoteId : undefined;
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
  const resolved = await resolveBodyParts(client, live, leaves, lane);

  const opened: Opened[] = live.map(m => {
    const facts = messageFacts(m, {
      self: ctx.account.address,
      partial: false,
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
  const removed =
    ref.knownCount === 1 ? [] : known.map(k => k.remoteId).filter(id => !present.has(id));
  return { messages: opened, ...(removed.length ? { removed } : {}), costUnits: client.spent };
}

/** One batch (chunked to the governor's batch size) for every body part held by attachment id. */
async function resolveBodyParts(
  client: GmailClient,
  messages: GmailMessage[],
  leaves: Map<string, BodyLeaf[]>,
  lane: 'interactive' | 'prefetch',
): Promise<Map<string, string>> {
  const wanted: { messageId: string; attachmentId: string }[] = [];
  for (const m of messages) {
    for (const leaf of leaves.get(m.id) ?? []) {
      if (leaf.kind !== 'attachment' && leaf.data === undefined && leaf.attachmentId)
        wanted.push({ messageId: m.id, attachmentId: leaf.attachmentId });
    }
  }
  const out = new Map<string, string>();
  const size = client.batchSize();
  for (let start = 0; start < wanted.length; start += size) {
    const chunk = wanted.slice(start, start + size);
    const outcomes = await client.batch<{ data?: string }>(
      chunk.map(w => ({
        method: 'gmail.messages.attachments.get' as const,
        path: `/messages/${w.messageId}/attachments/${w.attachmentId}`,
        fields: 'data',
        lane,
        item: w.messageId,
      })),
      lane,
    );
    outcomes.forEach((outcome, i) => {
      if (outcome.ok && outcome.data.data !== undefined)
        out.set(`${chunk[i].messageId}/${chunk[i].attachmentId}`, outcome.data.data);
    });
  }
  return out;
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
