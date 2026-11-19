// Settings rows in the palette (DESIGN §7.10 "Every setting is searchable from ⌘K";
// plan 30 U7 acceptance 2). Settings' manifest calls registerSetting at module load,
// so its rows are in the palette's Settings group even while Settings is closed.
// Choosing one returns a route ("settings/mail#undoSeconds") for the shell to open;
// the Settings screen scrolls to the row and focuses its control.
import { copyProblem } from './copy';

/** The eight Settings sections, in nav order (DESIGN §7.10). */
export type SettingSection =
  'general' | 'mail' | 'calendar' | 'ai' | 'notifications' | 'accounts' | 'keyboard' | 'help';

/** Each section's nav label, in order. */
export const SETTING_SECTIONS: readonly { readonly id: SettingSection; readonly label: string }[] =
  [
    { id: 'general', label: 'General' },
    { id: 'mail', label: 'Mail' },
    { id: 'calendar', label: 'Calendar' },
    { id: 'ai', label: 'AI' },
    { id: 'notifications', label: 'Notifications' },
    { id: 'accounts', label: 'Accounts' },
    { id: 'keyboard', label: 'Keyboard' },
    { id: 'help', label: 'Help & about' },
  ];

/** A Settings deep link: a section, optionally with a row anchor. */
export type SettingRoute = `settings/${SettingSection}` | `settings/${SettingSection}#${string}`;

/**
 * One Settings row as a palette entry. `id` is always `setting.<section>.<rowAnchor>`;
 * the row's `SettingRow.paletteId` carries the same id, and its DOM anchor is `rowAnchor`.
 */
export interface SettingEntry {
  /** `setting.<section>.<rowAnchor>`, e.g. "setting.mail.undoSeconds". */
  readonly id: string;
  /** The row's label as Settings shows it, e.g. "Undo send". */
  readonly label: string;
  /** Its section. */
  readonly section: SettingSection;
  /** Extra words to match on, e.g. ["delay", "unsend"]. */
  readonly keywords?: readonly string[];
  /** The row's anchor in its section: letters, digits, "-" or "_", starting with a letter. */
  readonly rowAnchor: string;
  /**
   * Optional live check: false means the row is not drawn in the current state, so the palette does not offer it.
   * Absent means always offered. Read at listing time, never cached.
   */
  readonly available?: () => boolean;
}

/** A table of settings entries; the app has one (registerSetting), tests make their own. */
export interface SettingsTable {
  /** Adds an entry; re-registering an identical entry is a no-op (hot reload). Returns the remove function. Throws on a bad or clashing entry. */
  register(entry: SettingEntry): () => void;
  /** Every entry, in registration order. */
  list(): readonly SettingEntry[];
  /** One entry by id. */
  get(id: string): SettingEntry | undefined;
}

/** Every setting entry id starts with this; no command id may. */
export const SETTING_ID_PREFIX = 'setting.';

const ANCHOR = /^[A-Za-z][\w-]*$/;

/** The id a row's entry must have. */
export function settingId(section: SettingSection, rowAnchor: string): string {
  return `${SETTING_ID_PREFIX}${section}.${rowAnchor}`;
}

/** The deep link for a row: "settings/mail#undoSeconds". */
export function settingRoute(entry: Pick<SettingEntry, 'section' | 'rowAnchor'>): SettingRoute {
  return `settings/${entry.section}#${entry.rowAnchor}`;
}

/** Reads "settings/<section>" or "settings/<section>#<row>"; null for anything else. */
export function parseSettingRoute(
  route: string,
): { readonly section: SettingSection; readonly row?: string } | null {
  const match = /^settings\/([a-z]+)(?:#([A-Za-z][\w-]*))?$/.exec(route);
  if (!match) return null;
  const section = SETTING_SECTIONS.find(s => s.id === match[1])?.id;
  if (!section) return null;
  return match[2] ? { section, row: match[2] } : { section };
}

function sameEntry(a: SettingEntry, b: SettingEntry): boolean {
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.section === b.section &&
    a.rowAnchor === b.rowAnchor &&
    (a.keywords ?? []).join('\u0000') === (b.keywords ?? []).join('\u0000')
  );
}

function check(entry: SettingEntry): void {
  if (!SETTING_SECTIONS.some(s => s.id === entry.section))
    throw new Error(`${entry.id}: unknown section "${entry.section}"`);
  if (!ANCHOR.test(entry.rowAnchor))
    throw new Error(`${entry.id}: bad row anchor "${entry.rowAnchor}"`);
  if (entry.id !== settingId(entry.section, entry.rowAnchor)) {
    throw new Error(
      `${entry.id}: a setting id must be ${settingId(entry.section, entry.rowAnchor)}`,
    );
  }
  for (const text of [entry.label, ...(entry.keywords ?? [])]) {
    const problem = copyProblem(text);
    if (problem) throw new Error(`${entry.id}: ${problem}`);
  }
}

export function createSettingsTable(): SettingsTable {
  const entries = new Map<string, SettingEntry>();
  return {
    register(entry) {
      check(entry);
      const existing = entries.get(entry.id);
      if (existing && !sameEntry(existing, entry))
        throw new Error(`Duplicate setting id ${entry.id}`);
      const kept = existing ?? entry;
      entries.set(entry.id, kept);
      return () => {
        if (entries.get(entry.id) === kept) entries.delete(entry.id);
      };
    },
    list: () => [...entries.values()],
    get: id => entries.get(id),
  };
}

/** The app's settings table, read by createAppRegistry's palette. */
export const APP_SETTINGS: SettingsTable = createSettingsTable();

/** Registers one Settings row with the app's palette; call at module load from Settings' manifest. Returns the remove function. */
export function registerSetting(entry: SettingEntry): () => void {
  return APP_SETTINGS.register(entry);
}
