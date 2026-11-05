// The focus side of `aplos://oauth-return`: which existing window a valid link raises, and that a
// later add can never surface (or create) the setup window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOnboarding, oauthReturnTarget } from '../../src/host/lifecycle';
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
    currentMail: () => mail,
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
  assert.equal(onboarding.focusOpen(), true);
  assert.equal(welcome.focused, true);
  assert.equal(mailCreated, 0);
});
