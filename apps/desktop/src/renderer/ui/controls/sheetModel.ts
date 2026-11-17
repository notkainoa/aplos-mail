// From the registry's sheet model (commands/sheet.ts: buildSheet) to ShortcutSheet's props. Pure, no React.
// `groups` is every section; `columns` is the section ids per column, taken from each section's `column`,
// so columns keep their places while the sheet filters (DESIGN §6 ShortcutSheet).
import type { SheetSection } from '../../commands';
import { parseKeyText } from '../buttons-keys/keyHints';
import type { ShortcutGroup, ShortcutSheetProps } from '../props';

export interface SheetProps {
  groups: readonly ShortcutGroup[];
  columns: ShortcutSheetProps['columns'];
}

/** `buildSheet(registry)` result in, `groups` and `columns` for `<ShortcutSheet>` out. Empty sections are dropped. */
export function sheetProps(sections: readonly SheetSection[]): SheetProps {
  const groups: ShortcutGroup[] = [];
  const columns: [string[], string[], string[]] = [[], [], []];
  for (const section of sections) {
    if (section.rows.length === 0) continue;
    groups.push({
      id: section.id,
      label: section.title,
      entries: section.rows.map(row => ({
        commandId: row.id,
        label: row.label,
        alternatives: parseKeyText(row.keys),
        ...(row.note ? { note: row.note } : {}),
      })),
    });
    columns[section.column].push(section.id);
  }
  return { groups, columns };
}

/**
 * The tallest height at most `room` whose bottom edge cuts no row in any column: a row half drawn at the foot of the
 * list reads as broken, so the first view ends between rows. Edges are measured from the body's top at scroll 0.
 */
export function wholeRowsHeight(
  edges: readonly { top: number; bottom: number }[],
  room: number,
): number {
  const fits = edges.filter(edge => edge.bottom <= room);
  const cutAt = (y: number) => edges.every(edge => !(edge.top < y - 0.5 && edge.bottom > y + 0.5));
  const candidates = fits.map(edge => edge.bottom).sort((a, b) => b - a);
  return candidates.find(cutAt) ?? room;
}
