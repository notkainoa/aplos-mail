// Frozen F9 surface: the CommandRegistry interface and the context names.
// Screens and the shell import from here only. Building blocks (createRegistry,
// the raw resolver, chord parsing, the catalog arrays) live in internal.ts.

// Vocabulary: ids, contexts, chords, specs, handlers, prefs, the resolver's answer.
export type {
  Binding,
  Command,
  CommandContext,
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
  PaletteGroup,
  Phase,
  Resolution,
  TargetSummary,
  UndoSpec,
} from './types';
// Every context name, the palette's group order, and default key prefs (250 ms hold, single keys on).
export { CONTEXT_NAMES, DEFAULT_KEY_PREFS, PALETTE_GROUPS } from './types';

// The app's registry over the whole catalog; screens attach run/when, the shell calls resolve and run.
export { createAppRegistry } from './catalog';
export { contextLine } from './registry';
export type { BindingConflict, KeymapIssue, PaletteEntry, Registry, RegistryEntry, RegistryErrorHandler, RunResult } from './registry';

// Normalizes the contexts the shell collects (route + data-keyctx) into a stack.
export { buildStack } from './stacks';

// Event helpers for the shell: classify focus, copy a keydown for the queue, the physical key of a hold.
export { focusKindOf, holdKeyOf, snapshotKey } from './keys';
export type { KeySnapshot } from './keys';

// Keycaps for Kbd, tooltips, the sheet and toasts ("⌘K", "J or ↓", "Hold R").
export { formatAlternatives, formatBinding, formatChord } from './keys';

// Tap versus hold: the tap runs on keydown, the tracker reports the upgrade and swallows repeats.
export { createHoldTracker, DEFAULT_HOLD_THRESHOLD_MS } from './hold';
export type { HoldOptions, HoldRelease, HoldTracker, HoldUpgrade } from './hold';

// Keys that arrive during a mount or transition wait here and drain in order next frame.
export { createKeyQueue } from './keyQueue';
export type { KeyQueue } from './keyQueue';

// The shortcut sheet model, generated from the registry.
export { buildSheet } from './sheet';
export type { SheetRow, SheetSection } from './sheet';
