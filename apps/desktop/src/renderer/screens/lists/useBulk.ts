/**
 * The bulk pick as React state (DESIGN 7.4): `selection.ts` holds the rules, this hook holds the value for one mounted
 * list. It settles against the list on every render (a row that left is forgotten) and keeps ⌘A as "the whole list",
 * so the pick survives the window sliding past 200 rows. Mutators write a ref first, so two keys inside one tick (X,
 * then E) see each other.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ViewSpec, ThreadListSpec } from '../../data';
import {
  NO_SELECTION,
  extendTo,
  isPicking,
  pickedInOrder,
  prune,
  selectAll,
  toggle,
  type Selection,
} from './selection';

/** What the hook stores: the picks, and whether ⌘A asked for everything. */
export interface RawPick {
  readonly selection: Selection;
  readonly everything: boolean;
}

export const NONE: RawPick = { selection: NO_SELECTION, everything: false };

/** The picks a list shows now: ⌘A means every loaded id, else the stored picks minus rows that left. */
export function settled(raw: RawPick, ids: readonly string[]): Selection {
  if (raw.everything) return { picked: new Set(ids), anchor: raw.selection.anchor };
  return prune(raw.selection, ids);
}

/** The controls a list's actions call. */
export interface BulkControls {
  /** X on this row. */
  toggle(id: string): void;
  /** ⇧X to this row. */
  extendTo(id: string): void;
  /** ⌘A. */
  selectAll(): void;
  /** Esc, and after a bulk action. */
  clear(): void;
}

/** The bulk pick of one list. */
export interface BulkState {
  readonly selection: Selection;
  /** Picked ids in list order. */
  readonly picked: readonly string[];
  readonly picking: boolean;
  /** ⌘A is in force: the owner meant the whole view, not just what is loaded. */
  readonly everything: boolean;
  readonly controls: BulkControls;
}

/** The view's spec as a thread-row spec a selector can name; null for Drafts and other non-thread views. */
export function threadSpecOf(spec: ViewSpec): ThreadListSpec | null {
  return spec.kind === 'drafts' ? null : (spec as ThreadListSpec);
}

export function useBulk(ids: readonly string[]): BulkState {
  const [stored, setStored] = useState<RawPick>(NONE);
  const live = useMemo(() => settled(stored, ids), [stored, ids]);
  const drained = stored.everything && ids.length === 0;
  const selection = drained ? NO_SELECTION : live;
  // Store the settled value back, so a row that left stays forgotten if it returns (an Undo).
  if (drained) setStored(NONE);
  else if (!stored.everything && live !== stored.selection)
    setStored({ selection: live, everything: false });

  const latest = useRef({ selection, ids, everything: stored.everything });
  latest.current = { selection, ids, everything: stored.everything && !drained };
  const apply = useCallback((next: RawPick) => {
    const { ids: now } = latest.current;
    latest.current = { selection: settled(next, now), ids: now, everything: next.everything };
    setStored(next);
  }, []);

  const controls = useMemo<BulkControls>(
    () => ({
      toggle: id => apply({ selection: toggle(latest.current.selection, id), everything: false }),
      extendTo: id =>
        apply({
          selection: extendTo(latest.current.selection, latest.current.ids, id),
          everything: false,
        }),
      selectAll: () =>
        apply({
          selection: selectAll(latest.current.ids),
          everything: latest.current.ids.length > 0,
        }),
      clear: () => apply(NONE),
    }),
    [apply],
  );
  const picked = useMemo(() => pickedInOrder(selection, ids), [selection, ids]);
  return {
    selection,
    picked,
    picking: isPicking(selection),
    everything: latest.current.everything,
    controls,
  };
}
