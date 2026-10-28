/**
 * The dock's renderer state, outside React so the palette's Ask row, the toolbar buttons and the keys reach the same
 * dock. `open`, `tab` and `width` are remembered in `Settings.ui.dock` by the container; the conversation state is
 * `ask.model.ts`'s `AskState`.
 */
import { useSyncExternalStore } from 'react';
import { initialAsk, type AskState } from './ask.model';

export interface DockState {
  readonly open: boolean;
  readonly tab: 'ask' | 'today';
  readonly width: number;
  readonly ask: AskState;
  /** A question another surface asked for (the palette's "Ask about “x”"), waiting for the container to run it. */
  readonly pendingQuestion?: string;
  /** Bumped to move focus to the field (A, ⌘J). */
  readonly focusTick: number;
}

/** Ask dock width (DESIGN §4.4): 360, or 320 under a 1180 px window. */
export function defaultDockWidth(windowWidth: number): number {
  return windowWidth < 1180 ? 320 : 360;
}

let current: DockState = { open: false, tab: 'ask', width: 360, ask: initialAsk, focusTick: 0 };
const listeners = new Set<() => void>();

export const askStore = {
  get: (): DockState => current,
  set(next: DockState): void {
    if (next === current) return;
    current = next;
    for (const listener of listeners) listener();
  },
  update(fn: (state: DockState) => DockState): void {
    askStore.set(fn(current));
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Opens the dock on a tab and focuses the field. */
  open(tab: 'ask' | 'today' = 'ask'): void {
    askStore.update(s => ({ ...s, open: true, tab, focusTick: s.focusTick + 1 }));
  },
  /** Opens the dock and asks a question (the palette's Ask row). */
  ask(question: string): void {
    askStore.update(s => ({
      ...s,
      open: true,
      tab: 'ask',
      pendingQuestion: question,
      focusTick: s.focusTick + 1,
    }));
  },
};

export function useDock(): DockState {
  return useSyncExternalStore(askStore.subscribe, askStore.get, askStore.get);
}
