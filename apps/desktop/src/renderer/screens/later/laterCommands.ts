/**
 * Later's handlers on the CommandRegistry. L and D both re-date here (the thread is already in Later, so "Later" means
 * "Later until"), through the same date presets; Done, bookmark and trash are the list's. A pure table, so the shell can
 * read it without a component.
 */
import { useMemo } from 'react';
import type { CommandHandlers } from '../../commands';
import { useRegisterCommands, type CommandHandlerTable } from '../../shell';
import type { ListActions } from '../lists/listActions';
import { navigationCommands } from '../lists/listCommands';

/** The list's actions plus the picker. */
export interface LaterActions extends ListActions {
  /** Opens the date presets for the cursor row, or the row with this id. */
  openPicker(key?: string): void;
}

function run(action: () => void): CommandHandlers {
  return { run: () => action() };
}

export function commandsForLater(actions: LaterActions): CommandHandlerTable {
  return {
    ...navigationCommands(actions),
    'mail.done': run(() => actions.done()),
    'mail.bookmark': run(() => actions.bookmark()),
    'mail.trash': run(() => actions.trash()),
    'mail.later': run(() => actions.openPicker()),
    'mail.setDate': run(() => actions.openPicker()),
  };
}

/** Attaches Later's handlers; they detach when the screen unmounts. */
export function useLaterKeys(actions: LaterActions): void {
  const table = useMemo(() => commandsForLater(actions), [actions]);
  useRegisterCommands(table);
}
