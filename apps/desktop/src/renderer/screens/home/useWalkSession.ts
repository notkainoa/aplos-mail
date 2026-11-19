/**
 * The walk as React state. The Do-now ids are snapshotted once, when `home` first reports live; after that the queue
 * is fixed, so mail arriving never joins it or changes the thread showing (`live` only decides what is skipped). The
 * session is settled against the live data while rendering, so a committed thread's successor shows in the same frame.
 */
import { useCallback, useRef, useState } from 'react';
import type { HomeView, ThreadId } from '../../data';
import { restoreKey, type ReturnPoint } from '../../shell';
import { doNowIdsOf, doNowQueue, failedIds, liveDoNow } from './oneByOneQueue';
import {
  beginSession,
  markActed,
  resumeSession,
  sessionProgress,
  settleSession,
  shownId,
  stepSession,
  type Session,
} from './oneByOneSession';

/** What the screen reads from the walk, and the two ways it moves it. */
export interface WalkState {
  /** Null until Do now has been read. */
  readonly session: Session | null;
  /** The view is live and the walk has started: show a thread or the finish. Otherwise show nothing. */
  readonly ready: boolean;
  readonly live: ReadonlySet<ThreadId>;
  /** The thread showing; null before the walk starts and once it is over. */
  readonly shown: ThreadId | null;
  readonly progress: { readonly index: number; readonly of: number } | null;
  /** J (+1) and K (−1). */
  readonly step: (delta: 1 | -1) => void;
  /** A commit is about to take this thread out of Do now: step on once it has left. */
  readonly acted: (id: ThreadId) => void;
}

/** A new walk over `queue`: from its start, or from the thread the reader closed over (the nearest one still queued). */
function startSession(queue: readonly string[], restore: ReturnPoint | null): Session {
  const id = restore ? restoreKey(restore, queue) : null;
  return id === null ? beginSession(queue) : resumeSession(queue, queue.indexOf(id));
}

/** `restore` starts the walk where the reader opened over it (Esc); every other visit starts at the first thread. */
export function useWalkSession(home: HomeView, restore: ReturnPoint | null = null): WalkState {
  const [stored, setStored] = useState<Session | null>(null);
  const ids = doNowIdsOf(home);
  const live = liveDoNow(ids);
  const fresh = () =>
    startSession(
      doNowQueue(ids, id => home.rows.get(id)),
      restore,
    );
  const read = stored ?? (home.status === 'live' ? fresh() : null);
  // While the window is reopening `live` is empty, which must not read as "everything left".
  const session =
    read && home.status === 'live' ? settleSession(read, live, failedIds(home)) : read;
  if (session !== stored) setStored(session);

  const latest = useRef(live);
  latest.current = live;
  const step = useCallback((delta: 1 | -1) => {
    setStored(current => current && stepSession(current, latest.current, delta));
  }, []);
  const acted = useCallback((id: ThreadId) => {
    setStored(current => current && markActed(current, id));
  }, []);

  return {
    session,
    ready: session !== null && home.status === 'live',
    live,
    shown: session && shownId(session, live),
    progress: session && sessionProgress(session, live),
    step,
    acted,
  };
}
