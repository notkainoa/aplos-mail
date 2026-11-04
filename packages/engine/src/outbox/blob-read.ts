import type { DraftFields } from '@aplos/contract';
import type { Clock } from '../ports/time';
import { fail, type BlobSource } from './context';

/**
 * Attachment bytes for the outbox (Blob package 4). The blob store reads files through the host, so a read is async: the
 * send and the draft upload load every byte first, then build the MIME synchronously from the map.
 */

const UNREADABLE = "Couldn't read an attachment. Try again.";
/** How long one load may take on the engine clock: a host read that hangs fails the send instead of holding it. */
export const BLOB_READ_LIMIT_MS = 10_000;

/** The blob ids a draft's attachments name, in order (duplicates kept; `loadBlobs` reads each once). */
export function blobIdsOf(fields: Pick<DraftFields, 'attachments'>): string[] {
  return fields.attachments.flatMap(a => (a.blobId !== undefined ? [a.blobId] : []));
}

/**
 * `work`, or a rejection once `BLOB_READ_LIMIT_MS` passed on `clock`. A later answer of `work` is dropped (its bytes are
 * never kept) and a later rejection stays handled by the race, so abandoning it never raises an unhandled rejection.
 */
async function withinLimit<T>(clock: Pick<Clock, 'sleep'>, work: Promise<T>): Promise<T> {
  const abort = new AbortController();
  const limit = clock.sleep(BLOB_READ_LIMIT_MS, abort.signal).then((): never => {
    throw new Error('blob read timed out');
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    abort.abort();
  }
}

/**
 * Reads the distinct `ids` concurrently, for at most `BLOB_READ_LIMIT_MS`. A blob that is gone is absent from the map; a
 * read that fails or is still running at the limit rejects the whole load with `unavailable`, so no message is ever
 * built from part of its attachments. A fresh map per call.
 */
export async function loadBlobs(
  source: BlobSource | undefined,
  ids: readonly string[],
  clock: Pick<Clock, 'sleep'>,
): Promise<Map<string, Uint8Array>> {
  const distinct = [...new Set(ids)];
  // `async`: a read that throws instead of rejecting fails the load the same way.
  const reads = Promise.all(distinct.map(async id => source?.get(id)));
  const read = await withinLimit(clock, reads).catch(() => fail('unavailable', UNREADABLE));
  return new Map(distinct.flatMap((id, i) => (read[i] ? [[id, read[i]] as const] : [])));
}
