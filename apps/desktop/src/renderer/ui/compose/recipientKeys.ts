/**
 * What a key does in a recipient field, apart from React (DESIGN 7.6): Return picks the highlighted match or commits the
 * typed text, a comma or semicolon commits it, Backspace on empty text removes the last person. ⌘Return and Ctrl+Return
 * are the composer's send and always go on to it: the composer commits what is typed in its recipient fields as it sends,
 * so the message never leaves without the address just typed. They never pick a match.
 */
import type { Recipient } from '../props';

/** The few facts of a keydown the field reads. */
export interface RecipientKeyEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly isComposing: boolean;
}

export interface RecipientKeyState {
  readonly query: string;
  readonly recipients: readonly Recipient[];
  /** The list is showing. */
  readonly open: boolean;
  readonly activeSuggestionId?: string;
}

export type RecipientKeyAction =
  | { readonly type: 'pick'; readonly id: string }
  | { readonly type: 'commit' }
  | { readonly type: 'remove'; readonly id: string };

/** Null: the field does nothing and the key goes on (to the composer's send, to Tab's focus move, to typing). */
export function recipientKey(
  event: RecipientKeyEvent,
  state: RecipientKeyState,
): RecipientKeyAction | null {
  if (event.isComposing) return null;
  const typed = state.query.trim() !== '';
  if (event.key === 'Enter') {
    if (event.metaKey || event.ctrlKey) return null;
    if (state.activeSuggestionId && state.open)
      return { type: 'pick', id: state.activeSuggestionId };
    return typed ? { type: 'commit' } : null;
  }
  if ((event.key === ',' || event.key === ';') && typed) return { type: 'commit' };
  const last = state.recipients[state.recipients.length - 1];
  if (event.key === 'Backspace' && state.query === '' && last)
    return { type: 'remove', id: last.id };
  return null;
}
