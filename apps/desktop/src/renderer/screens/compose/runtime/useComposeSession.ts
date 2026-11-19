/**
 * React's view of one composer session: it creates the session once its starting state is known, feeds it the engine's
 * `Draft` and `Submission` rows (`useRow`), flushes unsaved edits when the window hides or the composer unmounts, and
 * derives the view on the data layer's clock. After the first Send the tray comes from the `Submission` row, never from
 * local state. A composer that goes away hands its send to the toast stack whatever its phase (a refusal included), and
 * text the engine never confirmed stays in memory until it is saved (`recovery.ts`).
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { api, getNow, useNow, useRow, useSettings, useStatus } from '../../../data';
import { navigate, pushToast } from '../../../shell';
import type { ComposeState } from '../model/composeState';
import { composeView, type ComposeView } from '../model/composeView';
import type { ComposeNotice } from '../model/composeState';
import { scheduledLabel } from '../model/schedule';
import { isLiveSubmission, SEND_COPY } from '../model/sendState';
import { dataComposeApi } from './composeApi';
import {
  holdsUnsavedText,
  keepUntilSaved,
  keptSessions,
  recoveryKey,
  releaseKeptFor,
} from './recovery';
import { releaseSend } from './sendHandoff';
import { dropUnconfirmedSend, pushRefusedSend, pushUnconfirmedSend } from './sendNotices';
import { createComposeSession, type ComposeSession, type SendAnswer } from './session';

/** "Undo send" defaults to 8 s (DESIGN 7.6) until the settings arrive. */
const DEFAULT_UNDO_SECONDS = 8;

export const DISCARD_COPY = {
  discarded: 'Draft discarded',
  discardFailed: 'Couldn’t discard the draft. It is still saved.',
} as const;

const NOTICE_COPY: Record<ComposeNotice, string> = {
  ...DISCARD_COPY,
  alreadySent: SEND_COPY.alreadySent,
  undoRefused: SEND_COPY.undoFailed,
};

/** A composer's one-off notice; a refused Undo carries the engine's own sentence. */
function notify(notice: ComposeNotice, message?: string): void {
  pushToast({
    id: `compose-${notice}-${getNow()}`,
    kind: notice === 'discarded' ? 'info' : 'error',
    message: message ?? NOTICE_COPY[notice],
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
  const session: ComposeSession = createComposeSession(
    {
      api: dataComposeApi(api),
      timers: realTimers,
      notify,
      checkSent: () => navigate('sent'),
      onLateAnswer: answer => followLateAnswer(answer, session.getState()),
    },
    initial,
  );
  return session;
}

/** The sessions of the composers mounted now, so the window can save them all before it closes. */
const liveSessions = new Set<ComposeSession>();

/**
 * The account an open composer is writing in, for Ask's `context.draft.accountId` — read at run start, never
 * cached: which composer is open changes without the dock re-rendering, and a run fired after the composer
 * closed carries no account. The last open session wins: a compose page mounts over a reader's inline reply.
 * A sending composer is not open — its draft is already on its way, not being written.
 */
export function openDraftAccount(
  sessions: Iterable<Pick<ComposeSession, 'getState'>> = liveSessions,
): string | undefined {
  let accountId: string | undefined;
  for (const session of sessions) {
    const state = session.getState();
    if (state.open) accountId = state.context.accountId;
  }
  return accountId;
}

/** Whether a closing window may go: every composer's text is in the engine, or some of it is still only here. */
export type SaveResult = 'saved' | 'unsaved';

/**
 * Saves every mounted and every kept composer's unsaved text and waits for the engine to answer, for at most `limitMs`,
 * then says whether any of it is still only in memory. Used when main asks the window to close: a slow engine must not
 * hold the window open for long, but the text is in memory only (`recovery.ts`) and dies with the window, so the caller
 * must not close on `'unsaved'`. `settled()` resolves even when a save failed, so the answer comes from the state.
 */
export async function flushComposeSessions(limitMs = 2000): Promise<SaveResult> {
  const all = [...liveSessions, ...keptSessions()];
  for (const session of all) session.dispatch({ type: 'flush' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>(resolve => {
    timer = setTimeout(resolve, limitMs);
  });
  try {
    await Promise.race([Promise.all(all.map(session => session.settled())), limit]);
  } finally {
    clearTimeout(timer);
  }
  return [...liveSessions, ...keptSessions()].some(session => holdsUnsavedText(session.getState()))
    ? 'unsaved'
    : 'saved';
}

/** One session for the composer's lifetime, created when `initial` first becomes known. */
function useSessionFor(initial: ComposeState | null): ComposeSession | null {
  const [session, setSession] = useState<ComposeSession | null>(null);
  // Created and let go in one effect, so StrictMode's mount, unmount, mount gives a working session. `initial` is
  // decided once by the caller (null, then one state), so this runs once in the app.
  useEffect(() => {
    if (!initial) return;
    const created = newSession(initial);
    releaseKeptFor(initial);
    setSession(created);
    liveSessions.add(created);
    const stopFlushing = flushOnHide(created);
    return () => {
      liveSessions.delete(created);
      stopFlushing();
      closeSession(created);
    };
  }, [initial]);
  return session;
}

/**
 * Closing keeps the text: whatever is unsaved goes to the engine before the session lets go, a send still on its way
 * (or refused meanwhile) goes to the toast stack (one notice per send), and text the engine never took stays kept.
 */
export function closeSession(session: ComposeSession): void {
  session.dispatch({ type: 'flush' });
  void session.settled().then(() => {
    handOffIfLive(session.getState());
    keepUntilSaved(session);
  });
}

/** The window is hiding or closing: save now, without waiting for the quiet spell. Returns the unbinding. */
export function flushOnHide(
  session: Pick<ComposeSession, 'dispatch'>,
  win: Pick<Window, 'addEventListener' | 'removeEventListener'> | undefined = globalThis.window,
  doc:
    | Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>
    | undefined = globalThis.document,
): () => void {
  if (!win || !doc) return () => undefined;
  const flush = () => session.dispatch({ type: 'flush' });
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden') flush();
  };
  win.addEventListener('pagehide', flush);
  win.addEventListener('beforeunload', flush);
  doc.addEventListener('visibilitychange', onVisibility);
  return () => {
    win.removeEventListener('pagehide', flush);
    win.removeEventListener('beforeunload', flush);
    doc.removeEventListener('visibilitychange', onVisibility);
  };
}

/**
 * Gives a send to the toast stack once no composer shows it: a live submission (a no-op while a mounted composer still
 * claims it), or a refusal that came back after the composer closed ("Couldn’t send to Jordan. Your draft is saved.").
 */
export function handOffIfLive(state: ComposeState): void {
  const send = state.send;
  if (send.kind === 'refused' && !state.open) return handOffRefusal(state);
  if (send.kind === 'pending' && send.unconfirmed)
    return pushUnconfirmedSend(unconfirmedKey(state));
  if (send.kind !== 'tracking') return;
  if (send.row && !isLiveSubmission(send.row)) return;
  releaseSend(send.submissionId, true, send.row);
}

/** The unconfirmed notice's key: the draft the send names. */
function unconfirmedKey(state: ComposeState): string {
  return state.save.draftId ?? recoveryKey(state);
}

/**
 * A send that timed out answered after its composer was gone: the toast stack follows the submission (its tray, or
 * its failure), or the refusal becomes "Couldn’t send to …"; the unconfirmed notice goes either way.
 */
export function followLateAnswer(answer: SendAnswer, state: ComposeState): void {
  const key = unconfirmedKey(state);
  if (answer.type === 'sendAccepted') {
    dropUnconfirmedSend(key);
    return releaseSend(answer.submission.id, true, answer.submission);
  }
  // `conflict`: a send of this draft is already on its way; "Check Sent" stays the honest notice.
  if (answer.refusal.type === 'conflict') return;
  const { send, save } = state;
  if (send.kind !== 'pending' || save.draftId === null || save.revision === null) return;
  dropUnconfirmedSend(key);
  pushRefusedSend({
    draftId: save.draftId,
    revision: save.revision,
    names: send.names,
    ...(send.notBefore !== undefined ? { notBefore: send.notBefore } : {}),
    ...(send.alsoDone ? { alsoDone: true } : {}),
  });
}

function handOffRefusal(state: ComposeState): void {
  const { send, save } = state;
  if (send.kind !== 'refused' || save.draftId === null || save.revision === null) return;
  pushRefusedSend({
    draftId: save.draftId,
    revision: save.revision,
    names: send.names,
    ...(send.notBefore !== undefined ? { notBefore: send.notBefore } : {}),
    ...(send.alsoDone ? { alsoDone: true } : {}),
  });
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
    if (session && draft) session.dispatch({ type: 'observeDraft', draft, now: getNow() });
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
