import type { Settings, SettingsPatch } from '@aplos/contract';
import { StoreError, type CommitExtension, type CommitExtensionTx } from '../store/port';
import type { LaneModuleSource } from './services';

// The settings singleton (`Settings/get|set`): one JSON document in `settings` (id 1), written only through commits. The
// document may be PARTIAL (the image allow-list writer in `mail/allow-list.ts` touches `mail.imageAllowList` alone): a
// read lays the stored sections over the defaults, section by section, and a write merges a patch the same way.

type Doc = Record<string, unknown>;
const isObject = (value: unknown): value is Doc =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** First-run settings (the contract's sections). Groq is the default for every AI feature. */
export function defaultSettings(): Settings {
  const groq = (model: string) => ({ provider: 'groq', model });
  return {
    ui: {
      theme: 'system',
      density: 'default',
      keyHints: 'tooltip',
      singleKeys: true,
      holdMs: 250,
      dock: { open: false, tab: 'ask' },
      keymap: {},
      sidebarMinimised: false,
      swipe: true,
      swipeDirection: 'doneRight',
      zen: false,
      sendSound: true,
      devDetails: false,
      lastAccount: 'all',
      palette: { recents: [] },
      calendar: {},
    },
    mail: {
      undoSendSeconds: 8,
      followUpDays: 3,
      remoteImages: 'block',
      imageAllowList: [],
      doneAction: 'archive',
      laterAction: 'read',
      lowAction: 'archive',
      defaultReply: 'reply',
      signature: '',
      signatureMode: 'new',
      footer: false,
      autoPolish: false,
    },
    notifications: { enabled: true, perAccount: {}, reminders: true, reconnectReminder: false },
    host: { menuBar: true, openAtLogin: false, microphone: 'default' },
    retention: { bodyDays: 90, maxBodyBytes: 2 * 1024 ** 3 },
    calendar: { autoAddPlans: false, providerEventsFromMail: true },
    ai: {
      features: {
        ask: groq('openai/gpt-oss-120b'),
        summaries: groq('openai/gpt-oss-120b'),
        drafts: groq('openai/gpt-oss-120b'),
        plans: groq('openai/gpt-oss-120b'),
        voice: groq('whisper-large-v3-turbo'),
      },
      providers: {},
      background: true,
      dailyCap: { enabled: true, tokens: 150_000 },
    },
  };
}

/** The stored document, or empty: an unreadable row reads as no settings, never as a failed call. */
export function parseStored(data: string | undefined): Doc {
  if (data === undefined) return {};
  try {
    const doc: unknown = JSON.parse(data);
    return isObject(doc) ? doc : {};
  } catch {
    return {};
  }
}

/** The few enum fields (their values from the contract); a stored value outside the set reads as the default. */
const ENUMS: Readonly<Record<string, readonly string[]>> = {
  'ui.theme': ['light', 'dark', 'system'],
  'ui.density': ['compact', 'default', 'roomy'],
  'ui.keyHints': ['tooltip', 'always'],
  'ui.dock.tab': ['ask', 'today'],
  'ui.swipeDirection': ['doneRight', 'doneLeft'],
  'mail.remoteImages': ['block', 'allow'],
  'mail.doneAction': ['archive', 'read', 'unread'],
  'mail.laterAction': ['archive', 'read', 'unread'],
  'mail.lowAction': ['archive', 'read', 'unread'],
  'mail.defaultReply': ['reply', 'replyAll'],
  'mail.signatureMode': ['always', 'new', 'never'],
};

/** Optional fields the defaults do not carry, by path; each is kept when it is of the named type. */
const OPTIONAL_NUMBERS: ReadonlySet<string> = new Set(['ui.dock.width']);
const OPTIONAL_STRINGS: ReadonlySet<string> = new Set(['calendar.defaultCalendarId']);

/**
 * `value` read as the shape of `fallback`: a field of the wrong type, an enum value outside its set or a non-object
 * where an object belongs is the fallback, and a key the defaults do not know is dropped. The engine bundles no schema,
 * so this is what keeps `Settings/get` valid after a downgrade, a hand edit or a damaged row. An empty default object
 * is a free-form record (keymap, per-account flags, providers): kept as stored when it is an object.
 */
function coerce(path: string, fallback: unknown, value: unknown): unknown {
  if (Array.isArray(fallback)) return Array.isArray(value) ? value : fallback;
  if (isObject(fallback)) {
    if (Object.keys(fallback).length === 0) return isObject(value) ? value : fallback;
    const source = isObject(value) ? value : {};
    const out: Doc = {};
    for (const key of Object.keys(fallback))
      out[key] = coerce(`${path}.${key}`, fallback[key], source[key]);
    for (const key of Object.keys(source)) {
      const at = `${path}.${key}`;
      const value = source[key];
      if (OPTIONAL_NUMBERS.has(at) && typeof value === 'number') out[key] = value;
      if (OPTIONAL_STRINGS.has(at) && typeof value === 'string' && value !== '') out[key] = value;
    }
    return out;
  }
  if (typeof fallback === 'string') {
    if (typeof value !== 'string') return fallback;
    const allowed = ENUMS[path];
    return allowed && !allowed.includes(value) ? fallback : value;
  }
  if (typeof fallback === 'number')
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  if (typeof fallback === 'boolean') return typeof value === 'boolean' ? value : fallback;
  return fallback;
}

/** Each section read as its default's shape (`coerce`): a section the document lacks is the default, a field it lacks is too. */
export function withDefaults(stored: Doc): Settings {
  const base = defaultSettings() as unknown as Record<string, Doc>;
  const out: Record<string, unknown> = {};
  for (const section of Object.keys(base))
    out[section] = coerce(section, base[section], stored[section]);
  return out as unknown as Settings;
}

/** The sections the document has; a patch key outside them (`__proto__`, `constructor`, anything new) is ignored. */
const SECTIONS: ReadonlySet<string> = new Set(Object.keys(defaultSettings()));

/** `patch` laid over the stored sections, section by section (a field named in the patch replaces that field whole). */
export function mergePatch(stored: Doc, patch: SettingsPatch): Doc {
  const next: Doc = { ...stored };
  for (const section of Object.keys(patch)) {
    if (!SECTIONS.has(section)) continue;
    const fields = (patch as unknown as Doc)[section];
    if (!isObject(fields)) continue;
    const mine = next[section];
    // Spread defines own data properties, so a field named `__proto__` cannot reach a prototype.
    next[section] = { ...(isObject(mine) ? mine : {}), ...fields };
  }
  return next;
}

/** One `settings` write: sections of fields to change. The transport has validated them against the contract. */
export interface SettingsWrite {
  kind: 'settings';
  patch: SettingsPatch;
}

declare module '../store/port' {
  interface ExtensionWrites {
    settings: SettingsWrite;
  }
}

function apply(write: { kind: string }, tx: CommitExtensionTx): void {
  const { patch } = write as SettingsWrite;
  if (!isObject(patch)) throw new StoreError('invalid', 'A settings change is sections of fields');
  const row = tx.get<{ data: string }>('SELECT data FROM settings WHERE id = 1');
  const next = JSON.stringify(mergePatch(parseStored(row?.data), patch));
  // Nothing changed (an empty patch, the same values): no write and no change row, so no window is told to reload.
  if (row && JSON.stringify(parseStored(row.data)) === next) return;
  tx.run(
    'INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
    next,
  );
  tx.mark('Settings', 'settings', 'u');
}

export const settingsExtension: CommitExtension = {
  lane: 'eng-contract',
  kinds: ['settings'],
  changeTypes: ['Settings'],
  apply,
};

/** Seam 1 for the composition root: the settings writer, no services of its own. */
export const settingsModule: LaneModuleSource = {
  lane: 'eng-contract',
  extensions: [settingsExtension],
  createModule: () => ({}),
};
