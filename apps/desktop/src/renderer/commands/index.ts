// Frozen F9 surface: the CommandRegistry interface and the context names.
// Screens import from here only; everything else in this folder is internal.

import { CONTEXT_BLOCKS, COMMANDS, CONTROLS } from './catalog';
import { createRegistry, type Registry } from './registry';
import type { KeyPrefs } from './types';

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
  PaletteGroup,
  Phase,
  Resolution,
  TargetSummary,
  UndoSpec,
} from './types';
// Every context name, the palette's group order, and default key prefs (250 ms hold, single keys on).
export { CONTEXT_NAMES, DEFAULT_KEY_PREFS, PALETTE_GROUPS } from './types';

// The static catalog of DESIGN §8: palette commands, widget controls, and per-context blocks.
export { COMMANDS, CONTROLS, CONTEXT_BLOCKS } from './catalog';

// Build the registry; screens attach run/when; the palette, tooltips and toasts read from it.
export { contextLine, createRegistry } from './registry';
export type { BindingConflict, KeymapIssue, PaletteEntry, Registry, RegistryEntry, RunResult } from './registry';

// The pure resolver, for the shell's capture listener; FOCUS_SCOPED_CONTEXTS are exempt from the single-key switch.
export { FOCUS_SCOPED_CONTEXTS, resolve } from './resolver';
export type { ResolveOptions } from './resolver';

// Chord helpers: normalize events, classify focus, and format keycaps ("⌘K", "J or ↓", "Hold R").
export {
  chordFromEvent,
  chordId,
  focusKindOf,
  formatAlternatives,
  formatBinding,
  formatChord,
  parseChord,
  snapshotKey,
} from './keys';
export type { KeySnapshot } from './keys';

// Tap versus hold: the tap runs on keydown, the tracker reports when a hold upgrades it.
export { createHoldTracker, DEFAULT_HOLD_THRESHOLD_MS } from './hold';
export type { HoldRelease, HoldTracker, HoldUpgrade } from './hold';

// Keys that arrive during a mount or transition wait here and drain in order next frame.
export { createKeyQueue } from './keyQueue';
export type { KeyQueue } from './keyQueue';

// The shortcut sheet model, generated from the registry.
export { buildSheet, SHEET_SECTIONS } from './sheet';
export type { SheetRow, SheetSection } from './sheet';

/** The app's registry over the full catalog, with the user's prefs applied. */
export function createAppRegistry(prefs?: KeyPrefs): Registry {
  return createRegistry(COMMANDS, { controls: CONTROLS, blocks: CONTEXT_BLOCKS, prefs });
}
