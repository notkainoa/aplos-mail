// Keycaps and tooltip text from the CommandRegistry (DESIGN §8). A component never writes a keycap by hand
// where a command id exists. `useKeycapFor` prefers the shell's configured registry (remaps, the swipe-direction
// swap and the current context stack all show); where no `CommandKeysProvider` is mounted (the gallery, tests,
// previews) it falls back to a default registry over the catalog, which knows only the default keys.

import { useContext } from 'react';
import { createAppRegistry, formatChord, type Registry } from '../../../commands';
import { CommandKeysContext, parseKeyText } from '../../buttons-keys/keyHints';
import type { CommandId, LiteralKey } from '../../props';

let registry: Registry | null = null;

function appRegistry(): Registry | null {
  try {
    registry ??= createAppRegistry();
    return registry;
  } catch {
    return null;
  }
}

/** The main keycap for a command: its first tap binding ("→", "Space", "⌥↑"); '' when unbound or unknown. */
export function keycapFor(
  id: CommandId | undefined,
  from: Registry | null = appRegistry(),
): string {
  if (!id) return '';
  const binding = from?.keysFor(id).find(b => b.phase === 'tap');
  return binding ? formatChord(binding.chord) : '';
}

/**
 * The keycap as `keycapFor`, from the registry the shell mounted when it is reachable. The context's `describe`
 * is closed over the current context stack, so the cap names a key that works here (→ on Home, E in a plain
 * list), follows remaps and follows the swipe direction. Without a provider the default registry answers.
 */
export function useKeycapFor(id: CommandId | undefined): string {
  const describe = useContext(CommandKeysContext);
  if (!id) return '';
  if (describe) return parseKeyText(describe(id)).find(c => !c.hold)?.chord ?? '';
  return keycapFor(id);
}

/** The keycap DESIGN requires literally (Return, ⇧Return, Esc, Tab). */
export function literalKeycap(key: LiteralKey): string {
  return key;
}

/** Tooltip text: label plus its key, e.g. "Done · →". */
export function tooltipText(label: string, id?: CommandId, literal?: LiteralKey): string {
  const key = literal ? literalKeycap(literal) : keycapFor(id);
  return key ? `${label} · ${key}` : label;
}
