import type { Input, Output } from '@aplos/contract';
import type { MethodContext } from '../methods/types';
import type { EngineServices } from '../runtime/services';
import { contractError } from '../runtime/errors';
import { cleanName } from '../runtime/blobs';
import { deadline, within, type Deadline } from './deadline';
import { requireMessage } from './message';

/**
 * `Message/original` (Blob package 7, blob-area.md decision 13): the message's raw RFC822 for "Show original"
 * and `.eml` export, fetched live through `ProviderPort.original` — never from a store copy, never cached.
 * The optional port is absent until the prov-gov routes it to an adapter that has it (`unavailable` then).
 * The stream is capped at 25 MB under a 120 s total / 30 s idle deadline tied to the caller's signal, then
 * stored as an `original` blob (`message/rfc822`, name = cleaned subject + `.eml`) the caller owns.
 */

const MAX_BYTES = 25 * 1024 * 1024;
const TOTAL_MS = 120_000;
const IDLE_MS = 30_000;

const unavailable = (message = "Couldn't get this message's original. Try again.") =>
  contractError({ type: 'unavailable', message });
const tooLarge = () =>
  contractError({
    type: 'tooLarge',
    message: "This message's original is too large to open in Aplos.",
  });

/** The whole stream, or undefined once it exceeds 25 MB, is cancelled, or runs out of total or idle time. */
async function collect(
  services: EngineServices,
  chunks: AsyncIterable<Uint8Array>,
  total: Deadline,
  signal: AbortSignal,
): Promise<Uint8Array | undefined> {
  const iterator = chunks[Symbol.asyncIterator]();
  const parts: Uint8Array[] = [];
  let size = 0;
  let done = false;
  try {
    for (;;) {
      const idle = deadline(services.clock, IDLE_MS, signal);
      let step: IteratorResult<Uint8Array> | undefined;
      try {
        step = await within(within(iterator.next(), idle), total);
      } finally {
        idle.end();
      }
      if (!step) return undefined;
      if (step.done) {
        done = true;
        const out = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          out.set(part, offset);
          offset += part.byteLength;
        }
        return out;
      }
      if (!(step.value instanceof Uint8Array)) return undefined;
      size += step.value.byteLength;
      if (size > MAX_BYTES) throw tooLarge();
      parts.push(step.value);
    }
  } finally {
    if (!done)
      try {
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
      } catch {
        // A `return` that throws has stopped as far as we can tell.
      }
  }
}

export async function messageOriginal(
  args: Input<'Message/original'>,
  ctx: MethodContext,
): Promise<Output<'Message/original'>> {
  const { services } = ctx;
  if (!services.accounts.original) throw unavailable('This part of Aplos is not running yet.');
  const ref = requireMessage(services, args.messageId);
  const total = deadline(services.clock, TOTAL_MS, ctx.signal);
  try {
    const chunks = await within(services.accounts.original(ref.accountId, ref.remoteId), total);
    if (!chunks) throw unavailable();
    const bytes = await collect(services, chunks, total, ctx.signal);
    if (!bytes) throw unavailable();
    const subject = services.store.read(q =>
      q.get<{ subject: string | null }>('SELECT subject FROM messages WHERE id = ?', ref.rowId),
    )?.subject;
    // `line(500)` counts UTF-16 units and `put` re-cleans names to 255 code points: bound both, so
    // the returned name is exactly the stored one and always keeps the `.eml`.
    let base = cleanName(subject) ?? 'message';
    const cps = [...base].slice(0, 251);
    while (cps.join('').length > 496) cps.pop();
    base = cps.join('');
    const name = `${base}.eml`;
    const { blobId, size } = await services.blobs.put({
      caller: ctx.caller,
      connectionId: ctx.connectionId,
      kind: 'original',
      bytes,
      mime: 'message/rfc822',
      name,
      signal: ctx.signal,
    });
    return { blobId, name, size };
  } finally {
    total.end();
  }
}
