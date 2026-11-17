/**
 * Attaches the reader's handlers to the CommandRegistry. The registry owns the keys, the palette and the tooltips; the
 * reader only says what each command does while it is mounted. `commandsForReader` is a pure table, so a test or the
 * shell can read it without a component. O, ⌘F and ↑/↓ belong to the letter on paper (`ReaderLetter`).
 */
import type { MailFrameKey } from '../../mailframe';
import type { CommandHandlerTable } from '../../shell';
import type { ReaderActions } from './readerActions';

function run(action: () => void) {
  return { run: () => action() };
}

/** J/K, Done, Later, Trash, Bookmark, U, F, Z, Space, R, ⇧R, hold R and Esc. */
export function commandsForReader(actions: ReaderActions): CommandHandlerTable {
  return {
    'reader.nextThread': run(() => actions.step('next')),
    'reader.previousThread': run(() => actions.step('previous')),
    'mail.done': run(actions.done),
    'mail.later': run(actions.later),
    'mail.trash': run(actions.trash),
    'mail.restore': run(actions.restore),
    'mail.bookmark': run(actions.bookmark),
    'mail.toggleRead': run(actions.toggleRead),
    'app.undo': run(actions.undo),
    'mail.suggested': { run: () => actions.suggest(), labelFor: () => actions.suggestedLabel() },
    'mail.reply': run(actions.reply),
    'mail.replyAll': run(actions.replyAll),
    'mail.forward': run(actions.forward),
    'mail.dictateReply': run(actions.dictate),
    'nav.back': run(actions.back),
  };
}

/** The slice of a window the relay needs. */
export interface KeyTarget {
  dispatchEvent(event: Event): boolean;
}

/**
 * A key pressed with focus inside a letter's frame, handed to the shell's one key listener as a keydown on the window,
 * so the registry resolves it exactly as it would a key typed anywhere else. True when a command ran (the listener
 * cancels the event), which tells the frame to cancel the key too.
 */
export function relayToShell(key: MailFrameKey, target: KeyTarget = window): boolean {
  const event = new KeyboardEvent('keydown', {
    key: key.key,
    shiftKey: key.shift,
    altKey: key.alt,
    bubbles: true,
    cancelable: true,
  });
  return !target.dispatchEvent(event);
}
