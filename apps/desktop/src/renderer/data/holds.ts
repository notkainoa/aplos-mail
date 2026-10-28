/**
 * Holding still, the renderer half (DESIGN 4.8 hold, 5 rule 6, plan 30 4.1 and 4.3 `holdGate`). This is the one hold
 * gate: the data layer hands it out per list scope (`useHold`), and the motion runtime (`triage.ts`, the closer, the
 * cursor) drives the same object. Its `heldIds` go to `useView` as `holdIds`, which pins the engine's order and queues
 * frames meanwhile; its releases run `close`.
 *
 * The rules (owner decisions, plans/STATUS.md 2026-10-28):
 * - A triage key starts or extends a hold that releases `hold.base` (450 ms) after the last key, so a burst of any
 *   length closes once.
 * - If the pointer is still on the list then, the hold waits for it to leave, but never past `hold.cap` (1200 ms)
 *   after the last key. The cap releases once (close runs once) and, if the pointer is still inside, at once begins a
 *   fresh pointer-only hold with no pins.
 * - A pointer resting on the list with no key holds until it leaves (new mail never moves the row under it). Only
 *   `pointerLeave()` forgets the pointer.
 * - Hiding the window releases and forgets the pointer: nothing paints while hidden, so arrivals land instead of
 *   queueing. The list re-asserts the pointer with `pointerEnter()` on its next pointermove (it is idempotent).
 *
 * Time comes from a `Timers`: the data layer's (wall clock, `document` visibility) or the motion `Scheduler`, which
 * is one (visible time, paused while hidden). Either way a hide releases, so no hold spans hidden time.
 */
import { motions } from '../ui/generated/motion';
import type { Id } from './contract-shapes';
import type { HoldController, HoldReason, HoldReleaseListener } from './index';
import type { Timers } from './scheduler';

/** Release this long after the last key (the `hold` motion's base). */
export const HOLD_RELEASE_MS = motions.hold.durations.base;
/** With the pointer still on the list, a key hold never lasts past this after the last key (the `hold` motion's cap). */
export const HOLD_CAP_MS = motions.hold.durations.cap;

/** A hold controller plus the pointer and what the data layer and motion need to observe it. */
export interface HoldGate extends HoldController {
  /** The pointer is over the list (same as `begin('pointer', ids)`). Idempotent, so call it on pointermove too. */
  pointerEnter(ids?: readonly Id[]): void;
  /** The pointer left the list: forget it and release now. */
  pointerLeave(): void;
  /** Called on every change of `isHeld` or `heldIds` (for `useSyncExternalStore`). */
  subscribe(listener: () => void): () => void;
  /** Bumped on every change. */
  readonly version: number;
  /** Stop listening for hides and drop every listener and timer. */
  dispose(): void;
}

export function createHoldGate(timers: Timers): HoldGate {
  const releaseListeners = new Set<HoldReleaseListener>();
  const changeListeners = new Set<() => void>();
  let held = false;
  let reason: HoldReason | null = null;
  let ids: readonly Id[] = [];
  let pointerInside = false;
  let lastKeyAt: number | null = null;
  let cancelTimer: (() => void) | null = null;
  let version = 0;

  const changed = () => {
    version++;
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

  // hold.base after the last key: release, unless the pointer still rests on the list, in which case wait for it
  // to leave until hold.cap after the last key.
  function onKeyTimer() {
    cancelTimer = null;
    if (!pointerInside || lastKeyAt === null) {
      release();
      return;
    }
    const waited = timers.now() - lastKeyAt;
    cancelTimer = timers.setTimeout(release, Math.max(0, HOLD_CAP_MS - waited));
  }

  function release() {
    clearTimer();
    if (!held) return;
    const released = { ids, reason: reason ?? 'keys' };
    held = false;
    reason = null;
    ids = [];
    lastKeyAt = null;
    changed();
    for (const listener of [...releaseListeners]) listener(released);
    // The pointer is still resting on the list: it keeps holding, with no pins.
    if (pointerInside && !held) begin('pointer', []);
  }

  function armKeyTimer() {
    clearTimer();
    lastKeyAt = timers.now();
    cancelTimer = timers.setTimeout(onKeyTimer, HOLD_RELEASE_MS);
  }

  function begin(why: HoldReason, more: readonly Id[]) {
    const wasHeld = held;
    if (!held) {
      held = true;
      reason = why;
      lastKeyAt = null;
    }
    if (why === 'pointer') pointerInside = true;
    else armKeyTimer();
    if (addIds(more) || !wasHeld) changed();
  }

  const stopHide =
    timers.onHide?.(() => {
      pointerInside = false;
      release();
    }) ?? (() => {});

  return {
    begin,
    extend(more) {
      if (!held) {
        begin('keys', more ?? []);
        return;
      }
      armKeyTimer();
      if (addIds(more)) changed();
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
    get version() {
      return version;
    },
    dispose() {
      stopHide();
      clearTimer();
      releaseListeners.clear();
      changeListeners.clear();
    },
  };
}
