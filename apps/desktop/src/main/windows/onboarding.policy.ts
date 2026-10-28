/**
 * The onboarding window's decisions (DESIGN 7.11 "Window" and "Handoff to the mail window"; Appendix C F3, F4, F7).
 * Pure and Electron-free, so `main/windows/onboarding.ts` and the tests share one source of truth. Nothing here
 * touches a window, a clock or the engine.
 */

/** `Session/get.hasAccounts` and `Session/get.setup`: the facts main reads before it opens any window. */
export interface SetupFacts {
  /** Any account exists, demo accounts included. */
  readonly hasAccounts: boolean;
  readonly setup: { readonly completedAt?: number; readonly skippedAt?: number };
}

/** First run is no account and no recorded finish or skip, so "Skip setup" with zero accounts never reopens it. */
export function isFirstRun(facts: SetupFacts): boolean {
  return !facts.hasAccounts && facts.setup.completedAt === undefined && facts.setup.skippedAt === undefined;
}

/** Which window a launch or a Dock click opens. `none` means the app stays windowless (resident). */
export type WindowChoice = 'onboarding' | 'mail' | 'none';

/**
 * The window to open when the app starts. A login launch with no accounts stays windowless until the owner clicks
 * the Dock or the menu-bar item (plan 30 U8 window wish); with accounts it opens the mail window as before.
 */
export function startupWindow(facts: SetupFacts, launch: { readonly atLogin: boolean }): WindowChoice {
  if (!facts.hasAccounts && launch.atLogin) return 'none';
  return isFirstRun(facts) ? 'onboarding' : 'mail';
}

/** What is open right now. */
export interface OpenWindows {
  readonly onboarding: boolean;
  readonly mail: boolean;
}

/** What a second launch or a Dock click does (F3: never a second onboarding window, never two windows at startup). */
export type Activation =
  | { readonly kind: 'focus-mail' }
  | { readonly kind: 'focus-onboarding' }
  | { readonly kind: 'open-onboarding'; readonly mode: 'first' }
  | { readonly kind: 'open-mail' };

/**
 * A Dock click, a second launch (`second-instance`), a link or a notification. An open mail window answers it (the
 * onboarding window beside it, in review mode, stays where it is); otherwise an open onboarding window is focused;
 * otherwise nothing is open and the click opens what a startup would, except that a login launch no longer applies.
 */
export function activation(open: OpenWindows, facts: SetupFacts): Activation {
  if (open.mail) return { kind: 'focus-mail' };
  if (open.onboarding) return { kind: 'focus-onboarding' };
  return isFirstRun(facts) ? { kind: 'open-onboarding', mode: 'first' } : { kind: 'open-mail' };
}

/** `Window/openOnboarding {mode}` while an onboarding window already exists: focus it, whatever the mode (F3). */
export function openRequest(open: OpenWindows): 'create' | 'focus' {
  return open.onboarding ? 'focus' : 'create';
}

/** Review mode ("Show welcome") opens beside an existing mail window and changes nothing; first mode owns the screen. */
export function opensBesideMail(mode: 'first' | 'review', open: OpenWindows): boolean {
  return mode === 'review' && open.mail;
}

/** The handoff's timings (DESIGN 7.11): the fade, and the longest main waits for it before closing the window anyway. */
export const FADE_MS = 120;
export const FORCE_CLOSE_MS = 300;
/** How many opacity steps the fade takes; 15 ms apart they stay under one frame budget each. */
export const FADE_STEPS = 8;
/** The mail window had no `ready-to-show` in this long: show it anyway rather than leave the owner on a dead end. */
export const READY_TIMEOUT_MS = 10_000;

/** The opacities of the fade, 1 first: strictly decreasing, ending at 0. */
export function fadeOpacities(steps: number = FADE_STEPS): number[] {
  return Array.from({ length: steps + 1 }, (_, i) => Number((1 - i / steps).toFixed(4)));
}

/** The handoff's order, as data, so a test and a reader see the same sequence (F4). */
export const HANDOFF_ORDER = [
  'all-accounts',
  'create-mail-hidden',
  'mail-ready-to-show',
  'show-mail',
  'fade-onboarding',
  'close-onboarding',
] as const;
export type HandoffStep = (typeof HANDOFF_ORDER)[number];

/**
 * F7: with two or more accounts the mail window opens on All accounts. Returns the `ui.lastAccount` to store, or
 * undefined when nothing should change (one account has nothing to filter; no account is the zero-accounts state).
 */
export function lastAccountAfterOnboarding(accountCount: number): 'all' | undefined {
  return accountCount >= 2 ? 'all' : undefined;
}

/** `Setup/end` reasons main may send itself. The renderer sends `finished`, `skipped` and `demo`. */
export type SetupEndReason = 'closed';

/**
 * Main calls `Setup/end {reason:'closed'}` once per onboarding window, on close, unless the renderer's own call
 * was already seen going past main. The engine treats the call as idempotent either way.
 */
export function shouldEndSetup(state: { readonly ended: boolean }): boolean {
  return !state.ended;
}

/** The renderer route (`renderer/onboarding/showWelcome.ts` builds the same query for the browser preview). */
export function onboardingQuery(mode: 'first' | 'review'): { window: 'onboarding'; mode: 'first' | 'review' } {
  return { window: 'onboarding', mode };
}

/** The window's fixed numbers: 640 wide, 600 tall, never shorter than 520 (U8 acceptance 5). */
export const WINDOW = {
  width: 640,
  height: 600,
  minHeight: 520,
  /** The top strip is 48 px; the traffic lights centre in it. */
  trafficLights: { x: 20, y: 16 },
} as const;

/** The window's background before the renderer paints, matching `--canvas` in each theme. */
export function backgroundFor(dark: boolean): string {
  return dark ? '#191a1c' : '#ffffff';
}
