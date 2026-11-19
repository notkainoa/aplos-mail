/**
 * The bulk pick (DESIGN 7.4): X flips the row under the cursor, ⇧X picks the run from the anchor to it, ⌘A
 * picks the whole list, Esc clears. Pure: no React, no engine. The anchor is an id, never an index, so rows
 * arriving or leaving cannot move it.
 */

/** Which rows are picked, and the id ⇧X pivots on. */
export interface Selection {
  /** Picked ids, unordered; a set so a long list costs O(1) a look-up. */
  readonly picked: ReadonlySet<string>;
  /** The last row X touched; ⇧X picks the run from it to the cursor. Null until the first pick. */
  readonly anchor: string | null;
}

/** Nothing picked: the starting state and what Esc restores. */
export const NO_SELECTION: Selection = { picked: new Set<string>(), anchor: null };

/** X on the cursor row: flips it; the anchor follows either way, so ⇧X pivots on the row just touched. */
export function toggle(sel: Selection, id: string): Selection {
  const picked = new Set(sel.picked);
  if (picked.has(id)) {
    picked.delete(id);
  } else {
    picked.add(id);
  }
  return { picked, anchor: id };
}

/**
 * ⇧X: picks every row between the anchor and the cursor, either way, and keeps picks outside the run. With no
 * anchor in the list (none yet, or its row left) it picks just the cursor row and the anchor moves to it. The
 * anchor otherwise stays, so repeated ⇧X pivots on the same row.
 */
export function extendTo(sel: Selection, ids: readonly string[], cursorId: string): Selection {
  const cursorAt = ids.indexOf(cursorId);
  if (cursorAt < 0) return sel;
  const anchorAt = sel.anchor === null ? -1 : ids.indexOf(sel.anchor);
  const picked = new Set(sel.picked);
  if (anchorAt < 0) {
    picked.add(cursorId);
    return { picked, anchor: cursorId };
  }
  const [from, to] = [Math.min(anchorAt, cursorAt), Math.max(anchorAt, cursorAt)];
  for (const id of ids.slice(from, to + 1)) {
    picked.add(id);
  }
  return { picked, anchor: sel.anchor };
}

/** ⌘A: every id in the list, anchored on the first. */
export function selectAll(ids: readonly string[]): Selection {
  return { picked: new Set(ids), anchor: ids[0] ?? null };
}

/** Esc. */
export function clear(): Selection {
  return NO_SELECTION;
}

/**
 * The list changed: forget picked ids and an anchor whose row left. The same object when nothing left, so a
 * routine re-render stays cheap.
 */
export function prune(sel: Selection, ids: readonly string[]): Selection {
  const live = new Set(ids);
  const picked = new Set<string>();
  let dropped = false;
  for (const id of sel.picked) {
    if (live.has(id)) {
      picked.add(id);
    } else {
      dropped = true;
    }
  }
  const anchor = sel.anchor !== null && !live.has(sel.anchor) ? null : sel.anchor;
  if (!dropped && anchor === sel.anchor) return sel;
  return { picked, anchor };
}

/** Whether the pane header shows the pick bar ("3 selected · Done · Later · Trash · More · Esc"). */
export function isPicking(sel: Selection): boolean {
  return sel.picked.size > 0;
}

/** The picked ids in list order: what a bulk action and its toast act on. */
export function pickedInOrder(sel: Selection, ids: readonly string[]): readonly string[] {
  return ids.filter(id => sel.picked.has(id));
}
