/**
 * Holding still, the renderer half (DESIGN 5 rule 6, plan 30 4.1 and 4.3 `holdGate`). A triage key begins a hold over
 * the rows around the cursor; each further key extends it; it releases 450 ms after the last key, when the pointer
 * leaves the list, or at the 1200 ms cap, whichever comes first. The timing is the generated `hold` motion. The
 * controller's `heldIds` go to `useView` as `holdIds`, which pins the engine's order and queues frames meanwhile.
 */
import { motions } from '../ui/generated/motion';
import type { Id } from './contract-shapes';
import type { HoldController, HoldReason, HoldReleaseListener } from './index';
import type { Timers } from './scheduler';

/** Release this long after the last key (the `hold` motion's base). */
export const HOLD_RELEASE_MS = motions.hold.durations.base;
/** A hold never lasts longer than this (the `hold` motion's cap). */
export const HOLD_CAP_MS = motions.hold.durations.cap;

/** A hold controller plus what the data layer needs to observe it. */
export interface HoldGate extends HoldController {
  /** Called on every change (begin, extend with new ids, release). */
  subscribe(listener: () => void): () => void;
  /** Bumped on every change. */
  readonly version: number;
}

export function createHoldGate(timers: Timers): HoldGate {
  let ids: readonly Id[] = [];
  let reason: HoldReason | null = null;
  let startedAt = 0;
  let cancelTimer: (() => void) | null = null;
  let version = 0;
  const changeListeners = new Set<() => void>();
  const releaseListeners = new Set<HoldReleaseListener>();

  const changed = () => {
    version++;
    for (const listener of [...changeListeners]) listener();
  };

  const schedule = () => {
    cancelTimer?.();
    const now = timers.now();
    const wait = Math.max(0, Math.min(now + HOLD_RELEASE_MS, startedAt + HOLD_CAP_MS) - now);
    cancelTimer = timers.setTimeout(() => gate.release(), wait);
  };

  const merge = (more: readonly Id[] | undefined) => {
    if (!more?.length) return false;
    const next = [...new Set([...ids, ...more])];
    if (next.length === ids.length) return false;
    ids = next;
    return true;
  };

  const gate: HoldGate = {
    begin(why, around) {
      if (reason === null) {
        startedAt = timers.now();
        reason = why;
        ids = [...new Set(around)];
        schedule();
        changed();
        return;
      }
      if (why === 'keys') reason = 'keys';
      const grew = merge(around);
      schedule();
      if (grew) changed();
    },
    extend(more) {
      if (reason === null) return;
      const grew = merge(more);
      schedule();
      if (grew) changed();
    },
    release() {
      if (reason === null) return;
      cancelTimer?.();
      cancelTimer = null;
      const released = { ids, reason };
      ids = [];
      reason = null;
      changed();
      for (const listener of [...releaseListeners]) listener(released);
    },
    get isHeld() {
      return reason !== null;
    },
    get heldIds() {
      return ids;
    },
    get reason() {
      return reason;
    },
    onRelease(listener) {
      releaseListeners.add(listener);
      return () => {
        releaseListeners.delete(listener);
      };
    },
    subscribe(listener) {
      changeListeners.add(listener);
      return () => {
        changeListeners.delete(listener);
      };
    },
    get version() {
      return version;
    },
  };
  return gate;
}
