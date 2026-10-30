/**
 * React's view of one composer session: it creates the session once its starting state is known, feeds it the engine's
 * `Draft` and `Submission` rows (`useRow`), flushes unsaved edits when the composer unmounts, and derives the view on
 * the data layer's clock. After the first Send the tray comes from the `Submission` row, never from local state.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { api, getNow, useNow, useRow, useSettings, useStatus } from '../../../data';
import { navigate, pushToast } from '../../../shell';
import type { ComposeState } from '../model/composeState';
import { composeView, type ComposeView } from '../model/composeView';
import { scheduledLabel } from '../model/schedule';
import { isLiveSubmission } from '../model/sendState';
import { dataComposeApi } from './composeApi';
import { releaseSend } from './sendHandoff';
import { createComposeSession, type ComposeSession } from './session';

/** "Undo send" defaults to 8 s (DESIGN 7.6) until the settings arrive. */
const DEFAULT_UNDO_SECONDS = 8;

export const DISCARD_COPY = {
  discarded: 'Draft discarded',
  discardFailed: 'Couldn’t discard the draft. It is still saved.',
} as const;

function notify(notice: 'discarded' | 'discardFailed'): void {
  pushToast({
    id: `compose-${notice}-${getNow()}`,
    kind: 'info',
    message: DISCARD_COPY[notice],
    undoable: false,
  });
}

const realTimers = {
  now: () => getNow(),
  setTimeout(callback: () => void, ms: number) {
    const handle = setTimeout(callback, ms);
    return () => clearTimeout(handle);
  },
};

function newSession(initial: ComposeState): ComposeSession {
  return createComposeSession(
    { api: dataComposeApi(api), timers: realTimers, notify, checkSent: () => navigate('sent') },
    initial,
  );
}

/** One session for the composer's lifetime, created when `initial` first becomes known. */
function useSessionFor(initial: ComposeState | null): ComposeSession | null {
  const [session, setSession] = useState<ComposeSession | null>(null);
  // Created and let go in one effect, so StrictMode's mount, unmount, mount gives a working session. `initial` is
  // decided once by the caller (null, then one state), so this runs once in the app.
  useEffect(() => {
    if (!initial) return;
    const created = newSession(initial);
    setSession(created);
    return () => {
      // Closing keeps the text: whatever is unsaved goes to the engine before the session lets go, and a send still
      // on its way goes to the toast stack (one notice per send).
      created.dispatch({ type: 'flush' });
      void created.settled().then(() => {
        handOffIfLive(created.getState());
        created.dispose();
      });
    };
  }, [initial]);
  return session;
}

/** Gives a live send to the toast stack (a no-op when a mounted composer still claims it). */
export function handOffIfLive(state: ComposeState): void {
  const send = state.send;
  if (send.kind !== 'tracking') return;
  if (send.row && !isLiveSubmission(send.row)) return;
  releaseSend(send.submissionId, true);
}

const NO_STATE = (): null => null;
const NO_SUBSCRIBE = () => () => undefined;

/** Feeds the engine's rows for this session's draft and submission back to it. */
function useRowFeed(session: ComposeSession | null, state: ComposeState | null): void {
  const draftId = state?.save.draftId ?? undefined;
  const send = state?.send;
  const draft = useRow('Draft', draftId);
  const submission = useRow(
    'Submission',
    send?.kind === 'tracking' ? send.submissionId : undefined,
  );
  useEffect(() => {
    if (session && draft) session.dispatch({ type: 'observeDraft', draft });
  }, [session, draft]);
  useEffect(() => {
    if (session && submission) session.dispatch({ type: 'observeSubmission', submission });
  }, [session, submission]);
}

export interface ComposeBinding {
  readonly session: ComposeSession;
  readonly state: ComposeState;
  readonly view: ComposeView;
  readonly undoSeconds: number;
}

/** The session, its state and its view; null until `initial` is known. */
export function useComposeSession(initial: ComposeState | null): ComposeBinding | null {
  const session = useSessionFor(initial);
  const state = useSyncExternalStore(
    session?.subscribe ?? NO_SUBSCRIBE,
    session?.getState ?? NO_STATE,
    session?.getState ?? NO_STATE,
  );
  useRowFeed(session, state);
  const now = useNow({ granularity: 'second' });
  const online = useStatus(state?.context.accountId)?.status.state !== 'offline';
  const undoSeconds = useSettings()?.mail.undoSendSeconds ?? DEFAULT_UNDO_SECONDS;
  const view = useMemo(
    () => (state ? composeView(state, now, online, ms => scheduledLabel(ms, now)) : null),
    [state, now, online],
  );
  if (!session || !state || !view) return null;
  return { session, state, view, undoSeconds };
}
