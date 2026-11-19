/**
 * Which root a renderer window boots (plan 30 4.1): a pure rule, so `main.tsx` stays a thin switch and the rule has
 * unit tests. Main loads the onboarding window with `?window=onboarding&mode=first|review` (`main/windows.ts`
 * `loadRenderer`); every other window carries no `window` parameter and is the mail window.
 *
 * Order of the rule:
 * 1. The legacy switch wins (`VITE_APLOS_LEGACY=1` or `?legacy=1`). So does a build without the real engine's bridge
 *    that is not a development build: no release ships stand-in data, so the new roots boot outside development only
 *    on the real engine.
 * 2. Otherwise the onboarding window boots `OnboardingApp`, any other window boots `App`.
 *
 * `transportOf` then picks the session a new root connects: `window.aplosEngine` (the real engine, `bridge.ts`)
 * when the preload exposed it, the in-process stand-in otherwise (a development build without the bridge: previews,
 * tests, the demo). Preload exposes the bridge only on main's real-engine path (the default; main keeps the legacy
 * engine only on a folder with 0.2.x mail and no `mail.db`, see `realEngineRequested`), so a release boots the legacy
 * renderer only there.
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

/** True when the legacy renderer must boot: the env switch, `?legacy=1`, or a production build without the real engine. */
export function wantsLegacy({ search, dev, legacyEnv, bridge }: EntryInput): boolean {
  const params = new URLSearchParams(search);
  return (
    legacyEnv === true ||
    params.get('legacy') === '1' ||
    // A pop-out (`?draft=<id>` or `?thread=<id>`, main's `popout()`) is the legacy renderer's until the new one has them.
    params.has('draft') ||
    params.has('thread') ||
    (!dev && bridge !== true)
  );
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
  if (wantsLegacy(input)) return 'legacy';
  return windowKind(input.search, input.hook) === 'onboarding' ? 'onboarding' : 'app';
}

/**
 * The transport a new root connects: the real engine over `bridge.ts` when the window carries the preload bridge and is
 * not on the legacy path (`wantsLegacy` stays authoritative); the stand-in otherwise, which only a development build
 * reaches.
 */
export function transportOf(input: EntryInput): Transport {
  return input.bridge === true && !wantsLegacy(input) ? 'engine' : 'standin';
}
