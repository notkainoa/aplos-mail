/**
 * The app theme (DESIGN 4.8): the tokens go dark only under `:root[data-theme='dark']`, so something has to set that
 * attribute. The Theme setting (`settings.ui.theme`: light, dark or system, default system) picks it; `system` follows
 * the OS appearance (`prefers-color-scheme`) live. The entry starts the controller before the first paint so a dark Mac
 * never flashes light, and the shell hands it the saved setting once it is known.
 */

export type ThemeChoice = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

/** The theme a choice resolves to given whether the system is dark. */
export function resolveTheme(choice: ThemeChoice, systemDark: boolean): ResolvedTheme {
  if (choice === 'system') return systemDark ? 'dark' : 'light';
  return choice;
}

/** The part of the root element the controller writes. */
export interface ThemeRoot {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
}

/** The part of a `MediaQueryList` the controller reads. */
export interface ThemeMedia {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

export interface ThemeController {
  /** The saved Theme setting (system until it is known). */
  setChoice(choice: ThemeChoice): void;
  /** The theme now applied. */
  readonly current: ResolvedTheme;
  dispose(): void;
}

/** Applies the resolved theme to `root` now and again whenever the system appearance or the choice changes. */
export function createThemeController(
  root: ThemeRoot,
  media: ThemeMedia | null,
  initial: ThemeChoice = 'system',
): ThemeController {
  let choice = initial;
  let current: ResolvedTheme = 'light';
  const apply = (): void => {
    current = resolveTheme(choice, media?.matches === true);
    if (root.getAttribute('data-theme') !== current) root.setAttribute('data-theme', current);
  };
  media?.addEventListener('change', apply);
  apply();
  return {
    setChoice(next) {
      choice = next;
      apply();
    },
    get current() {
      return current;
    },
    dispose() {
      media?.removeEventListener('change', apply);
    },
  };
}

let active: ThemeController | null = null;

/** Starts following the system appearance on the document root (idempotent). Browser only. */
export function startSystemTheme(): ThemeController {
  if (active) return active;
  const media =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-color-scheme: dark)')
      : null;
  active = createThemeController(document.documentElement, media);
  return active;
}

/** Hands the saved Theme setting to the running controller (starts it if the entry has not). */
export function setThemeChoice(choice: ThemeChoice): void {
  startSystemTheme().setChoice(choice);
}
