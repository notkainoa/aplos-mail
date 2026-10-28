/**
 * Holding still, the renderer half (DESIGN 4.8 hold, 5 rule 6, plan 30 4.1 and 4.3). This is the one hold gate and
 * there is one per list: the data layer hands it out per scope (`useHold(scope)`, `layer.hold(scope)`), and the
 * screen gives that same object to the motion runtime (`createTriageMotion({hold})`). Its `heldIds` go to `useView`
 * as `holdIds`, which pins the engine's order and queues frames while they are non-empty; its releases run `close`.
 *
 * The rules (owner decisions, plans/STATUS.md 2026-10-28):
 * - A triage key starts or extends a hold that releases `hold.base` (450 ms) after the last key, so a burst of any
 *   length closes once. The pointer only lengthens a key hold: leaving inside those 450 ms does not cut it short.
 * - If the pointer is still on the list then, the hold waits for it to leave, but never past `hold.cap` (1200 ms)
 *   after the last key. The cap releases once (close runs once) and, if the pointer is still inside, at once begins a
 *   fresh pointer-only hold with no key pins: its `heldIds` are only the row under the pointer, so the window stays
 *   frozen (new mail never moves the row under it) while the burst's gap closes. There is no moment in between where
 *   the window lets queued frames through.
 * - A pointer resting on the list with no key holds until it leaves. Only `pointerLeave()` forgets the pointer;
 *   Esc (`release()`) closes what is held and the resting pointer keeps holding the same way as after the cap.
 * - Hiding the window releases and forgets the pointer: nothing paints while hidden, so arrivals land instead of
 *   queueing. The list re-asserts the pointer with `pointerEnter([hoveredId])` on its next pointermove.
 *
 * The list passes the row under the pointer to `pointerEnter(ids)`: the engine only freezes a window whose
 * `holdIds` are non-empty, so a pointer hold with no ids holds the gate but not the rows. `pointerEnter()` with no
 * ids keeps the ids it last had, so calling it on every pointermove is idempotent.
 *
 * With only the frozen `HoldController` surface, `begin('pointer', ids)` starts a pointer hold that `release()` ends
 * (the pointer left the list, Esc or navigation); it waits out key holds the same way until then.
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
  /**
   * The pointer is over the list; `ids` is the row under it. Idempotent, so call it on pointermove too; with no ids
   * the pointer keeps the row it last had.
   */
  pointerEnter(ids?: readonly Id[]): void;
  /** The pointer left the list: forget it; release now unless a key's 450 ms are still running. */
  pointerLeave(): void;
  /** Called on every change of `isHeld`, `heldIds` or `reason` (for `useSyncExternalStore`). */
  subscribe(listener: () => void): () => void;
  /** Bumped on every change. */
  readonly version: number;
  /** Stop listening for hides and drop every listener and timer. */
  dispose(): void;
}

/** How the gate knows about the pointer: `pointerEnter` (until `pointerLeave`), or `begin('pointer')` (until `release`). */
type Pointer = 'none' | 'entered' | 'begun';

export function createHoldGate(timers: Timers): HoldGate {
  const releaseListeners = new Set<HoldReleaseListener>();
  const changeListeners = new Set<() => void>();
  let held = false;
  let reason: HoldReason | null = null;
  let ids: readonly Id[] = [];
  let pointer: Pointer = 'none';
  /** The row under the pointer, the pins of a pointer-only hold. */
  let pointerIds: readonly Id[] = [];
  let lastKeyAt: number | null = null;
  /** Past `hold.base` after the last key, the pointer still on the list: waiting for it to leave until the cap. */
  let waiting = false;
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

  function forgetPointer() {
    pointer = 'none';
    pointerIds = [];
  }

  // hold.base after the last key: release, unless the pointer still rests on the list, in which case wait for it
  // to leave until hold.cap after the last key.
  function onKeyTimer() {
    cancelTimer = null;
    if (pointer === 'none' || lastKeyAt === null) {
      close();
      return;
    }
    waiting = true;
    const waited = timers.now() - lastKeyAt;
    cancelTimer = timers.setTimeout(close, Math.max(0, HOLD_CAP_MS - waited));
  }

  /** Close what is held, once. A pointer still on the list goes straight on holding its own row. */
  function close() {
    clearTimer();
    if (!held) return;
    const released = { ids, reason: reason ?? 'keys' };
    lastKeyAt = null;
    waiting = false;
    const before = { reason, ids };
    if (pointer !== 'none') {
      reason = 'pointer';
      ids = pointerIds;
    } else {
      held = false;
      reason = null;
      ids = [];
    }
    if (!held || before.reason !== reason || before.ids.join('\u0000') !== ids.join('\u0000'))
      changed();
    for (const listener of [...releaseListeners]) listener(released);
  }

  function armKeyTimer() {
    clearTimer();
    lastKeyAt = timers.now();
    waiting = false;
    cancelTimer = timers.setTimeout(onKeyTimer, HOLD_RELEASE_MS);
  }

  function hold(why: HoldReason, more: readonly Id[]) {
    const wasHeld = held;
    const wasReason = reason;
    held = true;
    if (why === 'keys') {
      // A key joins: this is a key hold now (one that may wait on the pointer).
      reason = 'keys';
      armKeyTimer();
    } else if (!wasHeld) reason = 'pointer';
    if (addIds(more) || !wasHeld || wasReason !== reason) changed();
  }

  function notePointer(more: readonly Id[]) {
    if (more.length > 0) pointerIds = [...new Set(more)];
  }

  const stopHide =
    timers.onHide?.(() => {
      forgetPointer();
      close();
    }) ?? (() => {});

  return {
    begin(why, more) {
      if (why === 'pointer') {
        if (pointer === 'none') pointer = 'begun';
        notePointer(more);
      }
      hold(why, more);
    },
    extend(more) {
      hold('keys', more ?? []);
    },
    release() {
      // Esc or navigation. A pointer the gate heard of through begin() has no pointerLeave: release() is its leave.
      if (pointer === 'begun') forgetPointer();
      close();
    },
    pointerEnter(more = []) {
      pointer = 'entered';
      notePointer(more);
      hold('pointer', pointerIds);
    },
    pointerLeave() {
      forgetPointer();
      // Inside a key's 450 ms the key timer still decides; it releases then, the pointer being gone.
      if (lastKeyAt !== null && !waiting) return;
      close();
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
