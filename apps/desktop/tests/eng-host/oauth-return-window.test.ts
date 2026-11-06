// The focus side of `aplos://oauth-return`: which existing window a valid link raises, and that a
// later add can never surface (or create) the setup window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createOnboarding,
  focusOauthReturnWindow,
  oauthReturnTarget,
  createLinkGate,
} from '../../src/host/lifecycle';
import type { WindowPort } from '../../src/host/lifecycle';

test('oauthReturnTarget never opens the setup window for a mail-window flow', () => {
  assert.equal(oauthReturnTarget('mail', { onboarding: true, mail: true }), 'mail');
  assert.equal(oauthReturnTarget('mail', { onboarding: true, mail: false }), 'none');
  assert.equal(oauthReturnTarget('mail', { onboarding: false, mail: true }), 'mail');
  assert.equal(oauthReturnTarget('mail', { onboarding: false, mail: false }), 'none');
});

test('oauthReturnTarget falls back to the mail window when the setup window is gone', () => {
  assert.equal(oauthReturnTarget('onboarding', { onboarding: true, mail: true }), 'onboarding');
  assert.equal(oauthReturnTarget('onboarding', { onboarding: false, mail: true }), 'mail');
  assert.equal(oauthReturnTarget('onboarding', { onboarding: false, mail: false }), 'none');
});

class FakeWindow implements WindowPort {
  id = 1;
  destroyed = false;
  visible = false;
  painted = false;
  focused = false;
  shown = 0;
  closed = 0;
  isDestroyed = () => this.destroyed;
  isVisible = () => this.visible;
  hasPainted = () => this.painted;
  isMinimized = () => false;
  restore() {}
  show() {
    this.visible = true;
    this.shown++;
  }
  focus() {
    this.focused = true;
  }
  close() {
    this.closed++;
    this.destroyed = true;
  }
  setOpacity() {}
  onReadyToShow() {}
  onClosed(listener: () => void) {
    this.listener = listener;
  }
  listener?: () => void;
}

test('focusOpen raises the open welcome window and never creates one', () => {
  let welcome: FakeWindow | undefined;
  let mailCreated = 0;
  const mail = new FakeWindow();
  const onboarding = createOnboarding({
    createOnboarding: () => {
      welcome = new FakeWindow();
      return welcome;
    },
    createMail: () => {
      mailCreated++;
      return mail;
    },
    // First run: no mail window exists (#316: first-run never opens over a live mail window).
    currentMail: () => undefined,
    endSetup: async () => undefined,
    announceShown: () => {},
    isQuitting: () => false,
    testMode: false,
    setTimer: (run: () => void) => setTimeout(run, 0),
    clearTimer: () => {},
  });
  assert.equal(onboarding.focusOpen(), false);
  onboarding.open('first');
  assert.ok(welcome);
  // A window still waiting for its first paint is not shown early (F4, #316's bring): the focus is declined, so a
  // deep link never raises the app over a window nobody can see yet.
  assert.equal(onboarding.focusOpen(), false);
  assert.equal(welcome.focused, false);
  welcome.painted = true;
  assert.equal(onboarding.focusOpen(), true);
  assert.equal(welcome.focused, true);
  assert.equal(mailCreated, 0);
});

test('focusOauthReturnWindow raises the app only after a live window took the focus', () => {
  // The recorded welcome window died between the open check and the focus and there is no mail
  // window to fall back to: resolving 'none' must not pull the app forward over nothing.
  let raised = 0;
  const dead = focusOauthReturnWindow('onboarding', {
    onboardingOpen: () => true,
    focusOnboarding: () => false,
    mail: () => undefined,
    raiseApp: () => raised++,
    testMode: false,
  });
  assert.equal(dead, 'none');
  assert.equal(raised, 0);
  // A live welcome window: the window is focused first, the app raised second.
  const order: string[] = [];
  const focused = focusOauthReturnWindow('onboarding', {
    onboardingOpen: () => true,
    focusOnboarding: () => {
      order.push('window');
      return true;
    },
    mail: () => undefined,
    raiseApp: () => {
      order.push('app');
    },
    testMode: false,
  });
  assert.equal(focused, 'onboarding');
  assert.deepEqual(order, ['window', 'app']);
  // The mail path: restored/shown/focused, then the app raised; and with no live window at all the
  // app is never raised.
  const mail = new FakeWindow();
  const order2: string[] = [];
  const got = focusOauthReturnWindow('mail', {
    onboardingOpen: () => false,
    focusOnboarding: () => assert.fail('the mail target never asks onboarding'),
    mail: () => mail,
    raiseApp: () => {
      order2.push('app');
    },
    testMode: false,
  });
  assert.equal(got, 'mail');
  assert.deepEqual([mail.shown, mail.focused], [1, true]);
  assert.deepEqual(order2, ['app']);
  let raised2 = 0;
  const none = focusOauthReturnWindow('mail', {
    onboardingOpen: () => true,
    focusOnboarding: () => assert.fail('a mail-flow link never surfaces the setup window'),
    mail: () => undefined,
    raiseApp: () => raised2++,
    testMode: false,
  });
  assert.equal(none, 'none');
  assert.equal(raised2, 0);
});

test('an unfocusable welcome window falls through to the live mail window, or to none', () => {
  // The welcome window is open but unpainted, so focusOpen declines it: the deep link falls back
  // to the mail window, exactly where oauthReturnTarget sends a closed welcome.
  const mail = new FakeWindow();
  let raised = 0;
  const focused = focusOauthReturnWindow('onboarding', {
    onboardingOpen: () => true,
    focusOnboarding: () => false,
    mail: () => mail,
    raiseApp: () => raised++,
    testMode: false,
  });
  assert.equal(focused, 'mail');
  assert.equal(raised, 1);
  assert.deepEqual([mail.shown, mail.focused], [1, true]);
  // No mail window either: nothing is focused and the app is never raised.
  let raised2 = 0;
  const none = focusOauthReturnWindow('onboarding', {
    onboardingOpen: () => true,
    focusOnboarding: () => false,
    mail: () => undefined,
    raiseApp: () => raised2++,
    testMode: false,
  });
  assert.equal(none, 'none');
  assert.equal(raised2, 0);
  // A welcome window that takes the focus still wins over the mail fallback.
  const painted = focusOauthReturnWindow('onboarding', {
    onboardingOpen: () => true,
    focusOnboarding: () => true,
    mail: () => mail,
    raiseApp: () => {},
    testMode: false,
  });
  assert.equal(painted, 'onboarding');
});

test('a link gate holds oauth-return links until the first window choice is applied', () => {
  const gate = createLinkGate(2);
  assert.equal(
    gate.hold('aplos://oauth-return?n=a'),
    true,
    'held while the window is being chosen',
  );
  assert.equal(gate.hold('aplos://oauth-return?n=b'), true);
  assert.equal(
    gate.hold('aplos://oauth-return?n=c'),
    true,
    'over the cap: still held back, but dropped',
  );
  assert.deepEqual(
    gate.release(),
    ['aplos://oauth-return?n=a', 'aplos://oauth-return?n=b'],
    'oldest first, bounded',
  );
  assert.equal(gate.hold('aplos://oauth-return?n=d'), false, 'after the choice it answers at once');
  assert.deepEqual(gate.release(), [], 'released once');
});

test('startup releases the held links only after the window choice was applied (source order)', () => {
  const src = readFileSync(join(import.meta.dirname, '../../src/main/lifecycle.ts'), 'utf8');
  const chain = src.indexOf('const windowsSettled = startWindows(atLogin)');
  const release = src.indexOf('oauthGate.release()');
  assert.ok(chain > 0 && release > chain, 'the drain sits after the startWindows chain');
  assert.match(
    src,
    /windowsSettled\.finally\(\(\) => \{[\s\S]*oauthGate\.release\(\)/,
    'drained from the settled chain',
  );
  assert.doesNotMatch(src, /queuedOauthReturns/, 'the started-only queue is gone');
});
