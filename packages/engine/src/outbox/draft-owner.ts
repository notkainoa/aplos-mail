import { ContractError } from '@aplos/contract/contract-error';
import { idFor } from './drafts';
import type { EngineServices } from '../runtime/services';
import type { Caller } from '../methods/types';

/** What `Draft/set` refuses a file that is not the caller's own with: the same words as a file that is gone. */
// (Spelled out, not imported from the blob runtime: that import is a cycle through the method table. The test pins it
// to `BLOB_SENTENCES.gone` plus ' Attach it again.')
const ATTACH_AGAIN = 'This file is no longer available. Attach it again.';

/**
 * `Draft/set`'s ownership check (Blob package 4, decision 9): every NEW `attachments[].blobId` (one the stored draft does
 * not already name) must be a blob this caller's principal made, so a listener cannot attach a window's file by id and a
 * window cannot name a blob that is gone. It is synchronous and the caller commits in the same turn, so a release cannot
 * slip between the check and the commit. An already attached file is not asked again: a draft keeps saving after its
 * blob lost its owner or was released — only a live send pins a blob against release.
 */
export function assertOwnedAttachments(
  services: Pick<EngineServices, 'blobs' | 'draftBox'>,
  caller: Caller,
  opId: string,
  draftId: string | undefined,
  attachments: readonly { blobId?: string }[],
): void {
  const named = attachments.flatMap(a => (a.blobId === undefined ? [] : [a.blobId]));
  if (!named.length) return;
  // A create that already landed under this opId is a replay: its row already names the ids, so they are
  // exempt — even if the caller released the blob since the first attempt. Without this lookup a replayed
  // create re-checks every id as new and is refused 'attach it again' although it succeeded.
  const stored = services.draftBox.get([draftId ?? idFor(opId, 'create')]).list[0];
  // (A row whose data is unreadable reads as having no attachments: every id is then checked.)
  const had = new Set(
    (stored?.attachments ?? []).flatMap(a => (a?.blobId === undefined ? [] : [a.blobId])),
  );
  for (const blobId of named)
    if (!had.has(blobId) && !services.blobs.owns(caller, blobId))
      throw new ContractError({ type: 'notFound', message: ATTACH_AGAIN });
}
