import test from 'node:test';
import assert from 'node:assert/strict';
import { redactText } from '../../src/diag/redact';

// FR-33: some providers' 401 text echoes the key masked with its last characters; the tail must not reach a log line.
test('a masked key echoed by a provider loses its visible tail', () => {
  for (const echoed of [
    'Incorrect API key provided: sk-proj-********************wxyz. You can find your API key at …',
    'Invalid API Key: gsk_****abcd',
    'key ••••••7f3e was rejected',
  ]) {
    const out = redactText(echoed, 'salt');
    assert.doesNotMatch(out, /wxyz|abcd|7f3e/, out);
    assert.match(out, /\[secret\]/, out);
  }
});

test('ordinary provider text keeps its words', () => {
  assert.equal(redactText('User-rate limit exceeded', 'salt'), 'User-rate limit exceeded');
});
