/**
 * Which root a renderer window boots (plan 30 4.1): a pure rule, so `main.tsx` stays a thin switch and the rule has
 * unit tests. Main loads the onboarding window with `?window=onboarding&mode=first|review` (`main/windows.ts`
 * `loadRenderer`); every other window carries no `window` parameter and is the mail window.
 *
 * `transportOf` then picks the session a root connects: `window.aplosEngine` (the real engine, `bridge.ts`) when the
 * preload exposed it, the in-process stand-in otherwise (a development build without the bridge: previews, tests, the
 * demo). A build that is not a development build never uses the stand-in: without the bridge it shows the fatal screen.
 *
 * The test hook `globalThis.__aplosWindowKind` (a browser test sets it before the entry runs) names the window kind
 * when the URL does not.
 */

/** The kinds of window the renderer boots as. */
export type WindowKind = 'mail' | 'onboarding';

/** The root the entry mounts. */
export type EntryKind = 'app' | 'onboarding';

/** The session a new root connects the data layer to: the real engine over the bridge, or the stand-in. */
export type Transport = 'engine' | 'standin';

/** The onboarding window's two modes (`Window/openOnboarding`). */
export type OnboardingMode = 'first' | 'review';

/** What the entry needs to choose. */
export interface EntryInput {
  /** `location.search`. */
  readonly search: string;
  /** A development build (`import.meta.env.DEV`). */
  readonly dev: boolean;
  /** The test hook's value, if any. */
  readonly hook?: string;
  /** `window.aplosEngine` is present (the preload's real-engine path); the boot adds it after the dynamic import. */
  readonly bridge?: boolean;
}

/** The window kind: the URL's `window` parameter, else the test hook, else the mail window. */
export function windowKind(search: string, hook?: string): WindowKind {
  const named = new URLSearchParams(search).get('window') ?? hook;
  return named === 'onboarding' ? 'onboarding' : 'mail';
}

/** `first` (the default, a fresh install) or `review` ("Show welcome"). */
export function onboardingMode(search: string): OnboardingMode {
  return new URLSearchParams(search).get('mode') === 'review' ? 'review' : 'first';
}

/**
 * Whether `host` carries the preload's engine bridge (`window.aplosEngine` with `call` and `subscribe`), read without
 * loading `bridge.ts`. Never throws. `bridge.ts` validates it again before a session is made.
 */
export function hasBridgeShape(host: unknown = globalThis): boolean {
  try {
    const api = (host as { aplosEngine?: { call?: unknown; subscribe?: unknown } } | null)
      ?.aplosEngine;
    return (
      api !== null &&
      typeof api === 'object' &&
      typeof api.call === 'function' &&
      typeof api.subscribe === 'function'
    );
  } catch {
    return false;
  }
}

/** The root to mount. */
export function chooseEntry(input: EntryInput): EntryKind {
  return windowKind(input.search, input.hook) === 'onboarding' ? 'onboarding' : 'app';
}

/** The transport a root connects: the real engine over `bridge.ts` when the window carries the preload bridge, the stand-in otherwise. */
export function transportOf(input: EntryInput): Transport {
  return input.bridge === true ? 'engine' : 'standin';
}
