// Theme switch (DESIGN 4.8): every transition is off for one frame, so the app
// changes at once. Sets the generated data-theme-switching hook on the root,
// applies the theme, forces a style pass while transitions are off, and clears
// the hook after timing.themeSwitchFrames frames. A switch during a freeze
// restarts the count.
import { themeHooks, timing } from '../ui/generated/motion';
import type { Scheduler } from './scheduler';

export interface ThemeFreeze {
  /** Runs `apply` (which sets data-theme and friends) with transitions frozen. */
  switchTheme(apply: () => void): void;
  readonly frozen: boolean;
  dispose(): void;
}

export function createThemeFreeze(root: HTMLElement, scheduler: Scheduler): ThemeFreeze {
  let cancel: (() => void) | null = null;

  function thaw() {
    cancel = null;
    root.removeAttribute(themeHooks.switching);
  }

  function countdown(frames: number) {
    cancel = scheduler.frame(() => {
      if (frames <= 1) thaw();
      else countdown(frames - 1);
    });
  }

  return {
    switchTheme(apply) {
      cancel?.();
      root.setAttribute(themeHooks.switching, '');
      apply();
      scheduler.env.flushStyle(root);
      countdown(timing.themeSwitchFrames);
    },
    get frozen() {
      return root.hasAttribute(themeHooks.switching);
    },
    dispose() {
      cancel?.();
      thaw();
    },
  };
}
