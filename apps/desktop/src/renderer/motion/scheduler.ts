// The one frame loop of the motion runtime (DESIGN 5 rules 13 and 15). Springs,
// the swipe and the theme freeze all run off this single requestAnimationFrame,
// and nothing here touches React, so no component re-renders per frame.
// While the window is hidden there is no frame request and timers are paused;
// visible time (now()) stops too, so a spring or a hold resumes where it was.
// A Scheduler is also the data layer's Timers (now, setTimeout, onHide), so the
// one hold gate (data/holds.ts) runs on this visible clock as is.
import type { Timers } from '../data/scheduler';
import type { MotionEnv, TimerHandle } from './env';

/** Runs every frame with visible time and the visible ms since its last run. Return false to stop. */
export type FrameTask = (now: number, dt: number) => boolean;

export interface Scheduler extends Timers {
  readonly env: MotionEnv;
  /** Visible milliseconds: the env clock minus the time spent hidden. */
  now(): number;
  readonly hidden: boolean;
  /** Run `task` every frame until it returns false or the returned function is called. */
  loop(task: FrameTask): () => void;
  /** Run once on the next frame. */
  frame(callback: (now: number) => void): () => void;
  /** Run after `ms` of visible time. Paused while hidden. */
  after(ms: number, callback: () => void): () => void;
  /** `after(ms, callback)` in the data layer's `Timers` shape. */
  setTimeout(callback: () => void, ms: number): () => void;
  onHide(listener: () => void): () => void;
  onShow(listener: () => void): () => void;
  /** Frame tasks, one-shot frames and timers still waiting. */
  readonly pending: number;
  dispose(): void;
}

interface LoopEntry {
  readonly task: FrameTask;
  last: number;
}

interface TimerEntry {
  readonly due: number;
  readonly callback: () => void;
  handle: TimerHandle | null;
}

export function createScheduler(env: MotionEnv): Scheduler {
  const loops = new Set<LoopEntry>();
  const frames = new Set<(now: number) => void>();
  const timers = new Set<TimerEntry>();
  const hideListeners = new Set<() => void>();
  const showListeners = new Set<() => void>();
  let frameId: number | null = null;
  let hidden = env.isHidden();
  let hiddenSince = hidden ? env.now() : 0;
  let hiddenTotal = 0;

  const now = () => (hidden ? hiddenSince : env.now()) - hiddenTotal;

  function requestFrame() {
    if (frameId !== null || hidden || (loops.size === 0 && frames.size === 0)) return;
    frameId = env.requestFrame(runFrame);
  }

  function runFrame() {
    frameId = null;
    const t = now();
    const once = [...frames];
    frames.clear();
    for (const callback of once) callback(t);
    for (const entry of [...loops]) {
      if (!loops.has(entry)) continue;
      const dt = Math.max(0, t - entry.last);
      entry.last = t;
      if (!entry.task(t, dt)) loops.delete(entry);
    }
    requestFrame();
  }

  function arm(entry: TimerEntry) {
    entry.handle = env.setTimer(
      () => {
        entry.handle = null;
        if (!timers.delete(entry)) return;
        entry.callback();
      },
      Math.max(0, entry.due - now()),
    );
  }

  function onVisibility() {
    const next = env.isHidden();
    if (next === hidden) return;
    if (next) {
      hiddenSince = env.now();
      hidden = true;
      if (frameId !== null) env.cancelFrame(frameId);
      frameId = null;
      for (const entry of timers) {
        if (entry.handle !== null) env.clearTimer(entry.handle);
        entry.handle = null;
      }
      for (const listener of [...hideListeners]) listener();
    } else {
      hiddenTotal += env.now() - hiddenSince;
      hidden = false;
      for (const entry of timers) arm(entry);
      for (const listener of [...showListeners]) listener();
      requestFrame();
    }
  }

  const unsubscribe = env.onVisibilityChange(onVisibility);

  function after(ms: number, callback: () => void) {
    const entry: TimerEntry = { due: now() + ms, callback, handle: null };
    timers.add(entry);
    if (!hidden) arm(entry);
    return () => {
      if (entry.handle !== null) env.clearTimer(entry.handle);
      timers.delete(entry);
    };
  }

  return {
    env,
    now,
    get hidden() {
      return hidden;
    },
    loop(task) {
      const entry: LoopEntry = { task, last: now() };
      loops.add(entry);
      requestFrame();
      return () => {
        loops.delete(entry);
      };
    },
    frame(callback) {
      const once = (t: number) => callback(t);
      frames.add(once);
      requestFrame();
      return () => {
        frames.delete(once);
      };
    },
    after,
    setTimeout: (callback, ms) => after(ms, callback),
    onHide(listener) {
      hideListeners.add(listener);
      return () => {
        hideListeners.delete(listener);
      };
    },
    onShow(listener) {
      showListeners.add(listener);
      return () => {
        showListeners.delete(listener);
      };
    },
    get pending() {
      return loops.size + frames.size + timers.size;
    },
    dispose() {
      unsubscribe();
      if (frameId !== null) env.cancelFrame(frameId);
      frameId = null;
      for (const entry of timers) if (entry.handle !== null) env.clearTimer(entry.handle);
      loops.clear();
      frames.clear();
      timers.clear();
      hideListeners.clear();
      showListeners.clear();
    },
  };
}
