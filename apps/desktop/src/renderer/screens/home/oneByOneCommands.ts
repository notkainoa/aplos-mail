/**
 * The one-by-one view's handlers for the shell's CommandRegistry, as a pure table. The keys and tooltips come from the
 * registry; the view only says what each command does while it is mounted. It shares Home's contexts (`home` on the
 * key stack), so J/K, E, L, Space, D, B, #, I and ⌥↑/⌥↓ are the list commands, and → / ← triage as on Home.
 */
import type { CommandHandlers } from '../../commands';
import type { CommandHandlerTable } from '../../shell';
import { DICTATE, REPLY_ALL, type HomeActions } from './homeActions';

function run(action: () => void): CommandHandlers {
  return { run: () => action() };
}

/** What the view does beyond `HomeActions`: the walk, the thread, the menu, the way out. */
export interface OneByOneControls {
  /** J and K. */
  readonly step: (delta: 1 | -1) => void;
  /** Return and O: the thread in the reader. */
  readonly open: () => void;
  readonly more: () => void;
  readonly why: () => void;
  /** A lane move takes the thread out of Do now, so the walk steps on. */
  readonly lane: (direction: 'up' | 'down') => void;
  readonly undo: () => void;
  /** Esc, the last rung of the ladder: back to Home. */
  readonly back: () => void;
}

/** The view's handlers by command id. */
export function commandsForOneByOne(
  actions: HomeActions,
  controls: OneByOneControls,
): CommandHandlerTable {
  return {
    'list.down': run(() => controls.step(1)),
    'list.up': run(() => controls.step(-1)),
    'mail.done': run(() => actions.done()),
    'mail.later': run(() => actions.later()),
    'mail.suggested': run(() => actions.suggested()),
    'mail.open': run(controls.open),
    'mail.reply': run(() => actions.reply()),
    'mail.replyAll': run(() => actions.reply(REPLY_ALL)),
    'mail.dictateReply': run(() => actions.reply(DICTATE)),
    'mail.forward': run(() => actions.forward()),
    'mail.toggleRead': run(() => actions.toggleRead()),
    'mail.setDate': run(() => actions.setDate()),
    'mail.bookmark': run(() => actions.bookmark()),
    'mail.trash': run(() => actions.trash()),
    'mail.laneDown': run(() => controls.lane('down')),
    'mail.laneUp': run(() => controls.lane('up')),
    'mail.why': run(controls.why),
    'mail.remindIfNoReply': run(() => actions.remind()),
    'list.more': run(controls.more),
    'app.undo': run(controls.undo),
    'nav.back': run(controls.back),
  };
}
