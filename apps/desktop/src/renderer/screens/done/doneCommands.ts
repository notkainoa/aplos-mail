/**
 * The Done place's handlers on the CommandRegistry (DESIGN 7.4, 8): H moves a row back to Home, the cursor moves and
 * Return opens. E and L are not attached, and the registry's `done` context turns them off as well, so they do nothing
 * on a done row. A pure table, so the shell can read it without a component.
 */
import { useMemo } from 'react';
import type { CommandHandlers } from '../../commands';
import { useRegisterCommands, type CommandHandlerTable } from '../../shell';
import type { ListActions } from '../lists/listActions';
import { navigationCommands, selectionCommands } from '../lists/listCommands';

function run(action: () => void): CommandHandlers {
  return { run: () => action() };
}

export function commandsForDone(actions: ListActions): CommandHandlerTable {
  return {
    ...navigationCommands(actions),
    ...selectionCommands(actions),
    'done.moveToHome': run(() => actions.moveToHome()),
  };
}

/** Attaches Done's handlers; they detach when the screen unmounts. */
export function useDoneKeys(actions: ListActions): void {
  const table = useMemo(() => commandsForDone(actions), [actions]);
  useRegisterCommands(table);
}
