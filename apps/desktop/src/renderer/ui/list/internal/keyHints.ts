// Key-hint mode for the list and reader stand-in buttons (DESIGN §8 Discoverability).
// buttons-keys owns the real context (ui/buttons-keys/keyHints.tsx, KeyHintsContextValue). It is not on this
// branch yet, so this is a private context of the same shape and default. When the stand-in Action is swapped for
// buttons-keys' Button + Kbd, this file goes away and the shell's one provider drives every keycap.

import { createContext, useContext } from 'react';
import { KeyHintsContext } from '../../buttons-keys/keyHints';
import type { KeyHint, KeyHintsContextValue, ShowKeysMode } from '../../props';

const DEFAULT_HINTS: KeyHintsContextValue = { showKeys: 'tooltips' };

/** Same shape and default as buttons-keys' KeyHintsContext; a test sets it to force a mode. */
export const ListKeyHintsContext = createContext<KeyHintsContextValue>(DEFAULT_HINTS);

/**
 * The current key-hint mode: this context wins where a test sets it, otherwise the shell's one
 * `KeyHintsProvider` (⌘ held, "Show all key hints") drives the stand-in buttons too.
 */
export function useShowKeys(): ShowKeysMode {
  const own = useContext(ListKeyHintsContext).showKeys;
  const shared = useContext(KeyHintsContext).showKeys;
  return own !== 'tooltips' ? own : shared;
}

/** An inline keycap: 'always' always, 'hint' only with "Show all key hints", 'tooltip' never. */
export function showsInline(hint: KeyHint | undefined, mode: ShowKeysMode): boolean {
  if (hint === 'always') return true;
  if (hint === 'hint') return mode === 'all';
  return false;
}
