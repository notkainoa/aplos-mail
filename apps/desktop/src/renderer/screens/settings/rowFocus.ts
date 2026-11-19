/**
 * Focus is never lost on commit (DESIGN 11.2). A row's control can leave the DOM while it still holds
 * focus — Settings → Calendar's "Enable editing" unmounts the moment the account flips to
 * "Editing on" — and the browser drops focus on the page. `focusRowId` names the settings row a
 * control sat in; `focusRowTarget` finds that row again, so the screen can give it the focus the
 * removed control dropped. Row wrappers are `.settings-anchor` with `tabindex="-1"` (`parts.tsx`
 * `Row`), so a programmatic `focus({preventScroll: true})` lands on them. `removedRowTarget` names
 * the row that takes a removed row's place — a revoked tool's focus has no row of its own to return to.
 */

/** The settings row `el` sits in, named by its label's DOM id; null outside a `.settings-anchor` row. */
export function focusRowId(el: Element): string | null {
  const row = el.closest('.settings-anchor');
  return row?.querySelector('.ui-setting-row__label[id]')?.id ?? null;
}

/** The row element a lost focus returns to: the still-standing `.settings-anchor` `rowId` names. */
export function focusRowTarget(rowId: string | null, root: ParentNode): HTMLElement | null {
  if (!rowId) return null;
  for (const row of root.querySelectorAll<HTMLElement>('.settings-anchor')) {
    if (row.querySelector('.ui-setting-row__label[id]')?.id === rowId) return row;
  }
  return null;
}

/**
 * Where a removed row's focus lands: the row now at its index (what stood after it), else the one
 * before it, else the group's stable row (`fallback`, e.g. "Add a tool"). `before`/`after` are row
 * label ids in drawn order; null when nothing left the list.
 */
export function removedRowTarget(
  before: readonly string[],
  after: readonly string[],
  fallback: string,
): string | null {
  const at = before.findIndex(id => !after.includes(id));
  if (at < 0) return null;
  return after[at] ?? after[at - 1] ?? fallback;
}
