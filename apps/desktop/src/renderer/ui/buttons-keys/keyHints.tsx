// Key hints (DESIGN §8 Discoverability): where a keycap shows, and where its text comes from.
//
// Two providers, both mounted once by the shell:
// - KeyHintsProvider carries the app-wide mode ('tooltips' | 'held' | 'all') that props.ts exports as
//   KeyHintsContextValue. Hover never changes it. 'all' WINS over 'held': while "Show all key hints" is on the
//   shell keeps 'all' even when ⌘ goes down (use resolveShowKeys), otherwise every inline keycap would unmount
//   and the buttons would shrink the moment ⌘ is pressed.
// - CommandKeysProvider carries the registry's `describeKeys` ("E", "J or ↓", "Hold R"), so a control that is
//   given a `commandId` can print the real keycap. Without it, nothing is printed for a commandId; a literal
//   `keys` still shows. The shell passes the CURRENT context stack (`stack`), so a tooltip only advertises keys
//   that work on the current screen (arrow triage is Home, one by one and the reader, not the All mail list).
//   Without a stack the registry lists every context's bindings, which is wrong on screen.
import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react';
import type { ContextName } from '../../commands';
import type {
  CommandId,
  KeyHint,
  KeyHintsContextValue,
  LiteralKey,
  ShortcutChord,
  ShowKeysMode,
} from '../props';

const DEFAULT_HINTS: KeyHintsContextValue = { showKeys: 'tooltips' };

/**
 * The one key-label convention: modifier chords and the bare key use the return glyph ("↩", "⌘↩", "⇧↩"); only Space,
 * Esc and Tab are words. The registry and `LiteralKey` say "Return" (the key's name); every keycap and tooltip draws it
 * through this.
 */
export function displayChord(chord: string): string {
  return chord.replace(/Return$/, '↩');
}

/** The app-wide key-hint mode. Default 'tooltips'. */
export const KeyHintsContext = createContext<KeyHintsContextValue>(DEFAULT_HINTS);

/** The mode the shell provides: 'all' while "Show all key hints" is on (it wins over ⌘), else 'held' while ⌘ is down, else 'tooltips'. */
export function resolveShowKeys(state: { all: boolean; held: boolean }): ShowKeysMode {
  return state.all ? 'all' : state.held ? 'held' : 'tooltips';
}

/** Provided once by the shell; compute `showKeys` with resolveShowKeys so 'all' wins over 'held'. */
export function KeyHintsProvider({
  value,
  children,
}: {
  value: KeyHintsContextValue;
  children: ReactNode;
}) {
  return createElement(KeyHintsContext.Provider, { value }, children);
}

/** Current key-hint mode. */
export function useKeyHints(): KeyHintsContextValue {
  return useContext(KeyHintsContext);
}

/** `registry.describeKeys` or an equivalent: "E", "J or ↓", "Hold R"; '' when unbound. `stack` is the current context stack; undefined means every context. */
export type DescribeKeys = (id: CommandId, stack?: readonly ContextName[]) => string;

/** What the controls call: `describeKeys` already closed over the current stack. */
type DescribeCurrent = (id: CommandId) => string;

/** Where keycap text comes from. Null until the shell provides the registry. */
export const CommandKeysContext = createContext<DescribeCurrent | null>(null);

/**
 * Provided once by the shell next to KeyHintsProvider:
 * `<CommandKeysProvider describe={(id, stack) => registry.describeKeys(id, stack)} stack={contextStack}>`.
 * Pass the current context stack and re-render the provider when it changes; without `stack` every context's
 * bindings are listed ("E or →" on All mail, where → does nothing).
 */
export function CommandKeysProvider({
  describe,
  stack,
  children,
}: {
  describe: DescribeKeys;
  stack?: readonly ContextName[];
  children: ReactNode;
}) {
  const value = useMemo<DescribeCurrent>(() => id => describe(id, stack), [describe, stack]);
  return createElement(CommandKeysContext.Provider, { value }, children);
}

const ALTERNATIVE_SEPARATOR = ' or ';
const HOLD_PREFIX = 'Hold ';

/** Parses the registry's key text into alternatives: "J or ↓" gives two, "Hold R" gives one with `hold`. */
export function parseKeyText(text: string): ShortcutChord[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed
    .split(ALTERNATIVE_SEPARATOR)
    .map(part =>
      part.startsWith(HOLD_PREFIX)
        ? { chord: part.slice(HOLD_PREFIX.length), hold: true }
        : { chord: part },
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
