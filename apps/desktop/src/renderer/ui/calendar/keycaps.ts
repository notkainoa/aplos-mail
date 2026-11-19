/**
 * Keycaps for the calendar family, read from the command registry (DESIGN 8): never typed by hand where a
 * command id exists. A literal key (`LiteralKey`) is allowed only where DESIGN names one.
 *
 * The default registry here shows catalog keys. When the shell provides its own registry (with the user's
 * remaps) through the key-hints context, swap `keycapOf` to read it.
 */
import { createAppRegistry, formatBinding, type Registry } from '../../commands';
import type { CommandId } from '../props';

let registry: Registry | undefined;

/** The first binding of a command as a keycap ("Y", "⌃6", "Hold R"), or undefined when unbound or unknown. */
export function keycapOf(id: CommandId): string | undefined {
  registry ??= createAppRegistry();
  const binding = registry.keysFor(id)[0];
  return binding ? formatBinding(binding) : undefined;
}
