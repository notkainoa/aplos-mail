/**
 * The bulk pick as React state (DESIGN 7.4): `selection.ts` holds the rules, this hook holds the value for one mounted
 * list. It settles against the list on every render (a row that left is forgotten) and keeps ⌘A as "the whole list",
 * so the pick survives the window sliding past 200 rows. Mutators write a ref first, so two keys inside one tick (X,
 * then E) see each other.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { State, ViewSpec, ThreadListSpec } from '../../data';
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

/** What ⌘A saw: the view at the moment it was pressed, so mail that arrives later is not swept in. */
export interface Frozen {
  /** The loaded ids at ⌘A. */
  readonly ids: readonly string[];
  /** `view.state` at ⌘A: the `atState` of a whole-view selector. */
  readonly state: State | null;
  /** Rows in the whole view at ⌘A. */
  readonly total: number;
  /** The view held more than the window: the selector covers rows the window slides to. */
  readonly beyond: boolean;
}

/** The view a pick sits on, read when ⌘A is pressed. */
export interface PickView {
  readonly state: State | null;
  readonly total: number;
}

/** What the hook stores: the picks, and whether ⌘A asked for everything (and what it saw). */
export interface RawPick {
  readonly selection: Selection;
  readonly everything: boolean;
  readonly frozen?: Frozen;
}

export const NONE: RawPick = { selection: NO_SELECTION, everything: false };

/**
 * The picks a list shows now. ⌘A means the rows it saw that are still loaded (mail that arrived since is not picked);
 * when the view reached past the window, every loaded row, since the selector covers the rows the window slides to.
 * Otherwise the stored picks minus rows that left.
 */
export function settled(raw: RawPick, ids: readonly string[]): Selection {
  if (!raw.everything) return prune(raw.selection, ids);
  const { frozen } = raw;
  if (!frozen || frozen.beyond) return { picked: new Set(ids), anchor: raw.selection.anchor };
  const saw = new Set(frozen.ids);
  return { picked: new Set(ids.filter(id => saw.has(id))), anchor: raw.selection.anchor };
}

function freeze(ids: readonly string[], view: PickView | undefined): Frozen {
  const total = view?.total ?? ids.length;
  return { ids, state: view?.state ?? null, total, beyond: total > ids.length };
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
  /** What ⌘A saw, while it is in force. */
  readonly frozen: Frozen | null;
  readonly controls: BulkControls;
}

/** The view's spec as a thread-row spec a selector can name; null for Drafts and other non-thread views. */
export function threadSpecOf(spec: ViewSpec): ThreadListSpec | null {
  return spec.kind === 'drafts' ? null : (spec as ThreadListSpec);
}

export function useBulk(ids: readonly string[], view?: PickView): BulkState {
  const [stored, setStored] = useState<RawPick>(NONE);
  const live = useMemo(() => settled(stored, ids), [stored, ids]);
  const drained = stored.everything && ids.length === 0;
  const selection = drained ? NO_SELECTION : live;
  // Store the settled value back, so a row that left stays forgotten if it returns (an Undo).
  if (drained) setStored(NONE);
  else if (!stored.everything && live !== stored.selection)
    setStored({ selection: live, everything: false });

  const latest = useRef({ selection, ids, view, everything: stored.everything });
  latest.current = { selection, ids, view, everything: stored.everything && !drained };
  const apply = useCallback((next: RawPick) => {
    const { ids: now } = latest.current;
    latest.current = {
      ...latest.current,
      selection: settled(next, now),
      everything: next.everything,
    };
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
      selectAll: () => {
        const { ids: now, view: seen } = latest.current;
        apply({ selection: selectAll(now), everything: now.length > 0, frozen: freeze(now, seen) });
      },
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
    frozen: stored.everything && !drained ? (stored.frozen ?? null) : null,
    controls,
  };
}
