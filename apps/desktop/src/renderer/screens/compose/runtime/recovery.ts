/**
 * Unsaved text is never let go silently. A composer that closes with edits the engine has not confirmed (the save
 * failed, the engine is away) stays alive here, keyed by its draft (or by the reply's thread, or the account for a new
 * message that never reached the engine), and keeps retrying on the autosave backoff. It lets go once the engine holds
 * the text or the draft is discarded. A composer that opens on the same key takes the text over instead of starting
 * from the stale row. Memory only: nothing about the text is written anywhere else.
 */
import { isDirty } from '../model/autosave';
import type { ComposeState } from '../model/composeState';
import { NO_SEND } from '../model/sendState';
import type { ComposeSession } from './session';

const kept = new Map<string, { readonly session: ComposeSession; readonly stop: () => void }>();

/** The key a composer's text is kept under. */
export function recoveryKey(state: Pick<ComposeState, 'save' | 'context'>): string {
  if (state.save.draftId) return `draft:${state.save.draftId}`;
  if (state.context.threadId) return `reply:${state.context.threadId}`;
  // A forward has no thread of its own: it must not share (and so release) a new message's kept text.
  if (state.context.mode === 'forward' && state.context.replyToMessageId)
    return `forward:${state.context.replyToMessageId}`;
  return `new:${state.context.accountId}`;
}

/** True while the text holds edits the engine has not confirmed (and is not being discarded). */
export function holdsUnsavedText(state: ComposeState): boolean {
  return !state.discarding && state.ended !== 'discarded' && isDirty(state.save);
}

function release(key: string): void {
  const entry = kept.get(key);
  if (!entry) return;
  kept.delete(key);
  entry.stop();
  entry.session.dispose();
}

/**
 * Keeps a closing composer with unsaved text alive until its text is saved; disposes it at once otherwise. A second
 * composer kept under the same key replaces the first only after the first is let go (one writer per draft).
 */
export function keepUntilSaved(session: ComposeSession): void {
  const state = session.getState();
  if (!holdsUnsavedText(state)) return session.dispose();
  const key = recoveryKey(state);
  release(key);
  const stop = session.subscribe(() => {
    if (!holdsUnsavedText(session.getState())) release(key);
  });
  kept.set(key, { session, stop });
}

/** The kept entry a composer opening under any of `keys` should take (its key then, or the key it has now). */
function findKept(keys: readonly string[]): string | null {
  for (const [key, entry] of kept) {
    if (keys.includes(key) || keys.includes(recoveryKey(entry.session.getState()))) return key;
  }
  return null;
}

/** Its text, open again, with a fresh save clock: the old composer's last save may or may not have landed. */
function reopened(state: ComposeState): ComposeState {
  const save = {
    ...state.save,
    flightSeq: null,
    failures: 0,
    lastFailAt: null,
    waitingForRemote: false,
  };
  return {
    ...state,
    save,
    open: true,
    ended: null,
    confirm: null,
    send: NO_SEND,
    suggestion: null,
  };
}

/** The keys a composer starting from `state` takes kept text from: its own, and its reply thread's. */
function keysFor(state: ComposeState): readonly string[] {
  const thread = state.context.threadId;
  return thread ? [recoveryKey(state), `reply:${thread}`] : [recoveryKey(state)];
}

/**
 * The state a composer should start from: kept text for the same draft or reply, open again, else `state` as it is.
 * Pure (safe during render); the new session lets the kept one go with `releaseKeptFor` once it exists.
 */
export function withKeptText(state: ComposeState): ComposeState {
  const key = findKept(keysFor(state));
  if (key === null) return state;
  const held = kept.get(key)!.session.getState();
  if (sending(held)) return state;
  return reopened(held);
}

/** True when a kept composer still owns a send in flight: a new composer does not take it over (`withKeptText`). */
function sending(state: ComposeState): boolean {
  return state.send.kind === 'pending' || state.send.kind === 'tracking';
}

/**
 * A composer took over: the kept one stops writing (one writer per draft). One whose send is still pending or tracked
 * was not taken over (the new composer started from the saved row), so it stays: its unsaved text and its send's answer
 * are not dropped.
 */
export function releaseKeptFor(state: ComposeState): void {
  const key = findKept(keysFor(state));
  if (key === null) return;
  if (sending(kept.get(key)!.session.getState())) return;
  release(key);
}

/** The composers kept for their unsaved text, so a closing window can ask them to save once more. */
export function keptSessions(): ComposeSession[] {
  return [...kept.values()].map(entry => entry.session);
}

/** How many composers are kept (tests). */
export function keptCount(): number {
  return kept.size;
}

/** Lets every kept composer go (tests). */
export function releaseAllKept(): void {
  for (const key of [...kept.keys()]) release(key);
}
