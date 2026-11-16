/**
 * Home's handlers for the shell's CommandRegistry, as a pure table. The registry owns the keys, the palette and the
 * tooltips; Home only says what each command does while it is mounted (`useRegisterCommands` attaches the table).
 */
import type { CommandHandlers } from '../../commands';
import type { CommandHandlerTable } from '../../shell';
import type { CommandAction } from '../../ui/props';
import { DICTATE, REPLY_ALL, type HomeActions } from './homeActions';

function run(action: () => void): CommandHandlers {
  return { run: () => action() };
}

/** Home's handlers by command id. */
export function commandsForHome(actions: HomeActions, extra: HomeExtras): CommandHandlerTable {
  return {
    'list.down': run(() => actions.move(1)),
    'list.up': run(() => actions.move(-1)),
    'list.select': run(() => actions.select()),
    'list.selectRange': run(() => actions.selectRange()),
    'list.selectAll': run(() => actions.selectAll()),
    'list.clearSelection': run(() => actions.clearSelection()),
    'list.nextSection': run(() => actions.jump(1)),
    'list.previousSection': run(() => actions.jump(-1)),
    'mail.done': run(() => actions.done()),
    'mail.later': run(() => actions.later()),
    'mail.setDate': run(() => actions.setDate()),
    'mail.laneDown': run(() => actions.lane('down')),
    'mail.laneUp': run(() => actions.lane('up')),
    'mail.trash': run(() => actions.trash()),
    'mail.bookmark': run(() => actions.bookmark()),
    'mail.why': run(extra.why),
    'mail.suggested': run(() => actions.suggested()),
    'mail.reply': run(() => actions.reply()),
    'mail.replyAll': run(() => actions.reply(REPLY_ALL)),
    'mail.dictateReply': run(() => actions.reply(DICTATE)),
    'mail.toggleRead': run(() => actions.toggleRead()),
    'mail.open': run(() => actions.open()),
    'home.clearFromHome': run(() => actions.clearFromHome()),
    'mail.remindIfNoReply': run(() => actions.remind()),
    'home.oneByOne': run(extra.oneByOne),
    'list.more': run(extra.more),
    'app.undo': run(() => extra.undo()),
  };
}

/** The pane header's bulk bar on Home (DESIGN 7.4): Done, Later, Trash; the keycaps come from the registry. */
export function homeBarActions(actions: HomeActions): readonly CommandAction[] {
  return [
    { label: 'Done', icon: 'check', commandId: 'mail.done', onSelect: () => actions.done() },
    { label: 'Later', icon: 'clock', commandId: 'mail.later', onSelect: () => actions.later() },
    { label: 'Trash', icon: 'trash', commandId: 'mail.trash', onSelect: () => actions.trash() },
  ];
}

/** Commands that need no engine call and are not part of `HomeActions`. */
export interface HomeExtras {
  readonly oneByOne: () => void;
  readonly more: () => void;
  /** I: "Why it's here" for the row under the cursor. */
  readonly why: () => void;
  readonly undo: () => void;
}
