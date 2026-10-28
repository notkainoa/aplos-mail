/**
 * Attaches the lists' handlers to the CommandRegistry. The registry owns the keys, the palette and the tooltips; a list
 * only says what each command does while it is mounted. `commandsForList` is a pure table, so a test or the shell can
 * read it without a component, and `useListKeys(register, actions)` attaches it with whatever `attach` the screen has.
 */
import type { CommandHandlers } from '../../commands';
import type { ListActions } from './listActions';
import { useCommandTable, type CommandTable, type Register } from './useCommandTable';

function run(action: () => void): CommandHandlers {
  return { run: () => action() };
}

/** The handlers common to every list: the cursor moves, Enter and Space open. */
export function navigationCommands(actions: ListActions): CommandTable {
  return {
    'list.down': run(() => actions.move(1)),
    'list.up': run(() => actions.move(-1)),
    'mail.open': run(() => actions.open()),
    'mail.suggested': run(() => actions.open()),
  };
}

/** All mail, Drafts, Sent, Trash, Spam, labels and Bookmarks. A verb a list does not own does nothing there. */
export function commandsForList(actions: ListActions): CommandTable {
  return {
    ...navigationCommands(actions),
    'mail.done': run(() => actions.done()),
    'mail.later': run(() => actions.later()),
    'mail.bookmark': run(() => actions.bookmark()),
    'mail.trash': run(() => actions.trash()),
    'mail.restore': run(() => actions.restore()),
  };
}

/** Attaches a list's handlers; they detach when the screen unmounts. */
export function useListKeys(register: Register, actions: ListActions): void {
  useCommandTable(register, commandsForList(actions));
}
