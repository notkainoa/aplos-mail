import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activation,
  applyWindowChoice,
  createOnboarding,
  isFirstRun,
  mailForActivation,
  readSessionFacts,
  startupWindow,
  UNKNOWN_FACTS,
  windowFallback,
  type OnboardingDeps,
  type SessionFacts,
  type WindowPort,
} from '../../src/host/lifecycle';

/**
 * The async seam between `Session/get` and the one window (M1–M3, F3): a failed first read never picks
 * onboarding, an activation landing while startup is pending never makes a second window, and a window
 * factory that throws falls back instead of leaving the app windowless.
 */

const fresh: SessionFacts = { hasAccounts: false, setup: {} };
const finished: SessionFacts = { hasAccounts: true, setup: { completedAt: 1 } };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('readSessionFacts: one retry turns a failed first read into the real answer', async () => {
  let calls = 0;
  const facts = await readSessionFacts(async () => {
    calls++;
    if (calls === 1) throw new Error('Session/get timed out');
    return finished;
  }, undefined);
  assert.equal(calls, 2);
  assert.deepEqual(facts, finished);
});

test('readSessionFacts: two misses on an existing install answer mail, never onboarding (M1)', async () => {
  let calls = 0;
  const facts = await readSessionFacts(async () => {
    calls++;
    throw new Error('The mailbox is restarting.');
  }, undefined);
  assert.equal(calls, 2, 'exactly one retry, then the unknown answer');
  assert.deepEqual(facts, UNKNOWN_FACTS);
  assert.equal(isFirstRun(facts), false, 'unknown is treated as not-first-run');
  assert.equal(startupWindow(facts, { atLogin: false }), 'mail');
  assert.equal(activation({ onboarding: false, mail: false }, facts), 'open-mail');
});

test('readSessionFacts: the last good answer stands in after two misses, whichever way it pointed', async () => {
  const fail = () => Promise.reject<SessionFacts>(new Error('The mailbox is restarting.'));
  assert.deepEqual(await readSessionFacts(fail, finished), finished, 'a finished setup stays mail');
  assert.deepEqual(
    await readSessionFacts(fail, fresh),
    fresh,
    'a real first run still gets onboarding while the engine restarts',
  );
});

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

/**
 * The windows.ts wiring, with fakes: `ensureMail` is the one guarded mail-window factory (the `main` slot),
 * shared by the startup `.then`, activations and the handoff, like `ensureMain` in `main/windows.ts`.
 */
function flow() {
  const log = {
    mail: [] as FakeWindow[],
    onboarding: [] as FakeWindow[],
    reported: [] as unknown[],
    fatal: [] as unknown[],
    activated: 0,
  };
  let mail: FakeWindow | undefined;
  let mailFailures = 0;
  const ensureMail = () => {
    if (mail && !mail.destroyed) return mail;
    if (mailFailures > 0) {
      mailFailures--;
      throw new Error('new BrowserWindow failed');
    }
    mail = new FakeWindow();
    log.mail.push(mail);
    return mail;
  };
  const deps: OnboardingDeps = {
    createOnboarding: () => {
      const win = new FakeWindow();
      log.onboarding.push(win);
      return win;
    },
    createMail: () => ensureMail(),
    currentMail: () => (mail && !mail.destroyed ? mail : undefined),
    endSetup: async () => undefined,
    announceShown: () => undefined,
    isQuitting: () => false,
    testMode: false,
    setTimer: (run, ms) => setTimeout(run, ms),
    clearTimer: handle => clearTimeout(handle as NodeJS.Timeout),
  };
  const controller = createOnboarding(deps);
  // The startup continuation, as `main/lifecycle.ts` wires it.
  const startup = (facts: Promise<SessionFacts>) =>
    facts
      .then(read => controller.start(read, { atLogin: false }))
      .then(choice =>
        applyWindowChoice(choice, {
          onboardingOpen: () => controller.isOpen(),
          ensureMail: () => void ensureMail(),
          activate: () => void log.activated++,
        }),
      )
      .catch(error =>
        windowFallback(error, {
          report: failure => void log.reported.push(failure),
          ensureMail: () => void ensureMail(),
          fatal: failure => void log.fatal.push(failure),
        }),
      );
  // focusMain's continuation, as `main/windows.ts` wires it (without paint/focus).
  const activation = (facts: Promise<SessionFacts>) =>
    facts
      .then(read => controller.activate(read))
      .then(decision => mailForActivation(decision, ensureMail));
  return {
    controller,
    log,
    startup,
    activation,
    mailWindow: () => mail,
    failMail: (n: number) => (mailFailures = n),
  };
}

test('window race: an activation while startup is pending makes exactly one window, either resolution order', async () => {
  // The activation resolves first, then startup: one mail window.
  const a = flow();
  const aStart = deferred<SessionFacts>();
  const aActivate = deferred<SessionFacts>();
  const aStartup = a.startup(aStart.promise);
  const aActivation = a.activation(aActivate.promise);
  aActivate.resolve(finished);
  await aActivation;
  aStart.resolve(finished);
  await aStartup;
  assert.equal(a.log.mail.length, 1, "startup found the activation's window already there");
  assert.equal(a.log.onboarding.length, 0);

  // Startup resolves first, then the activation: still one mail window.
  const b = flow();
  const bStart = deferred<SessionFacts>();
  const bActivate = deferred<SessionFacts>();
  const bStartup = b.startup(bStart.promise);
  const bActivation = b.activation(bActivate.promise);
  bStart.resolve(finished);
  await bStartup;
  bActivate.resolve(finished);
  await bActivation;
  assert.equal(b.log.mail.length, 1);
  assert.equal(b.log.onboarding.length, 0);
});

test('window race: a first-run activation then a mail startup choice leaves the one onboarding window', async () => {
  const f = flow();
  const fStart = deferred<SessionFacts>();
  const fActivate = deferred<SessionFacts>();
  const fStartup = f.startup(fStart.promise);
  const fActivation = f.activation(fActivate.promise);
  fActivate.resolve(fresh);
  await fActivation;
  assert.equal(f.log.onboarding.length, 1, 'the activation opened onboarding');
  fStart.resolve(finished);
  await fStartup;
  assert.equal(
    f.log.mail.length,
    0,
    'a late mail choice never overrides the open onboarding window',
  );
  assert.equal(f.log.onboarding.length, 1);
});

test('window race: a first-run activation then an onboarding startup choice still leaves one window', async () => {
  const f = flow();
  const fStart = deferred<SessionFacts>();
  const fActivate = deferred<SessionFacts>();
  const fStartup = f.startup(fStart.promise);
  const fActivation = f.activation(fActivate.promise);
  fActivate.resolve(fresh);
  await fActivation;
  fStart.resolve(fresh);
  await fStartup;
  assert.equal(f.log.onboarding.length, 1, 'startup joined the open onboarding window');
  assert.equal(f.log.mail.length, 0);
});

test('window race: a mail startup then a first-run activation never opens onboarding over the live mail window', async () => {
  const f = flow();
  const fStart = deferred<SessionFacts>();
  const fActivate = deferred<SessionFacts>();
  const fStartup = f.startup(fStart.promise);
  const fActivation = f.activation(fActivate.promise);
  fStart.resolve(finished);
  await fStartup;
  assert.equal(f.log.mail.length, 1, 'startup made the mail window (not yet painted)');
  assert.equal(f.mailWindow()?.painted, false);
  fActivate.resolve(fresh);
  const win = await fActivation;
  assert.equal(
    f.log.onboarding.length,
    0,
    'no first-run window over a live mail window, even unpainted',
  );
  assert.equal(win, undefined, 'the activation answered with no new window');
  assert.equal(f.log.mail.length, 1);
});

test('window failure: a throwing factory falls back through the catch and never leaves the app windowless', async () => {
  const f = flow();
  f.failMail(1); // the first attempt inside applyWindowChoice throws; the fallback's retry succeeds
  await f.startup(Promise.resolve(finished));
  assert.equal(f.log.reported.length, 1, 'the failure was logged');
  assert.equal(f.log.mail.length, 1, 'the fallback made the mail window');
  assert.equal(f.log.fatal.length, 0);

  const dead = flow();
  dead.failMail(2); // the choice and the fallback both fail
  await dead.startup(Promise.resolve(finished));
  assert.equal(dead.log.fatal.length, 1, 'the "could not start" path ran');
  assert.equal(dead.log.mail.length, 0);
});

test('window failure: a startup that itself rejects falls back to the mail window', async () => {
  const f = flow();
  await f.startup(Promise.reject(new Error('engine went away mid-read')));
  assert.equal(f.log.reported.length, 1);
  assert.equal(f.log.mail.length, 1);
  assert.equal(f.log.fatal.length, 0);
});

test('mailForActivation: an onboarding decision makes no mail window, a mail one returns the shared window (M5)', () => {
  let made = 0;
  const ensure = () => {
    made++;
    return new FakeWindow();
  };
  assert.equal(mailForActivation('open-onboarding', ensure), undefined);
  assert.equal(mailForActivation('focus-onboarding', ensure), undefined);
  assert.equal(made, 0, 'first run: no mail window is made for a queued command');
  const win = mailForActivation('open-mail', ensure);
  assert.ok(win instanceof FakeWindow);
  assert.equal(made, 1);
});

test('bring: an activation never lifts an unpainted window (F4), the handoff backstop may', async () => {
  const f = flow();
  f.controller.start(fresh, { atLogin: false });
  const onboarding = f.log.onboarding[0];
  f.controller.open('first'); // an activation lands while the window still loads: bring() must not show it
  assert.equal(onboarding.shows, 0, 'an unpainted window is not shown early');
  onboarding.paint();
  f.controller.open('first');
  assert.equal(onboarding.shows, 1, 'once painted it comes forward');
});
