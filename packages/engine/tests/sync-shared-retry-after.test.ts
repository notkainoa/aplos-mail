// Temporary home: these move next to the shared provider code when the engine restructure lands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRetryAfter } from '../../../apps/desktop/src/host/providers/shared/retry-after';

const NOW = Date.UTC(1994, 10, 6, 8, 49, 0); // Sun, 06 Nov 1994 08:49:00 GMT

test('delta-seconds: integers, decimals, zero and no cap', () => {
  assert.equal(parseRetryAfter('120', NOW), 120_000);
  assert.equal(parseRetryAfter(' 7 ', NOW), 7_000);
  assert.equal(parseRetryAfter('0', NOW), 0);
  assert.equal(parseRetryAfter('1.5', NOW), 1_500);
  assert.equal(parseRetryAfter('86400', NOW), 86_400_000);
  assert.equal(parseRetryAfter('99999999', NOW), 99_999_999_000);
});

test('HTTP-date in the three RFC 9110 forms', () => {
  const expected = 37_000; // 08:49:37 is 37 s after NOW
  assert.equal(parseRetryAfter('Sun, 06 Nov 1994 08:49:37 GMT', NOW), expected);
  assert.equal(parseRetryAfter('Sunday, 06-Nov-94 08:49:37 GMT', NOW), expected);
  assert.equal(parseRetryAfter('Sun Nov  6 08:49:37 1994', NOW), expected);
  assert.equal(parseRetryAfter('Sun, 06 Nov 1994 10:49:00 GMT', NOW), 2 * 3600_000);
});

test('a date more than a day out is not capped', () => {
  assert.equal(parseRetryAfter('Wed, 09 Nov 1994 08:49:00 GMT', NOW), 3 * 24 * 3600_000);
});

test('RFC 850 two-digit years pick the century within 50 years of now', () => {
  const now2026 = Date.UTC(2026, 9, 27, 16, 0, 0);
  assert.equal(parseRetryAfter('Wednesday, 28-Oct-26 16:00:00 GMT', now2026), 24 * 3600_000);
  // 94 would be 2094, more than 50 years ahead, so it is 1994: in the past.
  assert.equal(parseRetryAfter('Sunday, 06-Nov-94 08:49:37 GMT', now2026), 0);
});

test('a date in the past is 0', () => {
  assert.equal(parseRetryAfter('Sun, 06 Nov 1994 08:48:00 GMT', NOW), 0);
  assert.equal(parseRetryAfter('Sun, 06 Nov 1994 08:49:00 GMT', NOW), 0);
});

test('garbage, empty, negative and impossible values are undefined', () => {
  for (const bad of [
    undefined,
    null,
    '',
    '   ',
    'soon',
    '-5',
    '-0.5',
    '1e3',
    '12abc',
    '+5',
    'NaN',
    'Infinity',
    'Sun, 31 Feb 1994 08:49:37 GMT',
    'Sun, 06 Nov 1994 25:00:00 GMT',
    'Sun, 06 Foo 1994 08:49:37 GMT',
    '1994-11-06T08:49:37Z',
    '9'.repeat(400),
  ]) {
    assert.equal(parseRetryAfter(bad, NOW), undefined, String(bad));
  }
});
