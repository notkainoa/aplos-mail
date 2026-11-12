/**
 * The one-by-one walk plus what the screen adds to it (DESIGN 7.2): which thread was just committed (so the walk can
 * step on once it leaves Do now) and which ones the walk has committed (so a write the engine rejects brings its
 * thread back to the screen with the error, as it stays under the cursor on Home). Pure; the walk itself is
 * `oneByOneWalk.ts` and is not changed here.
 */
import { afterCommit, currentId, progress, startWalk, stepWalk, type Walk } from './oneByOneWalk';

/** A walk and the screen's notes on it. */
export interface Session {
  readonly walk: Walk;
  /** The thread just committed, until it has left Do now. */
  readonly pending: string | null;
  /** Threads this walk committed, for a rejected write to bring back. */
  readonly acted: readonly string[];
}

/** A new session at the first Do-now id. */
export function beginSession(ids: readonly string[]): Session {
  return { walk: startWalk(ids), pending: null, acted: [] };
}

/** A session at the thread the owner was reading when the reader opened over the walk (`at`: its place in `ids`). */
export function resumeSession(ids: readonly string[], at: number): Session {
  const session = beginSession(ids);
  return at <= 0 ? session : { ...session, walk: { ...session.walk, index: at } };
}

/** The thread showing: the walk's current live id, null once the walk is over. */
export function shownId(session: Session, live: ReadonlySet<string>): string | null {
  return currentId(session.walk, live);
}

/** The crumb's "n of m", null once the walk is over. */
export function sessionProgress(session: Session, live: ReadonlySet<string>) {
  return progress(session.walk, live);
}

/** E, L, Space, # or a lane move is about to take `id` out of Do now: the walk steps on once it has left. */
export function markActed(session: Session, id: string): Session {
  const acted = session.acted.includes(id) ? session.acted : [...session.acted, id];
  return { ...session, pending: id, acted };
}

/** J (+1) and K (−1). With nowhere to go the session is returned untouched, so a bump costs no render. */
export function stepSession(session: Session, live: ReadonlySet<string>, delta: 1 | -1): Session {
  const walk = stepWalk(session.walk, live, delta);
  if (walk === session.walk && session.pending === null) return session;
  return { ...session, walk, pending: null };
}

/** The just-committed thread has left `live`: the walk takes its next step (`afterCommit`). */
function advance(session: Session, live: ReadonlySet<string>): Session {
  if (session.pending === null || live.has(session.pending)) return session;
  return { ...session, walk: afterCommit(session.walk, live), pending: null };
}

function indexOfShown(session: Session, live: ReadonlySet<string>): number {
  const { walk } = session;
  const id = currentId(walk, live);
  return id === null ? walk.queue.length : walk.queue.indexOf(id, walk.index);
}

/** A thread the walk committed is live again with a rejected write: show it, with its error and Retry. */
function rewind(session: Session, live: ReadonlySet<string>, failed: ReadonlySet<string>): Session {
  const { queue } = session.walk;
  const at = indexOfShown(session, live);
  const back = session.acted.find(
    id => id !== session.pending && failed.has(id) && live.has(id) && queue.indexOf(id) < at,
  );
  if (back === undefined) return session;
  return {
    walk: { ...session.walk, index: queue.indexOf(back) },
    pending: null,
    acted: session.acted.filter(id => id !== back),
  };
}

/** The walk is over and a thread it committed is live again (Undo on the last one): show it, so K and Retry reach it. */
function revive(session: Session, live: ReadonlySet<string>): Session {
  const { queue } = session.walk;
  if (indexOfShown(session, live) < queue.length) return session;
  const back = session.acted.findLast(id => id !== session.pending && live.has(id));
  if (back === undefined) return session;
  return {
    walk: { ...session.walk, index: queue.indexOf(back) },
    pending: null,
    acted: session.acted.filter(id => id !== back),
  };
}

/**
 * Brings the session up to the live data, once per render: steps on past a committed thread, goes back to one whose
 * write failed, and reopens a finished walk when a committed thread returns. Returns the same object when nothing changed, so it is safe to store from a render.
 */
export function settleSession(
  session: Session,
  live: ReadonlySet<string>,
  failed: ReadonlySet<string>,
): Session {
  return revive(rewind(advance(session, live), live, failed), live);
}
