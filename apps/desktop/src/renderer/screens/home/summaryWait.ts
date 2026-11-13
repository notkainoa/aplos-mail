/**
 * How long Home's focus card waits for a summary that is being written (owner decision 2026-11-13). Past the limit the
 * card gives up quietly: the placeholder goes, the space collapses and no error shows. The clock starts the first time
 * the card sees the thread pending and survives scrolling away and back.
 */
import { useEffect, useReducer } from 'react';

export const SUMMARY_WAIT_MS = 20_000;

const firstSeen = new Map<string, number>();

/** Milliseconds left to wait, or null when nothing is pending (the clock for this thread resets). */
export function waitLeft(
  id: string,
  pending: boolean,
  now: number,
  seen: Map<string, number> = firstSeen,
): number | null {
  if (!pending) {
    seen.delete(id);
    return null;
  }
  const start = seen.get(id) ?? now;
  seen.set(id, start);
  return Math.max(0, SUMMARY_WAIT_MS - (now - start));
}

/** True once the summary for `id` has been pending past the limit; re-renders the card when the wait ends. */
export function useSummaryGaveUp(id: string, pending: boolean): boolean {
  const [, wake] = useReducer((n: number) => n + 1, 0);
  const left = waitLeft(id, pending, Date.now());
  useEffect(() => {
    if (left === null || left === 0) return undefined;
    const timer = setTimeout(wake, left);
    return () => clearTimeout(timer);
  }, [id, pending, left === 0]);
  return left === 0;
}
