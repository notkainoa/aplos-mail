/**
 * The onboarding window on the Electron main side (DESIGN 7.11 "Window" and "Handoff to the mail window"; plan 30 U8;
 * Appendix C F3, F4, F7). Everything that touches Electron, the engine, the clock or the other windows comes in through
 * `OnboardingDeps`, so this file imports no Electron value and runs under node:test. The decisions live in
 * `onboarding.policy.ts`. `windows.ts`, `lifecycle.ts` and `native-methods.ts` call it as `onboarding.patch.md` says.
 */
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import {
  FADE_MS,
  FORCE_CLOSE_MS,
  READY_TIMEOUT_MS,
  WINDOW,
  activation,
  backgroundFor,
  fadeOpacities,
  lastAccountAfterOnboarding,
  onboardingQuery,
  openRequest,
  shouldEndSetup,
  startupWindow,
  type Activation,
  type SetupFacts,
  type WindowChoice,
} from './onboarding.policy';

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
export function createOnboardingWindow(deps: OnboardingDeps, mode: OnboardingMode): OnboardingHandle {
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
  let forceTimer: unknown;
  const close = () => {
    if (finished) return;
    finished = true;
    deps.clock.clearTimeout(stepTimer);
    deps.clock.clearTimeout(forceTimer);
    if (!win.isDestroyed()) win.close();
  };
  forceTimer = deps.clock.setTimeout(close, FORCE_CLOSE_MS);
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
    let timer: unknown;
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
    timer = deps.clock.setTimeout(ready, READY_TIMEOUT_MS);
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
