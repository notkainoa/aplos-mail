/**
 * The onboarding window on the Electron main side (DESIGN 7.11 "Window" and "Handoff to the mail window"; plan 30 U8;
 * Appendix C F3, F4, F7). Everything that touches Electron, the engine, the clock or the other windows comes in through
 * `OnboardingDeps`, so this file imports no Electron value and runs under node:test. The decisions live in the pure
 * section below: Electron-free, so the tests share one source of truth and nothing there touches a window, a clock
 * or the engine. `windows.ts`, `lifecycle.ts` and `native-methods.ts` call this module as `onboarding.patch.md` says.
 */
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

/** `Session/get.hasAccounts` and `Session/get.setup`: the facts main reads before it opens any window. */
export interface SetupFacts {
  /** Any account exists, demo accounts included. */
  readonly hasAccounts: boolean;
  readonly setup: { readonly completedAt?: number; readonly skippedAt?: number };
}

/** First run is no account and no recorded finish or skip, so "Skip setup" with zero accounts never reopens it. */
export function isFirstRun(facts: SetupFacts): boolean {
  return (
    !facts.hasAccounts &&
    facts.setup.completedAt === undefined &&
    facts.setup.skippedAt === undefined
  );
}

/** Which window a launch or a Dock click opens. `none` means the app stays windowless (resident). */
export type WindowChoice = 'onboarding' | 'mail' | 'none';

/**
 * The window to open when the app starts. A login launch with no accounts stays windowless until the owner clicks
 * the Dock or the menu-bar item (plan 30 U8 window wish); with accounts it opens the mail window as before.
 */
export function startupWindow(
  facts: SetupFacts,
  launch: { readonly atLogin: boolean },
): WindowChoice {
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
export function onboardingQuery(mode: 'first' | 'review'): {
  window: 'onboarding';
  mode: 'first' | 'review';
} {
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

export type OnboardingMode = 'first' | 'review';

/** The part of a window this module drives. `adaptBrowserWindow` makes one from a real `BrowserWindow`. */
export interface WindowPort {
  readonly id: number;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  close(): void;
  setOpacity(value: number): void;
  /** `webContents.send`: the renderer's `aplos:event` channel (today) or the desktop frame (contract v1). */
  send(channel: string, payload: unknown): void;
  /** Electron's `ready-to-show`, once. */
  onReadyToShow(listener: () => void): void;
  /** Electron's `closed`. */
  onClosed(listener: () => void): void;
  /** `did-finish-load`: the renderer can now be sent the engine's current state. */
  onLoaded(listener: () => void): void;
  /** Trusted renderer URLs only; anything else is cancelled (will-navigate, will-redirect) and window.open is denied. */
  lockNavigation(isTrusted: (url: string) => boolean, openOutside: (url: string) => void): void;
  /** The renderer, in dev (`devURL`) or from the built file, with the onboarding route in the query. */
  load(target: { devURL?: string; file: string }, query: Record<string, string>): void;
}

/** The engine calls this module makes. Main reaches the engine through `service.invoke` today. */
export interface EnginePort {
  call(method: 'Setup/end', input: { reason: 'closed' }): Promise<unknown>;
  call(
    method: 'Settings/set',
    input: { opId: string; patch: { ui: { lastAccount: 'all' } } },
  ): Promise<unknown>;
}

export interface MailPort {
  /** The mail window if one exists. */
  current(): WindowPort | undefined;
  /** A new mail window, created hidden. It shows on `ready-to-show` only when this module says so. */
  create(): WindowPort;
}

export interface Clock {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface OnboardingDeps {
  /** `new BrowserWindow(options)`, adapted. Called with the options this module builds. */
  createWindow(options: BrowserWindowConstructorOptions): WindowPort;
  engine: EnginePort;
  mail: MailPort;
  /** How many accounts exist (demo included); `Session/get` or the engine's account list. */
  countAccounts(): Promise<number>;
  /** `APLOS_TEST=1`: no window is ever shown or focused. */
  testMode: boolean;
  /** `nativeTheme.shouldUseDarkColors`. */
  dark(): boolean;
  preloadPath: string;
  /** `trustedURL` and `external` from `security.ts`, and `devURL` and `rendererFile`. */
  trustedURL(url: string): boolean;
  openExternal(url: string): Promise<unknown> | void;
  target: { devURL?: string; file: string };
  clock: Clock;
  /** A fresh id for a `Settings/set`. */
  opId(): string;
  /** The window exists: add it to `windows` so state events and quit reach it. */
  onCreated?(win: WindowPort): void;
  /** The window closed: remove it from `windows`, then `finishQuit` if it was the last. */
  onClosed?(win: WindowPort): void;
  /** `did-finish-load`: send the engine's current state, as `createWindow` does for the mail window. */
  onLoaded?(win: WindowPort): void;
  /** The `shown` desktop event for this window (wire.ts `DesktopEvent`): the renderer starts its entrance. */
  sendShown(win: WindowPort): void;
}

/** The constructor options: 640 x 600, 520 minimum, the width fixed, vertical resize only (U8 acceptance 5; F13). */
export function onboardingOptions(
  deps: Pick<OnboardingDeps, 'dark' | 'preloadPath'>,
): BrowserWindowConstructorOptions {
  return {
    width: WINDOW.width,
    height: WINDOW.height,
    minWidth: WINDOW.width,
    maxWidth: WINDOW.width,
    minHeight: WINDOW.minHeight,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    center: true,
    title: 'Aplos Mail',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: WINDOW.trafficLights,
    backgroundColor: backgroundFor(deps.dark()),
    show: false,
    // No `icon`: the app icon is dropped (DESIGN decision 13).
    webPreferences: {
      preload: deps.preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      // The address field is not prose.
      spellcheck: false,
    },
  };
}

/** One onboarding window and the facts about it. */
export interface OnboardingHandle {
  readonly window: WindowPort;
  readonly mode: OnboardingMode;
  /** Setup has been ended (by the renderer, seen going past main, or by main). */
  readonly ended: boolean;
  /** The renderer's own `Setup/end` went past main: main need not send its own. */
  noteRendererEnd(): void;
}

/**
 * Creates the window hidden and wires it: shown on `ready-to-show` except in test mode, navigation locked to the app,
 * and `Setup/end {reason:'closed'}` sent once when it closes (idempotent with the renderer's call).
 */
export function createOnboardingWindow(
  deps: OnboardingDeps,
  mode: OnboardingMode,
): OnboardingHandle {
  const window = deps.createWindow(onboardingOptions(deps));
  const state = { ended: false };
  deps.onCreated?.(window);
  window.lockNavigation(deps.trustedURL, url => {
    // Test mode never opens a browser (it would take focus).
    if (!deps.testMode) void Promise.resolve(deps.openExternal(url)).catch(() => {});
  });
  window.onReadyToShow(() => {
    if (!deps.testMode) window.show();
    // Test mode sends it too, so the renderer reaches its entrance state in a window nobody sees.
    deps.sendShown(window);
  });
  window.onLoaded(() => deps.onLoaded?.(window));
  window.onClosed(() => {
    deps.onClosed?.(window);
    if (shouldEndSetup(state)) {
      state.ended = true;
      void deps.engine.call('Setup/end', { reason: 'closed' }).catch(() => {});
    }
  });
  window.load(deps.target, onboardingQuery(mode));
  return {
    window,
    mode,
    get ended() {
      return state.ended;
    },
    noteRendererEnd() {
      state.ended = true;
    },
  };
}

/** Brings a window forward. Test mode never shows or focuses anything. */
function reveal(deps: Pick<OnboardingDeps, 'testMode'>, win: WindowPort): void {
  if (deps.testMode || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** Fades the window out over 120 ms and closes it; closes it anyway 300 ms after the start if the fade stalls (F4). */
function fadeAndClose(deps: Pick<OnboardingDeps, 'clock'>, win: WindowPort): void {
  if (win.isDestroyed()) return;
  const opacities = fadeOpacities();
  const gap = FADE_MS / (opacities.length - 1);
  let index = 0;
  let finished = false;
  let stepTimer: unknown;
  const close = () => {
    if (finished) return;
    finished = true;
    deps.clock.clearTimeout(stepTimer);
    deps.clock.clearTimeout(forceTimer);
    if (!win.isDestroyed()) win.close();
  };
  const forceTimer = deps.clock.setTimeout(close, FORCE_CLOSE_MS);
  const step = () => {
    if (finished) return;
    try {
      if (win.isDestroyed()) return close();
      win.setOpacity(opacities[index]!);
    } catch {
      return close();
    }
    if (index === opacities.length - 1) return close();
    index += 1;
    stepTimer = deps.clock.setTimeout(step, gap);
  };
  step();
}

export interface Onboarding {
  /** An onboarding window exists. */
  isOpen(): boolean;
  /** `Window/openOnboarding {mode}`: opens the window, or focuses the one that exists (F3). */
  open(mode: OnboardingMode): 'created' | 'focused';
  /** Startup: opens the onboarding window itself when that is the choice; the caller opens the mail window for `mail`. */
  start(facts: SetupFacts, launch: { atLogin: boolean }): WindowChoice;
  /**
   * `second-instance`, the Dock and the menu-bar item. Does the onboarding half (focus or open) and returns the
   * decision, so the caller does the mail half for `focus-mail` and `open-mail`.
   */
  activate(facts: SetupFacts): Activation;
  /** `Window/finishOnboarding`: mail window hidden, shown on `ready-to-show`, onboarding faded and closed. */
  finish(): Promise<void>;
  /** The renderer's `Setup/end` went past main (the host's invoke handler saw it). Optional; the engine is idempotent. */
  noteRendererSetupEnd(): void;
}

export function createOnboarding(deps: OnboardingDeps): Onboarding {
  let current: OnboardingHandle | undefined;
  let handingOff: Promise<void> | undefined;
  const alive = () => (current && !current.window.isDestroyed() ? current : undefined);
  const mailOpen = () => {
    const mail = deps.mail.current();
    return !!mail && !mail.isDestroyed();
  };
  const open = (mode: OnboardingMode): 'created' | 'focused' => {
    const existing = alive();
    if (existing && openRequest({ onboarding: true, mail: mailOpen() }) === 'focus') {
      reveal(deps, existing.window);
      return 'focused';
    }
    const handle = createOnboardingWindow(deps, mode);
    current = handle;
    handle.window.onClosed(() => {
      if (current === handle) current = undefined;
    });
    return 'created';
  };
  const run = async (): Promise<void> => {
    const onboarding = alive();
    const existing = deps.mail.current();
    if (existing && !existing.isDestroyed()) {
      // "Show welcome" beside a mail window, or a zero-accounts window: nothing to change, just hand back.
      reveal(deps, existing);
      if (onboarding) fadeAndClose(deps, onboarding.window);
      return;
    }
    // F7: the mail window reads `ui.lastAccount` when it starts, so it is set before the window exists.
    const count = await deps.countAccounts().catch(() => 0);
    if (lastAccountAfterOnboarding(count))
      await deps.engine
        .call('Settings/set', { opId: deps.opId(), patch: { ui: { lastAccount: 'all' } } })
        .catch(() => {});
    const mail = deps.mail.create();
    let handled = false;
    const ready = () => {
      if (handled) return;
      handled = true;
      deps.clock.clearTimeout(timer);
      reveal(deps, mail);
      // The same callback: the mail window is on screen, so the fade has no blank frame under it (F4).
      const still = alive();
      if (still) fadeAndClose(deps, still.window);
    };
    mail.onReadyToShow(ready);
    const timer = deps.clock.setTimeout(ready, READY_TIMEOUT_MS);
  };
  return {
    isOpen: () => !!alive(),
    open,
    start(facts, launch) {
      const choice = startupWindow(facts, launch);
      if (choice === 'onboarding') open('first');
      return choice;
    },
    activate(facts) {
      const decision = activation({ onboarding: !!alive(), mail: mailOpen() }, facts);
      if (decision.kind === 'focus-onboarding') reveal(deps, alive()!.window);
      if (decision.kind === 'open-onboarding') open('first');
      return decision;
    },
    finish() {
      if (!handingOff) {
        const pending = run().finally(() => {
          if (handingOff === pending) handingOff = undefined;
        });
        handingOff = pending;
      }
      return handingOff;
    },
    noteRendererSetupEnd() {
      current?.noteRendererEnd();
    },
  };
}

/** Adapts a real `BrowserWindow` (created by the host with `onboardingOptions`) to the port. */
export function adaptBrowserWindow(win: BrowserWindow): WindowPort {
  return {
    id: win.id,
    isDestroyed: () => win.isDestroyed(),
    isMinimized: () => win.isMinimized(),
    restore: () => win.restore(),
    show: () => win.show(),
    focus: () => win.focus(),
    close: () => win.close(),
    setOpacity: value => win.setOpacity(value),
    send: (channel, payload) => win.webContents.send(channel, payload),
    onReadyToShow: listener => void win.once('ready-to-show', listener),
    onClosed: listener => void win.on('closed', listener),
    onLoaded: listener => void win.webContents.on('did-finish-load', listener),
    lockNavigation(isTrusted, openOutside) {
      win.webContents.on('will-navigate', (event, url) => {
        if (!isTrusted(url)) {
          event.preventDefault();
          openOutside(url);
        }
      });
      win.webContents.on('will-redirect', (event, url) => {
        if (!isTrusted(url)) event.preventDefault();
      });
      win.webContents.setWindowOpenHandler(({ url }) => {
        openOutside(url);
        return { action: 'deny' };
      });
    },
    load(target, query) {
      if (target.devURL) {
        const url = new URL(target.devURL);
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
        void win.loadURL(url.href);
      } else void win.loadFile(target.file, { query });
    },
  };
}
