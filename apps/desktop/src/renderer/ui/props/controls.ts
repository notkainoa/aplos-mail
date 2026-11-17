import type { Ref } from 'react';
import type { CommandId, IconName, LiteralKey, TagColor } from './shared';

/* ───────────────────────── controls ───────────────────────── */

/** On/off switch, 30 × 18, thumb on `--spring-thumb` (DESIGN §6 Switch). Mockups: settings-*.html, onboarding-permissions.html. Plain + refines: ui-foundation. */
export interface SwitchProps {
  /** On. */
  checked: boolean;
  /** Toggled. */
  onChange: (checked: boolean) => void;
  /** Required accessible name (DESIGN §11.3); or set `labelledBy`. */
  label: string;
  /** DOM id of a visible label (a SettingRow's label); overrides `label` as the name. */
  labelledBy?: string;
  /** Disabled. */
  disabled?: boolean;
  /** Tooltip explaining why it is disabled. */
  disabledReason?: string;
}

/** Checkbox with a `--control-edge` ring (DESIGN §4.1, §6 Checkbox). Mockups: inbox.html (bulk pick mark). Plain + refines: ui-foundation. */
export interface CheckboxProps {
  /** Checked, unchecked or mixed. */
  checked: boolean | 'mixed';
  /** Toggled. */
  onChange: (checked: boolean) => void;
  /** Required accessible name. */
  label: string;
  /** Show the label beside the box. Default true. */
  labelVisible?: boolean;
  /** Disabled. */
  disabled?: boolean;
}

/** The six account colours as a radio group of swatches, the selected one with a check; names are fixed copy "Sky", "Hill", "Stamp", "Dusk", "Sand", "Ember" (DESIGN §4.2). Mockups: settings-accounts.html (Colour row). Plain: ui-foundation; refines: ui-settings. */
export interface SwatchPickerProps {
  /** Accessible name of the radiogroup, e.g. "Colour". */
  label: string;
  /** DOM id of a visible label (a SettingRow's label); overrides `label` as the name. */
  labelledBy?: string;
  /** Selected colour. */
  value: TagColor;
  /** A colour was chosen (click, arrows, Space). */
  onChange: (color: TagColor) => void;
  /** Disabled. */
  disabled?: boolean;
}

/** A text field: `--sunken` fill, calm `--line-strong` ring at rest (decision 20), `--control-edge` under Increase Contrast (DESIGN §6 TextField, §11.1). Mockups: onboarding-accounts.html, onboarding-ai.html, settings-ai.html, shortcuts.html (filter). Plain + refines: ui-foundation. */
export interface TextFieldProps {
  /** DOM id. */
  id: string;
  /** Value. */
  value: string;
  /** Value changed. */
  onChange: (value: string) => void;
  /** Required accessible name. */
  label: string;
  /** Show the label above the field. Default false (placeholder-led fields keep the name for assistive tech). */
  labelVisible?: boolean;
  /** Placeholder in `--dim`. */
  placeholder?: string;
  /** Input type; 'password' for keys and app passwords (characters never shown back). */
  type?: 'text' | 'email' | 'password' | 'url' | 'search';
  /** 'md' 32 px; 'lg' 40 px (onboarding). Default 'md'. */
  size?: 'md' | 'lg';
  /** Leading icon. */
  icon?: IconName;
  /** Trailing literal keycap, e.g. Return on the onboarding address field. */
  trailingKeys?: LiteralKey;
  /** Mono text for addresses and server URLs (DESIGN §4.3). */
  mono?: boolean;
  /** One plain sentence under the field; also sets `aria-invalid`. */
  error?: string;
  /** Disabled. */
  disabled?: boolean;
  /** Read-only. */
  readOnly?: boolean;
  /** Return pressed (not during IME composition). */
  onSubmit?: () => void;
  /** Focus on mount. */
  autoFocus?: boolean;
  /** Element ref. */
  ref?: Ref<HTMLInputElement>;
}

/** One alternative chord in the sheet; `hold` renders the plain word "hold" before it. */
export interface ShortcutChord {
  /** Display chord, e.g. "J", "⌘K". */
  chord: string;
  /** "hold R". */
  hold?: boolean;
}

/** One sheet entry, generated from the registry. */
export interface ShortcutEntry {
  /** Command. */
  commandId: CommandId;
  /** Label. */
  label: string;
  /** Alternatives, joined with "or". */
  alternatives: readonly ShortcutChord[];
  /** A short qualifier when several commands share the key ("while queued"). */
  note?: string;
}

/** One context block, e.g. "Global", "Lists". */
export interface ShortcutGroup {
  /** Stable id. */
  id: string;
  /** Context label. */
  label: string;
  /** Entries. */
  entries: readonly ShortcutEntry[];
}

/** The shortcut sheet: generated from the registry; three columns at a fixed height that scrolls; alternatives joined with "or"; columns keep their places while filtering (DESIGN §6 ShortcutSheet, §8). In a Dialog. Mockups: shortcuts.html (default, filtered). Plain + refines: ui-foundation. */
export interface ShortcutSheetProps {
  /** Whether it is shown. */
  open: boolean;
  /** All groups. */
  groups: readonly ShortcutGroup[];
  /** Group ids per column, three columns. */
  columns: readonly [readonly string[], readonly string[], readonly string[]];
  /** Filter text. */
  query: string;
  /** Filter changed. */
  onQueryChange: (value: string) => void;
  /** Esc (clears the filter first), ? again, close button or scrim. */
  onClose: () => void;
}
