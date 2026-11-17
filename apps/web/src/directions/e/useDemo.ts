import { useReducer } from 'react';
import { DEMO_EMAILS, type KeyId } from './demo';

export type Mode = 'focus' | 'action' | 'ask';

type Snapshot = { index: number; mode: Mode };

export type DemoState = {
  index: number;
  mode: Mode;
  history: Snapshot[];
  /** The key that produced the current view, or null at rest. */
  last: KeyId | null;
  /** What the last key did, said plainly. */
  note: string;
  /** Bumps on every key so the stage can replay its entrance. */
  tick: number;
};

const INITIAL: DemoState = {
  index: 0,
  mode: 'focus',
  history: [],
  last: null,
  note: 'This is Home: the email that needs you, in focus.',
  tick: 0,
};

function senderAt(index: number): string {
  return DEMO_EMAILS[index]?.sender ?? '';
}

function move(state: DemoState, key: 'left' | 'right'): DemoState {
  const done = state.index >= DEMO_EMAILS.length;
  if (done) {
    return {
      ...INITIAL,
      last: key,
      note: 'Do now is clear. Starting the demo again.',
      tick: state.tick + 1,
    };
  }
  const where = key === 'left' ? 'Later' : 'Done';
  const history = [...state.history, { index: state.index, mode: state.mode }];
  const note = `${senderAt(state.index)} moved to ${where}. The next email comes into focus.`;
  return {
    ...state,
    index: state.index + 1,
    mode: 'focus',
    history,
    last: key,
    note,
    tick: state.tick + 1,
  };
}

function undo(state: DemoState): DemoState {
  const previous = state.history.at(-1);
  if (!previous) {
    return {
      ...state,
      mode: 'focus',
      last: 'z',
      note: 'Nothing to undo yet. Try ← or → first.',
      tick: state.tick + 1,
    };
  }
  const history = state.history.slice(0, -1);
  const note = `Undone. ${senderAt(previous.index)} is back in focus.`;
  return {
    ...state,
    index: previous.index,
    mode: previous.mode,
    history,
    last: 'z',
    note,
    tick: state.tick + 1,
  };
}

function mainAction(state: DemoState): DemoState {
  const email = DEMO_EMAILS[state.index];
  if (!email) {
    return {
      ...state,
      last: 'space',
      note: 'Do now is clear. Press ← or → to start again.',
      tick: state.tick + 1,
    };
  }
  const note = `Space does the suggested action. For ${email.sender}, that is ${email.action}.`;
  return { ...state, mode: 'action', last: 'space', note, tick: state.tick + 1 };
}

function ask(state: DemoState): DemoState {
  const note = 'A opens Ask. Hold A to dictate instead of typing.';
  return { ...state, mode: 'ask', last: 'a', note, tick: state.tick + 1 };
}

function reduce(state: DemoState, key: KeyId): DemoState {
  if (key === 'space') return mainAction(state);
  if (key === 'z') return undo(state);
  if (key === 'a') return ask(state);
  return move(state, key);
}

/** The hero's little Home: a queue of emails the five keys act on. */
export function useDemo() {
  return useReducer(reduce, INITIAL);
}
