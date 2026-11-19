import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ContractError,
  DiagnosticsBundle,
  Hello,
  HelloReply,
  HttpAddress,
  parseDiagnosticsBundle,
  Problem,
  StrictDiagnosticsBundle,
  ThreadAction,
  ViewSpec,
} from '../src/index';

/** Schema-level answers to the freeze review (plans/freeze/findings.md). Behaviour is the conformance suite's. */

test('FR-16: Hello keeps the client token, and the listener answers with HelloReply', () => {
  const hello = Hello.parse({
    v: 1,
    apiVersion: 1,
    client: { name: 'aplos-cli', kind: 'cli' },
    token: 'tok_0123456789abcdef',
  });
  assert.equal(hello.token, 'tok_0123456789abcdef', 'the token is no longer stripped');
  assert.ok(!Hello.safeParse({ ...hello, token: 'x'.repeat(129) }).success);
  assert.ok(
    HelloReply.safeParse({
      ok: true,
      session: { apiVersion: 1, dbEpoch: 'e1', clientId: 'c1', scopes: ['read'] },
    }).success,
  );
  assert.ok(
    HelloReply.safeParse({ ok: false, error: { type: 'forbidden', message: 'Unknown tool.' } })
      .success,
  );
});

test('FR-36: a server address may not carry a query or fragment', () => {
  assert.ok(HttpAddress.safeParse('http://localhost:11434/v1').success);
  assert.ok(HttpAddress.safeParse('').success);
  for (const bad of ['http://h.example/v1?key=sk-123', 'https://h.example/v1#token'])
    assert.equal(
      HttpAddress.safeParse(bad).error?.issues[0]?.message,
      'Use the server address only, without ? or # parts.',
    );
});

const bundle = {
  generatedAt: 1,
  versions: { app: '0.3.0', api: 1, schema: 1 },
  engine: { state: 'ready', uptimeMs: 5 },
  accounts: [{ accountHash: '0123456789abcdef', provider: 'google', state: 'ok', budgets: [] }],
  queues: { ops: 0, jobs: 0, submissions: 0, failed: 0 },
  errors: [
    {
      at: 1,
      error: {
        class: 'throttle',
        provider: 'gmail',
        method: 'gmail.threads.get',
        reason: 'rateLimitExceeded',
        item: 'msg-1890ab',
        providerMessage: 'Quota exceeded for key sk-****abcd',
      },
    },
  ],
  storage: { dbBytes: 0, walBytes: 0, ftsBacklog: 0, bodyBytes: 0, attachmentBytes: 0 },
  crashes: { count: 0 },
};

test('FR-32: the strict bundle drops provider text and refuses anything that is not a code', () => {
  assert.ok(DiagnosticsBundle.safeParse(bundle).success);
  const strict = parseDiagnosticsBundle(bundle);
  const error = strict.errors[0]!.error as Record<string, unknown>;
  assert.equal(error.providerMessage, undefined, 'provider text never leaves');
  assert.equal(error.item, undefined, 'nor a remote item id');
  // The canary: content that slipped into a stored error column fails the production parse.
  const canary = 'Subject: CANARY-7f3 lunch plans';
  for (const leak of [
    { ...bundle, errors: [{ at: 1, error: { ...bundle.errors[0]!.error, reason: canary } }] },
    { ...bundle, accounts: [{ ...bundle.accounts[0]!, accountHash: 'jordan@park.example' }] },
    { ...bundle, engine: { ...bundle.engine, parkedReason: canary } },
  ]) {
    assert.ok(DiagnosticsBundle.safeParse(leak).success, 'the loose schema let it through');
    assert.ok(!StrictDiagnosticsBundle.safeParse(leak).success);
    assert.throws(
      () => parseDiagnosticsBundle(leak),
      (e: unknown) => e instanceof ContractError && !e.message.includes('CANARY'),
    );
  }
});

test('FR-33: a problem message is bounded engine copy', () => {
  assert.ok(Problem.safeParse({ reasonCode: 'ai.failed', message: 'Try again.' }).success);
  assert.ok(!Problem.safeParse({ reasonCode: 'ai.failed', message: 'x'.repeat(1_001) }).success);
});

test('FR-27, FR-28: Low by sender is a view; reminders clear; Clear from Home is its own action', () => {
  assert.ok(ViewSpec.safeParse({ kind: 'lowBySender' }).success);
  assert.ok(ThreadAction.safeParse({ type: 'reminder', clear: true }).success);
  assert.ok(ThreadAction.safeParse({ type: 'clearFromHome' }).success);
});
