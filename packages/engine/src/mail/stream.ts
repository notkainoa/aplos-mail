import { within, type Deadline } from './deadline';

// Byte-stream helpers shared by `Message/original` and `Mail/serve`. They live apart from `serve.ts` so the core-side
// `original.ts` does not import the lazy server (and the frame code of @aplos/mail-html behind it).

/** Stops a stream we gave up on; its own failure to stop is not ours to report. */
export function closeIterator(iterator: AsyncIterator<unknown>): void {
  try {
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  } catch {
    // A `return` that throws has stopped as far as we can tell.
  }
}

/**
 * The whole stream, or undefined once it passes `max` bytes (unless `overLimit` throws its own
 * error), is cancelled or runs out of time. `idle` builds a fresh per-chunk deadline: a stalled
 * stream dies on it even while the outer `limit` still has time.
 */
export async function collectBytes(
  chunks: AsyncIterable<Uint8Array>,
  max: number,
  limit: Deadline,
  options?: { idle?: () => Deadline; overLimit?: () => Error },
): Promise<Uint8Array | undefined> {
  const iterator = chunks[Symbol.asyncIterator]();
  const parts: Uint8Array[] = [];
  let size = 0;
  let done = false;
  try {
    for (;;) {
      const stepLimit = options?.idle?.();
      let step: IteratorResult<Uint8Array> | undefined;
      try {
        step = await within(within(iterator.next(), stepLimit ?? limit), limit);
      } finally {
        stepLimit?.end();
      }
      if (!step) return undefined;
      if (step.done) {
        done = true;
        return joinBytes(parts, size);
      }
      if (!(step.value instanceof Uint8Array)) return undefined;
      size += step.value.byteLength;
      if (size > max) {
        if (options?.overLimit) throw options.overLimit();
        return undefined;
      }
      parts.push(step.value);
    }
  } finally {
    if (!done) closeIterator(iterator);
  }
}

function joinBytes(parts: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
