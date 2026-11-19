import type { AreaHandlers } from './types';

/**
 * The `blob` area, owned by lane `eng-contract` (plans/engine/blob-area.md decisions 5 to 7). The work is the blob
 * runtime's (`runtime/blobs.ts`): ids, principals, caps, the held check and the lifecycle. A blob of another principal
 * answers exactly as an unknown id does.
 */
export const handlers: AreaHandlers<'blob'> = {
  'Blob/put': ({ bytes, mime, name }, ctx) =>
    ctx.services.blobs.put({
      caller: ctx.caller,
      connectionId: ctx.connectionId,
      kind: 'upload',
      bytes,
      mime,
      name,
      signal: ctx.signal,
    }),
  'Blob/get': ({ blobId }, ctx) => ctx.services.blobs.get(ctx.caller, blobId),
  'Blob/release': async ({ blobId }, ctx) => {
    await ctx.services.blobs.release(ctx.caller, blobId);
    return { ok: true as const };
  },
};
