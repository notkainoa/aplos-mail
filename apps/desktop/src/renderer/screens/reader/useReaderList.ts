/**
 * The ordered thread ids J and K walk. The shell does not tell the reader which list it was opened from, so the reader
 * takes the `listIds` its screen is given, and otherwise Home's order: Do now, Back from Later, Important updates,
 * then Follow up. A thread opened from another list that is not in these ids is not lost: J opens the first row.
 */
import { useMemo } from 'react';
import { useHome } from '../../data';

/** The ids of Home in the order the owner sees them. */
export function useHomeOrder(): readonly string[] {
  const home = useHome();
  return useMemo(() => {
    const ids: string[] = [];
    for (const section of home.sections) {
      ids.push(...section.ids);
      if (section.fromLater) ids.push(...section.fromLater.ids);
    }
    return ids;
  }, [home.sections]);
}

/** `listIds` when the screen has them, else Home's order. Stable while the ids do not change. */
export function useReaderList(listIds: readonly string[] | undefined): readonly string[] {
  const home = useHomeOrder();
  const ids = listIds ?? home;
  const signature = ids.join('\u0000');
  return useMemo(() => (signature ? signature.split('\u0000') : []), [signature]);
}
