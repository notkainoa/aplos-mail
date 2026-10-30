/**
 * The state of the letter on paper that the keys and buttons change (DESIGN 7.5): earlier messages expanded or not,
 * the earlier messages opened one by one, the ↑/↓ message cursor, the remote images chosen for this reading, and
 * find. It belongs to one thread: a different thread starts from `freshUi`. Pure, so the keys can be tested.
 */
import type { CursorDirection } from './model/threadCursor';
import { stepMessage } from './readerModel';

/** The letter's interface state. */
export interface ReaderUi {
  readonly threadId: string | null;
  /** O has expanded the earlier messages into one-liners. */
  readonly expanded: boolean;
  /** Earlier messages opened to full messages. */
  readonly opened: readonly string[];
  /** The message the ↑/↓ rail is on; null until a key moves it (the latest message holds it). */
  readonly cursor: string | null;
  /** Messages whose remote images were loaded in this reading. */
  readonly imagesLoaded: readonly string[];
  /** The find bar: closed (null) or open with its query. */
  readonly find: string | null;
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
  };
}

/** What can change it. */
export type UiEvent =
  | { readonly type: 'toggleExpanded' }
  | { readonly type: 'openMessage'; readonly id: string }
  | { readonly type: 'moveCursor'; readonly ids: readonly string[]; readonly dir: CursorDirection }
  | { readonly type: 'loadImages'; readonly id: string }
  | { readonly type: 'openFind' }
  | { readonly type: 'setFind'; readonly query: string }
  | { readonly type: 'closeFind' };

function withId(list: readonly string[], id: string): readonly string[] {
  return list.includes(id) ? list : [...list, id];
}

/** One event. */
export function reduceUi(state: ReaderUi, event: UiEvent): ReaderUi {
  switch (event.type) {
    case 'toggleExpanded':
      return { ...state, expanded: !state.expanded };
    case 'openMessage':
      return { ...state, opened: withId(state.opened, event.id), cursor: event.id };
    case 'moveCursor':
      return { ...state, cursor: stepMessage(event.ids, state.cursor, event.dir) };
    case 'loadImages':
      return { ...state, imagesLoaded: withId(state.imagesLoaded, event.id) };
    case 'openFind':
      return { ...state, find: state.find ?? '' };
    case 'setFind':
      return { ...state, find: event.query };
    case 'closeFind':
      return { ...state, find: null };
  }
}

/** The ids ↑/↓ walks: the earlier messages while they are expanded, then the latest. */
export function walkableIds(
  earlierIds: readonly string[],
  expanded: boolean,
  latestId: string | null,
): readonly string[] {
  const ids = expanded ? [...earlierIds] : [];
  if (latestId !== null) ids.push(latestId);
  return ids;
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
