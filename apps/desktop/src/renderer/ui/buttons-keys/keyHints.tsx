// Key hints (DESIGN §8 Discoverability): where a keycap shows, and where its text comes from.
//
// Two providers, both mounted once by the shell:
// - KeyHintsProvider carries the app-wide mode ('tooltips' | 'held' | 'all') that props.ts exports as
//   KeyHintsContextValue. Hover never changes it.
// - CommandKeysProvider carries the registry's `describeKeys` ("E", "J or ↓", "Hold R"), so a control that is
//   given a `commandId` can print the real keycap. Without it, nothing is printed for a commandId; a literal
//   `keys` still shows.
import { createContext, createElement, useContext, type ReactNode } from 'react';
import type { CommandId, KeyHint, KeyHintsContextValue, LiteralKey, ShortcutChord, ShowKeysMode } from '../props';

const DEFAULT_HINTS: KeyHintsContextValue = { showKeys: 'tooltips' };

/** The app-wide key-hint mode. Default 'tooltips'. */
export const KeyHintsContext = createContext<KeyHintsContextValue>(DEFAULT_HINTS);

/** Provided once by the shell: `showKeys` is 'held' while ⌘ is down and 'all' with "Show all key hints". */
export function KeyHintsProvider({ value, children }: { value: KeyHintsContextValue; children: ReactNode }) {
  return createElement(KeyHintsContext.Provider, { value }, children);
}

/** Current key-hint mode. */
export function useKeyHints(): KeyHintsContextValue {
  return useContext(KeyHintsContext);
}

/** `registry.describeKeys` or an equivalent: "E", "J or ↓", "Hold R"; '' when unbound. */
export type DescribeKeys = (id: CommandId) => string;

/** Where keycap text comes from. Null until the shell provides the registry. */
export const CommandKeysContext = createContext<DescribeKeys | null>(null);

/** Provided once by the shell next to KeyHintsProvider: `<CommandKeysProvider describe={(id) => registry.describeKeys(id)}>`. */
export function CommandKeysProvider({ describe, children }: { describe: DescribeKeys; children: ReactNode }) {
  return createElement(CommandKeysContext.Provider, { value: describe }, children);
}

const ALTERNATIVE_SEPARATOR = ' or ';
const HOLD_PREFIX = 'Hold ';

/** Parses the registry's key text into alternatives: "J or ↓" gives two, "Hold R" gives one with `hold`. */
export function parseKeyText(text: string): ShortcutChord[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed.split(ALTERNATIVE_SEPARATOR).map((part) =>
    part.startsWith(HOLD_PREFIX) ? { chord: part.slice(HOLD_PREFIX.length), hold: true } : { chord: part },
  );
}

/** The keycaps of a control: a literal key where DESIGN requires one, otherwise the command's registry keys. */
export function useControlKeys(commandId?: CommandId, keys?: LiteralKey): ShortcutChord[] {
  const describe = useContext(CommandKeysContext);
  if (keys) return [{ chord: keys }];
  if (commandId && describe) return parseKeyText(describe(commandId));
  return [];
}

/** Whether a control's inline keycap shows: 'always' always, 'hint' only in "Show all key hints", 'tooltip' never (default). */
export function showsInline(hint: KeyHint | undefined, mode: ShowKeysMode): boolean {
  if (hint === 'always') return true;
  if (hint === 'hint') return mode === 'all';
  return false;
}

/** Whether a standalone Kbd renders for its `reveal`: 'always' always, 'hint' in "all" mode, 'badge' while ⌘ is held. Never hover. */
export function revealVisible(reveal: 'always' | 'hint' | 'badge', mode: ShowKeysMode): boolean {
  if (reveal === 'always') return true;
  if (reveal === 'hint') return mode === 'all';
  return mode === 'held';
}
