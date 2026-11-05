/**
 * Which root a renderer window boots (plan 30 4.1): a pure rule, so `main.tsx` stays a thin switch and the rule has
 * unit tests. Main loads the onboarding window with `?window=onboarding&mode=first|review` (`main/windows.ts`
 * `loadRenderer`); every other window carries no `window` parameter and is the mail window.
 *
 * Order of the rule:
 * 1. The legacy switch wins (`VITE_APLOS_LEGACY=1` or `?legacy=1`), and so does every production build: no release
 *    ships stand-in data, so the new roots cannot boot there yet.
 * 2. In a development build the onboarding window boots `OnboardingApp`, any other window boots `App`.
 *
 * `transportOf` then picks the session a new root connects: `window.aplosEngine` (the real engine, `bridge.ts`)
 * when the preload exposed it, the in-process stand-in otherwise. A release never reaches it — rule 1 sends every
 * non-development build to the legacy renderer first — so the bridge can never boot there.
 *
 * The test hook `globalThis.__aplosWindowKind` (a browser test sets it before the entry runs) names the window kind
 * when the URL does not.
 */

/** The kinds of window the renderer boots as. */
export type WindowKind = 'mail' | 'onboarding';

/** The root the entry mounts. */
export type EntryKind = 'legacy' | 'app' | 'onboarding';

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
  /** `import.meta.env.VITE_APLOS_LEGACY === '1'`. */
  readonly legacyEnv?: boolean;
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

/** True when the legacy renderer must boot: the env switch, `?legacy=1`, or a build that is not a development build. */
export function wantsLegacy({ search, dev, legacyEnv }: EntryInput): boolean {
  return legacyEnv === true || new URLSearchParams(search).get('legacy') === '1' || !dev;
}

/** The root to mount. */
export function chooseEntry(input: EntryInput): EntryKind {
  if (wantsLegacy(input)) return 'legacy';
  return windowKind(input.search, input.hook) === 'onboarding' ? 'onboarding' : 'app';
}

/**
 * The transport a new root connects: the real engine over `bridge.ts` only when the window carries the preload
 * bridge and is not on the legacy path (`wantsLegacy` stays authoritative, so a development build without the
 * legacy switch is the one place `engine` comes back).
 */
export function transportOf(input: EntryInput): Transport {
  return input.bridge === true && !wantsLegacy(input) ? 'engine' : 'standin';
}
