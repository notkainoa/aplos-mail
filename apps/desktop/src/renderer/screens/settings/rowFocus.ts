/**
 * Focus is never lost on commit (DESIGN 11.2). A row's control can leave the DOM while it still holds
 * focus — Settings → Calendar's "Enable editing" unmounts the moment the account flips to
 * "Editing on" — and the browser drops focus on the page. `focusRowId` names the settings row a
 * control sat in; `focusRowTarget` finds that row again, so the screen can give it the focus the
 * removed control dropped. Row wrappers are `.settings-anchor` with `tabindex="-1"` (`parts.tsx`
 * `Row`), so a programmatic `focus({preventScroll: true})` lands on them.
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
