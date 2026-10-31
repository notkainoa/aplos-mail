/**
 * The ordered thread ids J and K walk. A list screen tells the shell which ids it showed when it opened the thread
 * (`listIds`), and those are used as they are. Only when none came (a deep link, the palette) does the reader fall back
 * to Home's order, scoped to the account Home was filtered to, held while Home's hold is, and sorted by Home's own
 * `orderLayout`: Do now, Back from Later, Important updates, then Follow up. A thread that is not in the ids starts the
 * walk at an end, and one that has left them keeps its place so the neighbour is chosen (`walkList`).
 */
import { useMemo, useRef } from 'react';
import { useHold, useHome } from '../../data';
import { useAccountScope } from '../../shell';
import { orderLayout, type HomeLayout } from '../home/homeModel';
import { NO_MEMORY, walkList, type ListMemory } from './readerModel';

type HomeData = ReturnType<typeof useHome>;

function layoutOf(home: HomeData): HomeLayout {
  const section = home.sections.find(s => s.key === 'do');
  const ids = (key: 'update' | 'follow') => home.sections.find(s => s.key === key)?.ids ?? [];
  return {
    do: section?.ids ?? [],
    fromLater: section?.fromLater?.ids ?? [],
    update: ids('update'),
    follow: ids('follow'),
    lowCount: home.low.count,
  };
}

/** The ids of Home in the order the owner sees them (the Low band's rows are not on the list). */
export function useHomeOrder(): readonly string[] {
  const scope = useAccountScope();
  const hold = useHold('home');
  const home = useHome({ accountId: scope ?? undefined, holdIds: hold.heldIds });
  const held = hold.isHeld;
  return useMemo(() => {
    const ordered = orderLayout(layoutOf(home), id => home.rows.get(id), held);
    return [...ordered.do, ...ordered.fromLater, ...ordered.update, ...ordered.follow];
  }, [home, held]);
}

const SEPARATOR = '\u0000';

/** The same ids, as one array that keeps its identity while the ids do not change. */
function useStableIds(ids: readonly string[]): readonly string[] {
  const signature = ids.join(SEPARATOR);
  return useMemo(() => (signature ? signature.split(SEPARATOR) : []), [signature]);
}

/** What the reader walks, and the list itself (without a departed thread put back) for the crumb. */
export interface ReaderList {
  /** The list as it is now: the crumb's "n of m". */
  readonly ids: readonly string[];
  /** The list to walk from `open`: the same, with `open` kept in its place if it just left. */
  readonly walk: readonly string[];
}

/** `listIds` when the screen has them, else Home's order. Stable while the ids do not change. */
export function useReaderList(
  listIds: readonly string[] | undefined,
  open: string | null,
  gone: ReadonlySet<string>,
): ReaderList {
  const home = useHomeOrder();
  const source = listIds ?? home;
  const ids = useStableIds(gone.size === 0 ? source : source.filter(id => !gone.has(id)));
  const memory = useRef<ListMemory>(NO_MEMORY);
  const walked = walkList(memory.current, ids, open);
  memory.current = walked.memory;
  return { ids, walk: useStableIds(walked.walk) };
}
