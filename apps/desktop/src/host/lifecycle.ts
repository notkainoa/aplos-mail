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

/**
 * A login launch (`wasOpenedAtLogin`) stays windowless, with or without accounts, until the Dock or the menu-bar item
 * is clicked (host-2: Aplos at login is a menu-bar app and must not throw a window at the owner after a restart).
 */
export function startupWindow(facts: SessionFacts, launch: { atLogin: boolean }): WindowChoice {
  if (launch.atLogin) return 'none';
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
/** The handoff's fade (DESIGN 7.11): the welcome window thins out over `FADE_MS` in `FADE_STEPS` steps, and closes by `FORCE_CLOSE_MS` whatever happens. */
export const FADE_MS = 120;
export const FADE_STEPS = 8;
export const FORCE_CLOSE_MS = 300;

/** The opacities of the fade: 1 first, strictly decreasing, ending at 0. */
export function fadeOpacities(steps: number = FADE_STEPS): number[] {
  return Array.from({ length: steps + 1 }, (_, i) => Number((1 - i / steps).toFixed(4)));
}

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
  /** `BrowserWindow.setOpacity`; a port without it closes without a fade. */
  setOpacity?(value: number): void;
  /** Electron's `ready-to-show`, once. A listener added after it fired is never called. */
  onReadyToShow(listener: () => void): void;
  onClosed(listener: () => void): void;
}

export type OnboardingMode = 'first' | 'review';

/** Where the mail window opens after the handoff instead of Home (`Window/finishOnboarding { to }`). */
export type FinishDestination = 'settings.ai';

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
  /** Tell the mail window to open `to` (the renderer's `navigate` event). Called once, after the window is shown. */
  navigate?(win: WindowPort, to: FinishDestination): void;
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
  /**
   * Resolves when the mail window is up and the onboarding window is gone (or the handoff was abandoned). `to` opens
   * the mail window on that screen instead of Home; a second call while a handoff runs joins it and its `to` is ignored.
   */
  finish(options?: { to?: FinishDestination }): Promise<void>;
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

  function reveal(mail: WindowPort, done: () => void, to?: FinishDestination) {
    if (deps.isQuitting()) return done();
    bring(mail);
    deps.announceShown(mail);
    if (to) deps.navigate?.(mail, to);
    const onboarding = win;
    win = undefined;
    if (alive(onboarding)) fadeAndClose(onboarding, done);
    else done();
  }

  /** The mail window is already on screen, so the fade has no blank frame under it (F4). Test mode and a port without opacity close at once. */
  function fadeAndClose(target: WindowPort, done: () => void) {
    const setOpacity = target.setOpacity?.bind(target);
    if (deps.testMode || !setOpacity) {
      target.close();
      return done();
    }
    const opacities = fadeOpacities();
    const gap = FADE_MS / (opacities.length - 1);
    let index = 0;
    let finished = false;
    let stepTimer: unknown;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (stepTimer !== undefined) deps.clearTimer(stepTimer);
      deps.clearTimer(forceTimer);
      if (alive(target)) target.close();
      done();
    };
    const forceTimer = deps.setTimer(finish, FORCE_CLOSE_MS);
    const step = () => {
      if (finished) return;
      try {
        if (!alive(target)) return finish();
        setOpacity(opacities[index]!);
      } catch {
        return finish();
      }
      if (index === opacities.length - 1) return finish();
      index += 1;
      stepTimer = deps.setTimer(step, gap);
    };
    step();
  }

  function finish(options?: { to?: FinishDestination }): Promise<void> {
    if (handoff) return handoff;
    const to = options?.to;
    handoff = new Promise<void>(resolve => {
      const done = () => {
        handoff = undefined;
        resolve();
      };
      if (deps.isQuitting() || !alive(win)) return done();
      const existing = deps.currentMail();
      if (up(existing)) return reveal(existing, done, to);
      const mail = alive(existing) ? existing : deps.createMail();
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        deps.clearTimer(timer);
        reveal(mail, done, to);
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

// ---- host-2: resident mode, the quit warning, process states and the quit drain ----------------------------------

/** macOS Dock presence. With no window Aplos is an `accessory` (no Dock icon, no app menu); test mode always is. */
export type ActivationPolicy = 'regular' | 'accessory';

export function activationPolicy(openWindows: number, testMode: boolean): ActivationPolicy {
  if (testMode) return 'accessory';
  return openWindows > 0 ? 'regular' : 'accessory';
}

/** The shape of `Outbox/pending` (packages/contract/src/api/core.ts). `nextAt` is epoch milliseconds. */
export interface PendingWork {
  readonly scheduledSends: number;
  readonly reminders: number;
  readonly uncertain: number;
  readonly nextAt?: number;
}

/** The part of today's `AppState` the quit warning reads. */
export interface PendingSource {
  readonly drafts: ReadonlyArray<{ pendingSendAt?: string; sendAttemptAt?: string }>;
  readonly threads: ReadonlyArray<{ reminderAt?: string; reminderFired?: boolean }>;
}

const timeOf = (iso: string | undefined) => (iso === undefined ? NaN : Date.parse(iso));

/**
 * What will not happen while Aplos is quit, from today's `latestState`. Later `Outbox/pending` answers the same shape.
 * A draft with a send attempt that is still unsent is `uncertain` (never counted as scheduled as well).
 */
export function pendingWork(state: PendingSource | undefined): PendingWork {
  let scheduledSends = 0;
  let reminders = 0;
  let uncertain = 0;
  const due: number[] = [];
  for (const draft of state?.drafts ?? []) {
    if (draft.sendAttemptAt) uncertain++;
    else if (draft.pendingSendAt) {
      scheduledSends++;
      due.push(timeOf(draft.pendingSendAt));
    }
  }
  for (const thread of state?.threads ?? []) {
    if (!thread.reminderAt || thread.reminderFired) continue;
    reminders++;
    due.push(timeOf(thread.reminderAt));
  }
  const times = due.filter(Number.isFinite);
  const nextAt = times.length ? Math.min(...times) : undefined;
  return { scheduledSends, reminders, uncertain, ...(nextAt === undefined ? {} : { nextAt }) };
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function joinList(parts: string[]): string {
  if (parts.length < 2) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The ⌘Q confirm dialog text, or undefined when nothing is pending. The buttons are `Quit` and `Keep running`. */
export function quitWarning(
  pending: PendingWork,
  formatTime: (at: number) => string = at => new Date(at).toLocaleString(),
): { message: string; detail: string } | undefined {
  const parts: string[] = [];
  if (pending.scheduledSends)
    parts.push(plural(pending.scheduledSends, 'scheduled send', 'scheduled sends'));
  if (pending.reminders) parts.push(plural(pending.reminders, 'reminder', 'reminders'));
  const lines: string[] = [];
  if (pending.nextAt !== undefined && parts.length)
    lines.push(`The next one is due ${formatTime(pending.nextAt)}.`);
  if (pending.uncertain)
    lines.push(
      `${plural(pending.uncertain, 'send', 'sends')} not yet confirmed as sent will be checked when Aplos opens again.`,
    );
  if (!parts.length && !pending.uncertain) return undefined;
  const message = parts.length
    ? `${joinList(parts)} will not happen while Aplos is quit`
    : `${plural(pending.uncertain, 'send is', 'sends are')} not yet confirmed`;
  return {
    message,
    detail: [...lines, 'Close the window instead to keep Aplos running.'].join(' '),
  };
}

/** `Quit` is the first button because that is the order the owner asked for; `Keep running` is the default and the cancel. */
export const quitWarningButtons = ['Quit', 'Keep running'] as const;

export type ProcessStateName = 'starting' | 'ready' | 'parked';

export const PARK_AFTER_EXITS = 3;
export const PARK_WINDOW_MS = 60_000;

export interface ProcessState {
  readonly state: ProcessStateName;
  /** The engine answered. Ignored once parked. */
  engineReady(): void;
  /** The engine process stopped. Returns true when this exit parks the app (the third within 60 s). */
  noteEngineExit(now: number): boolean;
  /** "Try again" after a park: forget the exits and start over. */
  tryAgain(): void;
}

/** `starting` until the engine answers, `ready`, and `parked` after 3 engine exits within 60 s. */
export function createProcessState(): ProcessState {
  let state: ProcessStateName = 'starting';
  const exits: number[] = [];
  return {
    get state() {
      return state;
    },
    engineReady() {
      if (state === 'starting') state = 'ready';
    },
    noteEngineExit(now) {
      if (state === 'parked') return false;
      exits.push(now);
      while (exits.length && now - exits[0] > PARK_WINDOW_MS) exits.shift();
      state = exits.length >= PARK_AFTER_EXITS ? 'parked' : 'starting';
      return state === 'parked';
    },
    tryAgain() {
      exits.length = 0;
      state = 'starting';
    },
  };
}

/**
 * The most `finishQuit` waits for the engine to close before quitting anyway. It must outlast the supervisor's own wait
 * (`ENGINE_QUIT_MS` to ask, `ENGINE_EXIT_AFTER_KILL_MS` to see the kill take) with room to spare, so an engine that
 * exits just after the kill still releases the lock, and one that does not is reported stuck first.
 */
export const QUIT_DRAIN_MS = 6000;

/** Resolves when `work` settles or after `ms`, whichever is first. Never rejects. */
export function drain(
  work: Promise<unknown>,
  ms: number,
  timers: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void },
): Promise<void> {
  return new Promise<void>(resolve => {
    const handle = timers.set(resolve, ms);
    const done = () => {
      timers.clear(handle);
      resolve();
    };
    work.then(done, done);
  });
}

/**
 * Closes the engine, then lets go of the data lock, but ONLY if the engine confirmed it closed within `ms`. A second
 * instance that takes the lock must not open the database while this one's engine may still be writing it; a lock that
 * is not released names this process and is reclaimed as stale the moment the process is gone. Resolves true when the
 * engine closed in time (and the lock was released). A close that fails or times out leaves the lock held.
 */
export async function closeThenRelease(
  work: Promise<unknown>,
  ms: number,
  timers: { set(run: () => void, ms: number): unknown; clear(handle: unknown): void },
  release: () => void,
): Promise<boolean> {
  let closed = false;
  await drain(
    work.then(
      () => void (closed = true),
      () => undefined,
    ),
    ms,
    timers,
  );
  if (closed) release();
  return closed;
}

/**
 * One quit question at a time. `request` asks `confirm` (the pending-work warning) and, if the answer is yes, calls
 * `begin`. A second request while the question is open is ignored. A `confirm` that throws or rejects counts as yes and
 * never leaves the gate stuck, and neither does a `begin` that throws, because a quit that cannot be asked about must still be possible.
 */
export function createQuitGate(confirm: () => Promise<boolean>, begin: () => void) {
  let asking = false;
  /** Asks at once (not a tick later), turning a synchronous throw into a rejection. */
  const ask = async () => confirm();
  return {
    request() {
      if (asking) return;
      asking = true;
      void ask()
        .catch(() => true)
        .then(go => {
          asking = false;
          // A `begin` that throws must not become an unhandled rejection; the gate is already open again.
          try {
            if (go) begin();
          } catch {
            // Nothing safe to report from here; the next quit request asks again.
          }
        });
    },
  };
}
