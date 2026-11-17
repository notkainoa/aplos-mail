/**
 * The compose route. `openCompose` records what the page should open on (a draft, a reply popped out of the reader, or
 * nothing for a new message) and where it was opened from, then shows the `{ label: 'compose' }` screen. `closeCompose`
 * goes back to that screen. The request is cleared as soon as the shell shows any other screen.
 */
import { createStore } from './store-core';
import { getScreen, setScreen, subscribeScreen } from './store-route';
import type { Screen } from './store-route';

export const COMPOSE_SCREEN = { label: 'compose' } as const;

/** What the compose page opens on. */
export interface ComposeTarget {
  /** Open on this draft (Drafts, Pop out). */
  readonly draftId?: string;
  /** A reply popped out before its first save. */
  readonly replyTo?: {
    readonly threadId: string;
    readonly messageId: string;
    readonly replyAll?: boolean;
  };
  /** A forward of this thread's latest message: the page seeds "Fwd:" and the quoted original once they load. */
  readonly forward?: { readonly threadId: string };
}

/** A target plus the screen to go back to; `seq` is new for every open, so each open mounts a fresh page. */
export interface ComposeRequest extends ComposeTarget {
  readonly from: Screen | null;
  readonly seq: number;
}

const requestStore = createStore<ComposeRequest | null>(null);
let seq = 0;

function onComposeScreen(screen: Screen = getScreen()): boolean {
  return typeof screen !== 'string' && screen.label === COMPOSE_SCREEN.label;
}

// Cleared on leave: any other screen showing means the page has gone.
subscribeScreen(() => {
  if (!onComposeScreen()) requestStore.set(null);
});

/** Shows the compose page. A bare open while the page is already showing keeps the page (and its text) as it is. */
export function openCompose(target: ComposeTarget = {}): void {
  const open = onComposeScreen();
  if (open && !target.draftId && !target.replyTo && !target.forward) return;
  const current = getScreen();
  const from = open ? (requestStore.get()?.from ?? null) : current;
  seq += 1;
  requestStore.set({ ...target, from, seq });
  setScreen(COMPOSE_SCREEN);
}

/** Leaves the compose page for the screen it was opened from (Home when none). Does nothing when it is not showing. */
export function closeCompose(): void {
  if (!onComposeScreen()) return;
  setScreen(requestStore.get()?.from ?? 'home');
}

export const getComposeRequest = requestStore.get;
export const subscribeComposeRequest = requestStore.subscribe;
