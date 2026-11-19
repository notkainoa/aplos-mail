import test from 'node:test';
import assert from 'node:assert/strict';
import { createFaultInjector, googleError } from '../src/kit/faults';
import type { EmulatedRequest } from '../src/kit/types';

let seq = 0;
function req(apiMethod: string, extra: Partial<EmulatedRequest> = {}): EmulatedRequest {
  return {
    service: 'gmail',
    apiMethod,
    httpMethod: 'GET',
    path: '/x',
    cost: 5,
    seq: ++seq,
    ...extra,
  };
}

test('googleError builds the Google JSON shape and headers', async () => {
  const response = googleError(403, 'userRateLimitExceeded', 'slow down', { retryAfterSeconds: 7 });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get('retry-after'), '7');
  const body = (await response.json()) as any;
  assert.equal(body.error.code, 403);
  assert.equal(body.error.errors[0].reason, 'userRateLimitExceeded');
  assert.equal(body.error.errors[0].domain, 'usageLimits');
  assert.equal(body.error.status, 'PERMISSION_DENIED');
  const other = (await googleError(404, 'notFound').json()) as any;
  assert.equal(other.error.errors[0].domain, 'global');
  assert.equal(other.error.message, 'notFound');
});

test('failNext is one-shot and only hits the matching request', async () => {
  const faults = createFaultInjector();
  faults.failNext(
    { apiMethod: 'gmail.users.threads.get' },
    { status: 500, reason: 'backendError' },
  );
  assert.equal(faults.intercept(req('gmail.users.messages.get'), 0), undefined);
  const decision = faults.intercept(req('gmail.users.threads.get'), 0);
  assert.equal(decision?.kind, 'respond');
  if (decision?.kind !== 'respond') return;
  assert.equal(decision.response.status, 500);
  assert.equal(decision.charge, undefined);
  assert.equal(faults.intercept(req('gmail.users.threads.get'), 0), undefined);
  assert.equal(faults.pending, 0);
  assert.equal(faults.fired.length, 1);
  assert.deepEqual(
    { rule: faults.fired[0].rule, status: faults.fired[0].status, reason: faults.fired[0].reason },
    { rule: 'fail', status: 500, reason: 'backendError' },
  );
});

test('match filters: regex, http method, account, service', () => {
  const faults = createFaultInjector();
  faults.dropNext({
    apiMethod: /\.messages\./,
    httpMethod: 'post',
    account: 'a@example.test',
    service: 'gmail',
  });
  assert.equal(
    faults.intercept(
      req('gmail.users.messages.send', { httpMethod: 'POST', account: 'b@example.test' }),
      0,
    ),
    undefined,
  );
  assert.equal(
    faults.intercept(
      req('gmail.users.messages.send', { httpMethod: 'GET', account: 'a@example.test' }),
      0,
    ),
    undefined,
  );
  assert.equal(
    faults.intercept(
      req('gmail.users.messages.send', {
        httpMethod: 'POST',
        account: 'a@example.test',
        service: 'gcal',
      }),
      0,
    ),
    undefined,
  );
  assert.deepEqual(
    faults.intercept(
      req('gmail.users.messages.send', { httpMethod: 'POST', account: 'a@example.test' }),
      0,
    ),
    { kind: 'drop' },
  );
});

test('after N lets N matching requests through, counting only matches', () => {
  const faults = createFaultInjector();
  faults.failNext({ apiMethod: 'm', after: 2 }, { status: 429, reason: 'rateLimitExceeded' });
  assert.equal(faults.intercept(req('m'), 0), undefined);
  assert.equal(faults.intercept(req('other'), 0), undefined);
  assert.equal(faults.intercept(req('m'), 0), undefined);
  assert.equal(faults.intercept(req('m'), 0)?.kind, 'respond');
  assert.equal(faults.intercept(req('m'), 0), undefined);
});

test('times fires repeatedly with a fresh body each time, charge is passed through', async () => {
  const faults = createFaultInjector();
  faults.failNext({}, new Response('nope', { status: 503 }), { times: 2, charge: true });
  for (let i = 0; i < 2; i++) {
    const decision = faults.intercept(req('m'), 0);
    assert.ok(decision?.kind === 'respond');
    assert.equal(decision.charge, true);
    assert.equal(await decision.response.text(), 'nope');
  }
  assert.equal(faults.intercept(req('m'), 0), undefined);
});

test('rules fire in insertion order and the first one to fire wins', () => {
  const faults = createFaultInjector();
  faults.dropNext({ apiMethod: 'm' });
  faults.corruptNext({ apiMethod: 'm' });
  assert.equal(faults.intercept(req('m'), 0)?.kind, 'drop');
  assert.equal(faults.intercept(req('m'), 0)?.kind, 'corrupt');
  assert.equal(faults.intercept(req('m'), 0), undefined);
});

test('storm refuses only inside its time range and stays until cleared', async () => {
  const faults = createFaultInjector();
  faults.storm({
    from: 1000,
    to: 2000,
    status: 429,
    reason: 'rateLimitExceeded',
    retryAfterSeconds: 3,
    match: { apiMethod: 'm' },
  });
  assert.equal(faults.intercept(req('m'), 999), undefined);
  for (const now of [1000, 1500, 1999]) {
    const decision = faults.intercept(req('m'), now);
    assert.ok(decision?.kind === 'respond');
    assert.equal(decision.response.status, 429);
    assert.equal(decision.response.headers.get('retry-after'), '3');
  }
  assert.equal(faults.intercept(req('m'), 2000), undefined);
  assert.equal(faults.intercept(req('other'), 1500), undefined);
  assert.equal(faults.fired.length, 3);
  assert.deepEqual(
    faults.fired.map(f => f.at),
    [1000, 1500, 1999],
  );
  faults.clear();
  assert.equal(faults.pending, 0);
  assert.equal(faults.intercept(req('m'), 1500), undefined);
  assert.equal(faults.fired.length, 3, 'clear keeps the history');
  faults.reset();
  assert.equal(faults.fired.length, 0);
});

test('storm defaults to 429 and an earlier one-shot takes priority inside it', () => {
  const faults = createFaultInjector();
  faults.storm({ from: 0, to: 100, reason: 'rateLimitExceeded' });
  faults.dropNext({});
  // Storm was added first so it wins; the one-shot waits.
  const first = faults.intercept(req('m'), 50);
  assert.ok(first?.kind === 'respond' && first.response.status === 429);
  assert.equal(faults.pending, 2);
  assert.equal(faults.intercept(req('m'), 200)?.kind, 'drop');
});

test('dropAfterNext and corruptNext produce their decisions', () => {
  const faults = createFaultInjector();
  faults.dropAfterNext({ apiMethod: 'send' });
  faults.corruptNext({ apiMethod: 'list' });
  assert.deepEqual(faults.intercept(req('send'), 0), { kind: 'dropAfter' });
  assert.deepEqual(faults.intercept(req('list'), 0), { kind: 'corrupt' });
  assert.deepEqual(
    faults.fired.map(f => f.rule),
    ['dropAfter', 'corrupt'],
  );
});

test('fired entries hold routing facts only', () => {
  const faults = createFaultInjector();
  faults.dropNext({});
  faults.intercept(req('m', { account: 'a@example.test', path: '/secret/path' }), 5);
  assert.deepEqual(Object.keys(faults.fired[0]).sort(), [
    'apiMethod',
    'at',
    'reason',
    'rule',
    'seq',
    'service',
    'status',
  ]);
});
