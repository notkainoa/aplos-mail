import { useCallback, useState } from 'react';

export type Commit = { kind: 'done' | 'later'; id: string; key: number };

type QueueState = {
  order: string[];
  history: string[][];
  last: Commit | null;
};

function commitTo(state: QueueState, kind: Commit['kind']): QueueState {
  const [head, ...rest] = state.order;
  if (!head) {
    return state;
  }
  const order = kind === 'done' ? rest : [...rest, head];
  const key = (state.last?.key ?? 0) + 1;
  return { order, history: [...state.history, state.order], last: { kind, id: head, key } };
}

function undoFrom(state: QueueState): QueueState {
  const previous = state.history.at(-1);
  if (!previous) {
    return state;
  }
  return { order: previous, history: state.history.slice(0, -1), last: null };
}

/** Home's Do now queue: the head is in focus; Done drops it, Later sends it to the end, Z undoes. */
export function useQueue(initial: string[]) {
  const [state, setState] = useState<QueueState>({ order: initial, history: [], last: null });
  const done = useCallback(() => setState(s => commitTo(s, 'done')), []);
  const later = useCallback(() => setState(s => commitTo(s, 'later')), []);
  const undo = useCallback(() => setState(undoFrom), []);
  const reset = useCallback(() => setState({ order: initial, history: [], last: null }), [initial]);
  return { ...state, canUndo: state.history.length > 0, done, later, undo, reset };
}
