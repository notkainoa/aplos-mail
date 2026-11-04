import { ProviderError } from '../ports/base';
import type { AdapterContext, AttachmentRef, ProviderAdapter } from '../ports/provider';

/**
 * The byte reads of the `ProviderPort` section (`sync/host.ts` keeps the thread and search reads): one attachment's
 * bytes, and the message's raw RFC822 for `Message/original`. Each takes the account's actor entry — the adapter and
 * the actor that supplies the governed context.
 */
export interface ReadEntry {
  adapter: Pick<ProviderAdapter, 'kind' | 'fetchAttachment'> & {
    /**
     * The adapter's optional raw-RFC822 read (`ProviderPort.original`); the Gmail adapter has it
     * (`bodies.ts fetchOriginal`). Declared structurally: an adapter that cannot serve it leaves it out.
     */
    original?(remoteMessageId: string, ctx: AdapterContext): Promise<AsyncIterable<Uint8Array>>;
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

/**
 * The message's raw RFC822, fetched live and never cached (`ports/engine.ts` `ProviderPort.original`). An adapter
 * without it answers `unavailable`, not absent, so the caller can tell "this account cannot" from "this read failed".
 */
export function originalRemote(
  entry: ReadEntry,
  remoteMessageId: string,
): Promise<AsyncIterable<Uint8Array>> {
  if (!entry.adapter.original)
    throw new ProviderError({
      class: 'permanent',
      provider: entry.adapter.kind,
      method: 'ProviderPort.original',
      reason: 'unavailable',
      uncertain: false,
    });
  return entry.adapter.original(remoteMessageId, entry.actor.context());
}
