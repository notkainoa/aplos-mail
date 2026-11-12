import { ProviderError, type AccountId } from '../ports/base';
import type {
  AdapterAccount,
  AdapterContext,
  AttachmentRef,
  OpenedThread,
  ProviderAdapter,
} from '../ports/provider';
import type { StorePort, StoreWrite } from '../store/port';
import { messageWrites } from './facts';
import { readFence } from './ops';

/**
 * The byte reads of the `ProviderPort` section (`sync/host.ts` keeps search): a thread's open, one attachment's
 * bytes, and the message's raw RFC822 for `Message/original`. Each takes the account's actor entry — the adapter and
 * the actor that supplies the governed context. Loaded on the first read (`import()` in `sync/host.ts`), so none of it
 * counts against the engine core.
 */
export interface ReadEntry {
  adapter: Pick<ProviderAdapter, 'kind' | 'fetchAttachment' | 'openThread'> & {
    /**
     * The adapter's optional raw-RFC822 read (`ProviderPort.original`); the Gmail adapter has it
     * (`bodies.ts fetchOriginal`). Declared structurally: an adapter that cannot serve it leaves it out.
     * `opts.signal` is the caller's view of the deadline (a lane stop or the 120 s total), merged into the
     * adapter's own abort set so the HTTP read really stops.
     */
    original?(
      remoteMessageId: string,
      ctx: AdapterContext,
      opts?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<Uint8Array>>;
  };
  actor: { context(): AdapterContext };
}

/** One attachment's bytes (`messages.attachments.get` on Gmail), on the account's own context. */
export function attachmentBytes(
  entry: ReadEntry,
  ref: AttachmentRef,
): Promise<AsyncIterable<Uint8Array>> {
  return entry.adapter.fetchAttachment(ref, entry.actor.context());
}

/** Thread reads in flight, per mailbox (`sharedOpen`). */
const inFlight = new WeakMap<StorePort, Map<string, Promise<OpenedThread>>>();

/**
 * `openThreadRemote` with reads in flight shared, by lane, account and thread (fix-bodies S2): one open of an email used
 * to fetch the thread twice (`Thread/open` and `MessageBody/get`, both interactive), each a full `threads.get` waiting
 * its turn for the one reserved slot. A second caller on the same lane joins the read already going out; an interactive
 * caller never joins a prefetch read, so it never waits behind the slow lane.
 */
export function sharedOpen(
  entry: ReadEntry,
  store: StorePort,
  newId: () => string,
  account: AccountId,
  remoteThreadId: string,
  opts: { knownCount?: number; lane?: 'interactive' | 'prefetch' },
): Promise<OpenedThread> {
  const opening = inFlight.get(store) ?? new Map<string, Promise<OpenedThread>>();
  inFlight.set(store, opening);
  const key = `${opts.lane ?? 'interactive'} ${account} ${remoteThreadId}`;
  const going = opening.get(key);
  if (going) return going;
  const read = openThreadRemote(entry, store, newId, account, remoteThreadId, opts);
  opening.set(key, read);
  const done = () => opening.delete(key);
  read.then(done, done);
  return read;
}

/** `ProviderPort.openThread` (AM-1): the adapter read plus the fence and commit the host owes the store. */
export async function openThreadRemote(
  entry: ReadEntry,
  store: StorePort,
  newId: () => string,
  account: AccountId,
  remoteThreadId: string,
  opts: { knownCount?: number; lane?: 'interactive' | 'prefetch' },
): Promise<OpenedThread> {
  const ctx = entry.actor.context();
  const fence = readFence(store, account, ctx.generation);
  const opened = await entry.adapter.openThread(
    { remoteThreadId, ...(opts.knownCount !== undefined ? { knownCount: opts.knownCount } : {}) },
    opts.lane ?? 'interactive',
    ctx,
  );
  store.commit({
    opId: newId(),
    origin: 'sync',
    fenceSeq: fence,
    writes: openedWrites(ctx.account, remoteThreadId, opened),
  });
  return opened;
}

/**
 * The message's raw RFC822, fetched live and never cached (`ports/engine.ts` `ProviderPort.original`). An adapter
 * without it answers `unavailable`, not absent, so the caller can tell "this account cannot" from "this read failed".
 */
export function originalRemote(
  entry: ReadEntry,
  remoteMessageId: string,
  opts?: { signal?: AbortSignal },
): Promise<AsyncIterable<Uint8Array>> {
  if (!entry.adapter.original)
    throw new ProviderError({
      class: 'permanent',
      provider: entry.adapter.kind,
      method: 'ProviderPort.original',
      reason: 'unavailable',
      uncertain: false,
    });
  return entry.adapter.original(remoteMessageId, entry.actor.context(), opts);
}

/** An opened thread: full messages, bodies, `complete`, and messages the thread no longer has. */
export function openedWrites(
  account: AdapterAccount,
  remoteThreadId: string,
  opened: OpenedThread,
): StoreWrite[] {
  const id = account.id;
  const writes: StoreWrite[] = [];
  let size: number | undefined;
  let complete = true;
  for (const m of opened.messages) {
    const { body, ...facts } = m;
    writes.push(...messageWrites(id, account.address, facts));
    // A body part that did not arrive (a pause, a failed part fetch) is not stored (fix-bodies R3): a stored body is
    // never fetched again, so it would read as a blank letter forever. Left out, the thread stays partial and the next
    // open fetches it again.
    if (m.partial) complete = false;
    else
      writes.push({
        kind: 'body',
        accountId: id,
        remoteId: m.remoteId,
        body: { text: body.text, html: body.html, cidMap: body.cidMap },
      });
    size = m.threadSize ?? size;
  }
  for (const remoteId of opened.removed ?? [])
    writes.push({ kind: 'messageDelete', accountId: id, remoteId });
  writes.push({
    kind: 'thread',
    accountId: id,
    remoteThreadId,
    complete,
    remoteCount: size ?? opened.messages.length,
  });
  return writes;
}
