// The motion runtime's window onto the platform. Everything time- or
// visibility-dependent goes through a MotionEnv, so tests inject a fake clock,
// a fake requestAnimationFrame and fake visibility, and the runtime itself
// never reads a global.
import { themeHooks } from '../ui/generated/motion';

export type TimerHandle = ReturnType<typeof setTimeout>;

export interface MotionEnv {
  /** Monotonic milliseconds (performance.now in the browser). */
  now(): number;
  requestFrame(callback: (time: number) => void): number;
  cancelFrame(id: number): void;
  setTimer(callback: () => void, ms: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  /** The window is hidden or occluded (document.hidden). */
  isHidden(): boolean;
  /** Returns an unsubscribe function. */
  onVisibilityChange(listener: () => void): () => void;
  /** prefers-reduced-motion, or the app's own data-motion="reduced" override. */
  prefersReducedMotion(): boolean;
  /** Forces a style recalculation on `element` (the theme freeze needs one). */
  flushStyle(element: Element): void;
}

/** The real platform. Only call it in a renderer with a document. */
export function browserEnv(): MotionEnv {
  const query = window.matchMedia(themeHooks.reducedMotionQuery);
  return {
    now: () => performance.now(),
    requestFrame: callback => window.requestAnimationFrame(callback),
    cancelFrame: id => window.cancelAnimationFrame(id),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: handle => clearTimeout(handle),
    isHidden: () => document.hidden,
    onVisibilityChange(listener) {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
    prefersReducedMotion: () =>
      query.matches || document.documentElement.getAttribute(themeHooks.motion) === 'reduced',
    flushStyle(element) {
      void window.getComputedStyle(element).opacity;
    },
  };
}
