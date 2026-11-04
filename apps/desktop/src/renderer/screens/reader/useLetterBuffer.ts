/**
 * React's view of the letter buffer: the store lives as long as the reader, `wanted` is told to it after each render,
 * and the snapshot says which letter is on paper and whether the 12 px line shows. Bodies the engine should have ready
 * around the cursor are asked for through the data layer's prefetch on intent (80 ms), which cancels when the cursor
 * moves on.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { usePrefetchIntent } from '../../data';
import { realTimers, type Timers } from '../../data/scheduler';
import {
  createLetterController,
  type LetterController,
  type LetterSnapshot,
} from './letterController';
import { PREFETCH_RADIUS, prefetchTargets } from './model/letterBuffer';

/** The buffer for the reader's lifetime. */
export function useLetterController(timers: Timers = realTimers): LetterController {
  const [controller] = useState(() => createLetterController(timers));
  return controller;
}

/** Tells the buffer which letter is wanted and returns what is on paper. */
export function useLetterBuffer(
  controller: LetterController,
  wanted: string | null,
): LetterSnapshot {
  useEffect(() => controller.want(wanted), [controller, wanted]);
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
