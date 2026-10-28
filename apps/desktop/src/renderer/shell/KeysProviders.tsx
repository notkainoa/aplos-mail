/**
 * The key-hint providers the shell mounts once (ui README "Keys"): `KeyHintsProvider` (tooltips, ⌘ held, or all) and
 * `CommandKeysProvider` (the registry's `describeKeys`, closed over the current context stack). They only describe keys.
 * Binding keys is the registry's resolver and the key listener, which are not mounted here.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createAppRegistry, keyPrefsFromUi, type ContextName } from '../commands';
import { useSettings } from '../data';
import { CommandKeysProvider, KeyHintsProvider, resolveShowKeys } from '../ui/buttons-keys';
import type { Screen } from './index';

const META_KEY = 'Meta';

/** Whether ⌘ is down, for the held-key badges. Cleared when the window loses focus so it cannot stick. */
function useCommandHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === META_KEY) setHeld(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === META_KEY) setHeld(false);
    };
    const clear = () => setHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
    };
  }, []);
  return held;
}

/** The key context a screen puts on the stack, so tooltips list only keys that work there. */
export function screenContext(screen: Screen): ContextName | null {
  if (typeof screen !== 'string') return null;
  switch (screen) {
    case 'home':
    case 'done':
    case 'calendar':
    case 'settings':
      return screen;
    default:
      return 'list';
  }
}

/** Props for `KeysProviders`. */
export interface KeysProvidersProps {
  readonly screen: Screen;
  /** A sheet is open, so the modal `sheet` context is on top. */
  readonly sheetOpen: boolean;
  readonly children: ReactNode;
}

export function KeysProviders({ screen, sheetOpen, children }: KeysProvidersProps) {
  const ui = useSettings()?.ui;
  const held = useCommandHeld();
  const registry = useMemo(() => createAppRegistry(ui ? keyPrefsFromUi(ui) : undefined), [ui]);
  const context = screenContext(screen);
  const stack = useMemo<readonly ContextName[]>(() => {
    const base: ContextName[] = context ? ['global', context] : ['global'];
    return sheetOpen ? [...base, 'sheet'] : base;
  }, [context, sheetOpen]);
  const showKeys = resolveShowKeys({ all: ui?.keyHints === 'always', held });
  return (
    <KeyHintsProvider value={{ showKeys }}>
      <CommandKeysProvider describe={(id, from) => registry.describeKeys(id, from)} stack={stack}>
        {children}
      </CommandKeysProvider>
    </KeyHintsProvider>
  );
}
