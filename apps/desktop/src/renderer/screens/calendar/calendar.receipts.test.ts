/**
 * Receipt kinds (item 2): a write whose receipt says `undoable:false` (the write-through path — no hold,
 * no undo window yet) keeps no Undo toast; the pushed one becomes the plain confirmation in place. An
 * undoable receipt keeps today's behaviour: the Undo toast stays, reworded held → sent once the hold ends.
 * In both, the overlay settles on `appliedState`, never ghosting the entry.
 * Run: `cd apps/desktop && npx tsx --test 'src/renderer/screens/calendar/*.test.ts*'`.
 */
import './calendar.tz';
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Receipt } from '../../data';
import { getToasts, resetToasts } from '../../shell/store-toast';
import type { CalendarEffect } from './calendar.model';
import { runCalendarEffect, type EffectPorts } from './effects';
import { boot, ports, testUi } from './calendar.testkit';

const receipt = (extra: Partial<Receipt> = {}): Receipt => ({
  opId: 'op-1',
  appliedState: { dbEpoch: 'e', seq: 9 },
  ...extra,
});

const eventSet: CalendarEffect = {
  kind: 'eventSet',
  change: { type: 'update', id: 'dental', scope: 'occurrence', fields: { title: 'Cleaning' } },
  optimistic: { id: 'dental', patch: { title: 'Cleaning' } },
  toast: {
    kind: 'info',
    message: 'Changed Cleaning',
    held: 'Changing Cleaning',
    undoable: true,
  },
  undoLabel: 'Changed Cleaning',
  failure: 'Couldn’t change Cleaning.',
};

const rsvpFx: CalendarEffect = {
  kind: 'rsvp',
  id: 'q4',
  response: 'accepted',
  scope: 'occurrence',
  answer: 'yes',
  organizer: 'Priya',
  optimistic: { id: 'q4', patch: { myReply: 'yes' } },
  failure: 'Couldn’t send your reply.',
};

const withEventSet = (r: Receipt): EffectPorts => ({
  ...ports(),
  eventSet: () => Promise.resolve({ receipt: r }),
});

const withRsvp = (r: Receipt): EffectPorts => ({
  ...ports(),
  eventRsvp: () => Promise.resolve(r),
});

const lastToast = () => getToasts()[getToasts().length - 1];

test('receipts: undoable:false demotes the Undo toast to the plain sent notice', async () => {
  resetToasts();
  try {
    const ui = testUi();
    runCalendarEffect(eventSet, withEventSet(receipt({ undoable: false })), ui);
    assert.ok(getToasts().some(t => t.undoable && t.actions?.some(a => a.keysFrom === 'app.undo')));
    await new Promise(resolve => setImmediate(resolve));
    const toast = lastToast();
    assert.equal(toast?.message, 'Changed Cleaning');
    assert.equal(toast?.undoable, false);
    assert.equal(toast?.actions, undefined, 'no Undo action on a write-through receipt');
    // One operation, one notice: the opId toast alone stands.
    assert.equal(getToasts().length, 1);
    assert.deepEqual(ui.applied, ['dental']);
    assert.deepEqual(ui.dropped, []);
  } finally {
    resetToasts();
  }
});

test('receipts: an undoable receipt keeps the Undo toast and its wording', async () => {
  resetToasts();
  try {
    const ui = testUi();
    runCalendarEffect(eventSet, withEventSet(receipt({ undoable: true })), ui);
    await new Promise(resolve => setImmediate(resolve));
    const toast = lastToast();
    assert.equal(toast?.message, 'Changed Cleaning');
    assert.equal(toast?.undoable, true);
    assert.ok(toast?.actions?.some(a => a.keysFrom === 'app.undo'));
    assert.deepEqual(ui.applied, ['dental']);
  } finally {
    resetToasts();
  }
});

test('receipts: a held write keeps the Undo toast while undoUntil is in the future', async () => {
  await boot();
  resetToasts();
  try {
    const ui = testUi();
    runCalendarEffect(
      eventSet,
      withEventSet(receipt({ undoable: true, undoUntil: Date.now() + 60_000 })),
      ui,
    );
    await new Promise(resolve => setImmediate(resolve));
    const toast = lastToast();
    assert.equal(toast?.message, 'Changing Cleaning', 'still the held wording inside the window');
    assert.equal(toast?.undoable, true);
  } finally {
    resetToasts();
  }
});

test('receipts: rsvp undoable:false demotes to "Replied Yes to Priya" with no Undo', async () => {
  resetToasts();
  try {
    const ui = testUi();
    runCalendarEffect(rsvpFx, withRsvp(receipt({ undoable: false })), ui);
    await new Promise(resolve => setImmediate(resolve));
    const toast = lastToast();
    assert.equal(toast?.message, 'Replied Yes to Priya');
    assert.equal(toast?.undoable, false);
    assert.equal(toast?.actions, undefined);
    assert.equal(getToasts().length, 1);
  } finally {
    resetToasts();
  }
});
