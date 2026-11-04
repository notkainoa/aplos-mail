import { ContractError } from '@aplos/contract/contract-error';
import type { EngineServices } from '../runtime/services';
import type { Caller } from './types';
import { BLOB_SENTENCES } from '../runtime/blobs';

/** What `Draft/set` refuses a file that is not the caller's own with: the same words as a file that is gone. */
const ATTACH_AGAIN = `${BLOB_SENTENCES.gone} Attach it again.`;

/**
 * `Draft/set`'s ownership check (Blob package 4, decision 9): every NEW `attachments[].blobId` (one the stored draft does
 * not already name) must be a blob this caller's principal made, so a listener cannot attach a window's file by id and a
 * window cannot name a blob that is gone. It is synchronous and the caller commits in the same turn, so a release cannot
 * slip between the check and the commit. An already attached file is not asked again: a draft keeps working after its
 * blob lost its owner, and a held blob is never released while a draft names it.
 */
export function assertOwnedAttachments(
  services: Pick<EngineServices, 'blobs' | 'draftBox'>,
  caller: Caller,
  draftId: string | undefined,
  attachments: readonly { blobId?: string }[],
): void {
  const named = attachments.flatMap(a => (a.blobId === undefined ? [] : [a.blobId]));
  if (!named.length) return;
  const stored = draftId === undefined ? undefined : services.draftBox.get([draftId]).list[0];
  const had = new Set(stored?.attachments.flatMap(a => (a.blobId === undefined ? [] : [a.blobId])));
  for (const blobId of named)
    if (!had.has(blobId) && !services.blobs.owns(caller, blobId))
      throw new ContractError({ type: 'notFound', message: ATTACH_AGAIN });
}
