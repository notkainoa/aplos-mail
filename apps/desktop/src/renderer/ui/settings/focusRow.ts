/**
 * Deep links into Settings (DESIGN 7.10, "Every setting is searchable from ⌘K"): `settings/<section>#<row>` lands
 * on the row whose SettingRow got `paletteId` `setting.<section>.<row>`. The screen calls this once the section has
 * rendered. It scrolls the row to the middle of the pane and focuses its control, or the whole row's button when the
 * row is a folded disclosure. Returns whether a row was found.
 */

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function focusSettingRow(anchor: string, root: ParentNode = document): boolean {
  const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-setting-anchor]'));
  const row = rows.find(el => el.dataset.settingAnchor === anchor);
  if (!row) return false;
  row.scrollIntoView?.({ block: 'center' });
  const target =
    row.querySelector('.ui-setting-row__control')?.querySelector<HTMLElement>(FOCUSABLE) ??
    row.querySelector<HTMLElement>('.ui-setting-row__toggle') ??
    row.querySelector<HTMLElement>(FOCUSABLE);
  target?.focus({ preventScroll: true });
  return true;
}
