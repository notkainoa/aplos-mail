/**
 * The dock's renderer state, outside React so the palette's Ask row, the pane-header buttons and the keys reach the
 * same dock. The shell owns `open`/`tab` and passes them as props to `AskDockHost`; this store holds the conversation
 * state (`ask.model.ts`'s `AskState`), the chosen width (persisted in `Settings.ui.dock.width` by the host), a
 * pending question another surface asked for (the palette's "Ask about “x”") and a focus tick. `open(tab)` and
 * `ask(question)` also record a request the shell can mount the dock for (REQUESTS.md).
 */
import { useSyncExternalStore } from 'react';
import { initialAsk, type AskState } from './ask.model';

export interface DockState {
  /** The last tab a command asked for; the shell mirrors it into its own dock state. */
  readonly tab: 'ask' | 'today';
  /** Open-request counter: bumps when a command wants the dock open on `tab`. */
  readonly openTick: number;
  readonly width: number;
  readonly ask: AskState;
  /** A question another surface asked for (the palette's "Ask about “x”"), waiting for the host to run it. */
  readonly pendingQuestion?: string;
  /** Hold-A asked for dictation while the dock was closed; the host starts listening when it mounts. */
  readonly pendingDictation?: boolean;
  /** Bumped to move focus to the field (A, ⌘J). */
  readonly focusTick: number;
  /** The consent record version "Not now" dismissed; the line stays hidden until the record's version passes it. */
  readonly consentDismissed?: number;
}

/** Ask dock width (DESIGN §4.4): 360, or 320 under a 1180 px window. */
export function defaultDockWidth(windowWidth: number): number {
  return windowWidth < 1180 ? 320 : 360;
}

/**
 * The width worth writing back to `Settings.ui.dock.width`: only one the owner dragged — the seeded
 * layout default is never persisted on its own, since absent means "follow the layout" — and only
 * when it differs from what settings already store.
 */
export function dockWidthPersisted(
  width: number,
  seed: number,
  saved: number | undefined,
  dragged: boolean,
): number | undefined {
  if (!dragged && width === seed) return undefined;
  if (saved === width) return undefined;
  return width;
}

let current: DockState = {
  tab: 'ask',
  openTick: 0,
  width: 360,
  ask: initialAsk,
  focusTick: 0,
};
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
  /** Records "open the dock on this tab and focus the field" (A, the Ask button, ⇧A). */
  open(tab: 'ask' | 'today' = 'ask'): void {
    askStore.update(s => ({ ...s, tab, openTick: s.openTick + 1, focusTick: s.focusTick + 1 }));
  },
  /** Opens the dock and asks a question (the palette's Ask row). */
  ask(question: string): void {
    askStore.update(s => ({
      ...s,
      tab: 'ask',
      openTick: s.openTick + 1,
      pendingQuestion: question,
      focusTick: s.focusTick + 1,
    }));
  },
};

export function useDock(): DockState {
  return useSyncExternalStore(askStore.subscribe, askStore.get, askStore.get);
}
