// Temporary home: these move next to the shared provider code when the engine restructure lands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGoogleError } from '../../../apps/desktop/src/host/providers/shared/google-error';

test('Gmail v1 error: errors[0] wins over the rpc status', () => {
  const body = JSON.stringify({
    error: {
      code: 403,
      message: 'User-rate limit exceeded.  Retry after 2026-10-27T17:00:00.000Z',
      errors: [
        {
          message: 'User-rate limit exceeded.',
          domain: 'usageLimits',
          reason: 'userRateLimitExceeded',
        },
      ],
      status: 'PERMISSION_DENIED',
    },
  });
  assert.deepEqual(parseGoogleError(403, body), {
    status: 403,
    reason: 'userRateLimitExceeded',
    domain: 'usageLimits',
    rpcStatus: 'PERMISSION_DENIED',
    message: 'User-rate limit exceeded. Retry after 2026-10-27T17:00:00.000Z',
  });
});

test('429 RESOURCE_EXHAUSTED: the reason comes from the ErrorInfo detail', () => {
  const body = JSON.stringify({
    error: {
      code: 429,
      message: 'Quota exceeded for quota metric',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.Help',
          links: [{ url: 'https://example.invalid' }],
        },
        {
          '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
          reason: 'RATE_LIMIT_EXCEEDED',
          domain: 'googleapis.com',
          metadata: { quota_limit: 'x' },
        },
      ],
    },
  });
  assert.deepEqual(parseGoogleError(429, body), {
    status: 429,
    reason: 'RATE_LIMIT_EXCEEDED',
    domain: 'googleapis.com',
    rpcStatus: 'RESOURCE_EXHAUSTED',
    message: 'Quota exceeded for quota metric',
  });
});

test('falls back to the rpc status when nothing names a reason', () => {
  const body = JSON.stringify({
    error: {
      code: 429,
      message: 'Too many concurrent requests for user.',
      status: 'RESOURCE_EXHAUSTED',
    },
  });
  const info = parseGoogleError(429, body);
  assert.equal(info.reason, 'RESOURCE_EXHAUSTED');
  assert.equal(info.message, 'Too many concurrent requests for user.');
  assert.equal(info.domain, undefined);
});

test('a message-only 429 keeps its text and an unknown reason', () => {
  const info = parseGoogleError(
    429,
    JSON.stringify({ error: { code: 429, message: 'User-rate limit exceeded (Mail sending)' } }),
  );
  assert.equal(info.reason, 'unknown');
  assert.equal(info.message, 'User-rate limit exceeded (Mail sending)');
});

test('OAuth token endpoint errors', () => {
  const info = parseGoogleError(
    400,
    JSON.stringify({
      error: 'invalid_grant',
      error_description: 'Token has been expired\n or revoked.',
    }),
  );
  assert.deepEqual(info, {
    status: 400,
    reason: 'invalid_grant',
    message: 'Token has been expired or revoked.',
    oauthDescription: 'Token has been expired or revoked.',
  });
  const bare = parseGoogleError(400, JSON.stringify({ error: 'admin_policy_enforced' }));
  assert.equal(bare.reason, 'admin_policy_enforced');
  assert.equal(bare.message, 'admin_policy_enforced');
  assert.equal(bare.oauthDescription, undefined);
});

test('non-JSON, JSON that is not an error object, and empty bodies', () => {
  const html = parseGoogleError(502, '<html>\n  <body>Bad   Gateway</body>\n</html>');
  assert.equal(html.reason, 'unknown');
  assert.equal(html.message, '<html> <body>Bad Gateway</body> </html>');
  for (const body of ['', '   ', 'null', '[]', '"oops"', '{}', '{"error":{}}']) {
    const info = parseGoogleError(500, body);
    assert.equal(info.status, 500);
    assert.equal(info.reason, 'unknown', JSON.stringify(body));
  }
  assert.equal(parseGoogleError(500, '').message, '');
});

test('messages are collapsed and cut to 300 characters without splitting a surrogate pair', () => {
  const long = parseGoogleError(500, JSON.stringify({ error: { message: 'a '.repeat(400) } }));
  assert.equal(long.message.length, 300);
  assert.ok(!/\s{2}/.test(long.message));
  const emoji = parseGoogleError(
    500,
    JSON.stringify({ error: { message: 'x'.repeat(299) + '\u{1F600}' } }),
  );
  assert.equal(emoji.message, 'x'.repeat(299));
});
