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

/** Each section laid over its default: a section the document lacks is the default, a field it lacks is too. */
export function withDefaults(stored: Doc): Settings {
  const base = defaultSettings() as unknown as Record<string, Doc>;
  const out: Record<string, Doc> = {};
  for (const section of Object.keys(base)) {
    const mine = stored[section];
    out[section] = { ...base[section], ...(isObject(mine) ? mine : {}) };
  }
  return out as unknown as Settings;
}

/** `patch` laid over the stored sections, section by section (a field named in the patch replaces that field whole). */
export function mergePatch(stored: Doc, patch: SettingsPatch): Doc {
  const next: Doc = { ...stored };
  for (const [section, fields] of Object.entries(patch)) {
    if (!isObject(fields)) continue;
    const mine = next[section];
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
