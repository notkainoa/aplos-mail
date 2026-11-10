// The weekly reconnect (DESIGN 7.1, 7.10, 7.15; plan 30 U8 acceptance 3 and 9; roadmap N3).
// Run: cd apps/desktop && npx tsx --test tests/ui-onboard/reconnect.test.ts
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import {
  DAY_MS,
  callFor,
  callForSheetMode,
  enableForSheetMode,
  initialReconnect,
  reconnectOffer,
  reconnectedToast,
  reduceReconnect,
  runReconnectEffect,
  sheetView,
  type ReconnectAccount,
  type ReconnectEffect,
  type ReconnectEvent,
  type ReconnectPorts,
  type ReconnectState,
  type SheetMode,
} from '../../src/renderer/onboarding/reconnect/reconnect.model';

const NOW = new Date(2026, 9, 29, 10, 0).getTime();
const ADDRESS = 'jordan.lee@example.com';

const account = (
  over: Partial<ReconnectAccount['health']> & { state?: string } = {},
  rest: Partial<ReconnectAccount> = {},
) => {
  const { state = 'ok', ...health } = over;
  return { health: { status: { state }, ...health }, ...rest } satisfies ReconnectAccount;
};

describe('which accounts offer Reconnect, and which call', () => {
  test('reconnect-due-line: ok with reconnectBy inside 24 h offers "Reconnect now" through Account/reconnect', () => {
    const offer = reconnectOffer(account({ reconnectBy: NOW + DAY_MS - 1 }), NOW);
    assert.equal(offer?.call, 'reconnect');
    assert.equal(offer?.reason, 'dueSoon');
    assert.equal(offer?.label, 'Reconnect now');
    assert.equal(offer?.mode, 'reconnect');
  });

  test('a grant that lasts longer than a day offers nothing', () => {
    assert.equal(reconnectOffer(account({ reconnectBy: NOW + DAY_MS + 1 }), NOW), null);
    assert.equal(reconnectOffer(account(), NOW), null);
  });

  test('reconnectBy already past still offers it (the status flips to needsReauth a moment later)', () => {
    assert.equal(reconnectOffer(account({ reconnectBy: NOW - 1000 }), NOW)?.call, 'reconnect');
  });

  test('needsReauth offers "Reconnect" through Account/reconnect', () => {
    const offer = reconnectOffer(
      account({ state: 'needsReauth', reasonCode: 'auth.expired' }),
      NOW,
    );
    assert.deepEqual(
      [offer?.call, offer?.label, offer?.reason],
      ['reconnect', 'Reconnect', 'needsReauth'],
    );
  });

  test('needsPermission offers Account/grantPermissions and the grant copy', () => {
    const offer = reconnectOffer(
      account({ state: 'needsPermission', reasonCode: 'permission.mailModify' }),
      NOW,
    );
    assert.deepEqual(
      [offer?.call, offer?.mode, offer?.label],
      ['grantPermissions', 'grant', 'Reconnect'],
    );
  });

  test('a missing feature permission while mail works grants; needsReauth outranks it; due outranks nothing', () => {
    const missing = [{ capability: 'calendar', reasonCode: 'permission.calendar' }];
    assert.equal(
      reconnectOffer(account({}, { missingPermissions: missing }), NOW)?.call,
      'grantPermissions',
    );
    assert.equal(
      reconnectOffer(
        account({ state: 'needsReauth', reconnectBy: NOW }, { missingPermissions: missing }),
        NOW,
      )?.call,
      'reconnect',
    );
    assert.equal(reconnectOffer(account({}, { missingPermissions: [] }), NOW), null);
  });

  test("a refused calendar write's calendarWrite row is no offer on its own; other rows still grant", () => {
    // The calendarWrite-only account has its own entry point (Settings → Calendar's "Enable
    // editing"); it is never a standing 'missingPermission' nag here.
    const writeOnly = [{ capability: 'calendarWrite', reasonCode: 'permission.calendarWrite' }];
    assert.equal(reconnectOffer(account({}, { missingPermissions: writeOnly }), NOW), null);
    const withRead = [
      { capability: 'calendarWrite', reasonCode: 'permission.calendarWrite' },
      { capability: 'calendar', reasonCode: 'permission.calendar' },
    ];
    assert.equal(
      reconnectOffer(account({}, { missingPermissions: withRead }), NOW)?.call,
      'grantPermissions',
      'a real read gap still offers the grant',
    );
  });

  test('nothing is offered for demo mail, an administrator block, a build without Google set up, or offline', () => {
    assert.equal(reconnectOffer(account({ state: 'needsReauth' }, { demo: true }), NOW), null);
    assert.equal(
      reconnectOffer(account({ state: 'needsAdmin', reasonCode: 'auth.adminPolicy' }), NOW),
      null,
    );
    assert.equal(
      reconnectOffer(account({ state: 'needsReauth', reasonCode: 'auth.adminConsent' }), NOW),
      null,
    );
    assert.equal(reconnectOffer(account({ state: 'misconfigured' }), NOW), null);
    assert.equal(reconnectOffer(account({ state: 'offline', reconnectBy: NOW }), NOW), null);
  });

  test('an explicit click on an account with no offer still makes the weekly call', () => {
    assert.equal(callFor(account(), NOW), 'reconnect');
    assert.equal(callFor(account({ state: 'needsPermission' }), NOW), 'grantPermissions');
  });
});

/** The reducer plus a recording runner: what the owner sees and what the engine is asked. */
function harness(call: 'reconnect' | 'grantPermissions' = 'reconnect') {
  let state: ReconnectState = initialReconnect({ accountId: 'acc-1', address: ADDRESS, call });
  const effects: ReconnectEffect[] = [];
  const send = (event: ReconnectEvent) => {
    const out = reduceReconnect(state, event);
    state = out.state;
    effects.push(...out.effects);
    return out;
  };
  return {
    send,
    get state() {
      return state;
    },
    effects,
    closes: () => effects.filter(e => e.type === 'close'),
    cancels: () => effects.filter(e => e.type === 'cancelConnect'),
    starts: () => effects.filter(e => e.type === 'start'),
  };
}

const started = (attempt = 1, connectId = 'c1'): ReconnectEvent => ({
  type: 'started',
  attempt,
  connectId,
});
const frame = (
  state: string,
  over: Partial<Extract<ReconnectEvent, { type: 'frame' }>> = {},
): ReconnectEvent => ({
  type: 'frame',
  connectId: 'c1',
  mode: 'reconnect',
  state,
  accountId: 'acc-1',
  ...over,
});

describe('the sheet: idle → waiting → failed | reconnected → closed', () => {
  test('opening starts exactly one call, and the sheet is "waiting" at once', () => {
    const h = harness();
    h.send({ type: 'open' });
    h.send({ type: 'open' });
    assert.equal(h.state.phase, 'waiting');
    assert.deepEqual(h.starts(), [
      { type: 'start', call: 'reconnect', accountId: 'acc-1', attempt: 1 },
    ]);
    assert.deepEqual(sheetView(h.state), {
      open: true,
      state: 'waiting',
      mode: 'reconnect',
      address: ADDRESS,
    });
  });

  test('connected: the sheet closes as "reconnected"', () => {
    const h = harness();
    h.send({ type: 'open' });
    h.send(started());
    h.send(frame('waiting'));
    assert.equal(h.state.phase, 'waiting');
    h.send(frame('connected'));
    assert.equal(h.state.phase, 'closed');
    assert.deepEqual(h.closes(), [{ type: 'close', outcome: 'reconnected' }]);
    assert.equal(sheetView(h.state).open, false);
  });

  test('failed: a plain sentence from copy.ts and Try again; retry starts a new attempt', () => {
    const h = harness();
    h.send({ type: 'open' });
    h.send(started());
    h.send(frame('failed', { reasonCode: 'auth.denied' }));
    assert.equal(h.state.phase, 'failed');
    assert.equal(sheetView(h.state).reason, 'Google sign-in was declined. Nothing changed.');
    h.send({ type: 'retry' });
    assert.equal(h.state.phase, 'waiting');
    assert.equal(h.state.reason, undefined);
    assert.equal(h.starts().length, 2);
    assert.equal(h.starts()[1]?.type === 'start' && h.starts()[1].attempt, 2);
  });

  test('reconnect-wrong-account: auth.wrongAccount names the address to choose', () => {
    const h = harness();
    h.send({ type: 'open' });
    h.send(started());
    h.send(frame('failed', { reasonCode: 'auth.wrongAccount' }));
    assert.equal(h.state.phase, 'failed');
    assert.equal(
      h.state.reason,
      `That was a different Google account. Choose ${ADDRESS} to reconnect.`,
    );
  });

  test('timeout and an unknown code: a known code has its sentence; an unknown one falls back to the sheet default', () => {
    const timeout = harness();
    timeout.send({ type: 'open' });
    timeout.send(started());
    timeout.send(frame('failed', { reasonCode: 'auth.timeout' }));
    assert.equal(timeout.state.reason, 'Google sign-in took too long. Try again.');
    const unknown = harness();
    unknown.send({ type: 'open' });
    unknown.send(started());
    unknown.send(frame('failed', { reasonCode: 'something.new' }));
    assert.equal(unknown.state.phase, 'failed');
    assert.equal(unknown.state.reason, undefined);
    assert.equal('reason' in sheetView(unknown.state), false);
  });

  test('the call itself refused: failed with its sentence, Try again works', () => {
    const h = harness();
    h.send({ type: 'open' });
    h.send({ type: 'startFailed', attempt: 1, reasonCode: 'net.offline' });
    assert.equal(h.state.phase, 'failed');
    assert.equal(h.state.reason, 'You’re offline. Aplos continues when you’re back online.');
  });

  test('grant mode: Account/grantPermissions, the grant copy, and frames of its own mode only', () => {
    const h = harness('grantPermissions');
    h.send({ type: 'open' });
    h.send(started());
    assert.equal(h.starts()[0]?.type === 'start' && h.starts()[0].call, 'grantPermissions');
    assert.equal(sheetView(h.state).mode, 'grant');
    h.send(frame('connected', { mode: 'reconnect' }));
    assert.equal(h.state.phase, 'waiting');
    h.send(frame('connected', { mode: 'grantPermissions' }));
    assert.equal(h.state.phase, 'closed');
  });

  test("the 'enableEditing' sheet mode is grantPermissions plus enable 'calendarWrite'; 'grant' carries none", () => {
    assert.equal(callForSheetMode('enableEditing'), 'grantPermissions');
    assert.equal(callForSheetMode('grant'), 'grantPermissions');
    assert.equal(callForSheetMode('reconnect'), 'reconnect');
    assert.equal(enableForSheetMode('enableEditing'), 'calendarWrite');
    assert.equal(enableForSheetMode('grant'), undefined);
    assert.equal(enableForSheetMode('reconnect'), undefined);
    const initial = initialReconnect({
      accountId: 'acc-1',
      address: ADDRESS,
      call: 'grantPermissions',
      enable: 'calendarWrite',
    });
    const out = reduceReconnect(initial, { type: 'open' });
    const state = out.state;
    assert.deepEqual(out.effects, [
      {
        type: 'start',
        call: 'grantPermissions',
        accountId: 'acc-1',
        attempt: 1,
        enable: 'calendarWrite',
      },
    ]);
    assert.equal(sheetView(state).mode, 'enableEditing');
    // A retry keeps the same widened call.
    const failed = reduceReconnect(state, { type: 'startFailed', attempt: 1 });
    const retried = reduceReconnect(failed.state, { type: 'retry' });
    assert.equal(
      retried.effects[0]?.type === 'start' && retried.effects[0].enable,
      'calendarWrite',
    );
  });

  test('callForSheetMode fails closed: an absent or unknown mode is the narrower reconnect', () => {
    // openSheet casts its args without a runtime check, so a missing or mistyped mode must never
    // widen the call to Account/grantPermissions.
    for (const mode of [undefined, '', 'bogus'] as const) {
      assert.equal(callForSheetMode(mode as SheetMode), 'reconnect', `mode ${String(mode)}`);
    }
    assert.equal(callForSheetMode('reconnect'), 'reconnect');
    assert.equal(callForSheetMode('grant'), 'grantPermissions');
    assert.equal(callForSheetMode('enableEditing'), 'grantPermissions');
  });

  test("a 'reconnected' close of the editing ask raises no 'Reconnected' toast; reconnect and grant keep it", () => {
    // For 'enableEditing' the row flipping to "Editing on" is the confirmation — and a consent that
    // left the events scope unticked must not announce a reconnect that never happened.
    assert.equal(reconnectedToast({ enable: 'calendarWrite' }), null);
    assert.equal(reconnectedToast({}), 'Reconnected');
  });
});

describe('races: Cancel, late frames, another flow', () => {
  test('keys-sheet-esc-cancels: Cancel while waiting calls cancelConnect with the flow id and closes as cancelled', () => {
    const h = harness();
    h.send({ type: 'open' });
    h.send(started());
    h.send({ type: 'cancel' });
    assert.equal(h.state.phase, 'closed');
    assert.deepEqual(h.cancels(), [{ type: 'cancelConnect', connectId: 'c1' }]);
    assert.deepEqual(h.closes(), [{ type: 'close', outcome: 'cancelled' }]);
  });

  test('a late connected frame after Cancel changes nothing: no second close, no toast outcome', () => {
    const h = harness();
    h.send({ type: 'open' });
    h.send(started());
    h.send({ type: 'cancel' });
    const before = h.state;
    h.send(frame('connected'));
    h.send(frame('failed', { reasonCode: 'auth.denied' }));
    assert.equal(h.state, before);
    assert.equal(h.closes().length, 1);
  });

  test('a late frame after the sheet already reconnected is ignored', () => {
    const h = harness();
    h.send({ type: 'open' });
    h.send(started());
    h.send(frame('connected'));
    h.send(frame('failed', { reasonCode: 'auth.expired' }));
    h.send(frame('connected'));
    assert.equal(h.closes().length, 1);
    assert.equal(h.state.outcome, 'reconnected');
  });

  test('Cancel before the id arrives: the id is cancelled when it lands, and nothing on screen changes', () => {
    const h = harness();
    h.send({ type: 'open' });
    h.send({ type: 'cancel' });
    assert.deepEqual(h.cancels(), []);
    const closed = h.state;
    h.send(started(1, 'late'));
    assert.deepEqual(h.cancels(), [{ type: 'cancelConnect', connectId: 'late' }]);
    assert.equal(h.state, closed);
    h.send(frame('connected', { connectId: 'late' }));
    assert.equal(h.closes().length, 1);
  });

  test("a settled frame that beats the call's answer is kept until the id arrives", () => {
    const h = harness();
    h.send({ type: 'open' });
    h.send(frame('connected'));
    assert.equal(h.state.phase, 'waiting');
    h.send(started());
    assert.equal(h.state.phase, 'closed');
    assert.equal(h.state.outcome, 'reconnected');
    // A frame for some other flow never settles this one.
    const other = harness();
    other.send({ type: 'open' });
    other.send(frame('connected', { connectId: 'old' }));
    other.send(started(1, 'c1'));
    assert.equal(other.state.phase, 'waiting');
  });

  test("an older attempt's frame or id after Try again does not settle or break the new attempt", () => {
    const h = harness();
    h.send({ type: 'open' });
    h.send(started(1, 'c1'));
    h.send(frame('failed', { reasonCode: 'auth.denied' }));
    h.send({ type: 'retry' });
    h.send(started(2, 'c2'));
    h.send(frame('failed', { connectId: 'c1', reasonCode: 'auth.denied' }));
    assert.equal(h.state.phase, 'waiting');
    // The old attempt's id answering now is cancelled; the new flow keeps waiting.
    h.send(started(1, 'c1-again'));
    assert.deepEqual(h.cancels(), [{ type: 'cancelConnect', connectId: 'c1-again' }]);
    h.send(frame('connected', { connectId: 'c2' }));
    assert.equal(h.state.outcome, 'reconnected');
  });

  test('Cancel on the failed sheet closes it as failed and cancels nothing (the flow already ended)', () => {
    const h = harness();
    h.send({ type: 'open' });
    h.send(started());
    h.send(frame('failed', { reasonCode: 'auth.timeout' }));
    h.send({ type: 'cancel' });
    assert.deepEqual(h.cancels(), []);
    assert.deepEqual(h.closes(), [{ type: 'close', outcome: 'failed' }]);
  });

  test('frames for another account or another mode are ignored; the engine cancelling the flow closes as cancelled', () => {
    const h = harness();
    h.send({ type: 'open' });
    h.send(started());
    h.send(frame('connected', { accountId: 'acc-2' }));
    h.send(frame('connected', { mode: 'new' }));
    assert.equal(h.state.phase, 'waiting');
    h.send(frame('cancelled'));
    assert.deepEqual(h.closes(), [{ type: 'close', outcome: 'cancelled' }]);
  });
});

describe('reconnect-no-resync: no Sync/request, ever', () => {
  /** Ports that record every engine call by its contract name. */
  function recorder(connectId = 'c1') {
    const calls: string[] = [];
    const ports: ReconnectPorts = {
      reconnect: async () => {
        calls.push('Account/reconnect');
        return { connectId };
      },
      grantPermissions: async () => {
        calls.push('Account/grantPermissions');
        return { connectId };
      },
      cancelConnect: async () => {
        calls.push('Account/cancelConnect');
        return { cancelled: true };
      },
    };
    return { ports, calls };
  }

  /** Runs events through the reducer and every effect through the ports, to quiescence. */
  async function play(
    call: 'reconnect' | 'grantPermissions',
    script: (send: (e: ReconnectEvent) => void) => void | Promise<void>,
  ) {
    const { ports, calls } = recorder();
    let state = initialReconnect({ accountId: 'acc-1', address: ADDRESS, call });
    const pending: Promise<void>[] = [];
    const send = (event: ReconnectEvent) => {
      const out = reduceReconnect(state, event);
      state = out.state;
      for (const effect of out.effects) pending.push(runReconnectEffect(effect, ports, send));
    };
    send({ type: 'open' });
    await script(send);
    for (let i = 0; i < 4; i += 1) await Promise.all(pending.splice(0));
    return { calls, state };
  }

  test('open → connected makes exactly one Account/reconnect call and nothing else', async () => {
    const { calls, state } = await play('reconnect', async send => {
      await new Promise(r => setImmediate(r));
      send(frame('connected'));
    });
    assert.deepEqual(calls, ['Account/reconnect']);
    assert.equal(state.outcome, 'reconnected');
  });

  test('failed, Try again, connected: only reconnect calls; grant mode only grantPermissions; Cancel adds cancelConnect', async () => {
    const retry = await play('reconnect', async send => {
      await new Promise(r => setImmediate(r));
      send(frame('failed', { reasonCode: 'auth.timeout' }));
      send({ type: 'retry' });
      await new Promise(r => setImmediate(r));
      send({ type: 'cancel' });
    });
    assert.deepEqual(retry.calls, [
      'Account/reconnect',
      'Account/reconnect',
      'Account/cancelConnect',
    ]);
    const grant = await play('grantPermissions', async send => {
      await new Promise(r => setImmediate(r));
      send(frame('connected', { mode: 'grantPermissions' }));
    });
    assert.deepEqual(grant.calls, ['Account/grantPermissions']);
  });

  test("the 'enableEditing' start asks grantPermissions with enable 'calendarWrite'; a plain grant does not", async () => {
    const inputs: { accountId: string; enable?: 'calendarWrite' }[] = [];
    const ports: ReconnectPorts = {
      reconnect: async () => ({ connectId: 'c1' }),
      grantPermissions: async input => {
        inputs.push(input);
        return { connectId: 'c1' };
      },
      cancelConnect: async () => ({ cancelled: true }),
    };
    const run = async (state: ReconnectState) => {
      const out = reduceReconnect(state, { type: 'open' });
      for (const effect of out.effects) await runReconnectEffect(effect, ports, () => {});
      return out.state;
    };
    await run(
      initialReconnect({
        accountId: 'acc-1',
        address: ADDRESS,
        call: 'grantPermissions',
        enable: 'calendarWrite',
      }),
    );
    await run(initialReconnect({ accountId: 'acc-1', address: ADDRESS, call: 'grantPermissions' }));
    assert.deepEqual(inputs, [
      { accountId: 'acc-1', enable: 'calendarWrite' },
      { accountId: 'acc-1' },
    ]);
  });

  test('the effect vocabulary and the ports have no sync: every effect is start, cancelConnect or close', () => {
    const effects = new Set<string>();
    const h = harness();
    const events: ReconnectEvent[] = [
      { type: 'open' },
      started(),
      frame('failed', { reasonCode: 'auth.denied' }),
      { type: 'retry' },
      started(2, 'c2'),
      { type: 'cancel' },
      started(2, 'c3'),
    ];
    for (const event of events) h.send(event);
    h.effects.forEach(e => effects.add(e.type));
    assert.deepEqual([...effects].sort(), ['cancelConnect', 'close', 'start']);
  });

  test('no file of the reconnect flow, the demo controls or Show welcome mentions Sync/request', () => {
    const root = path.resolve(process.cwd(), 'src/renderer/onboarding');
    const files = [
      ...readdirSync(path.join(root, 'reconnect'))
        .filter(f => /\.(ts|tsx)$/.test(f) && f !== 'states.tsx')
        .map(f => path.join(root, 'reconnect', f)),
      path.join(root, 'demo.ts'),
      path.join(root, 'showWelcome.ts'),
      path.join(root, 'ZeroAccounts.tsx'),
    ];
    for (const file of files) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      assert.doesNotMatch(
        code,
        /Sync\/request|sync\.request|\.sync\b/,
        `${path.basename(file)} must not ask for a sync`,
      );
    }
  });
});
