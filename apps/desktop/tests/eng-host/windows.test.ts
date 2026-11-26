import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FADE_STEPS,
  FORCE_CLOSE_MS,
  READY_TIMEOUT_MS,
  activation,
  createOnboarding,
  fadeOpacities,
  finishOptionsOf,
  isFirstRun,
  onboardingEnabledFor,
  onboardingOptedOut,
  settingsPaneUrl,
  startupWindow,
  type OnboardingDeps,
  type SessionFacts,
  type WindowPort,
} from '../../src/host/lifecycle';

const fresh: SessionFacts = { hasAccounts: false, setup: {} };
const withAccount: SessionFacts = { hasAccounts: true, setup: { completedAt: 1 } };

class FakeWindow implements WindowPort {
  static next = 1;
  id = FakeWindow.next++;
  destroyed = false;
  visible = false;
  painted = false;
  shows = 0;
  ready: Array<() => void> = [];
  closed: Array<() => void> = [];
  isDestroyed = () => this.destroyed;
  isVisible = () => this.visible;
  hasPainted = () => this.painted;
  isMinimized = () => false;
  restore = () => {};
  show = () => {
    this.visible = true;
    this.shows++;
  };
  focus = () => {};
  close = () => this.destroy();
  onReadyToShow = (listener: () => void) => void this.ready.push(listener);
  onClosed = (listener: () => void) => void this.closed.push(listener);
  paint() {
    this.painted = true;
    for (const listener of this.ready.splice(0)) listener();
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.visible = false;
    for (const listener of this.closed.splice(0)) listener();
  }
}

/** A window that can fade (a real `BrowserWindow` can); the plain `FakeWindow` has no `setOpacity` and closes at once. */
class FadeWindow extends FakeWindow {
  opacities: number[] = [];
  throws = false;
  setOpacity = (value: number) => {
    if (this.throws) throw new Error('window is gone');
    this.opacities.push(value);
  };
}

function harness(options: { testMode?: boolean; fade?: boolean; navigateThrows?: boolean } = {}) {
  const log = {
    onboarding: [] as FakeWindow[],
    mail: [] as FakeWindow[],
    ends: 0,
    shown: [] as number[],
    navigated: [] as Array<{ id: number; to: string }>,
    quitting: false,
    timers: [] as Array<{ run: () => void; ms: number; cleared: boolean }>,
    endFails: false,
  };
  let mail: FakeWindow | undefined;
  const deps: OnboardingDeps = {
    createOnboarding: () => {
      const win = options.fade ? new FadeWindow() : new FakeWindow();
      log.onboarding.push(win);
      return win;
    },
    createMail: () => {
      mail = new FakeWindow();
      log.mail.push(mail);
      return mail;
    },
    currentMail: () => (mail && !mail.destroyed ? mail : undefined),
    endSetup: async () => {
      log.ends++;
      if (log.endFails) throw new Error('Unsupported engine method.');
    },
    announceShown: win => void log.shown.push(win.id),
    navigate: (win, to) => {
      if (options.navigateThrows) throw new Error('webContents is gone');
      log.navigated.push({ id: win.id, to });
    },
    isQuitting: () => log.quitting,
    testMode: options.testMode ?? false,
    setTimer: (run, ms) => {
      const timer = { run, ms, cleared: false };
      log.timers.push(timer);
      return timer;
    },
    clearTimer: handle => void ((handle as { cleared: boolean }).cleared = true),
  };
  const seedMail = () => deps.createMail() as FakeWindow;
  return { controller: createOnboarding(deps), log, mailWindow: () => mail, seedMail };
}

test('startup: first run opens onboarding, a login launch stays windowless, else mail', () => {
  assert.equal(startupWindow(fresh, { atLogin: false }), 'onboarding');
  assert.equal(startupWindow(fresh, { atLogin: true }), 'none');
  assert.equal(startupWindow(withAccount, { atLogin: true }), 'none');
  assert.equal(startupWindow(withAccount, { atLogin: false }), 'mail');
  assert.equal(
    startupWindow({ hasAccounts: false, setup: { skippedAt: 5 } }, { atLogin: false }),
    'mail',
  );
  assert.equal(isFirstRun({ hasAccounts: false, setup: { completedAt: 5 } }), false);
});

test('activation: an open mail window answers a click, then an open onboarding window, then startup rules', () => {
  assert.equal(activation({ onboarding: true, mail: true }, fresh), 'focus-mail');
  assert.equal(activation({ onboarding: true, mail: false }, fresh), 'focus-onboarding');
  assert.equal(activation({ onboarding: false, mail: false }, fresh), 'open-onboarding');
  assert.equal(activation({ onboarding: false, mail: false }, withAccount), 'open-mail');
});

test('the onboarding window is the default first-run path; only APLOS_ONBOARDING_WINDOW=0 opts out', () => {
  assert.equal(onboardingOptedOut({}), false, 'unset: on');
  assert.equal(onboardingOptedOut({ APLOS_ONBOARDING_WINDOW: '1' }), false);
  assert.equal(onboardingOptedOut({ APLOS_ONBOARDING_WINDOW: 'yes' }), false);
  assert.equal(onboardingOptedOut({ APLOS_ONBOARDING_WINDOW: '0' }), true, 'the explicit opt-out');
});

test('the onboarding window is the default unless opted out', () => {
  assert.equal(onboardingEnabledFor({}), true, 'unset: on');
  assert.equal(onboardingEnabledFor({ APLOS_ONBOARDING_WINDOW: '0' }), false, 'the opt-out wins');
});

test('first run: exactly one window exists, the onboarding window, and no mail window until the handoff', async () => {
  const { controller, log, mailWindow } = harness();
  assert.equal(controller.start(fresh, { atLogin: false }), 'onboarding');
  assert.equal(log.onboarding.length + log.mail.length, 1, 'exactly one window');
  assert.equal(log.mail.length, 0, 'the mail window does not exist before the handoff');
  // A second launch or a Dock click while it waits only focuses the one window.
  assert.equal(controller.activate(fresh), 'focus-onboarding');
  assert.equal(log.onboarding.length + log.mail.length, 1);
  const handoff = controller.finish();
  mailWindow()!.paint();
  await handoff;
  assert.equal(log.mail.length, 1, 'the mail window is created only at the handoff');
  assert.equal(log.onboarding[0].destroyed, true, 'and onboarding is gone after it');
});

test('accounts exist: startup opens the mail window, never onboarding', () => {
  const { controller, log } = harness();
  assert.equal(controller.start(withAccount, { atLogin: false }), 'mail');
  assert.equal(log.onboarding.length, 0);
  assert.equal(controller.activate(withAccount), 'open-mail');
});

test('a login launch is windowless even on first run, and a later Dock click opens onboarding then', () => {
  const { controller, log } = harness();
  assert.equal(controller.start(fresh, { atLogin: true }), 'none');
  assert.equal(log.onboarding.length + log.mail.length, 0);
  assert.equal(controller.activate(fresh), 'open-onboarding');
  assert.equal(log.onboarding.length, 1);
});

test('the demo path (Demo/load then finish) hands over to the mail window the same as a clean finish', async () => {
  const { controller, log, mailWindow } = harness();
  controller.start(fresh, { atLogin: false });
  const handoff = controller.finish();
  mailWindow()!.paint();
  await handoff;
  assert.equal(log.mail.length, 1);
  assert.equal(controller.isOpen(), false);
  assert.equal(controller.activate({ hasAccounts: true, setup: {} }), 'focus-mail');
});

test('start opens the one onboarding window on first run and none on a login launch', () => {
  const first = harness();
  assert.equal(first.controller.start(fresh, { atLogin: false }), 'onboarding');
  assert.equal(first.log.onboarding.length, 1);
  const login = harness();
  assert.equal(login.controller.start(fresh, { atLogin: true }), 'none');
  assert.equal(login.log.onboarding.length, 0);
  const mail = harness();
  assert.equal(mail.controller.start(withAccount, { atLogin: false }), 'mail');
  assert.equal(mail.log.onboarding.length, 0);
});

test('window race: a second instance (activate or open) during onboarding never makes a second window', () => {
  const { controller, log } = harness();
  controller.start(fresh, { atLogin: false });
  for (let i = 0; i < 5; i++) {
    assert.equal(controller.activate(fresh), 'focus-onboarding');
    controller.open(i % 2 ? 'first' : 'review');
  }
  assert.equal(log.onboarding.length, 1);
  assert.equal(log.mail.length, 0);
});

test('window race: closing onboarding before the renderer loads ends setup once and still leaves a window', async () => {
  const { controller, log, mailWindow } = harness();
  controller.start(fresh, { atLogin: false });
  log.onboarding[0].destroy(); // closed before ready-to-show
  await Promise.resolve();
  assert.equal(log.ends, 1);
  assert.equal(log.mail.length, 1, 'the mail window opens so the app is never left with no window');
  assert.equal(mailWindow()?.shows, 0, 'and shows itself on its own first paint, not before');
  assert.equal(controller.isOpen(), false);
});

test('Setup/end: skipped when the renderer already ended setup, and a rejection is swallowed', async () => {
  const done = harness();
  done.controller.start(fresh, { atLogin: false });
  done.controller.noteRendererSetupEnd();
  done.log.onboarding[0].destroy();
  assert.equal(done.log.ends, 0);
  const failing = harness();
  failing.log.endFails = true;
  failing.controller.start(fresh, { atLogin: false });
  failing.log.onboarding[0].destroy();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(failing.log.ends, 1);
});

test('handoff: the mail window is created hidden, the welcome window closes only after the mail window paints', async () => {
  const { controller, log, mailWindow } = harness();
  controller.start(fresh, { atLogin: false });
  const handoff = controller.finish();
  const mail = mailWindow()!;
  assert.equal(mail.visible, false, 'created hidden');
  assert.equal(
    log.onboarding[0].destroyed,
    false,
    'onboarding stays until the mail window is ready',
  );
  mail.paint();
  await handoff;
  assert.equal(mail.visible, true);
  assert.deepEqual(log.shown, [mail.id], 'shown is announced once, for the mail window');
  assert.equal(log.onboarding[0].destroyed, true);
  assert.equal(
    log.timers.every(timer => timer.cleared),
    true,
  );
  assert.equal(log.mail.length, 1);
});

test('handoff: finish twice shares one handoff and one mail window; the backstop shows a window that never paints', async () => {
  const { controller, log, mailWindow } = harness();
  controller.start(fresh, { atLogin: false });
  const a = controller.finish();
  const b = controller.finish();
  assert.equal(a, b);
  assert.equal(log.mail.length, 1);
  const backstop = log.timers.find(timer => timer.ms === READY_TIMEOUT_MS);
  assert.ok(backstop);
  backstop.run();
  await a;
  assert.equal(mailWindow()?.visible, true);
  assert.equal(log.onboarding[0].destroyed, true);
});

test('handoff: an existing visible mail window (Show welcome) is brought forward and onboarding closes', async () => {
  const { controller, log, seedMail } = harness();
  const mail = seedMail();
  mail.visible = true;
  controller.open('review');
  assert.equal(controller.activate(withAccount), 'focus-mail');
  await controller.finish();
  assert.equal(log.onboarding[0].destroyed, true);
  assert.equal(mail.destroyed, false);
  assert.equal(log.mail.length, 1, 'no second mail window');
});

test('window race: a painted window that is not visible (test mode, minimized) hands over at once', async () => {
  const { controller, log, seedMail } = harness({ testMode: true });
  const mail = seedMail();
  mail.paint();
  controller.open('review');
  await controller.finish(); // would stall for READY_TIMEOUT_MS if it waited for a ready-to-show that already fired
  assert.equal(log.onboarding[0].destroyed, true);
  assert.equal(
    log.timers.filter(timer => !timer.cleared).length,
    0,
    'no backstop timer was left armed',
  );
});

test('window race: a Dock click during the handoff never brings forward the unpainted mail window', async () => {
  const { controller, log, mailWindow } = harness();
  controller.start(fresh, { atLogin: false });
  const handoff = controller.finish();
  assert.equal(controller.activate(fresh), 'focus-onboarding');
  assert.equal(mailWindow()!.shows, 0);
  mailWindow()!.paint();
  await handoff;
  assert.equal(log.mail.length, 1);
  assert.equal(controller.activate(withAccount), 'focus-mail');
});

test('window race: the welcome closed and then the hidden mail window closing still leaves a window', async () => {
  const { controller, log, mailWindow } = harness();
  controller.start(fresh, { atLogin: false });
  const handoff = controller.finish();
  const first = mailWindow()!;
  log.onboarding[0].destroy(); // closed mid-handoff: the pending mail window stands in
  first.destroy();
  await handoff;
  assert.equal(log.mail.length, 2, 'a replacement mail window was created');
  assert.equal(mailWindow()!.destroyed, false);
});

test('window race: quitting during the handoff shows nothing, opens nothing and leaves no pending timer work', async () => {
  const { controller, log, mailWindow } = harness();
  controller.start(fresh, { atLogin: false });
  const handoff = controller.finish();
  const mail = mailWindow()!;
  log.quitting = true;
  mail.paint();
  await handoff;
  assert.equal(mail.shows, 0);
  assert.deepEqual(log.shown, []);
  // Quit closes the onboarding window: no replacement mail window may open while quitting.
  log.onboarding[0].destroy();
  assert.equal(log.mail.length, 1);
  controller.open('first');
  assert.equal(log.onboarding.length, 1);
});

test('window race: the mail window closing before it paints keeps the welcome window up', async () => {
  const { controller, log, mailWindow } = harness();
  controller.start(fresh, { atLogin: false });
  const handoff = controller.finish();
  mailWindow()!.destroy();
  await handoff;
  assert.equal(log.onboarding[0].destroyed, false);
  assert.equal(controller.isOpen(), true);
});

test('test mode never shows or focuses a window, yet still hands over and announces shown', async () => {
  const { controller, log, mailWindow } = harness({ testMode: true });
  controller.start(fresh, { atLogin: false });
  controller.activate(fresh);
  const handoff = controller.finish();
  mailWindow()!.paint();
  await handoff;
  assert.equal(mailWindow()!.shows, 0);
  assert.equal(log.onboarding[0].shows, 0);
  assert.equal(log.shown.length, 1);
  assert.equal(log.onboarding[0].destroyed, true);
});

test('System/openSettings only names the three fixed panes', () => {
  assert.match(settingsPaneUrl('notifications'), /^x-apple\.systempreferences:/);
  assert.match(settingsPaneUrl('microphone'), /Privacy_Microphone$/);
  assert.match(settingsPaneUrl('loginItems'), /LoginItems/);
  for (const bad of ['', 'toString', '__proto__', 'https://evil.example', undefined, 5])
    assert.throws(() => settingsPaneUrl(bad), /Choose a settings pane/);
});

test('fade: the welcome window thins out step by step after the mail window is up, then closes', async () => {
  const { controller, log, mailWindow } = harness({ fade: true });
  controller.start(fresh, { atLogin: false });
  const handoff = controller.finish();
  mailWindow()!.paint();
  const welcome = log.onboarding[0] as FadeWindow;
  assert.equal(mailWindow()!.visible, true, 'the mail window is on screen before the fade starts');
  assert.deepEqual(welcome.opacities, [1], 'the first step ran at once');
  assert.equal(welcome.destroyed, false);
  for (let step = 1; step <= FADE_STEPS; step++) {
    const timer = log.timers.filter(t => !t.cleared && t.ms !== FORCE_CLOSE_MS).at(-1)!;
    timer.run();
  }
  await handoff;
  assert.deepEqual(welcome.opacities, fadeOpacities());
  assert.equal(welcome.destroyed, true);
  assert.equal(
    log.timers.every(timer => timer.cleared || timer.ms !== FORCE_CLOSE_MS),
    true,
    'the force-close timer is cleared once the fade ends',
  );
});

test('fade: a stalled fade closes the window at FORCE_CLOSE_MS', async () => {
  const { controller, log, mailWindow } = harness({ fade: true });
  controller.start(fresh, { atLogin: false });
  const handoff = controller.finish();
  mailWindow()!.paint();
  assert.equal(log.onboarding[0].destroyed, false);
  log.timers.find(t => t.ms === FORCE_CLOSE_MS && !t.cleared)!.run();
  await handoff;
  assert.equal(log.onboarding[0].destroyed, true);
});

test('fade: a window that fails to take an opacity closes at once; test mode never fades', async () => {
  const broken = harness({ fade: true });
  broken.controller.start(fresh, { atLogin: false });
  (broken.log.onboarding[0] as FadeWindow).throws = true;
  const handoff = broken.controller.finish();
  broken.mailWindow()!.paint();
  await handoff;
  assert.equal(broken.log.onboarding[0].destroyed, true);

  const quiet = harness({ fade: true, testMode: true });
  quiet.controller.start(fresh, { atLogin: false });
  const done = quiet.controller.finish();
  quiet.mailWindow()!.paint();
  await done;
  assert.deepEqual((quiet.log.onboarding[0] as FadeWindow).opacities, []);
  assert.equal(quiet.log.onboarding[0].destroyed, true);
});

test('finish with a destination tells the mail window once, after it is shown; without one it does not', async () => {
  const withTo = harness();
  withTo.controller.start(fresh, { atLogin: false });
  const handoff = withTo.controller.finish({ to: 'settings.ai' });
  assert.deepEqual(withTo.log.navigated, [], 'not before the mail window paints');
  withTo.mailWindow()!.paint();
  await handoff;
  assert.deepEqual(withTo.log.navigated, [{ id: withTo.mailWindow()!.id, to: 'settings.ai' }]);

  const plain = harness();
  plain.controller.start(fresh, { atLogin: false });
  const done = plain.controller.finish();
  plain.mailWindow()!.paint();
  await done;
  assert.deepEqual(plain.log.navigated, []);
});

test('finish with a destination also navigates a mail window that is already up; a joined call keeps the first', async () => {
  const up = harness();
  up.controller.start(fresh, { atLogin: false });
  const mail = up.seedMail();
  mail.visible = true;
  mail.painted = true;
  await up.controller.finish({ to: 'settings.ai' });
  assert.deepEqual(up.log.navigated, [{ id: mail.id, to: 'settings.ai' }]);

  const joined = harness();
  joined.controller.start(fresh, { atLogin: false });
  const a = joined.controller.finish();
  const b = joined.controller.finish({ to: 'settings.ai' });
  joined.mailWindow()!.paint();
  await Promise.all([a, b]);
  assert.deepEqual(
    joined.log.navigated,
    [],
    'the first call had no destination, the joiner is ignored',
  );
});

test('finishOptionsOf accepts the one named destination and nothing else', () => {
  assert.deepEqual(finishOptionsOf({ to: 'settings.ai' }), { to: 'settings.ai' });
  for (const payload of [
    undefined,
    null,
    {},
    { to: 'inbox' },
    { to: 1 },
    { to: { x: 1 } },
    'settings.ai',
  ])
    assert.deepEqual(finishOptionsOf(payload), {}, JSON.stringify(payload));
});

test('a destination is never sent when the handoff is abandoned, nothing to hand over, or the sender throws', async () => {
  const abandoned = harness();
  abandoned.controller.start(fresh, { atLogin: false });
  const gone = abandoned.controller.finish({ to: 'settings.ai' });
  abandoned.mailWindow()!.destroy();
  await gone;
  assert.deepEqual(abandoned.log.navigated, []);

  const idle = harness();
  await idle.controller.finish({ to: 'settings.ai' });
  assert.deepEqual(idle.log.navigated, [], 'no onboarding window: nothing to hand over');
  // The refused call must not leave a handoff registered: a later one still runs.
  idle.controller.start(fresh, { atLogin: false });
  const later = idle.controller.finish({ to: 'settings.ai' });
  idle.mailWindow()!.paint();
  await later;
  assert.equal(idle.log.navigated.length, 1);
});

test('a sender that throws does not block the handoff: the welcome window still closes', async () => {
  const w = harness({ navigateThrows: true });
  w.controller.start(fresh, { atLogin: false });
  const handoff = w.controller.finish({ to: 'settings.ai' });
  w.mailWindow()!.paint();
  await handoff;
  assert.equal(w.log.onboarding[0].destroyed, true);
  assert.equal(w.mailWindow()!.visible, true);
});
