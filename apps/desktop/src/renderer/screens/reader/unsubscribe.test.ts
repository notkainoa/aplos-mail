/** Unsubscribe's outcomes in plain words: success only when the engine confirmed it, a link only when one came back. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { unsubscribeFailed, unsubscribeNotice } from './unsubscribe';

test('done says so, and a link is opened only for openLink', () => {
  assert.deepEqual(unsubscribeNotice({ outcome: 'done', message: '' }, 'Weekly Digest'), {
    message: 'Unsubscribed from Weekly Digest.',
  });
  const link = unsubscribeNotice(
    { outcome: 'openLink', url: 'https://example.com/u', message: '' },
    'Weekly Digest',
  );
  assert.equal(link.open, 'https://example.com/u');
  assert.equal(unsubscribeNotice({ outcome: 'openLink', message: '' }, 'A').open, undefined);
});

test('unsure never claims success; failures use the engine line, and a thrown call changes nothing', () => {
  assert.match(
    unsubscribeNotice({ outcome: 'unsure', message: '' }, 'A').message,
    /did not confirm/,
  );
  assert.equal(
    unsubscribeNotice({ outcome: 'failed', message: 'The sender refused.' }, 'A').message,
    'The sender refused.',
  );
  assert.match(unsubscribeFailed('A').message, /Nothing changed/);
});
