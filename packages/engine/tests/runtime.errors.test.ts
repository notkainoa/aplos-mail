import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '@aplos/contract/contract-error';
import { NotSentError, PausedError, ProviderError } from '../src/ports';
import { testEngine } from './runtime.helpers';

const PROVIDER_TEXT = 'Invalid Credentials for owner@mail.example ya29.secret-token-value';

const providerError = () =>
  new ProviderError({
    class: 'throttle',
    provider: 'gmail',
    method: 'gmail.threads.get',
    reason: 'rateLimitExceeded',
    status: 429,
    providerMessage: PROVIDER_TEXT,
  });

/** Calls `Thread/get` with a handler that throws `error`, and returns what the caller got. */
async function failWith(error: unknown) {
  const t = await testEngine({
    handlers: {
      'Thread/get': () => {
        throw error;
      },
    },
  });
  try {
    const got = await t.engine
      .connect()
      .call('Thread/get', { ids: [] })
      .then(
        () => assert.fail('the call should fail'),
        (e: unknown) => e,
      );
    return { got: got as ContractError, log: t.logText() };
  } finally {
    await t.cleanup();
  }
}

/** Everything a caller can read off the rejection. */
const visible = (e: ContractError) =>
  JSON.stringify({ body: e.body, message: e.message, stack: e.stack, cause: e.cause, e });

test('an unexpected throw becomes internal, with no stack and no text of its own', async () => {
  const bug = new TypeError(`Cannot read properties of undefined; ${PROVIDER_TEXT}`);
  const { got, log } = await failWith(bug);
  assert.ok(got instanceof ContractError);
  assert.deepEqual(got.body, { type: 'internal', message: 'Something went wrong. Try again.' });
  assert.doesNotMatch(visible(got), /Cannot read|ya29|owner@|\.ts:\d|at /);
  assert.doesNotMatch(log, /Cannot read|ya29|owner@/);
  assert.match(log, /"rpc\.failed"/);
  assert.match(log, /"reason":"internal"/);
});

test('a provider refusal becomes providerError or paused, without the provider message or reason', async () => {
  for (const [error, type] of [
    [providerError(), 'providerError'],
    [new NotSentError(providerError().error), 'providerError'],
    [new PausedError('a1', 'gmail', 'throttle', PROVIDER_TEXT, 1_800_000_000_000), 'paused'],
  ] as const) {
    const { got, log } = await failWith(error);
    assert.equal(got.type, type);
    assert.doesNotMatch(visible(got), /ya29|owner@|rateLimitExceeded|Invalid Credentials/);
    assert.doesNotMatch(log, /ya29|owner@|Invalid Credentials/);
    if (type === 'paused') assert.equal(got.body.resumeAt, 1_800_000_000_000);
  }
});

test("a handler's ContractError keeps its sentence and loses its stack, cause and extra fields", async () => {
  const mine = Object.assign(
    new ContractError({ type: 'notFound', message: 'That conversation is gone.' }),
    { cause: new Error(PROVIDER_TEXT), providerMessage: PROVIDER_TEXT },
  );
  const { got, log } = await failWith(mine);
  assert.notEqual(got, mine);
  assert.deepEqual(got.body, { type: 'notFound', message: 'That conversation is gone.' });
  assert.equal(got.stack, 'ContractError: That conversation is gone.');
  assert.doesNotMatch(visible(got), /ya29|owner@|\.ts:\d/);
  assert.doesNotMatch(log, /rpc\.failed/);
});

test('a thrown value that defeats instanceof is still internal', async () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  const { got } = await failWith(proxy);
  assert.equal(got.type, 'internal');
});

test('a throw that is not an Error at all is still internal', async () => {
  for (const odd of [undefined, 'a string', { stack: 'fake', message: PROVIDER_TEXT }]) {
    const { got } = await failWith(odd);
    assert.equal(got.type, 'internal');
    assert.doesNotMatch(visible(got), /ya29|fake/);
  }
});
