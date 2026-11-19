/**
 * The state of the letter on paper that the keys and buttons change (DESIGN 7.5): quoted text shown or not, the
 * earlier messages (compact cards) opened one by one, the ↑/↓ message cursor, the remote images chosen for this reading, and
 * find. It belongs to one thread: a different thread starts from `freshUi`. Pure, so the keys can be tested.
 */
import type { CursorDirection } from './model/threadCursor';
import { stepMessage } from './readerModel';
import type { InlineReplyHostProps } from '../compose';

/** The inline reply the letter shows under the thread: how it was asked for (R, ⇧R, hold R, a suggestion). */
export interface ReplyRequest {
  readonly replyAll: boolean;
  /** Opened by holding R: the host starts listening at once. */
  readonly dictate: boolean;
  /** The dim text to offer: the Follow up nudge. */
  readonly suggest?: InlineReplyHostProps['suggest'];
  /** Open on this draft (an Undo send handed it back). */
  readonly draftId?: string;
}

/** The reply card a thread was opened for (R, ⇧R, hold R or the Follow up nudge on Home or one by one). */
export function replyRequestOf(reply: {
  readonly replyAll: boolean;
  readonly dictate: boolean;
  readonly nudge: boolean;
  readonly draftId?: string;
}): ReplyRequest {
  const { replyAll, dictate, nudge, draftId } = reply;
  const base: ReplyRequest = draftId ? { replyAll, dictate, draftId } : { replyAll, dictate };
  return nudge ? { ...base, suggest: { kind: 'followUp' } } : base;
}

/** A plain R. */
export const PLAIN_REPLY: ReplyRequest = { replyAll: false, dictate: false };

/** The letter's interface state. */
export interface ReaderUi {
  readonly threadId: string | null;
  /** O (with the cursor on the latest message) shows the quoted text. */
  readonly expanded: boolean;
  /** Earlier messages opened from their compact card to the full message (a click, or O on the focused card). */
  readonly opened: readonly string[];
  /** The message the ↑/↓ rail is on; null until a key moves it (the latest message holds it). */
  readonly cursor: string | null;
  /** Messages whose remote images were loaded in this reading. */
  readonly imagesLoaded: readonly string[];
  /** The find bar: closed (null) or open with its query. */
  readonly find: string | null;
  /** Counts every ⌘F, so a second one refocuses the field even though find is already open. */
  readonly findFocus: number;
  /** The inline reply under the thread, or null while only the stub shows. */
  readonly reply: ReplyRequest | null;
  /** The reply card is open (a sent reply's tray is not): the filled suggestion belongs to the card while it is. */
  readonly replyOpen: boolean;
}

/** A thread's untouched state. */
export function freshUi(threadId: string | null): ReaderUi {
  return {
    threadId,
    expanded: false,
    opened: [],
    cursor: null,
    imagesLoaded: [],
    find: null,
    findFocus: 0,
    reply: null,
    replyOpen: false,
  };
}

/** What can change it. */
export type UiEvent =
  | { readonly type: 'toggleExpanded' }
  | { readonly type: 'toggleMessage'; readonly id: string }
  | { readonly type: 'focusMessage'; readonly id: string }
  | { readonly type: 'moveCursor'; readonly ids: readonly string[]; readonly dir: CursorDirection }
  | { readonly type: 'loadImages'; readonly id: string }
  | { readonly type: 'openFind' }
  | { readonly type: 'setFind'; readonly query: string }
  | { readonly type: 'closeFind' }
  | { readonly type: 'openReply'; readonly request: ReplyRequest }
  | { readonly type: 'closeReply' }
  | { readonly type: 'replyOpen'; readonly open: boolean };

function withId(list: readonly string[], id: string): readonly string[] {
  return list.includes(id) ? list : [...list, id];
}

function toggled(list: readonly string[], id: string): readonly string[] {
  return list.includes(id) ? list.filter(other => other !== id) : [...list, id];
}

/** One event. */
export function reduceUi(state: ReaderUi, event: UiEvent): ReaderUi {
  switch (event.type) {
    case 'toggleExpanded':
      return { ...state, expanded: !state.expanded };
    case 'toggleMessage':
      return { ...state, opened: toggled(state.opened, event.id), cursor: event.id };
    case 'focusMessage':
      return state.cursor === event.id ? state : { ...state, cursor: event.id };
    case 'moveCursor':
      // No cursor yet means the latest message holds it, which is the last id the keys walk.
      return {
        ...state,
        cursor: stepMessage(event.ids, state.cursor ?? event.ids.at(-1) ?? null, event.dir),
      };
    case 'loadImages':
      return { ...state, imagesLoaded: withId(state.imagesLoaded, event.id) };
    case 'openFind':
      return { ...state, find: state.find ?? '', findFocus: state.findFocus + 1 };
    case 'setFind':
      return { ...state, find: event.query };
    case 'closeFind':
      return { ...state, find: null };
    case 'openReply':
      return state.reply ? state : { ...state, reply: event.request };
    case 'closeReply':
      return { ...state, reply: null, replyOpen: false };
    case 'replyOpen':
      return state.replyOpen === event.open ? state : { ...state, replyOpen: event.open };
  }
}

/** The ids ↑/↓ walks: every message, oldest first (the earlier ones are compact cards, the latest is open). */
export function walkableIds(
  earlierIds: readonly string[],
  latestId: string | null,
): readonly string[] {
  return latestId === null ? [...earlierIds] : [...earlierIds, latestId];
}

/**
 * What O does: on an earlier message's compact card it opens or folds that card; on the latest message (where the
 * cursor starts) it shows or hides the quoted text.
 */
export function expandEvent(cursor: string | null, earlierIds: readonly string[]): UiEvent {
  return cursor !== null && earlierIds.includes(cursor)
    ? { type: 'toggleMessage', id: cursor }
    : { type: 'toggleExpanded' };
}

/** An event for one thread's state: a state for any other thread starts afresh first. */
export interface ThreadUiEvent {
  readonly threadId: string;
  readonly event: UiEvent;
}

/** The reducer the screen runs: events carry the thread they belong to, so no effect has to reset anything. */
export function reduceFor(state: ReaderUi, { threadId, event }: ThreadUiEvent): ReaderUi {
  return reduceUi(state.threadId === threadId ? state : freshUi(threadId), event);
}

/** The state to draw for a thread: the live one if it is that thread's, else untouched. */
export function uiFor(state: ReaderUi, threadId: string): ReaderUi {
  return state.threadId === threadId ? state : freshUi(threadId);
}
