// The list holds still (DESIGN 4.8 hold, 5 rule 6, plan 30 4.3 holdGate). A
// triage key starts or extends a hold that releases hold.base (450 ms) after the
// last key, so a burst of any length closes once. If the pointer is still on the
// list then, the hold waits for it to leave, but never past hold.cap (1200 ms)
// after the last key. A pointer resting on the list with no key holds until it
// leaves (new mail never moves the row under it). Leaving releases at once.
// Hiding the window releases too: nothing paints while hidden, so arrivals land
// instead of queueing. It satisfies the data layer's HoldController, so
// `useHold` can hand one out as is.
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
  let lastKeyAt: number | null = null;
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
    if (!pointerInside || lastKeyAt === null) {
      release();
      return;
    }
    const waited = scheduler.now() - lastKeyAt;
    cancelTimer = scheduler.after(Math.max(0, cap - waited), release);
  }

  function armKeyTimer() {
    clearTimer();
    lastKeyAt = scheduler.now();
    cancelTimer = scheduler.after(base, onKeyTimer);
  }

  function start(why: HoldReason) {
    held = true;
    reason = why;
    lastKeyAt = null;
  }

  function release() {
    clearTimer();
    if (!held) return;
    const released = { ids, reason: reason ?? 'keys' };
    held = false;
    reason = null;
    ids = [];
    pointerInside = false;
    lastKeyAt = null;
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

  const stopHide = scheduler.onHide(release);

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
      stopHide();
      clearTimer();
      releaseListeners.clear();
      changeListeners.clear();
    },
  };
}
