// Keycaps and tooltip text from the CommandRegistry (DESIGN §8). A component never writes a keycap by hand
// where a command id exists. Plain first version: one app registry over the catalog with default keys. When
// buttons-keys lands its Kbd/Tooltip (and the shell's configured registry with remaps), these calls move there.

import { createAppRegistry, formatChord, type Registry } from '../../../commands';
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

/** The main keycap for a command: its first tap binding ("E", "Space", "⌥↑"); '' when unbound or unknown. */
export function keycapFor(id: CommandId | undefined): string {
  if (!id) return '';
  const binding = appRegistry()
    ?.keysFor(id)
    .find((b) => b.phase === 'tap');
  return binding ? formatChord(binding.chord) : '';
}

/** The keycap DESIGN requires literally (Return, ⇧Return, Esc, Tab). */
export function literalKeycap(key: LiteralKey): string {
  return key;
}

/** Tooltip text: label plus its key, e.g. "Done · E". */
export function tooltipText(label: string, id?: CommandId, literal?: LiteralKey): string {
  const key = literal ? literalKeycap(literal) : keycapFor(id);
  return key ? `${label} · ${key}` : label;
}
