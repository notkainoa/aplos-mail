/**
 * Wires a toast's command action (Undo) to the command registry: the shell hands `setToastCommandRunner` the
 * function this returns, built from the registry and the context stack it currently shows.
 */
import { buildStack, DEFAULT_KEY_PREFS } from '../commands';
import type {
  CommandContext,
  CommandId,
  ContextName,
  KeyPrefs,
  Registry,
  TargetSummary,
} from '../commands';

/** The `CommandContext` a toast action runs in: the shell's stack, the current target, nothing selected. */
export function toastContext(
  stack: readonly ContextName[],
  target: TargetSummary | null,
  prefs: KeyPrefs = DEFAULT_KEY_PREFS,
): CommandContext {
  return { stack: buildStack(stack), target, selection: [], conditions: {}, prefs, focus: 'none' };
}

/** Runs a command id through the registry, reading the context at call time. */
export function toastCommandRunner(
  registry: Pick<Registry, 'run'>,
  context: () => CommandContext,
): (commandId: string) => unknown {
  return commandId => registry.run(commandId as CommandId, context());
}
