// A failed send: an error toast that fades, plus an outbox notice in the sidebar that stays until the owner acts.
// Run: cd apps/desktop && npx tsx --test src/renderer/screens/compose/runtime/sendNotices.test.ts
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getOutbox, resetOutbox, runOutboxAction } from '../../../shell/store-outbox';
import { getToasts, resetToasts, runToastAction } from '../../../shell/store-toast';
import { SEND_COPY } from '../model/sendState';
import type { Submission } from '../../../data';
import { dismissOutboxNotice } from '../../../shell/OutboxHost';
import { releaseSend } from './sendHandoff';
import { dropUnconfirmedSend, pushRefusedSend, pushUnconfirmedSend } from './sendNotices';

beforeEach(() => {
  resetToasts();
  resetOutbox();
});

const refused = { draftId: 'd1', revision: 1, names: ['Jordan Lee'] };

test('a refused send raises an error toast that is not persistent, and an outbox notice', () => {
  pushRefusedSend(refused);
  const [toast] = getToasts();
  assert.equal(toast?.kind, 'error');
  assert.ok(!toast?.persistent, 'the toast fades by itself');
  assert.equal(toast?.message, SEND_COPY.failed('Jordan'));
  assert.deepEqual(
    getToasts()[0]?.actions?.map(a => a.label),
    ['Try again', 'Edit'],
  );
  const [notice] = getOutbox();
  assert.equal(notice?.message, toast?.message);
  assert.deepEqual(
    notice?.actions.map(a => a.label),
    ['Try again', 'Edit'],
  );
});

test('the toast fading leaves the notice; its verb clears both', () => {
  pushRefusedSend(refused);
  const id = getToasts()[0]?.id ?? '';
  assert.equal(getOutbox().length, 1);
  runToastAction(id, 'edit');
  assert.equal(getToasts().length, 0);
  assert.equal(getOutbox().length, 0, 'acting on the toast resolves the notice');
});

test('a verb on the notice closes the toast too; a second failure replaces, never piles up', () => {
  pushRefusedSend(refused);
  pushRefusedSend(refused);
  assert.equal(getOutbox().length, 1);
  assert.equal(getToasts().length, 1);
  runOutboxAction(getOutbox()[0]?.id ?? '', 'edit');
  assert.equal(getToasts().length, 0);
  assert.equal(getOutbox().length, 0);
});

test('an unconfirmed send is an error toast with a notice, and both go when the answer comes', () => {
  pushUnconfirmedSend('k');
  assert.equal(getToasts()[0]?.kind, 'error');
  assert.ok(!getToasts()[0]?.persistent);
  assert.equal(getOutbox().length, 1);
  dropUnconfirmedSend('k');
  assert.equal(getToasts().length, 0);
  assert.equal(getOutbox().length, 0);
});

test('closing the notice closes its toast too', () => {
  pushRefusedSend(refused);
  dismissOutboxNotice(getOutbox()[0]?.id ?? '');
  assert.equal(getToasts().length, 0);
  assert.equal(getOutbox().length, 0);
});

test('a later send of the same draft clears the stale failure', () => {
  pushRefusedSend(refused);
  releaseSend('sub-1', true, { id: 'sub-1', draftId: 'd1' } as Submission);
  assert.equal(getToasts().length, 0);
  assert.equal(getOutbox().length, 0);
});

test('a send of another draft leaves the failure alone', () => {
  pushRefusedSend(refused);
  releaseSend('sub-2', true, { id: 'sub-2', draftId: 'other' } as Submission);
  assert.equal(getOutbox().length, 1);
});
