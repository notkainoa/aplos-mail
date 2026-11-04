import type { DraftFields } from '@aplos/contract';
import { fail, type BlobSource } from './context';

/**
 * Attachment bytes for the outbox (Blob package 4). The blob store reads files through the host, so a read is async: the
 * send and the draft upload load every byte first, then build the MIME synchronously from the map.
 */

const UNREADABLE = "Couldn't read an attachment. Try again.";

/** The blob ids a draft's attachments name, in order (duplicates kept; `loadBlobs` reads each once). */
export function blobIdsOf(fields: Pick<DraftFields, 'attachments'>): string[] {
  return fields.attachments.flatMap(a => (a.blobId !== undefined ? [a.blobId] : []));
}

/**
 * Reads the distinct `ids` concurrently. A blob that is gone is absent from the map; a read that fails rejects the whole
 * load with `unavailable`, so no message is ever built from part of its attachments. A fresh map per call.
 */
export async function loadBlobs(
  source: BlobSource | undefined,
  ids: readonly string[],
): Promise<Map<string, Uint8Array>> {
  const distinct = [...new Set(ids)];
  // `async`: a read that throws instead of rejecting fails the load the same way.
  const read = await Promise.all(distinct.map(async id => source?.get(id))).catch(() =>
    fail('unavailable', UNREADABLE),
  );
  return new Map(distinct.flatMap((id, i) => (read[i] ? [[id, read[i]] as const] : [])));
}
