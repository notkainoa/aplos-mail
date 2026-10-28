// The onboarding window on the main side (DESIGN 7.11 "Window" and "Handoff"; Appendix C F3, F4, F7; U8 acceptance 5).
// Pure decisions plus `createOnboardingWindow` / `createOnboarding` with fake windows, engine and clock. No Electron.
// Run: cd apps/desktop && npx tsx --test tests/ui-onboard/window.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  createOnboarding,
  createOnboardingWindow,
  onboardingOptions,
  type Clock,
  type OnboardingDeps,
  type WindowPort,
} from '../../src/main/windows/onboarding';
import {
  FADE_MS,
  FORCE_CLOSE_MS,
  HANDOFF_ORDER,
  activation,
  backgroundFor,
  fadeOpacities,
  isFirstRun,
  lastAccountAfterOnboarding,
  onboardingQuery,
  opensBesideMail,
  startupWindow,
  type SetupFacts,
} from '../../src/main/windows/onboarding.policy';
import { ONBOARDING_ROUTE, onboardingRoute } from '../../src/renderer/onboarding/showWelcome';

const FRESH: SetupFacts = { hasAccounts: false, setup: {} };
const SKIPPED: SetupFacts = { hasAccounts: false, setup: { skippedAt: 1 } };
const COMPLETED: SetupFacts = { hasAccounts: false, setup: { completedAt: 1 } };
const ACCOUNTS: SetupFacts = { hasAccounts: true, setup: {} };

/** A clock the test advances by hand. */
function fakeClock(): Clock & { now: number; advance(ms: number): void; pending(): number } {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    get now() {
      return now;
    },
    setTimeout(run, ms) {
      const id = next++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    pending: () => timers.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = end;
    },
  };
}

type Log = string[];

class FakeWindow implements WindowPort {
  static next = 1;
  readonly id = FakeWindow.next++;
  destroyed = false;
  visible = false;
  minimized = false;
  opacity = 1;
  focused = 0;
  stuckFade = false;
  loaded?: { target: { devURL?: string; file: string }; query: Record<string, string> };
  locked?: { isTrusted: (url: string) => boolean; openOutside: (url: string) => void };
  private ready: (() => void)[] = [];
  private closed: (() => void)[] = [];
  private didLoad: (() => void)[] = [];
  constructor(
    readonly name: string,
    readonly log: Log,
    readonly options?: unknown,
  ) {}
  isDestroyed = () => this.destroyed;
  isMinimized = () => this.minimized;
  restore() {
    this.minimized = false;
  }
  show() {
    this.visible = true;
    this.log.push(`${this.name}:show`);
  }
  focus() {
    this.focused += 1;
  }
  close() {
    if (this.destroyed) return;
    this.log.push(`${this.name}:close`);
    this.destroyed = true;
    this.visible = false;
    for (const l of this.closed) l();
  }
  setOpacity(value: number) {
    if (this.stuckFade) throw new Error('setOpacity is not supported');
    this.opacity = value;
    this.log.push(`${this.name}:opacity ${value}`);
  }
  send() {}
  onReadyToShow(l: () => void) {
    this.ready.push(l);
  }
  onClosed(l: () => void) {
    this.closed.push(l);
  }
  onLoaded(l: () => void) {
    this.didLoad.push(l);
  }
  lockNavigation(isTrusted: (url: string) => boolean, openOutside: (url: string) => void) {
    this.locked = { isTrusted, openOutside };
  }
  load(target: { devURL?: string; file: string }, query: Record<string, string>) {
    this.loaded = { target, query };
  }
  fireReady() {
    this.log.push(`${this.name}:ready-to-show`);
    for (const l of this.ready.splice(0)) l();
  }
  fireLoaded() {
    for (const l of this.didLoad) l();
  }
}

interface World {
  deps: OnboardingDeps;
  onboarding: ReturnType<typeof createOnboarding>;
  clock: ReturnType<typeof fakeClock>;
  log: Log;
  engine: { method: string; input: unknown }[];
  windows: FakeWindow[];
  external: string[];
  shown: FakeWindow[];
  mail: { window?: FakeWindow };
  accounts: { count: number };
  onClosed: FakeWindow[];
}

function world(options: { testMode?: boolean; accounts?: number; mailOpen?: boolean } = {}): World {
  const log: Log = [];
  const clock = fakeClock();
  const engine: World['engine'] = [];
  const windows: FakeWindow[] = [];
  const external: string[] = [];
  const shown: FakeWindow[] = [];
  const onClosed: FakeWindow[] = [];
  const mail: World['mail'] = {};
  const accounts = { count: options.accounts ?? 0 };
  if (options.mailOpen) mail.window = new FakeWindow('mail', log);
  const deps: OnboardingDeps = {
    createWindow: opts => {
      const win = new FakeWindow('onboarding', log, opts);
      windows.push(win);
      return win;
    },
    engine: {
      call: (async (method: string, input: unknown) => {
        engine.push({ method, input });
        log.push(`engine:${method}`);
        return {};
      }) as OnboardingDeps['engine']['call'],
    },
    mail: {
      current: () => (mail.window && !mail.window.destroyed ? mail.window : undefined),
      create: () => {
        mail.window = new FakeWindow('mail', log);
        log.push('mail:create-hidden');
        return mail.window;
      },
    },
    countAccounts: async () => accounts.count,
    testMode: options.testMode ?? false,
    dark: () => false,
    preloadPath: '/app/preload.cjs',
    trustedURL: url => url.startsWith('file:///app/renderer/index.html'),
    openExternal: url => void external.push(url),
    target: { file: '/app/renderer/index.html' },
    clock,
    opId: () => 'op-1',
    sendShown: win => void shown.push(win as FakeWindow),
    onClosed: win => void onClosed.push(win as FakeWindow),
  };
  return { deps, onboarding: createOnboarding(deps), clock, log, engine, windows, external, shown, mail, accounts, onClosed };
}

/** Lets the handoff's awaited engine calls settle. */
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

describe('window policy: which window opens', () => {
  test('a fresh install with no account opens the onboarding window; with an account, the mail window', () => {
    assert.equal(startupWindow(FRESH, { atLogin: false }), 'onboarding');
    assert.equal(startupWindow(ACCOUNTS, { atLogin: false }), 'mail');
  });

  test('"Skip setup" or a finished setup with zero accounts opens the mail window, not onboarding again (GAP-7)', () => {
    assert.equal(startupWindow(SKIPPED, { atLogin: false }), 'mail');
    assert.equal(startupWindow(COMPLETED, { atLogin: false }), 'mail');
    assert.equal(isFirstRun(SKIPPED), false);
    assert.equal(isFirstRun(FRESH), true);
  });

  test('launched at login with no account: no window until the Dock or menu-bar item is clicked', () => {
    assert.equal(startupWindow(FRESH, { atLogin: true }), 'none');
    assert.equal(startupWindow(SKIPPED, { atLogin: true }), 'none');
    assert.equal(startupWindow(ACCOUNTS, { atLogin: true }), 'mail');
    // The click is not a login launch any more.
    assert.deepEqual(activation({ onboarding: false, mail: false }, FRESH), { kind: 'open-onboarding', mode: 'first' });
    assert.deepEqual(activation({ onboarding: false, mail: false }, SKIPPED), { kind: 'open-mail' });
  });

  test('a Dock click or second launch focuses what exists and never opens a second onboarding window (F3)', () => {
    assert.deepEqual(activation({ onboarding: true, mail: false }, FRESH), { kind: 'focus-onboarding' });
    assert.deepEqual(activation({ onboarding: true, mail: true }, ACCOUNTS), { kind: 'focus-mail' });
    assert.deepEqual(activation({ onboarding: false, mail: true }, ACCOUNTS), { kind: 'focus-mail' });
  });

  test('"Show welcome" opens beside an existing mail window and changes nothing; first mode owns the screen', () => {
    assert.equal(opensBesideMail('review', { onboarding: false, mail: true }), true);
    assert.equal(opensBesideMail('review', { onboarding: false, mail: false }), false);
    assert.equal(opensBesideMail('first', { onboarding: false, mail: true }), false);
  });

  test('All accounts after onboarding with two or more accounts; one or none leaves the filter alone (F7)', () => {
    assert.equal(lastAccountAfterOnboarding(2), 'all');
    assert.equal(lastAccountAfterOnboarding(5), 'all');
    assert.equal(lastAccountAfterOnboarding(1), undefined);
    assert.equal(lastAccountAfterOnboarding(0), undefined);
  });

  test('the route matches what the renderer builds for the browser preview', () => {
    const query = onboardingQuery('review');
    assert.equal(`?${new URLSearchParams(query)}`, ONBOARDING_ROUTE);
    assert.equal(`?${new URLSearchParams(onboardingQuery('first'))}`, onboardingRoute('first'));
  });

  test('the fade is 120 ms, strictly decreasing from 1 to 0, and the force-close comes after it', () => {
    const steps = fadeOpacities();
    assert.equal(steps[0], 1);
    assert.equal(steps.at(-1), 0);
    for (let i = 1; i < steps.length; i++) assert.ok(steps[i]! < steps[i - 1]!);
    assert.equal(FADE_MS, 120);
    assert.equal(FORCE_CLOSE_MS, 300);
    assert.deepEqual(HANDOFF_ORDER.slice(2, 5), ['mail-ready-to-show', 'show-mail', 'fade-onboarding']);
  });
});

describe('createOnboardingWindow: the window itself', () => {
  test('640 x 600, minimum 640 x 520, no app icon, hidden-inset title bar, not maximizable or fullscreenable', () => {
    const w = world();
    createOnboardingWindow(w.deps, 'first');
    const o = w.windows[0]!.options as Record<string, unknown>;
    assert.equal(o.width, 640);
    assert.equal(o.height, 600);
    assert.equal(o.minWidth, 640);
    assert.equal(o.minHeight, 520);
    assert.equal(o.titleBarStyle, 'hiddenInset');
    assert.equal(o.maximizable, false);
    assert.equal(o.fullscreenable, false);
    assert.equal('icon' in o, false);
    assert.equal(o.show, false);
  });

  test('resizable vertically only: the width is pinned by equal minimum and maximum, the height is free', () => {
    const o = onboardingOptions({ dark: () => false, preloadPath: '/p' });
    assert.equal(o.resizable, true);
    assert.equal(o.minWidth, o.maxWidth);
    assert.equal(o.maxWidth, o.width);
    assert.equal(o.maxHeight, undefined);
    assert.ok((o.minHeight ?? 0) < (o.height ?? 0));
  });

  test('white paper in light, near-black in dark, the canvas colour of each theme', () => {
    assert.equal(onboardingOptions({ dark: () => false, preloadPath: '/p' }).backgroundColor, backgroundFor(false));
    assert.equal(onboardingOptions({ dark: () => true, preloadPath: '/p' }).backgroundColor, '#191a1c');
    assert.equal(backgroundFor(false), '#ffffff');
  });

  test('same hardening as the mail window: sandbox, context isolation, no node, web security, the preload', () => {
    const p = onboardingOptions({ dark: () => false, preloadPath: '/app/preload.cjs' }).webPreferences!;
    assert.equal(p.preload, '/app/preload.cjs');
    assert.equal(p.sandbox, true);
    assert.equal(p.contextIsolation, true);
    assert.equal(p.nodeIntegration, false);
    assert.equal(p.webSecurity, true);
  });

  test('loads the onboarding route for the mode and locks navigation to the app', () => {
    const w = world();
    createOnboardingWindow(w.deps, 'review');
    const win = w.windows[0]!;
    assert.deepEqual(win.loaded, { target: { file: '/app/renderer/index.html' }, query: { window: 'onboarding', mode: 'review' } });
    assert.equal(win.locked!.isTrusted('file:///app/renderer/index.html?window=onboarding'), true);
    assert.equal(win.locked!.isTrusted('https://example.com/'), false);
    win.locked!.openOutside('https://example.com/');
    assert.deepEqual(w.external, ['https://example.com/']);
  });

  test('shown on ready-to-show, and the renderer is told (shown event)', () => {
    const w = world();
    createOnboardingWindow(w.deps, 'first');
    const win = w.windows[0]!;
    assert.equal(win.visible, false);
    win.fireReady();
    assert.equal(win.visible, true);
    assert.deepEqual(w.shown, [win]);
  });

  test('test mode: never shown or focused, never opens a browser, but the renderer still gets shown', () => {
    const w = world({ testMode: true });
    w.onboarding.open('first');
    const win = w.windows[0]!;
    win.fireReady();
    w.onboarding.activate(FRESH);
    w.onboarding.open('review');
    win.locked!.openOutside('https://example.com/');
    assert.equal(win.visible, false);
    assert.equal(win.focused, 0);
    assert.deepEqual(w.external, []);
    assert.deepEqual(w.shown, [win]);
  });
});

describe('createOnboarding: one window (F3)', () => {
  test('startup opens the onboarding window on a fresh install, and only the choice for the mail window otherwise', () => {
    const w = world();
    assert.equal(w.onboarding.start(ACCOUNTS, { atLogin: false }), 'mail');
    assert.equal(w.windows.length, 0);
    assert.equal(w.onboarding.start(FRESH, { atLogin: true }), 'none');
    assert.equal(w.windows.length, 0);
    assert.equal(w.onboarding.start(FRESH, { atLogin: false }), 'onboarding');
    assert.equal(w.windows.length, 1);
  });

  test('a second launch, a Dock click and a second Window/openOnboarding all focus the one window', () => {
    const w = world();
    w.onboarding.start(FRESH, { atLogin: false });
    w.windows[0]!.fireReady();
    assert.deepEqual(w.onboarding.activate(FRESH), { kind: 'focus-onboarding' });
    assert.deepEqual(w.onboarding.activate(FRESH), { kind: 'focus-onboarding' });
    assert.equal(w.onboarding.open('first'), 'focused');
    assert.equal(w.onboarding.open('review'), 'focused');
    assert.equal(w.windows.length, 1);
    assert.equal(w.windows[0]!.focused, 4);
  });

  test('a minimised window is restored when focused', () => {
    const w = world();
    w.onboarding.open('first');
    w.windows[0]!.minimized = true;
    w.onboarding.open('first');
    assert.equal(w.windows[0]!.minimized, false);
  });

  test('after the window closes, a Dock click on a fresh install opens a new one', () => {
    const w = world();
    w.onboarding.open('first');
    w.windows[0]!.close();
    assert.equal(w.onboarding.isOpen(), false);
    assert.deepEqual(w.onboarding.activate(FRESH), { kind: 'open-onboarding', mode: 'first' });
    assert.equal(w.windows.length, 2);
  });

  test('"Show welcome" beside a mail window: created, mail untouched', () => {
    const w = world({ mailOpen: true });
    assert.equal(w.onboarding.open('review'), 'created');
    assert.equal(w.mail.window!.visible, false);
    assert.equal(w.mail.window!.destroyed, false);
    assert.deepEqual(w.engine, []);
    assert.deepEqual(w.log.filter(l => l.startsWith('mail:')), []);
  });
});

describe('createOnboarding: the handoff (F4, F7)', () => {
  test('mail window hidden first, shown on ready-to-show, then the fade starts in the same callback and the window closes', async () => {
    const w = world({ accounts: 1 });
    w.onboarding.open('first');
    w.windows[0]!.fireReady();
    w.log.length = 0;
    await w.onboarding.finish();
    // Created hidden; nothing shown yet; the onboarding window is untouched until the mail window is ready.
    assert.deepEqual(w.log, ['mail:create-hidden']);
    assert.equal(w.windows[0]!.opacity, 1);
    w.clock.advance(5000);
    assert.deepEqual(w.log, ['mail:create-hidden'], 'no ready-to-show, no show, no fade');
    w.mail.window!.fireReady();
    const afterReady = w.log.slice(1);
    assert.deepEqual(afterReady.slice(0, 3), ['mail:ready-to-show', 'mail:show', 'onboarding:opacity 1']);
    // Same callback: the fade has begun but the window is still open.
    assert.equal(w.windows[0]!.destroyed, false);
    w.clock.advance(FADE_MS);
    assert.equal(w.windows[0]!.destroyed, true);
    assert.equal(w.windows[0]!.opacity, 0);
    const order = w.log.map(l => l.replace(/ [\d.]+$/, ''));
    assert.ok(order.indexOf('mail:show') < order.indexOf('onboarding:opacity'));
    assert.ok(order.lastIndexOf('onboarding:opacity') < order.indexOf('onboarding:close'));
    assert.equal(w.mail.window!.visible, true);
    assert.ok(w.mail.window!.focused >= 1);
  });

  test('the fade lasts 120 ms: still open at 119, closed at 120', async () => {
    const w = world({ accounts: 1 });
    w.onboarding.open('first');
    await w.onboarding.finish();
    w.mail.window!.fireReady();
    w.clock.advance(FADE_MS - 1);
    assert.equal(w.windows[0]!.destroyed, false);
    w.clock.advance(1);
    assert.equal(w.windows[0]!.destroyed, true);
  });

  test('a fade that throws (setOpacity unsupported) closes the window at once instead of leaving it half faded', async () => {
    const w = world({ accounts: 1 });
    w.onboarding.open('first');
    w.windows[0]!.stuckFade = true;
    await w.onboarding.finish();
    w.mail.window!.fireReady();
    assert.equal(w.windows[0]!.destroyed, true);
  });

  test('force-close at 300 ms when the fade steps never run (a starved timer), not before', async () => {
    const w = world({ accounts: 1 });
    w.onboarding.open('first');
    const real = w.clock;
    // The fade's own step timers are dropped; only the 300 ms backstop is kept.
    w.deps.clock = {
      setTimeout: (run, ms) => (ms === FORCE_CLOSE_MS ? real.setTimeout(run, ms) : 0),
      clearTimeout: handle => real.clearTimeout(handle),
    };
    await w.onboarding.finish();
    const win = w.windows[0]!;
    w.mail.window!.fireReady();
    assert.equal(win.destroyed, false);
    real.advance(FORCE_CLOSE_MS - 1);
    assert.equal(win.destroyed, false);
    real.advance(1);
    assert.equal(win.destroyed, true);
  });

  test('with two or more accounts the filter is set to All accounts before the mail window is created (F7)', async () => {
    const w = world({ accounts: 2 });
    w.onboarding.open('first');
    w.log.length = 0;
    await w.onboarding.finish();
    assert.deepEqual(w.engine, [
      { method: 'Settings/set', input: { opId: 'op-1', patch: { ui: { lastAccount: 'all' } } } },
    ]);
    assert.deepEqual(w.log, ['engine:Settings/set', 'mail:create-hidden']);
  });

  test('with one account nothing is written', async () => {
    const w = world({ accounts: 1 });
    w.onboarding.open('first');
    await w.onboarding.finish();
    assert.deepEqual(w.engine, []);
  });

  test('a failing engine never blocks the handoff', async () => {
    const w = world({ accounts: 3 });
    w.deps.engine.call = (async () => {
      throw new Error('engine is restarting');
    }) as OnboardingDeps['engine']['call'];
    const onboarding = createOnboarding(w.deps);
    onboarding.open('first');
    await onboarding.finish();
    assert.equal(w.mail.window !== undefined, true);
  });

  test('finish twice builds one mail window', async () => {
    const w = world({ accounts: 1 });
    w.onboarding.open('first');
    await Promise.all([w.onboarding.finish(), w.onboarding.finish()]);
    assert.equal(w.log.filter(l => l === 'mail:create-hidden').length, 1);
  });

  test('a mail window that never reports ready-to-show is shown after 10 s rather than leaving a dead end', async () => {
    const w = world({ accounts: 1 });
    w.onboarding.open('first');
    await w.onboarding.finish();
    w.clock.advance(9_999);
    assert.equal(w.mail.window!.visible, false);
    w.clock.advance(1);
    assert.equal(w.mail.window!.visible, true);
    w.clock.advance(FADE_MS);
    assert.equal(w.windows[0]!.destroyed, true);
  });

  test('with a mail window already open ("Show welcome", zero-accounts Add an account) the handoff only reveals it and closes onboarding', async () => {
    const w = world({ mailOpen: true, accounts: 2 });
    w.onboarding.open('review');
    await w.onboarding.finish();
    assert.deepEqual(w.engine, []);
    assert.equal(w.log.includes('mail:create-hidden'), false);
    assert.equal(w.mail.window!.visible, true);
    w.clock.advance(FADE_MS);
    assert.equal(w.windows[0]!.destroyed, true);
  });

  test('test mode runs the same sequence but never shows either window', async () => {
    const w = world({ testMode: true, accounts: 2 });
    w.onboarding.open('first');
    await w.onboarding.finish();
    w.mail.window!.fireReady();
    w.clock.advance(FADE_MS);
    assert.equal(w.mail.window!.visible, false);
    assert.equal(w.mail.window!.focused, 0);
    assert.equal(w.windows[0]!.destroyed, true);
  });
});

describe('createOnboarding: Setup/end on close', () => {
  const ends = (w: World) => w.engine.filter(c => c.method === 'Setup/end');

  test('closing the window calls Setup/end {reason: closed} once', () => {
    const w = world();
    w.onboarding.open('first');
    w.windows[0]!.close();
    assert.deepEqual(ends(w), [{ method: 'Setup/end', input: { reason: 'closed' } }]);
    assert.deepEqual(w.onClosed, [w.windows[0]]);
  });

  test('a second close event for the same window does not send it again', () => {
    const w = world();
    const handle = createOnboardingWindow(w.deps, 'first');
    w.windows[0]!.close();
    w.windows[0]!.destroyed = false;
    w.windows[0]!.close();
    assert.equal(ends(w).length, 1);
    assert.equal(handle.ended, true);
  });

  test('exactly one Setup/end across the renderer and main: when the renderer ended it first, main sends none', () => {
    const w = world();
    w.onboarding.open('first');
    // The renderer's call goes engine-bound past main's invoke handler, which reports it.
    w.engine.push({ method: 'Setup/end', input: { reason: 'finished' } });
    w.onboarding.noteRendererSetupEnd();
    w.windows[0]!.close();
    assert.deepEqual(ends(w), [{ method: 'Setup/end', input: { reason: 'finished' } }]);
  });

  test('when the renderer never calls it (red button, renderer gone) main sends exactly one', () => {
    const w = world();
    w.onboarding.open('first');
    w.windows[0]!.close();
    assert.equal(ends(w).length, 1);
  });

  test('the handoff close after a clean finish sends nothing more once the renderer has ended setup', async () => {
    const w = world({ accounts: 1 });
    w.onboarding.open('first');
    w.engine.push({ method: 'Setup/end', input: { reason: 'finished' } });
    w.onboarding.noteRendererSetupEnd();
    await w.onboarding.finish();
    w.mail.window!.fireReady();
    w.clock.advance(FADE_MS);
    assert.equal(ends(w).length, 1);
  });

  test('a reopened window ends its own setup: close, reopen, close sends two, one per window', () => {
    const w = world();
    w.onboarding.open('review');
    w.windows[0]!.close();
    w.onboarding.open('review');
    w.windows[1]!.close();
    assert.equal(ends(w).length, 2);
  });

  test('a rejected Setup/end never throws out of the close handler', async () => {
    const w = world();
    w.deps.engine.call = (async () => {
      throw new Error('engine is restarting');
    }) as OnboardingDeps['engine']['call'];
    const onboarding = createOnboarding(w.deps);
    onboarding.open('first');
    assert.doesNotThrow(() => w.windows[0]!.close());
    await settle();
  });

  test('the host hears about creation and load', () => {
    const w = world();
    const created: WindowPort[] = [];
    const loaded: WindowPort[] = [];
    w.deps.onCreated = win => void created.push(win);
    w.deps.onLoaded = win => void loaded.push(win);
    createOnboardingWindow(w.deps, 'first');
    w.windows[0]!.fireLoaded();
    assert.deepEqual(created, [w.windows[0]]);
    assert.deepEqual(loaded, [w.windows[0]]);
  });
});
