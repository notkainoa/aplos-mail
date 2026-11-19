/** Unsubscribe's outcomes in plain words: success only when the engine confirmed it, a link only when one came back. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMailto, unsubscribeFailed, unsubscribeNotice } from './unsubscribe';
import { prefilledCompose } from '../compose/ComposeScreen';
import { closeCompose, getComposeRequest, openCompose } from '../../shell/store-compose';

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

test('a mailto outcome carries the prepared To, Subject and Body into a new composer', () => {
  const notice = unsubscribeNotice(
    {
      outcome: 'compose',
      url: 'mailto:leave@list.example?subject=unsubscribe%20me&body=Please%20remove%20me.&cc=x@y.example',
      message: '',
    },
    'Weekly Digest',
  );
  assert.deepEqual(notice.compose, {
    to: ['leave@list.example'],
    subject: 'unsubscribe me',
    body: 'Please remove me.',
  });
  assert.equal(notice.open, undefined, 'never an external open for a mailto');
  assert.match(notice.message, /Review the email/);

  openCompose({ prefill: { accountId: 'acct-1', ...notice.compose! } });
  const request = getComposeRequest();
  assert.equal(request?.prefill?.accountId, 'acct-1');
  const state = prefilledCompose(request!.prefill!);
  assert.equal(state.context.accountId, 'acct-1');
  assert.equal(state.context.mode, 'new');
  assert.deepEqual(
    state.fields.to.map(r => r.address),
    ['leave@list.example'],
  );
  assert.equal(state.fields.subject, 'unsubscribe me');
  assert.equal(state.fields.body, 'Please remove me.');
  assert.equal(state.send.kind, 'none', 'nothing is sent from here');
  closeCompose();
});

test('a mailto with no usable address says so instead of opening an empty message', () => {
  assert.equal(parseMailto('mailto:?subject=x'), null);
  assert.equal(parseMailto('https://example.com/u'), null);
  const notice = unsubscribeNotice({ outcome: 'compose', message: '' }, 'A');
  assert.equal(notice.compose, undefined);
  assert.match(notice.message, /did not offer/);
});
