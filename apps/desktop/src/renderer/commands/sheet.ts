// The shortcut sheet model (DESIGN §6 ShortcutSheet, §8). Generated from the
// registry's effective bindings, so a bound key can never be missing from it.
import { chordId, formatAlternatives } from './keys';
import type { Registry } from './registry';
import type { Binding, CommandId, ContextName } from './types';

export interface SheetRow {
  readonly id: CommandId;
  readonly label: string;
  /** "J or ↓", "Hold R", "1–9", "⌥-click". */
  readonly keys: string;
  readonly kind: 'key' | 'pointer';
}

export interface SheetSection {
  readonly id: string;
  readonly title: string;
  /** Which of the sheet's three columns it sits in (DESIGN §6: three columns). */
  readonly column: 0 | 1 | 2;
  readonly rows: readonly SheetRow[];
}

interface SectionDef {
  readonly id: string;
  readonly title: string;
  readonly column: 0 | 1 | 2;
  readonly contexts: readonly ContextName[];
}

/**
 * The sections of DESIGN §8, in reading order. The onboarding window (onboarding,
 * firstSync, drill) and Settings are not listed: the sheet opens from the mail
 * window. The reconnect and consent `sheet` has only Return and Esc, like a dialog.
 */
export const SHEET_SECTIONS: readonly SectionDef[] = [
  { id: 'global', title: 'Global', column: 0, contexts: ['global'] },
  {
    id: 'home',
    title: 'Home and one by one',
    column: 0,
    contexts: ['home', 'oneByOne', 'lowImportance'],
  },
  { id: 'done', title: 'Done', column: 0, contexts: ['done'] },
  { id: 'reader', title: 'Reader', column: 0, contexts: ['reader'] },
  { id: 'lists', title: 'Lists', column: 1, contexts: ['list'] },
  // Return here runs the remote search; in a list the same key opens the row, so the field gets a group of its own.
  { id: 'search', title: 'Search field', column: 1, contexts: ['search'] },
  {
    id: 'palette',
    title: 'Palette, menus and date picker',
    column: 1,
    contexts: ['palette', 'menu', 'datePicker', 'dialog'],
  },
  { id: 'compose', title: 'Compose', column: 2, contexts: ['compose'] },
  { id: 'ask', title: 'Ask', column: 2, contexts: ['ask'] },
  { id: 'calendar', title: 'Calendar', column: 2, contexts: ['calendar'] },
];

/** Pointer gestures DESIGN §8 lists beside the keys; they have no binding to generate from. */
export const SHEET_POINTER_ROWS: Readonly<Record<string, readonly SheetRow[]>> = {
  lists: [
    {
      id: 'list.openClick',
      label: 'Open the selected email',
      keys: 'Click it again',
      kind: 'pointer',
    },
  ],
  calendar: [
    { id: 'calendar.solo', label: 'Show only this calendar', keys: '⌥-click', kind: 'pointer' },
    { id: 'calendar.zoom', label: 'Zoom', keys: 'Pinch or ⌘-scroll', kind: 'pointer' },
  ],
};

function uniqueBindings(bindings: readonly Binding[]): Binding[] {
  const seen = new Set<string>();
  const out: Binding[] = [];
  for (const b of bindings) {
    const key = `${b.phase}|${chordId(b.chord)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(b);
  }
  return out;
}

export function buildSheet(registry: Registry): SheetSection[] {
  const ids = [...registry.list().map(c => c.id), ...registry.controls().map(c => c.id)];
  const all = registry.bindings();
  const sheetContexts = new Set(SHEET_SECTIONS.flatMap(section => section.contexts));
  // A command bound in several contexts (Done is → on Home and E in a list) is one row in the first section that
  // has it, with every key it answers to there, so "→ or E" reads the same as in Settings → Keyboard.
  const listed = new Set<string>();
  return SHEET_SECTIONS.map(section => {
    const rows: SheetRow[] = [];
    for (const id of ids) {
      if (listed.has(id)) continue;
      const here = all.filter(b => b.commandId === id && section.contexts.includes(b.context));
      if (here.length === 0) continue;
      const everywhere = all.filter(b => b.commandId === id && sheetContexts.has(b.context));
      const label = registry.get(id)?.spec.label ?? id;
      listed.add(id);
      rows.push({ id, label, keys: formatAlternatives(uniqueBindings(everywhere)), kind: 'key' });
    }
    rows.push(...(SHEET_POINTER_ROWS[section.id] ?? []));
    return { id: section.id, title: section.title, column: section.column, rows };
  });
}
