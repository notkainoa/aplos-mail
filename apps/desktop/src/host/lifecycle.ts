/**
 * Window lifecycle decisions for the desktop host (host-1; ARCH 10 and DESIGN 7.11 "Window" and "Handoff").
 * Everything that touches Electron, the engine or a timer comes in through `OnboardingDeps`, so this file imports
 * nothing and runs under node:test. `main/windows.ts`, `main/lifecycle.ts` and `main/native-methods.ts` wire it up.
 * Its method names (`start`, `activate`, `open`, `finish`, `noteRendererSetupEnd`) are the ones `ui-onboard`'s own
 * `main/windows/onboarding.ts` uses, so that module can replace this controller without touching its callers.
 */

/** `Session/get.hasAccounts` and `.setup`: the facts main reads before it opens any window. */
export interface SessionFacts {
  /** Any account exists, demo accounts included. */
  readonly hasAccounts: boolean;
  readonly setup: { readonly completedAt?: number; readonly skippedAt?: number };
}

/** First run is no account and no recorded finish or skip, so "Skip setup" with zero accounts never reopens it. */
export function isFirstRun(facts: SessionFacts): boolean {
  return (
    !facts.hasAccounts &&
    facts.setup.completedAt === undefined &&
    facts.setup.skippedAt === undefined
  );
}

/** Which window a launch opens. `none` means the app stays windowless (resident). */
export type WindowChoice = 'onboarding' | 'mail' | 'none';

/** A login launch with no accounts stays windowless until the Dock or the menu-bar item is clicked. */
export function startupWindow(facts: SessionFacts, launch: { atLogin: boolean }): WindowChoice {
  if (!facts.hasAccounts && launch.atLogin) return 'none';
  return isFirstRun(facts) ? 'onboarding' : 'mail';
}

/** What a Dock click, a second launch (`second-instance`), a link or a notification does (never a second window). */
export type Activation = 'focus-mail' | 'focus-onboarding' | 'open-onboarding' | 'open-mail';

export function activation(
  open: { onboarding: boolean; mail: boolean },
  facts: SessionFacts,
): Activation {
  if (open.mail) return 'focus-mail';
  if (open.onboarding) return 'focus-onboarding';
  return isFirstRun(facts) ? 'open-onboarding' : 'open-mail';
}

/** The longest the handoff waits for the mail window's first paint before showing it anyway. */
export const READY_TIMEOUT_MS = 10_000;

/** The part of a window this module drives. `main/windows.ts` adapts a real `BrowserWindow`. */
export interface WindowPort {
  readonly id: number;
  isDestroyed(): boolean;
  isVisible(): boolean;
  /** `ready-to-show` has fired (the window may still be hidden: test mode, or minimized). */
  hasPainted(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  close(): void;
  /** Electron's `ready-to-show`, once. A listener added after it fired is never called. */
  onReadyToShow(listener: () => void): void;
  onClosed(listener: () => void): void;
}

export type OnboardingMode = 'first' | 'review';

export interface OnboardingDeps {
  /** A hidden onboarding window. It shows itself on its own `ready-to-show` (never in test mode). */
  createOnboarding(mode: OnboardingMode): WindowPort;
  /** The mail window, created hidden. It becomes `main`. */
  createMail(): WindowPort;
  currentMail(): WindowPort | undefined;
  /** `Setup/end {reason:'closed'}`. Idempotent in the engine; a rejection is swallowed (today's engine has no such call). */
  endSetup(): Promise<unknown>;
  /** The `desktop` frame's `shown` event: the window is up, the renderer may run its entrance. */
  announceShown(win: WindowPort): void;
  isQuitting(): boolean;
  /** Test mode never shows or focuses a window. */
  testMode: boolean;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface OnboardingController {
  start(facts: SessionFacts, launch: { atLogin: boolean }): WindowChoice;
  activate(facts: SessionFacts): Activation;
  open(mode: OnboardingMode): void;
  /** Resolves when the mail window is up and the onboarding window is gone (or the handoff was abandoned). */
  finish(): Promise<void>;
  /**
   * The renderer ended setup itself, so main's own call on close is skipped. Not called yet: the renderer's `Setup/end`
   * goes straight to the engine (`engine-host.ts`), so main still sends its own, which the engine treats as idempotent.
   */
  noteRendererSetupEnd(): void;
  isOpen(): boolean;
}

const alive = (win: WindowPort | undefined): win is WindowPort => !!win && !win.isDestroyed();
/** A mail window that is up: one still waiting for its first paint belongs to a handoff and is not "open" yet. */
const up = (win: WindowPort | undefined): win is WindowPort =>
  alive(win) && (win.isVisible() || win.hasPainted());

export function createOnboarding(deps: OnboardingDeps): OnboardingController {
  let win: WindowPort | undefined;
  let ended = false;
  let handoff: Promise<void> | undefined;

  function bring(target: WindowPort) {
    if (deps.testMode) return;
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
  }

  function onboardingClosed(closed: WindowPort) {
    if (win === closed) win = undefined;
    // Once per window, and not when the renderer already ended setup itself.
    if (!ended) void deps.endSetup().catch(() => {});
    ended = false;
    // Closing the welcome window must not leave the app with no window at all.
    // (The mail window shows itself on its own first paint.)
    if (!deps.isQuitting() && !alive(deps.currentMail())) deps.createMail();
  }

  function open(mode: OnboardingMode) {
    if (deps.isQuitting()) return;
    if (alive(win)) return bring(win);
    const created = deps.createOnboarding(mode);
    win = created;
    ended = false;
    created.onClosed(() => onboardingClosed(created));
  }

  function reveal(mail: WindowPort, done: () => void) {
    if (deps.isQuitting()) return done();
    bring(mail);
    deps.announceShown(mail);
    const onboarding = win;
    win = undefined;
    if (alive(onboarding)) onboarding.close();
    done();
  }

  function finish(): Promise<void> {
    if (handoff) return handoff;
    handoff = new Promise<void>(resolve => {
      const done = () => {
        handoff = undefined;
        resolve();
      };
      if (deps.isQuitting() || !alive(win)) return done();
      const existing = deps.currentMail();
      if (up(existing)) return reveal(existing, done);
      const mail = alive(existing) ? existing : deps.createMail();
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        deps.clearTimer(timer);
        reveal(mail, done);
      };
      const timer = deps.setTimer(settle, READY_TIMEOUT_MS);
      mail.onReadyToShow(settle);
      // The mail window closing before it paints abandons the handoff; the welcome window stays.
      mail.onClosed(() => {
        if (settled) return;
        settled = true;
        deps.clearTimer(timer);
        // The welcome window may have been closed meanwhile: never leave the app with no window.
        if (!alive(win) && !deps.isQuitting() && !alive(deps.currentMail())) deps.createMail();
        done();
      });
    });
    return handoff;
  }

  return {
    start(facts, launch) {
      const choice = startupWindow(facts, launch);
      if (choice === 'onboarding') open('first');
      return choice;
    },
    activate(facts) {
      const decision = activation({ onboarding: alive(win), mail: up(deps.currentMail()) }, facts);
      if (decision === 'focus-onboarding' && win) bring(win);
      if (decision === 'open-onboarding') open('first');
      return decision;
    },
    open,
    finish,
    noteRendererSetupEnd() {
      ended = true;
    },
    isOpen: () => alive(win),
  };
}

/** The macOS System Settings pane URL for each pane `System/openSettings` may name. Fixed strings, never built from input. */
export const settingsPanes = {
  notifications: 'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
  microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
  loginItems: 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension',
} as const;
export type SettingsPane = keyof typeof settingsPanes;

export function settingsPaneUrl(pane: unknown): string {
  if (typeof pane !== 'string' || !Object.hasOwn(settingsPanes, pane))
    throw new Error('Choose a settings pane to open.');
  return settingsPanes[pane as SettingsPane];
}
