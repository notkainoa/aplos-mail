/**
 * The composer's handlers for the CommandRegistry (DESIGN 8 Compose; catalog `compose.*`). The registry owns the keys
 * (⌘↩, ⌘⇧↩, Tab, Esc, hold Space, ⌘⇧C), the palette and the tooltips; these tables only say what each command does
 * while a composer is open. Pure tables, so a test reads them without a component.
 */
import type { CommandHandlerTable } from '../../../shell';
import { keepsOnRelease } from '../model/dictationModel';

export interface ComposeCommandActions {
  /** ⌘↩ (⌘⇧↩ also marks the thread Done). */
  send(alsoDone: boolean): void;
  /** Tab while dim suggested text shows. */
  keepSuggestion(): void;
  /** Esc while dim suggested text shows. */
  dismissSuggestion(): void;
  /** Esc otherwise: the ladder (suggestion, confirmation, then close keeping the draft). */
  close(): void;
  /** "Discard the draft" from the palette, which has already asked "Discard this draft?". */
  discard(): void;
  /** ⌘⇧C. */
  toggleCc(): void;
  /** The inline reply's Pop out. */
  popOut?: () => void;
  /** Hold Space in an empty body: start listening, then keep or drop on release. */
  dictateStart(): void;
  dictateRelease(keep: boolean): void;
}

function run(action: () => void) {
  return { run: () => action() };
}

/** The `compose` context's handlers while a composer is open. */
export function composeCommands(actions: ComposeCommandActions): CommandHandlerTable {
  const table: Record<string, CommandHandlerTable[string]> = {
    'compose.send': run(() => actions.send(false)),
    'compose.sendAndDone': run(() => actions.send(true)),
    'compose.keepSuggestion': run(actions.keepSuggestion),
    'compose.dismissSuggestion': run(actions.dismissSuggestion),
    'compose.close': run(actions.close),
    'compose.discard': run(actions.discard),
    'compose.ccBcc': run(actions.toggleCc),
    'compose.dictate': {
      run: () => actions.dictateStart(),
      release: (_ctx, release) => actions.dictateRelease(keepsOnRelease(release)),
    },
  };
  if (actions.popOut) table['compose.popOut'] = run(actions.popOut);
  return table;
}

/** Z while a send is held: undo that send (it shadows the shell's Z until the window closes). */
export function undoSendCommands(undo: () => void): CommandHandlerTable {
  return { 'app.undo': run(undo) };
}

/** Hold R from the reader: the inline reply opens listening; releasing R keeps the words, Esc drops them. */
export function dictateReplyCommands(
  start: () => void,
  release: (keep: boolean) => void,
): CommandHandlerTable {
  return {
    'mail.dictateReply': {
      run: () => start(),
      release: (_ctx, hold) => release(keepsOnRelease(hold)),
    },
  };
}
