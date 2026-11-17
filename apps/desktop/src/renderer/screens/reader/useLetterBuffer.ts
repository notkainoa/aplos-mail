/**
 * React's view of the letter buffer: the store lives as long as the reader, `wanted` is told to it after each render,
 * and the snapshot says which letter is on paper and whether the 12 px line shows. Bodies the engine should have ready
 * around the cursor are asked for through the data layer's prefetch on intent (80 ms), which cancels when the cursor
 * moves on.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { usePrefetchIntent } from '../../data';
import { realTimers, type Timers } from '../../data/scheduler';
import {
  createLetterController,
  type LetterController,
  type LetterSnapshot,
} from './letterController';
import { PREFETCH_RADIUS, prefetchTargets } from './model/letterBuffer';

const NOBODY: ReadonlySet<string> = new Set();

/** The buffer for the reader's lifetime. */
export function useLetterController(timers: Timers = realTimers): LetterController {
  const [controller] = useState(() => createLetterController(timers));
  return controller;
}

/**
 * Tells the buffer which letter is wanted and returns what is on paper. A letter on paper that this reading sent away
 * (`gone`: Done, Later, Trash), or no letter at all, is not kept while the next one loads: the next one is shown at
 * once, so what is on screen is always a thread the keys can act on.
 */
export function useLetterBuffer(
  controller: LetterController,
  wanted: string | null,
  gone: ReadonlySet<string> = NOBODY,
): LetterSnapshot {
  const away = useRef(gone);
  away.current = gone;
  useEffect(() => {
    const paper = controller.snapshot().letter;
    controller.want(wanted, paper === null || away.current.has(paper));
  }, [controller, wanted]);
  return useSyncExternalStore(controller.subscribe, controller.snapshot, controller.snapshot);
}

/** Prefetch the neighbours' bodies once the cursor has rested (the data layer waits 80 ms and cancels on a move). */
export function usePrefetchAround(ids: readonly string[], current: string | null): void {
  const prefetch = usePrefetchIntent();
  useEffect(() => {
    if (current === null) return undefined;
    prefetch.focus(current, prefetchTargets(ids, current, PREFETCH_RADIUS));
    return () => prefetch.cancel();
  }, [prefetch, ids, current]);
}
