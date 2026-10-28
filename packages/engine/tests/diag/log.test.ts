import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { logEventSchema, logEvents } from '@aplos/contract';
import type { ClassifiedError, LogRecord } from '@aplos/contract';
import { createLogger, type Logger } from '../../src/diag/log';
import { hashAddress, redactText } from '../../src/diag/redact';
import { sha256Hex } from '../../src/diag/sha256';
import { eventIds, sampleFields, validValue } from './samples';

const SALT = 'test-salt-0001';

function memoryLogger(level?: 'debug' | 'info') {
  const records: LogRecord[] = [];
  const logger = createLogger({
    sink: { write: r => records.push(r) },
    salt: SALT,
    clock: { now: () => 1_793_000_000_000 },
    level,
  });
  return { logger, records, text: () => records.map(r => JSON.stringify(r)).join('\n') };
}

/**
 * A stub Gmail call site, written the way a hurried adapter would: it has the request (with the owner's address, the
 * bearer token and the subject it was searching for) and Google's refusal, and it passes the lot to the Logger.
 */
function stubGmailCallSite(
  log: Logger,
  response: {
    status: number;
    body: {
      error: { code: number; message: string; errors: { reason: string; message: string }[] };
    };
  },
) {
  const request = {
    url: 'https://gmail.googleapis.com/gmail/v1/users/owner%40mail.example/messages?q=subject%3A%22Quarterly%20numbers%22',
    headers: { Authorization: 'Bearer ya29.a0AfB_byCANARYtoken0123456789' },
    subject: 'Quarterly numbers',
  };
  const { error } = response.body;
  const classified: ClassifiedError = {
    class: 'throttle',
    provider: 'google',
    method: 'gmail.users.messages.list',
    reason: error.errors[0].reason,
    status: response.status,
    providerMessage: error.message,
  };
  log.event('sync.gmail.request_refused', {
    error: classified,
    units: 5,
    ...({ request, response } as object),
  });
}

test('E0: a fake 403 rateLimitExceeded gives exactly one line with the reason and status, and no address, token or subject', () => {
  const { logger, records, text } = memoryLogger();
  stubGmailCallSite(logger.with({ account: 'acc_1', lane: 'interactive' }), {
    status: 403,
    body: {
      error: {
        code: 403,
        message: 'User-rate limit exceeded',
        errors: [{ reason: 'rateLimitExceeded', message: 'User-rate limit exceeded' }],
      },
    },
  });
  assert.equal(records.length, 1);
  const [line] = records;
  assert.equal(line.event, 'sync.gmail.request_refused');
  assert.equal(line.level, 'warn');
  assert.equal(line.account, 'acc_1');
  const error = line.data.error as ClassifiedError;
  assert.equal(error.reason, 'rateLimitExceeded');
  assert.equal(error.status, 403);
  assert.equal(error.providerMessage, 'User-rate limit exceeded');
  assert.equal(line.dropped, 2, 'request and response were refused and counted');
  assert.doesNotMatch(
    text(),
    /owner|mail\.example|ya29|CANARY|Bearer|Authorization|Quarterly|"subject"|"headers"|"request"|"response"/i,
  );
  console.log(`E0 line: ${text()}`);
});

test('every catalog event logs its own valid fields with nothing dropped, and passes its strict schema', () => {
  const { logger, records } = memoryLogger('debug');
  for (const id of eventIds) logger.event(id, sampleFields(id, validValue));
  assert.equal(records.length, eventIds.length);
  for (const record of records) {
    assert.equal(record.dropped, undefined, `${record.event} dropped a valid field`);
    assert.ok(logEventSchema(record.event as never).safeParse(record.data).success, record.event);
  }
});

test('the catalog: dotted ids, a lane for each event, and no field that could hold content', () => {
  const banned =
    /^(subject|body|snippet|html|preview|name|displayName|token|accessToken|refreshToken|key|apiKey|password|secret|authorization|headers?|cookie|email|query|url|message|cause|stack)$/i;
  for (const [id, spec] of Object.entries(logEvents)) {
    assert.match(id, /^[a-z]+(\.[a-z_]+)+$/, id);
    assert.ok(spec.emitters.length > 0, `${id} names its lanes`);
    for (const key of Object.keys(spec.fields)) assert.doesNotMatch(key, banned, `${id}.${key}`);
  }
  for (const id of [
    'sync.gmail.request_refused',
    'governor.paused',
    'governor.resumed',
    'send.uncertain',
    'send.failed',
    'submission.state',
    'auth.reconnect_needed',
    'engine.started',
    'engine.parked',
    'store.migrated',
    'ai.job.failed',
    'listener.request_denied',
  ]) {
    assert.ok(id in logEvents, id);
  }
});

test('unlisted fields and fields of the wrong kind are dropped and counted, never written', () => {
  const { logger, records } = memoryLogger();
  logger.event('store.migrated', {
    from: 1,
    to: -2,
    durationMs: Number.NaN,
    ...({ subject: 'Hello there', body: { text: 'secret plans' } } as object),
  });
  assert.deepEqual(records[0].data, { from: 1 });
  assert.equal(records[0].dropped, 4);
  // @ts-expect-error an unlisted field is a type error at the call site
  logger.event('store.migrated', { from: 1, to: 2, durationMs: 3, subject: 'x' });
  // @ts-expect-error so is a field of the wrong type
  logger.event('store.migrated', { from: '1', to: 2, durationMs: 3 });
});

test('ids and codes must look like ids and codes', () => {
  const { logger, records } = memoryLogger();
  logger.event('send.failed', {
    submission: 'Re: lunch tomorrow',
    error: {
      class: 'permanent',
      provider: 'google',
      method: 'gmail send',
      reason: 'bob@x.example',
      providerMessage: 'x',
    },
  });
  const data = records[0].data as { submission?: string; error: ClassifiedError };
  assert.equal(data.submission, undefined);
  assert.equal(data.error.method, 'unknown');
  assert.equal(data.error.reason, 'unknown');
  assert.equal(records[0].dropped, 3);
});

test('addresses are written as salted hashes that correlate within an install and differ across installs', () => {
  const { logger, records } = memoryLogger();
  logger.event('auth.identity_mismatch', {
    provider: 'gmail',
    expected: 'Owner@Mail.example',
    got: 'other@mail.example',
  });
  const data = records[0].data as { expected: string; got: string };
  assert.equal(data.expected, hashAddress(SALT, 'owner@mail.example'));
  assert.match(data.expected, /^[0-9a-f]{16}$/);
  assert.notEqual(data.expected, data.got);
  assert.notEqual(hashAddress('another-install', 'owner@mail.example'), data.expected);
  assert.match(
    redactText('mailbox owner@mail.example is full', SALT),
    new RegExp(`\\[addr:${data.expected}\\] is full`),
  );
});

test('levels, context and a failing sink', () => {
  const { logger, records } = memoryLogger('info');
  logger.event('auth.token_refreshed', { provider: 'oauth', durationMs: 4 });
  assert.equal(records.length, 0, 'debug is off at info');
  assert.equal(logger.enabled('debug'), false);
  logger
    .with({ account: 'acc_2' })
    .with({ lane: 'backfill', ...({ subject: 'x' } as object) })
    .event('engine.stopping', { why: 'quit' });
  assert.equal(records[0].account, 'acc_2');
  assert.equal(records[0].lane, 'backfill');
  assert.equal('subject' in records[0], false);
  logger.with({ account: 'bob@x.example' }).event('engine.stopping', { why: 'quit' });
  assert.equal(records[1].account, undefined);

  const broken = createLogger({
    sink: {
      write: () => {
        throw new Error('disk on fire');
      },
    },
    salt: SALT,
    clock: { now: () => 0 },
  });
  assert.doesNotThrow(() => broken.event('engine.stopping', { why: 'quit' }));
  assert.doesNotThrow(() =>
    (broken.event as (id: string, f: unknown) => void)('no.such_event', {}),
  );
  assert.doesNotThrow(() =>
    (broken.event as (id: string, f: unknown) => void)('engine.stopping', null),
  );
  assert.deepEqual(broken.stats(), { lines: 0, droppedFields: 0, failures: 3 });
});

test('the redactor', () => {
  const r = (s: string) => redactText(s, SALT);
  assert.equal(r('User-rate limit exceeded'), 'User-rate limit exceeded');
  assert.equal(
    r('Request had invalid authentication credentials. Expected OAuth 2 access token'),
    'Request had invalid authentication credentials. Expected OAuth 2 access token',
  );
  assert.equal(r('token ya29.a0AfB_byC-xyz expired'), 'token [secret] expired');
  assert.equal(r('refresh 1//0gAbCdEfGhIjKl failed'), 'refresh [secret] failed');
  assert.equal(r('keys sk-ant-api03-abcdefgh and gsk_abcdefgh12345'), 'keys [secret] and [secret]');
  assert.equal(r('jwt eyJhbGciOiJ.eyJzdWIiOiIx.c2lnbmF0dXJl'), 'jwt [secret]');
  assert.equal(
    r('GET https://u:p@api.example/v1/x?access_token=abc#frag'),
    'GET https://api.example/v1/x?[q]',
  );
  assert.equal(r('Authorization: Bearer abc.def'), 'Authorization: [secret]');
  assert.equal(r('Invalid label name "Taxes 2026"'), 'Invalid label name "[text]"');
  assert.equal(r('thread 18c2f3a4b5d6e7f8 not found'), 'thread [id] not found');
  assert.equal(r('word '.repeat(100)).length, 300);
  assert.equal(
    r('550 5.7.1 [203.0.113.5] or 2001:db8::8a2e:370:7334 rejected at 12:30:45'),
    '550 5.7.1 [[ip]] or [ip] rejected at 12:30:45',
  );
  assert.equal(r('Subject: Lunch on Friday'), 'Subject: [text]');
});

test('the SHA-256 matches Node on block boundaries and non-ASCII input', () => {
  for (const input of [
    '',
    'abc',
    'a'.repeat(55),
    'a'.repeat(56),
    'a'.repeat(64),
    'a'.repeat(1000),
    'adresse@exemple.example ✉️ 東京',
  ]) {
    assert.equal(sha256Hex(input), createHash('sha256').update(input, 'utf8').digest('hex'));
  }
});
