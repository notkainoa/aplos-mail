import { CORE_WRITE_KINDS } from './commit';
import { LANE_WRITE_KINDS, StoreError, type CommitExtension } from './port';

/** Change types only the store writes; an extension moves them through `touchThread` / `touchMessage`. */
const STORE_CHANGE_TYPES: ReadonlySet<string> = new Set([
  'Account',
  'Folder',
  'Thread',
  'Message',
  'Calendar',
  'Event',
]);

/**
 * Seam 2: validates the lanes' commit extensions when the store opens. A kind belongs to one writer: a store kind is
 * never claimable, a reserved kind only by its lane, and no two extensions share one. Store change types are refused,
 * so a lane cannot forge a row for a type it does not own.
 */
export function registerExtensions(
  list: readonly CommitExtension[] = [],
): ReadonlyMap<string, CommitExtension> {
  const byKind = new Map<string, CommitExtension>();
  for (const ext of list) {
    if (!ext.lane || !ext.kinds?.length || typeof ext.apply !== 'function')
      throw new StoreError('invalid', 'A commit extension needs a lane, kinds and apply()');
    for (const kind of ext.kinds) {
      if (CORE_WRITE_KINDS.has(kind))
        throw new StoreError('invalid', `${ext.lane} cannot claim the store kind ${kind}`);
      const owner = (LANE_WRITE_KINDS as Record<string, string>)[kind];
      if (owner && owner !== ext.lane)
        throw new StoreError(
          'invalid',
          `Write kind ${kind} is reserved for ${owner}, not ${ext.lane}`,
        );
      const held = byKind.get(kind);
      if (held)
        throw new StoreError(
          'invalid',
          `Write kind ${kind} is registered twice (${held.lane}, ${ext.lane})`,
        );
      byKind.set(kind, ext);
    }
    for (const type of ext.changeTypes ?? [])
      if (STORE_CHANGE_TYPES.has(type))
        throw new StoreError('invalid', `${ext.lane} cannot write ${type} change rows`);
  }
  return byKind;
}
