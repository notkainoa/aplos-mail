// The list holds still (DESIGN 5 rule 6, plan 30 4.3 holdGate). A triage key
// starts or extends a hold that releases hold.base (450 ms) after the last key,
// and never later than hold.cap (1200 ms) after it began. A pointer resting on
// the list holds too, until it leaves; leaving releases at once, whatever else
// is pending. Timers run on the scheduler's visible clock, so a hidden window
// pauses the hold. It satisfies the data layer's HoldController, so `useHold`
// can hand one out as is.
import type { HoldController, HoldReason, HoldReleaseListener, Id } from '../data';
import { motions } from '../ui/generated/motion';
import type { Scheduler } from './scheduler';

export interface HoldGate extends HoldController {
  /** The pointer entered the list (same as begin('pointer', ids)). */
  pointerEnter(ids?: readonly Id[]): void;
  /** The pointer left the list: release now. */
  pointerLeave(): void;
  /** Called on every change of isHeld or heldIds (for useSyncExternalStore). */
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export function createHoldGate(scheduler: Scheduler): HoldGate {
  const { base, cap } = motions.hold.durations;
  const releaseListeners = new Set<HoldReleaseListener>();
  const changeListeners = new Set<() => void>();
  let held = false;
  let reason: HoldReason | null = null;
  let ids: readonly Id[] = [];
  let pointerInside = false;
  let capAt = 0;
  let cancelTimer: (() => void) | null = null;

  const notify = () => {
    for (const listener of [...changeListeners]) listener();
  };

  function addIds(more: readonly Id[] | undefined) {
    if (!more || more.length === 0) return false;
    const next = [...ids];
    for (const id of more) if (!next.includes(id)) next.push(id);
    if (next.length === ids.length) return false;
    ids = next;
    return true;
  }

  function clearTimer() {
    cancelTimer?.();
    cancelTimer = null;
  }

  function onKeyTimer() {
    cancelTimer = null;
    if (!pointerInside) release();
  }

  function armKeyTimer() {
    clearTimer();
    const now = scheduler.now();
    cancelTimer = scheduler.after(Math.max(0, Math.min(now + base, capAt) - now), onKeyTimer);
  }

  function start(why: HoldReason) {
    held = true;
    reason = why;
    capAt = scheduler.now() + cap;
  }

  function release() {
    clearTimer();
    if (!held) return;
    const released = { ids, reason: reason ?? 'keys' };
    held = false;
    reason = null;
    ids = [];
    pointerInside = false;
    notify();
    for (const listener of [...releaseListeners]) listener(released);
  }

  function begin(why: HoldReason, more: readonly Id[]) {
    const wasHeld = held;
    if (!held) start(why);
    if (why === 'pointer') pointerInside = true;
    else armKeyTimer();
    if (addIds(more) || !wasHeld) notify();
  }

  return {
    begin,
    extend(more) {
      if (!held) {
        begin('keys', more ?? []);
        return;
      }
      armKeyTimer();
      if (addIds(more)) notify();
    },
    release,
    pointerEnter(more) {
      begin('pointer', more ?? []);
    },
    pointerLeave() {
      pointerInside = false;
      release();
    },
    get isHeld() {
      return held;
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
    dispose() {
      clearTimer();
      releaseListeners.clear();
      changeListeners.clear();
    },
  };
}
