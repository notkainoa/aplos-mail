import test from 'node:test';
import assert from 'node:assert/strict';
import type { ClassifiedError, LogRecord } from '@aplos/contract';
import { createLogger } from '../../src/diag/log';

/**
 * Ten hostile log calls (plan 10 E0's adversarial work package), written against the redactor rather than for it:
 * each tries to get mail content or a credential into a line. The secret parts all contain "canary" (any case, often
 * with no digits, as real subjects have none), so one search covers every case.
 */

function capture() {
  const records: LogRecord[] = [];
  const logger = createLogger({
    sink: { write: r => records.push(r) },
    salt: 'hostile-salt',
    clock: { now: () => 0 },
    level: 'debug',
  });
  return { logger, records, text: () => records.map(r => JSON.stringify(r)).join('\n') };
}

const base: ClassifiedError = {
  class: 'permanent',
  provider: 'google',
  method: 'gmail.users.messages.send',
  reason: 'badRequest',
  status: 400,
};
/** Bypasses the call-site types, as a JavaScript caller, a cast or `any` would. */
const loose = (fields: object) => fields as never;

function assertClean(text: string, ...also: RegExp[]) {
  assert.doesNotMatch(text, /canary/i);
  for (const re of also) assert.doesNotMatch(text, re);
}

test('1. a token inside an error message, with and without a known prefix', () => {
  const { logger, records, text } = capture();
  for (const providerMessage of [
    'invalid_grant: Token has been expired or revoked. token ya29.A0ARrdaMcanaryTOKEN-xyz',
    'The access token CanaryAbcdefGhijklMnopqrSt was rejected',
    'refresh_token canaryRefreshTokenValueABCDEF invalid',
    'Bad key gsk_canary and sk-proj-canaryabcdefgh',
    'Invalid credentials for canaryuser:canarypassword@imap.mail.example',
  ])
    logger.event('auth.refresh_failed', { error: { ...base, providerMessage } });
  assert.equal(records.length, 5);
  assertClean(text(), /ya29|gsk_|sk-proj/);
});

test('2. an address inside a URL: encoded, in the path, in the query, in user-info', () => {
  const { logger, text } = capture();
  for (const providerMessage of [
    'GET https://gmail.googleapis.com/gmail/v1/users/canary.person%40mail.example/messages failed',
    'GET https://gmail.googleapis.com/gmail/v1/users/canary.person%2540mail.example/threads failed',
    'POST https://canary:secret@smtp.mail.example/submit?to=canary.person@mail.example 550',
    'See mailto:canary.person@mail.example?subject=Canary%20plans',
  ])
    logger.event('send.failed', { submission: 'sub_1', error: { ...base, providerMessage } });
  // The server's host may stay; the address in the path, the query and the user-info may not.
  assertClean(text(), /%40|%2540|secret@/);
});

test('3. a subject inside a thrown error, its cause chain and its message', () => {
  const { logger, text } = capture();
  const subject = 'Canary launch plans';
  const thrown = Object.assign(
    new Error(`Could not send "${subject}"`, {
      cause: { subject, cause: new Error(`Subject: ${subject}`) },
    }),
    base,
  );
  logger.event('send.failed', { submission: 'sub_1', error: thrown });
  logger.event('send.failed', {
    submission: 'sub_1',
    error: { ...base, providerMessage: String(thrown) },
  });
  logger.event('send.failed', {
    submission: 'sub_1',
    error: { ...base, providerMessage: `Message rejected. Subject: ${subject}` },
  });
  logger.event('send.failed', {
    submission: 'sub_1',
    error: {
      ...base,
      providerMessage: String(thrown.cause && (thrown.cause as { cause: Error }).cause),
    },
  });
  logger.event(
    'send.failed',
    loose({ submission: 'sub_1', error: base, cause: thrown.cause, stack: thrown.stack }),
  );
  assertClean(text(), /launch plans/);
});

test('4. a nested body object, as an unlisted field and inside the error', () => {
  const { logger, records, text } = capture();
  const body = {
    html: '<p>Canary body</p>',
    parts: [{ mimeType: 'text/plain', body: { data: 'Q2FuYXJ5IGJvZHk=' } }],
    snippet: 'Canary snippet',
  };
  logger.event(
    'sync.gmail.page_committed',
    loose({ phase: 'incremental', durationMs: 5, body, payload: { body } }),
  );
  logger.event('sync.gmail.request_refused', {
    error: loose({ ...base, providerMessage: body, body }),
  });
  logger.event('update.failed', { reason: 'network', detail: loose(body) });
  assert.equal(records.length, 3);
  assertClean(text(), /Q2FuYXJ5/);
});

test('5. unicode-obfuscated addresses', () => {
  const { logger, text } = capture();
  for (const address of [
    'ｃａｎａｒｙ.person＠mail．example',
    'canary​.per‍son@mail.example',
    'canary.person﹫mail.example',
    'canary.person (at) mail (dot) example',
    'canary.person&#64;mail.example',
    'canary.person@mail。example',
    'canaryİperson@mail.example',
  ])
    logger.event('send.failed', {
      submission: 'sub_1',
      error: { ...base, providerMessage: `Recipient ${address} rejected` },
    });
  assertClean(text(), /person/);
});

test('6. an Authorization header object, wherever it is put', () => {
  const { logger, text } = capture();
  const headers = {
    Authorization: 'Bearer ya29.canaryAccessToken',
    'X-Goog-Api-Key': 'AIzaSyCanaryKey0000000000000000',
    Cookie: 'SID=canarycookie',
  };
  logger.event(
    'sync.gmail.request',
    loose({ method: 'gmail.users.threads.list', durationMs: 3, headers, request: { headers } }),
  );
  logger.event('auth.refresh_failed', {
    error: loose({ ...base, headers, providerMessage: JSON.stringify(headers) }),
  });
  logger.event('auth.refresh_failed', {
    error: {
      ...base,
      providerMessage: Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n'),
    },
  });
  logger.event('auth.refresh_failed', {
    error: { ...base, providerMessage: 'authorization: basic Y2FuYXJ5OnNlY3JldA==' },
  });
  assertClean(text(), /ya29|AIza|SID=|Y2FuYXJ5/);
});

test('7. a JSON string inside providerMessage, plain and double-encoded', () => {
  const { logger, records, text } = capture();
  const google = {
    error: {
      code: 400,
      message: 'Invalid To header: canary.person@mail.example',
      errors: [{ reason: 'invalidArgument', subject: 'Canary launch plans' }],
      details: { snippet: 'canary snippet text', q: 'from:canary' },
    },
  };
  logger.event('send.failed', {
    submission: 'sub_1',
    error: { ...base, providerMessage: JSON.stringify(google) },
  });
  logger.event('send.failed', {
    submission: 'sub_1',
    error: { ...base, providerMessage: JSON.stringify(JSON.stringify(google)) },
  });
  logger.event('send.failed', {
    submission: 'sub_1',
    error: { ...base, providerMessage: JSON.stringify(google, null, 2) },
  });
  assert.equal(records.length, 3);
  assertClean(text(), /launch plans|snippet text/);
});

test('8. a 2 MB string, in free text, in an id, a code, an address, and a token at the edge of the scan', () => {
  const { logger, records, text } = capture();
  const huge = 'Canary words '.repeat(170_000);
  const started = performance.now();
  logger.event('send.failed', {
    submission: huge,
    error: { ...base, providerMessage: huge, item: huge, reason: huge },
  });
  logger.event('auth.identity_mismatch', { provider: 'gmail', expected: huge, got: huge });
  logger.event('update.failed', { reason: 'network', detail: huge });
  // Just under the scan limit, so it is scanned whole: the token at the very end must still go, and the cut to 300 comes after.
  logger.event('auth.refresh_failed', {
    error: { ...base, providerMessage: `${'a '.repeat(985)}token ya29.canaryCutToken` },
  });
  assert.ok(performance.now() - started < 1000, 'bounded work');
  assert.equal(records.length, 4);
  assert.ok(text().length < 3000);
  assertClean(text(), /ya29|words words/);
});

test('9. circular objects as fields, errors and context', () => {
  const { logger, records, text } = capture();
  const loop: Record<string, unknown> = { subject: 'Canary loop' };
  loop.self = loop;
  loop.cause = loop;
  const error = { ...base, providerMessage: 'circular', cause: loop } as Record<string, unknown>;
  error.self = error;
  logger.event('send.failed', loose({ submission: 'sub_1', error, loop }));
  logger.with(loose(loop)).event('engine.stopping', { why: 'quit' });
  logger.event('send.failed', loose({ submission: loop, error: loop }));
  assert.equal(records.length, 3);
  assertClean(text());
});

test('10. a toJSON that throws, throwing getters and a hostile proxy', () => {
  const { logger, records, text } = capture();
  const bomb = {
    toJSON() {
      throw new Error('Canary toJSON');
    },
    toString() {
      throw new Error('Canary toString');
    },
  };
  const getter = Object.defineProperty({ ...base }, 'providerMessage', {
    enumerable: true,
    get() {
      throw new Error('Canary getter');
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('Canary ownKeys');
      },
      get() {
        throw new Error('Canary get');
      },
      has() {
        throw new Error('Canary has');
      },
      getOwnPropertyDescriptor() {
        throw new Error('Canary descriptor');
      },
    },
  );
  assert.doesNotThrow(() => {
    logger.event('send.failed', loose({ submission: bomb, error: bomb, extra: bomb }));
    logger.event('send.failed', { submission: 'sub_1', error: getter as ClassifiedError });
    logger.event('send.failed', loose(proxy));
    logger.event('send.failed', loose({ submission: 'sub_1', error: proxy }));
    logger.with(loose(proxy)).event('engine.stopping', { why: 'quit' });
    logger.event('update.failed', { reason: 'network', detail: loose(bomb) });
  });
  assert.ok(records.length >= 5);
  assertClean(text());
});
