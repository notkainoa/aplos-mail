// `reasonOf` and the three flows that read a refused call's reason code (DESIGN 7.11, 7.15). A `ContractError`
// keeps the code on `error.body.reasonCode`; a top-level `error.reasonCode` read misses it, so a refused connect
// showed the generic sentence instead of the specific one.
// Run: cd apps/desktop && npx tsx --test tests/ui-onboard/reason.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ContractError } from '@aplos/contract';
import { connectSentence } from '../../src/renderer/onboarding/copy';
import {
  initialAccounts,
  reduceAccounts,
  runAccountsEffect,
  type AccountsEvent,
  type AccountsState,
  type ConnectPorts,
} from '../../src/renderer/onboarding/connect';
import { reasonOf } from '../../src/renderer/onboarding/reason';
import {
  initialReconnect,
  reduceReconnect,
  runReconnectEffect,
  type ReconnectEvent,
  type ReconnectPorts,
  type ReconnectState,
} from '../../src/renderer/onboarding/reconnect/reconnect.model';
import {
  initialAi,
  keyFailureSentence,
  reduceAi,
} from '../../src/renderer/onboarding/steps/ai.model';

const JORDAN = 'jordan.lee@example.com';

const refused = (reasonCode: string): ContractError =>
  new ContractError({ type: 'permission', message: 'The engine refused the call.', reasonCode });

describe('reasonOf reads the contract error body', () => {
  test('a ContractError gives its body.reasonCode', () => {
    assert.equal(reasonOf(refused('auth.denied')), 'auth.denied');
    assert.equal(reasonOf(new ContractError({ type: 'internal', message: 'no code' })), undefined);
  });

  test('plain objects, non-objects and empty codes', () => {
    assert.equal(reasonOf({ reasonCode: 'net.offline' }), 'net.offline');
    assert.equal(reasonOf({ body: { reasonCode: 'a.b' }, reasonCode: 'c.d' }), 'a.b');
    assert.equal(reasonOf(undefined), undefined);
    assert.equal(reasonOf(null), undefined);
    assert.equal(reasonOf('auth.denied'), undefined);
    assert.equal(reasonOf(42), undefined);
    assert.equal(reasonOf(new Error('auth.denied')), undefined);
    assert.equal(reasonOf({ reasonCode: '' }), undefined);
    assert.equal(reasonOf({ reasonCode: 42 }), undefined);
  });
});

describe("reasonOf never throws from inside a flow's catch", () => {
  test('a throwing getter or a throwing proxy reads as no reason', () => {
    const getter = {
      get body(): never {
        throw new Error('boom');
      },
    };
    const proxy = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
      },
    );
    assert.equal(reasonOf(getter), undefined);
    assert.equal(reasonOf(proxy), undefined);
  });
});

describe('a refused call surfaces its own sentence, not the generic one', () => {
  test('Accounts step: Account/connect refused keeps the code through runAccountsEffect + reduceAccounts', async () => {
    let state: AccountsState = initialAccounts();
    for (const e of [
      { type: 'edit', address: JORDAN },
      { type: 'submit' },
      { type: 'discovered', seq: 1, provider: 'google' },
      { type: 'connect', loginHint: JORDAN },
    ] as const) {
      state = reduceAccounts(state, e).state;
    }
    assert.equal(state.mode, 'waiting');

    const ports: ConnectPorts = {
      discover: async () => ({ provider: 'google' }),
      connect: async () => {
        throw refused('config.clientMissing');
      },
      cancelConnect: async () => ({ cancelled: true }),
    };
    const events: AccountsEvent[] = [];
    await runAccountsEffect(
      { type: 'connect', attempt: state.attempt, loginHint: JORDAN },
      ports,
      e => events.push(e),
      'setup-1',
    );

    for (const e of events) state = reduceAccounts(state, e).state;
    assert.equal(state.mode, 'failed');
    assert.equal(state.failure, 'config.clientMissing');
    assert.equal(
      connectSentence(state.failure ?? undefined, { address: JORDAN }),
      'Google sign-in isn’t set up in this build.',
    );
  });

  test('reconnect sheet: Account/reconnect refused keeps the code through runReconnectEffect + reduceReconnect', async () => {
    let state: ReconnectState = initialReconnect({ accountId: 'acc-1', address: JORDAN });
    const opened = reduceReconnect(state, { type: 'open' });
    state = opened.state;
    assert.equal(state.phase, 'waiting');

    const ports: ReconnectPorts = {
      reconnect: async () => {
        throw refused('auth.denied');
      },
      grantPermissions: async () => ({ connectId: 'unused' }),
      cancelConnect: async () => ({ cancelled: true }),
    };
    const events: ReconnectEvent[] = [];
    await runReconnectEffect(opened.effects[0], ports, e => events.push(e));

    for (const e of events) state = reduceReconnect(state, e).state;
    assert.equal(state.phase, 'failed');
    assert.equal(state.reason, 'Google sign-in was declined. Nothing changed.');
  });

  test('AI step: Ai/setKey refused keeps the code through the keyFailed event + reduceAi', () => {
    // The container's dispatch line verbatim (Ai.tsx onSaveKey): the event carries the code reasonOf read.
    const state = reduceAi(initialAi(), {
      type: 'keyFailed',
      reasonCode: reasonOf(refused('ai.missingKey')),
    });
    assert.equal(state.keyFailure, 'ai.missingKey');
    assert.equal(
      keyFailureSentence(state.keyFailure, 'Groq'),
      'Groq didn’t take that key. Paste it again, or skip for now.',
    );
  });
});
