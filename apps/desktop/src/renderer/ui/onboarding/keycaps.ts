/**
 * Keycaps for the onboarding family, read from the command registry (DESIGN 8). A literal key (`LiteralKey`) is
 * allowed only where DESIGN names one: Return and Esc here. The default registry shows catalog keys; when the
 * shell provides its own registry (with the user's remaps) through the key-hints context, swap `keycapOf`.
 */
import { createAppRegistry, formatBinding, type Registry } from '../../commands';
import type { CommandId, StepButton } from '../props';

let registry: Registry | undefined;

/** The first binding of a command as a keycap ("Y", "⌃6", "Hold R"), or undefined when unbound or unknown. */
export function keycapOf(id: CommandId): string | undefined {
  registry ??= createAppRegistry();
  const binding = registry.keysFor(id)[0];
  return binding ? formatBinding(binding) : undefined;
}

/** The keycap a step button wears: its literal key, else its command's. */
export function keycapOfButton(button: Pick<StepButton, 'keys' | 'commandId'>): string | undefined {
  return button.keys ?? (button.commandId ? keycapOf(button.commandId) : undefined);
}
