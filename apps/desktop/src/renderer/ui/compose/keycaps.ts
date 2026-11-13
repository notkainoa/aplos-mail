/**
 * Keycaps for the compose and ask families. The text always comes from the CommandRegistry (never hand-written where
 * a command id exists); this file only turns the registry's "⌘Return" into the "⌘↩" DESIGN §6 and §8 show on Send.
 *
 * Plain first implementation: it reads the default registry. When the shell provides the live registry (remaps,
 * swipe direction) through a context, only `keycapsFor` changes.
 */
import { createAppRegistry } from '../../commands';
import type { Registry } from '../../commands';
import type { CommandId } from '../props';
import { displayChord } from '../buttons-keys/keyHints';

let registry: Registry | undefined;

/** "⌘Return" becomes "⌘↩" and a bare "Return" "↩": the one key-label convention (see `displayChord`). */
export function displayKey(text: string): string {
  return displayChord(text);
}

/** The registry's text for a command exactly as it describes it ("⌘Return", "J or ↓"), for running copy such as "⌘Return sends now". */
export function describeKeys(commandId: CommandId): string {
  registry ??= createAppRegistry();
  return registry.describeKeys(commandId);
}

/** The registry's keycaps for a command, one string per alternative ("J or ↓" gives two); empty when unbound. */
export function keycapsFor(commandId: CommandId | undefined): string[] {
  if (!commandId) return [];
  registry ??= createAppRegistry();
  const text = registry.describeKeys(commandId);
  return text ? text.split(' or ').map(displayKey) : [];
}
