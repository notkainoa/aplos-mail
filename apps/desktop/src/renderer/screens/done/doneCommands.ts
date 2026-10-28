/**
 * The Done place's handlers on the CommandRegistry (DESIGN 7.4, 8): H moves a row back to Home, the cursor moves and
 * Return opens. E and L are not attached, and the registry's `done` context turns them off as well, so they do nothing
 * on a done row. A pure table, so the shell can read it without a component.
 */
import type { CommandHandlers } from '../../commands';
import type { ListActions } from '../lists/listActions';
import { navigationCommands } from '../lists/listCommands';
import { useCommandTable, type CommandTable, type Register } from '../lists/useCommandTable';

function run(action: () => void): CommandHandlers {
  return { run: () => action() };
}

export function commandsForDone(actions: ListActions): CommandTable {
  return {
    ...navigationCommands(actions),
    'done.moveToHome': run(() => actions.moveToHome()),
  };
}

/** Attaches Done's handlers; they detach when the screen unmounts. */
export function useDoneKeys(register: Register, actions: ListActions): void {
  useCommandTable(register, commandsForDone(actions));
}
