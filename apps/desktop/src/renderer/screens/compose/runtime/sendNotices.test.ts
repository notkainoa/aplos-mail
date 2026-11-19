// A failed send: one error toast that stays until the owner acts on it; no sidebar notice.
// Run: cd apps/desktop && npx tsx --test src/renderer/screens/compose/runtime/sendNotices.test.ts
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { dismissToast } from '../../../shell';
import { getToasts, resetToasts, runToastAction } from '../../../shell/store-toast';
import { SEND_COPY } from '../model/sendState';
import type { Submission } from '../../../data';
import { releaseSend } from './sendHandoff';
import { dropUnconfirmedSend, pushRefusedSend, pushUnconfirmedSend } from './sendNotices';

beforeEach(() => {
  resetToasts();
});

const refused = { draftId: 'd1', revision: 1, names: ['Jordan Lee'] };

test('a refused send raises one persistent error toast with Try again and Edit', () => {
  pushRefusedSend(refused);
  assert.equal(getToasts().length, 1);
  const [toast] = getToasts();
  assert.equal(toast?.kind, 'error');
  assert.equal(toast?.persistent, true, 'the toast stays until the owner acts on it');
  assert.equal(toast?.message, SEND_COPY.failed('Jordan'));
  assert.deepEqual(
    toast?.actions?.map(a => a.label),
    ['Try again', 'Edit'],
  );
});

test('a verb clears the toast; a second failure replaces it, never piles up', () => {
  pushRefusedSend(refused);
  pushRefusedSend(refused);
  assert.equal(getToasts().length, 1);
  runToastAction(getToasts()[0]?.id ?? '', 'edit');
  assert.equal(getToasts().length, 0);
});

test('dismissing the toast clears the failure', () => {
  pushRefusedSend(refused);
  dismissToast(getToasts()[0]?.id ?? '');
  assert.equal(getToasts().length, 0);
});

test('an unconfirmed send is a persistent error toast, and it goes when the answer comes', () => {
  pushUnconfirmedSend('k');
  assert.equal(getToasts()[0]?.kind, 'error');
  assert.equal(getToasts()[0]?.persistent, true);
  dropUnconfirmedSend('k');
  assert.equal(getToasts().length, 0);
});

test('a later send of the same draft clears the stale failure', () => {
  pushRefusedSend(refused);
  releaseSend('sub-1', true, { id: 'sub-1', draftId: 'd1' } as Submission);
  assert.equal(getToasts().length, 0);
});

test('a send of another draft leaves the failure alone', () => {
  pushRefusedSend(refused);
  releaseSend('sub-2', true, { id: 'sub-2', draftId: 'other' } as Submission);
  assert.equal(getToasts().length, 1);
});
