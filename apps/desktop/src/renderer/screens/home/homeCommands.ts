/**
 * Home's handlers for the shell's CommandRegistry, as a pure table. The registry owns the keys, the palette and the
 * tooltips; Home only says what each command does while it is mounted (`useRegisterCommands` attaches the table).
 */
import {
  DEFAULT_KEY_PREFS,
  buildStack,
  focusKindOf,
  type CommandContext,
  type CommandHandlers,
  type ContextName,
  type TargetSummary,
} from '../../commands';
import type { CommandHandlerTable } from '../../shell';
import type { HomeActions } from './homeActions';

function run(action: () => void): CommandHandlers {
  return { run: () => action() };
}

/** Home's handlers by command id. */
export function commandsForHome(actions: HomeActions, extra: HomeExtras): CommandHandlerTable {
  return {
    'list.down': run(() => actions.move(1)),
    'list.up': run(() => actions.move(-1)),
    'list.nextSection': run(() => actions.jump(1)),
    'list.previousSection': run(() => actions.jump(-1)),
    'mail.done': run(() => actions.done()),
    'mail.later': run(() => actions.later()),
    'mail.setDate': run(() => actions.setDate()),
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
    'app.undo': run(() => extra.undo()),
  };
}

/** Commands that need no engine call and are not part of `HomeActions`. */
export interface HomeExtras {
  readonly oneByOne: () => void;
  readonly more: () => void;
  readonly undo: () => void;
}

/** What a command run from Home's own code (Space on a reply) gets: the stack the shell reports for Home. */
export function homeRunContext(
  target: TargetSummary | null,
  lowSheetOpen: boolean,
  remindOffer: boolean,
  focusTarget: unknown,
): CommandContext {
  const contexts: ContextName[] = lowSheetOpen
    ? ['global', 'home', 'lowImportance']
    : ['global', 'home'];
  return {
    stack: buildStack(contexts),
    target,
    selection: [],
    conditions: { remindOffer },
    prefs: DEFAULT_KEY_PREFS,
    focus: focusKindOf(focusTarget),
  };
}
