// Key-hint mode for the list and reader stand-in buttons (DESIGN §8 Discoverability).
// buttons-keys owns the real context (ui/buttons-keys/keyHints.tsx, KeyHintsContextValue). It is not on this
// branch yet, so this is a private context of the same shape and default. When the stand-in Action is swapped for
// buttons-keys' Button + Kbd, this file goes away and the shell's one provider drives every keycap.

import { createContext, useContext } from 'react';
import type { KeyHint, KeyHintsContextValue, ShowKeysMode } from '../../props';

const DEFAULT_HINTS: KeyHintsContextValue = { showKeys: 'tooltips' };

/** Same shape and default as buttons-keys' KeyHintsContext; the shell provides the mode. */
export const ListKeyHintsContext = createContext<KeyHintsContextValue>(DEFAULT_HINTS);

/** The current key-hint mode. */
export function useShowKeys(): ShowKeysMode {
  return useContext(ListKeyHintsContext).showKeys;
}

/** An inline keycap: 'always' always, 'hint' only with "Show all key hints", 'tooltip' never. */
export function showsInline(hint: KeyHint | undefined, mode: ShowKeysMode): boolean {
  if (hint === 'always') return true;
  if (hint === 'hint') return mode === 'all';
  return false;
}
