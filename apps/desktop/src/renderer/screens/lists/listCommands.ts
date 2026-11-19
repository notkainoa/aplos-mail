/**
 * Attaches the lists' handlers to the CommandRegistry. The registry owns the keys, the palette and the tooltips; a list
 * only says what each command does while it is mounted. `commandsForList` is a pure table, so a test or the shell can
 * read it without a component, and `useListKeys(actions)` attaches it to the shell's registry.
 */
import { useMemo } from 'react';
import type { CommandHandlers } from '../../commands';
import { useRegisterCommands, type CommandHandlerTable } from '../../shell';
import type { ListActions } from './listActions';

function run(action: () => void): CommandHandlers {
  return { run: () => action() };
}

/** The handlers common to every list: the cursor moves, Enter and Space open. */
export function navigationCommands(actions: ListActions): CommandHandlerTable {
  return {
    'list.down': run(() => actions.move(1)),
    'list.up': run(() => actions.move(-1)),
    'mail.open': run(() => actions.open()),
    'mail.suggested': run(() => actions.open()),
  };
}

/** X, ⇧X, ⌘A and Esc: the bulk pick. Arrows never add to it (decision 7). */
export function selectionCommands(actions: ListActions): CommandHandlerTable {
  return {
    'list.select': run(() => actions.select()),
    'list.selectRange': run(() => actions.selectRange()),
    'list.selectAll': run(() => actions.selectAll()),
    'list.clearSelection': run(() => actions.clearSelection()),
    'list.more': run(() => actions.more()),
  };
}

/** All mail, Drafts, Sent, Trash, Spam, labels and Bookmarks. A verb a list does not own does nothing there. */
export function commandsForList(actions: ListActions): CommandHandlerTable {
  return {
    ...navigationCommands(actions),
    ...selectionCommands(actions),
    'mail.done': run(() => actions.done()),
    'mail.later': run(() => actions.later()),
    'mail.bookmark': run(() => actions.bookmark()),
    'mail.trash': run(() => actions.trash()),
    'mail.forward': run(() => actions.forward()),
    'mail.restore': run(() => actions.restore()),
  };
}

/** Attaches a list's handlers; they detach when the screen unmounts. */
export function useListKeys(actions: ListActions): void {
  const table = useMemo(() => commandsForList(actions), [actions]);
  useRegisterCommands(table);
}
