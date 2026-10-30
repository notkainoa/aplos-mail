import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '@aplos/contract/contract-error';
import { isAbsent } from '../src/index';
import type { UnsubscribePort } from '../src/ports';
import { testEngine } from './runtime.helpers';

const isUnavailable = (e: unknown) => e instanceof ContractError && e.type === 'unavailable';

const fake: UnsubscribePort = {
  describe: headers => ({ method: headers.listUnsubscribe ? 'link' : 'none' }),
  run: async () => ({ kind: 'done', message: 'Unsubscribed.' }),
};

test('an unsubscribe port the host left out answers unavailable', async () => {
  const t = await testEngine();
  try {
    const { unsubscribe } = t.engine.services;
    assert.ok(isAbsent(unsubscribe));
    assert.throws(() => unsubscribe.describe({}), isUnavailable);
    assert.throws(
      () =>
        unsubscribe.run({ from: 'a@x.test', headers: {}, signal: new AbortController().signal }),
      isUnavailable,
    );
  } finally {
    await t.cleanup();
  }
});

test('the unsubscribe port the host injects is what services.unsubscribe returns, frozen with the rest', async () => {
  const t = await testEngine({ ports: { unsubscribe: fake } });
  try {
    const { services } = t.engine;
    assert.equal(services.unsubscribe, fake);
    assert.ok(!isAbsent(services.unsubscribe));
    assert.deepEqual(services.unsubscribe.describe({ listUnsubscribe: '<https://x.test/u>' }), {
      method: 'link',
    });
    const done = await services.unsubscribe.run({
      from: 'a@x.test',
      headers: {},
      signal: new AbortController().signal,
    });
    assert.equal(done.kind, 'done');
    assert.ok(Object.isFrozen(services));
    assert.throws(() => {
      (services as { unsubscribe: unknown }).unsubscribe = null;
    });
  } finally {
    await t.cleanup();
  }
});
