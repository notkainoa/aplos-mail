import { ProviderError, type AccountId } from '../ports/base';
import type {
  AdapterContext,
  AttachmentRef,
  OpenedThread,
  ProviderAdapter,
} from '../ports/provider';
import type { StorePort } from '../store/port';
import { openedWrites } from './facts';
import { readFence } from './ops';

/**
 * The byte reads of the `ProviderPort` section (`sync/host.ts` keeps search): a thread's open, one attachment's
 * bytes, and the message's raw RFC822 for `Message/original`. Each takes the account's actor entry — the adapter and
 * the actor that supplies the governed context.
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
