/**
 * Settings → Keyboard, the pure layer (DESIGN 7.10, 8, 11.4). The list is generated from the command registry, so it
 * can never drift from the real keys: every command with a key appears once, in its group, with its effective keys.
 * Remaps are stored as overrides only (`Settings.ui.keymap`), so a newer default still reaches a command nobody
 * changed. A remap replaces the command's first key and keeps the rest; Reset puts the defaults back.
 *
 * Conflicts, reserved chords (⌘Q, ⌘W, ⌘H and the text-editing keys) and shadowing are the registry's own checks
 * (`conflicts`), the same ones the key resolver uses, so Settings and the resolver cannot disagree.
 */
import {
  chordId,
  conflicts,
  createAppRegistry,
  formatChord,
  keyPrefsFromUi,
  parseChord,
  type KeymapIssue,
  type UiKeyFields,
} from '../../commands';
import type { KeyBinding, UiSettings } from '../../data';

export type KeymapState = UiSettings['keymap'];
export type KeyFields = Pick<UiSettings, 'keymap' | 'singleKeys' | 'holdMs' | 'swipeDirection'>;

export const SHORTCUT_GROUPS = [
  'Lists and Home',
  'Reader',
  'Compose',
  'Ask',
  'Calendar',
  'Search',
  'Places',
  'Everywhere',
] as const;
export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number];

export interface ShortcutRow {
  readonly commandId: string;
  readonly label: string;
  readonly group: ShortcutGroup;
  /** Canonical chord ids ("meta+k", "e"), tap keys only. */
  readonly chords: readonly string[];
  /** The owner changed it: Reset shows. */
  readonly changed: boolean;
  /** Its keys are taken by another command: "Same keys as …". */
  readonly conflictWith?: { readonly commandId: string; readonly label: string };
}

const PLACES_EXCLUDED = new Set(['nav.search', 'nav.today', 'nav.skipToList', 'nav.skipToReader']);

function groupOf(id: string, contexts: readonly string[]): ShortcutGroup {
  if (contexts.includes('global')) {
    return id.startsWith('nav.') && !PLACES_EXCLUDED.has(id) ? 'Places' : 'Everywhere';
  }
  if (contexts.some(c => c === 'list' || c === 'home' || c === 'done' || c === 'oneByOne'))
    return 'Lists and Home';
  if (contexts.includes('reader')) return 'Reader';
  if (contexts.includes('compose')) return 'Compose';
  if (contexts.includes('ask')) return 'Ask';
  if (contexts.includes('calendar')) return 'Calendar';
  if (contexts.includes('search')) return 'Search';
  return 'Everywhere';
}

function prefsOf(ui: KeyFields) {
  return keyPrefsFromUi(ui as UiKeyFields);
}

/** A command's tap chords as the registry has them, de-duplicated across contexts, in catalog order. */
function tapChords(registry: ReturnType<typeof createAppRegistry>, id: string): string[] {
  const out: string[] = [];
  for (const b of registry.keysFor(id)) {
    if (b.phase !== 'tap') continue;
    const c = chordId(b.chord);
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

function entryChord(e: KeyBinding | string): string {
  const text = typeof e === 'string' ? e : e.chord;
  try {
    return chordId(parseChord(text));
  } catch {
    return text;
  }
}

const labelOf = (registry: ReturnType<typeof createAppRegistry>, id: string): string => {
  const entry = registry.get(id);
  return entry ? entry.spec.label : id;
};

export interface ShortcutGroupModel {
  readonly group: ShortcutGroup;
  readonly rows: readonly ShortcutRow[];
}

/** Every remappable command, grouped, with its effective keys, whether it changed and any clash it has at rest. */
export function shortcutGroups(ui: KeyFields): readonly ShortcutGroupModel[] {
  const registry = createAppRegistry(prefsOf(ui));
  const defaults = createAppRegistry(prefsOf({ ...ui, keymap: {} }));
  const issues = registry.keymapIssues;
  const ids: string[] = [];
  for (const b of defaults.bindings())
    if (b.phase === 'tap' && !ids.includes(b.commandId)) ids.push(b.commandId);

  const rows: ShortcutRow[] = [];
  for (const id of ids) {
    const entry = defaults.get(id);
    if (!entry || entry.kind !== 'command') continue;
    const stored = ui.keymap[id];
    const clash = issues.find(
      i =>
        i.commandId === id &&
        (i.reason === 'conflict' || i.reason === 'shadowed') &&
        i.with?.length,
    );
    const other = clash?.with?.[0];
    rows.push({
      commandId: id,
      label: entry.spec.label,
      group: groupOf(id, entry.spec.contexts),
      chords: stored ? stored.map(entryChord) : tapChords(registry, id),
      changed: stored !== undefined,
      ...(other ? { conflictWith: { commandId: other, label: labelOf(registry, other) } } : {}),
    });
  }
  return SHORTCUT_GROUPS.map(group => ({
    group,
    rows: rows.filter(r => r.group === group),
  })).filter(g => g.rows.length > 0);
}

/** What pressing a chord while recording does. */
export type ChordVerdict =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'conflict';
      readonly with: { readonly commandId: string; readonly label: string };
    }
  | { readonly kind: 'refused'; readonly text: string };

const REFUSED: Partial<Record<KeymapIssue['reason'], (chord: string) => string>> = {
  reserved: c =>
    `${c} belongs to macOS or edits text, so it can’t be a shortcut. Press other keys.`,
  invalidChord: c => `${c} can’t be a shortcut. Press other keys.`,
  invalidEntry: c => `${c} can’t be a shortcut. Press other keys.`,
};

/** The command's keys after remapping its first key to `chord` (the rest stay). */
export function remapChords(current: readonly string[], chord: string): string[] {
  return [chord, ...current.slice(1).filter(c => c !== chord)];
}

/** Judges `chord` for `commandId` against the whole catalog, with the registry's own checks. */
export function judgeChord(commandId: string, chord: string, ui: KeyFields): ChordVerdict {
  const rows = shortcutGroups(ui).flatMap(g => g.rows);
  const current = rows.find(r => r.commandId === commandId)?.chords ?? [];
  const candidate: KeymapState = {
    ...ui.keymap,
    [commandId]: remapChords(current, chord).map(c => ({ chord: c })),
  };
  const issues = conflicts(candidate, prefsOf(ui)).filter(i => i.commandId === commandId);
  if (issues.length === 0) return { kind: 'ok' };
  const shown = (() => {
    try {
      return formatChord(parseChord(chord));
    } catch {
      return chord;
    }
  })();
  const refused = issues.find(i => REFUSED[i.reason]);
  if (refused) return { kind: 'refused', text: REFUSED[refused.reason]!(shown) };
  const clash = issues.find(
    i => (i.reason === 'conflict' || i.reason === 'shadowed') && i.with?.length,
  );
  if (clash?.with) {
    const registry = createAppRegistry();
    return {
      kind: 'conflict',
      with: { commandId: clash.with[0], label: labelOf(registry, clash.with[0]) },
    };
  }
  return { kind: 'ok' };
}

function sameChords(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

/** Sets a command's keys; an override equal to the defaults is dropped, so the store holds overrides only. */
function setKeys(
  ui: KeyFields,
  keymap: KeymapState,
  commandId: string,
  chords: readonly string[],
): KeymapState {
  const defaults = createAppRegistry(prefsOf({ ...ui, keymap: {} }));
  const next: Record<string, KeyBinding[]> = { ...keymap };
  if (sameChords(chords, tapChords(defaults, commandId))) delete next[commandId];
  else next[commandId] = chords.map(c => ({ chord: c }));
  return next;
}

/**
 * The keymap after the owner confirms `chord` for `commandId`. With `replace`, the other command gives the chord up
 * (it keeps its other keys, or none). Overrides only.
 */
export function applyRemap(
  ui: KeyFields,
  commandId: string,
  chord: string,
  replace?: { readonly commandId: string },
): KeymapState {
  const rows = shortcutGroups(ui).flatMap(g => g.rows);
  const chordsOf = (id: string) => rows.find(r => r.commandId === id)?.chords ?? [];
  let next = setKeys(ui, ui.keymap, commandId, remapChords(chordsOf(commandId), chord));
  if (replace) {
    next = setKeys(
      ui,
      next,
      replace.commandId,
      chordsOf(replace.commandId).filter(c => c !== chord),
    );
  }
  return next;
}

/** Reset one command, or all of them. */
export function resetKeys(keymap: KeymapState, commandId?: string): KeymapState {
  if (!commandId) return {};
  const { [commandId]: _gone, ...rest } = keymap;
  return rest;
}

/** The recording row's state, owned by the screen's view state. */
export interface Recording {
  readonly commandId: string;
  readonly state: 'recording' | 'conflict';
  readonly pendingChord?: string;
  readonly conflictWith?: { readonly commandId: string; readonly label: string };
  /** A refused chord: the sentence under the row. */
  readonly refused?: string;
}

/** "Done is now L" for the toast and the undo line. */
export function remapLabel(label: string, chord: string): string {
  return `${label} is now ${formatChord(parseChord(chord))}`;
}

export const SINGLE_KEY_LINE = 'Letters like E and L act on their own. Off turns them off.';
export const SINGLE_KEY_OFF_TOAST = 'Single-key shortcuts are off. ⌘K still finds every action.';
export const SINGLE_KEY_ON_TOAST = 'Single-key shortcuts are on';
export const RESET_ALL_TOAST = 'Every shortcut is back to its default';
