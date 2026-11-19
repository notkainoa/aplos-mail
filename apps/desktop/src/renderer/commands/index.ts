// Frozen F9 surface: the CommandRegistry interface and the context names.
// Screens and the shell import from here only. Building blocks (createRegistry,
// the raw resolver, the catalog arrays) live in internal.ts.

// Vocabulary: ids, contexts, chords, specs, handlers, prefs, the resolver's answer.
export type {
  Binding,
  Command,
  CommandContext,
  CommandGroup,
  CommandHandlers,
  CommandId,
  CommandSpec,
  Condition,
  ConditionState,
  ConfirmSpec,
  ContextName,
  ContextStack,
  ControlSpec,
  FocusKind,
  IconName,
  KeyChord,
  KeyInput,
  KeyPrefs,
  KeySpec,
  Keymap,
  KeymapEntry,
  PaletteChild,
  PaletteGroup,
  Phase,
  Resolution,
  TargetKind,
  TargetSummary,
  UndoSpec,
} from './types';
// Every context name, the palette's group order, and default key prefs (250 ms hold, single keys on).
export { CONTEXT_NAMES, DEFAULT_KEY_PREFS, PALETTE_GROUPS } from './types';

// The app's registry over the whole catalog; screens attach run/when, the shell calls resolve and run.
export { createAppRegistry } from './catalog';
export { contextLine } from './registry';
export type {
  BindingConflict,
  KeymapIssue,
  PaletteEntry,
  Registry,
  RegistryEntry,
  RegistryErrorHandler,
  RunResult,
} from './registry';

// Settings rows in the palette: Settings' manifest registers each row at module load; a row's route is "settings/<section>#<row>".
export {
  parseSettingRoute,
  registerSetting,
  SETTING_SECTIONS,
  settingId,
  settingRoute,
} from './settings';
export type { SettingEntry, SettingRoute, SettingSection } from './settings';

// Normalizes the contexts the shell collects (route + data-keyctx) into a stack; which contexts are modal.
export { buildStack, isModal } from './stacks';

// Event helpers for the shell: classify focus, copy a keydown for the queue, the physical key of a hold.
export { focusKindOf, holdKeyOf, snapshotKey } from './keys';
export type { KeySnapshot } from './keys';

// Keycaps for Kbd, tooltips, the sheet and toasts ("⌘K", "J or ↓", "Hold R").
export { arrowsFirst, formatAlternatives, formatBinding, formatChord } from './keys';

// Keymap utilities for Settings → Keyboard and KeyRecorder (DESIGN §7.10, §11.4).
// parseChord reads a spec string ("meta+k"); chordFromEvent reads a keydown (IME-safe, Caps Lock ignored);
// chordId writes the canonical spec string a keymap stores; RESERVED_CHORDS and reservedReason name the
// chords no remap may take; conflicts(keymap) checks a whole keymap before it is saved; keyPrefsFromUi
// turns the stored Settings.ui fields into the registry's prefs.
export { chordFromEvent, chordId, parseChord, RESERVED_CHORDS, reservedReason } from './keys';
export { conflicts } from './catalog';
export { keyPrefsFromUi } from './prefs';
export type { UiKeyFields } from './prefs';

// Tap versus hold: the tap runs on keydown, the tracker reports the upgrade and swallows repeats.
export { createHoldTracker, DEFAULT_HOLD_THRESHOLD_MS } from './hold';
// Hold-release hook: pass the HoldRelease the tracker returns (up, cancel, interrupt, down) to `registry.release(release, ctx)`;
// it calls the `release(ctx, release)` handler a screen attached to the hold command. Dictation keeps what it heard only
// when `release.upgraded && release.ended === 'up'`; any other ending discards it.
export type { HoldEnd, HoldOptions, HoldRelease, HoldTracker, HoldUpgrade } from './hold';

// Command icons are SF names; `uiIconFor` gives the UI's closed icon for a PaletteItem or menu row.
export { UI_ICON_FOR_COMMAND, uiIconFor } from './icons';

// Keys that arrive during a mount or transition wait here and drain in order next frame.
export { createKeyQueue } from './keyQueue';
export type { KeyQueue } from './keyQueue';

// The shortcut sheet model, generated from the registry.
export { buildSheet } from './sheet';
export type { SheetRow, SheetSection } from './sheet';
