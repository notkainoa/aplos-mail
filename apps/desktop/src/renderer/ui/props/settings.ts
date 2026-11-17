import type { ReactNode } from 'react';
import type { Announce, CommandId, TagColor } from './shared';

/* ───────────────────────── settings ───────────────────────── */

/** A settings row: 40 px, or 48 px with a one-line description of what it does; hairline separators; a fixed control column (DESIGN §6 SettingRow, §7.10). Mockups: settings-*.html (settings.js row, disclosure). Plain + refines: ui-settings. */
export interface SettingRowProps {
  /** DOM id; the control is labelled by it. */
  id: string;
  /** Setting name. */
  label: string;
  /** What the setting does, `small` `--dim`. */
  description?: ReactNode;
  /** 'attention' shows the description with an alert icon in `--stamp-ink` (an account that needs reconnecting). */
  descriptionTone?: 'default' | 'attention';
  /** Quiet tag after the label, e.g. "Default". */
  tag?: string;
  /** Leading colour mark (account rows). */
  mark?: TagColor;
  /** Dim text after the label, e.g. the provider "Google". */
  meta?: string;
  /** The control: Switch, Puck, picker Button, TextField or Buttons. */
  control?: ReactNode;
  /** A folded row whose long text opens beneath it ("How your mail is used"). */
  disclosure?: { expanded: boolean; onToggle: () => void; content: ReactNode };
  /** A line under the row, e.g. an ErrorLine with placement 'settings'. */
  below?: ReactNode;
  /** The row's palette entry id, `setting.<section>.<rowAnchor>` (renderer/commands `registerSetting`); the row renders its anchor so ⌘K can scroll to it and focus the control (DESIGN §7.10 "Every setting is searchable from ⌘K"). */
  paletteId?: string;
}

/** AI features with a provider and model each (DESIGN §7.10 AI). */
export type AiFeature = 'ask' | 'summaries' | 'drafts' | 'plans' | 'voice';

/** Providers; display names are fixed copy: Groq, OpenAI, Claude, Gemini, OpenRouter, OpenCode Go, Ollama, LM Studio, Custom server (AGENTS.md). Matches @aplos/contract's aiProviderIds (freeze finding FR-1). */
export type ProviderId =
  | 'groq'
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'openrouter'
  | 'opencode-go'
  | 'ollama'
  | 'lmstudio'
  | 'custom';

/** Where a provider's key comes from; key characters are never shown (DESIGN §7.10). */
export type KeySource =
  | {
      /** "Key set on this Mac"; Remove is disabled with the reason in a tooltip. The variable name joins the line only with Developer details on. */
      kind: 'environment';
      /** Variable name; empty unless Developer details is on. */
      variable: string;
    }
  | {
      /** "Saved in Keychain". */
      kind: 'keychain';
    }
  | {
      /** "No key yet"; the row offers "Add key". The variable name joins the line only with Developer details on. */
      kind: 'none';
      /** Variable the engine would read; empty unless Developer details is on. */
      variable: string;
    }
  | {
      /** A model on this Mac: no key needed. */
      kind: 'local';
    };

/** A hosted provider's test status. */
export type ProviderStatus =
  | { kind: 'ready' }
  | { kind: 'needsKey' }
  /** A local server that is not running and has not been tested: a quiet --dim "Not running", never red (red follows a failed Test). */
  | { kind: 'notRunning' }
  | { kind: 'testing' }
  | {
      /** "Works · 0.4 s". */
      kind: 'works';
      /** Round trip in milliseconds; formatted by the component. */
      latencyMs: number;
    }
  | { kind: 'refused' }
  | { kind: 'unreachable' };

/** Actions on a provider row. */
export type ProviderAction = 'test' | 'remove' | 'addKey' | 'replaceKey';

/** The Settings → AI tables: Features first, then hosted providers, then "On this Mac and custom" (DESIGN §6 ProviderTable, §7.10). Mockups: settings-ai.html (default, testing). Plain + refines: ui-settings. */
export type ProviderTableProps =
  | {
      /** Ask, Summaries, Drafts, Plans, Voice, each with provider and model pickers; Voice lists only speech-to-text providers. */
      kind: 'features';
      /** One row per feature. */
      rows: readonly {
        feature: AiFeature;
        provider: ProviderId;
        model: string;
        providerOptions: readonly ProviderId[];
        /** The row's provider needs a key: a quiet "Needs a key" shows after the feature's name. */
        needsKey?: boolean;
        modelOptions: readonly string[];
        /** Display names for model ids ("GPT-OSS 120B"), where the provider's catalogue has one; an id without one shows as it is. */
        modelNames?: Readonly<Record<string, string>>;
      }[];
      /** A picker changed. */
      onChange: (feature: AiFeature, choice: { provider: ProviderId; model: string }) => void;
    }
  | {
      /** Hosted providers with status, key source, Test and Remove or Add key; a refused key adds an ErrorLine below. */
      kind: 'hosted';
      /** One row per provider. */
      rows: readonly {
        provider: ProviderId;
        isDefault: boolean;
        keySource: KeySource;
        status: ProviderStatus;
      }[];
      /** A row action. */
      onAction: (provider: ProviderId, action: ProviderAction) => void;
    }
  | {
      /** Ollama, LM Studio and a custom server, each with an editable address and its default port; keys are optional (OLLAMA_API_KEY, LM_STUDIO_API_KEY, CUSTOM_AI_API_KEY). */
      kind: 'local';
      /** One row per server; `keySource` 'local' means no key is set and none is needed. */
      rows: readonly {
        provider: 'ollama' | 'lmstudio' | 'custom';
        address: string;
        defaultAddress: string;
        running?: boolean;
        keySource?: KeySource;
        status?: ProviderStatus;
      }[];
      /** Address edited. */
      onAddressChange: (provider: 'ollama' | 'lmstudio' | 'custom', address: string) => void;
      /** Test, Add key, Replace key or Remove on a local row. */
      onAction?: (provider: 'ollama' | 'lmstudio' | 'custom', action: ProviderAction) => void;
    };

/** One remappable shortcut row: keycaps, conflict marks, recording with Replace / Cancel, Reset when changed (DESIGN §6 KeyRecorder, §7.10 Keyboard, §11.4). Mockups: settings-keyboard.html (default, recording). Plain + refines: ui-settings. */
export interface KeyRecorderProps {
  /** Command being edited. */
  commandId: CommandId;
  /** Its label, e.g. "Done". */
  label: string;
  /** Current chords. */
  chords: readonly string[];
  /** Differs from the default: Reset shows. */
  changed: boolean;
  /** 'idle'; 'recording' = "Press the new keys · Esc to cancel"; 'conflict' = the pressed chord is taken. */
  state: 'idle' | 'recording' | 'conflict';
  /** The chord just pressed (conflict state). */
  pendingChord?: string;
  /** Who already uses the pending chord ("Already used by Later"), or an existing clash at rest ("Same keys as …"). */
  conflictWith?: { commandId: CommandId; label: string };
  /** Start recording (click on the keys). */
  onStart: () => void;
  /** A chord was captured (IME-safe, `event.key`, modifiers alone ignored, DESIGN §5 rule 16). */
  onChord: (chord: string) => void;
  /** Replace the other command's binding. */
  onReplace: () => void;
  /** Esc or Cancel. */
  onCancel: () => void;
  /** Back to the default. */
  onReset: () => void;
  /** Announces recording and conflicts (DESIGN §11.3). */
  announce?: Announce;
}
