/**
 * Attaches Home's handlers to the CommandRegistry. The registry owns the keys, the palette and the tooltips; Home only
 * says what each command does while it is mounted. Detaching hands every command back to what was attached before.
 */
import type { CommandHandlers, Registry } from '../../commands';
import type { HomeActions } from './homeActions';

function run(action: () => void): CommandHandlers {
  return { run: () => action() };
}

function handlersFor(
  actions: HomeActions,
  extra: HomeExtras,
): Readonly<Record<string, CommandHandlers>> {
  return {
    'list.down': run(() => actions.move(1)),
    'list.up': run(() => actions.move(-1)),
    'list.nextSection': run(() => actions.jump(1)),
    'list.previousSection': run(() => actions.jump(-1)),
    'mail.done': run(() => actions.done()),
    'mail.later': run(() => actions.later()),
    'mail.laneDown': run(() => actions.lane('down')),
    'mail.laneUp': run(() => actions.lane('up')),
    'mail.trash': run(() => actions.trash()),
    'mail.bookmark': run(() => actions.bookmark()),
    'mail.suggested': run(() => actions.suggested()),
    'mail.open': run(() => actions.open()),
    'home.clearFromHome': run(() => actions.clearFromHome()),
    'mail.remindIfNoReply': run(() => actions.remind()),
    'home.oneByOne': run(extra.oneByOne),
    'list.more': run(extra.more),
    'app.undo': run(extra.undo),
  };
}

/** Commands that need no engine call and are not part of `HomeActions`. */
export interface HomeExtras {
  readonly oneByOne: () => void;
  readonly more: () => void;
  readonly undo: () => void;
}

/** Attaches every Home handler; returns the function that detaches them all. */
export function attachHomeCommands(
  registry: Registry,
  actions: HomeActions,
  extra: HomeExtras,
): () => void {
  const table = handlersFor(actions, extra);
  const detach = Object.entries(table).map(([id, handlers]) => registry.attach(id, handlers));
  return () => detach.forEach(fn => fn());
}
