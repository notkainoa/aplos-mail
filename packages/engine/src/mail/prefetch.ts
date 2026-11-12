import type { Input } from '@aplos/contract';
import type { MethodContext } from '../methods/types';
import type { EngineServices } from '../runtime/services';
import type { StoreReader } from '../store/port';
import { findMessage, type MessageRef } from './message';
import { readAllowList, readRemoteImages, resolveImagePolicy } from './policy';
import { renderMessage, storedBody } from './render';

// `MessageBody/prefetch`: on focus or hover, fetch bodies that are not stored on the prefetch lane and warm the LRU with
// the render `Mail/frame` would make first (the sender's resolved `block` policy, no find, quotes closed). It answers
// at once; the work runs behind it and its failures are dropped (the reader's own `Mail/frame` will fetch and report).
// `cancel` stops a pending warm-up. The provider fetch itself cannot be aborted: `ProviderPort.openThread` takes no
// signal.

/** Messages to warm: the ones named, and for each named thread its newest message. */
function targets(q: StoreReader, args: Input<'MessageBody/prefetch'>): MessageRef[] {
  const accounts = q.all<{ id: string }>('SELECT id FROM accounts').map(a => a.id);
  const refs = (args.ids ?? []).flatMap(id => findMessage(q, id, accounts) ?? []);
  for (const threadId of args.threadIds ?? []) {
    const newest = newestMessageOf(q, threadId, accounts);
    if (newest) refs.push(newest);
  }
  return refs;
}

function newestMessageOf(
  q: StoreReader,
  threadId: string,
  accounts: readonly string[],
): MessageRef | undefined {
  const account = accounts
    .filter(a => threadId.startsWith(`${a}:`))
    .sort((a, b) => b.length - a.length)[0];
  if (account === undefined) return undefined;
  const row = q.get<{ remote_id: string }>(
    `SELECT m.remote_id FROM messages m JOIN threads t ON t.id = m.thread_id
      WHERE t.account_id = ? AND t.remote_id = ? AND (m.flags & 8) = 0 ORDER BY m.id DESC LIMIT 1`,
    account,
    threadId.slice(account.length + 1),
  );
  return row ? findMessage(q, `${account}:${row.remote_id}`, accounts) : undefined;
}

const threadKey = (ref: MessageRef) => `${ref.accountId}\u0000${ref.threadRemoteId}`;

/** The refs grouped by thread, each message once, so a thread is opened at most once per call. */
function byThread(refs: readonly MessageRef[]): Map<string, MessageRef[]> {
  const groups = new Map<string, MessageRef[]>();
  for (const ref of refs) {
    const group = groups.get(threadKey(ref)) ?? [];
    if (!group.some(r => r.id === ref.id)) group.push(ref);
    groups.set(threadKey(ref), group);
  }
  return groups;
}

async function fetchThread(services: EngineServices, refs: readonly MessageRef[]): Promise<void> {
  const first = refs[0];
  if (refs.every(ref => storedBody(services, ref))) return;
  await services.accounts.openThread(first.accountId, first.threadRemoteId, {
    ...(first.remoteCount !== null ? { knownCount: first.remoteCount } : {}),
    lane: 'prefetch',
  });
}

async function warm(services: EngineServices, key: string, refs: readonly MessageRef[]) {
  const { cancelled } = services.mailFrames;
  cancelled.delete(key);
  await fetchThread(services, refs);
  if (cancelled.delete(key)) return;
  const allowList = services.store.read(readAllowList);
  const global = services.store.read(readRemoteImages);
  for (const ref of refs) {
    const policy = resolveImagePolicy('block', ref.fromAddr, allowList, global);
    await renderMessage(
      services,
      ref,
      { messageId: ref.id, requested: 'block', policy, quotesOpen: false },
      'prefetch',
    );
  }
}

/** Cancel marks are dropped wholesale past this many, so cancelling unknown threads cannot grow memory. */
const MAX_CANCELLED = 200;

export function prefetchBodies(
  args: Input<'MessageBody/prefetch'>,
  ctx: MethodContext,
): { ok: true } {
  const { services } = ctx;
  const groups = byThread(services.store.read(q => targets(q, args)));
  const { cancelled } = services.mailFrames;
  if (args.cancel === true) {
    if (cancelled.size + groups.size > MAX_CANCELLED) cancelled.clear();
    for (const key of groups.keys()) cancelled.add(key);
    return { ok: true };
  }
  for (const [key, refs] of groups) void warm(services, key, refs).catch(() => undefined);
  return { ok: true };
}
