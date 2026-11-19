/**
 * Pending sent replies: shown until the thread holds the real message.
 * Run: cd apps/desktop && npx tsx --test src/renderer/screens/compose/model/pendingSent.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PENDING_SENT_LIFE_MS,
  pendingSentStore,
  stillPending,
  type PendingSent,
} from './pendingSent';

const fields = { to: [], cc: [], bcc: [], subject: 'Re: Plans', body: 'On my way.' };
const note = (over: Partial<PendingSent>): PendingSent => ({
  key: 'a',
  threadId: 't1',
  fields,
  at: 1000,
  baseline: 1,
  ...over,
});

test('a note shows while the thread has no new message of yours, and goes when it has', () => {
  const notes = [note({})];
  assert.equal(stillPending(notes, 't1', 1, 2000).length, 1);
  assert.equal(stillPending(notes, 't1', 2, 2000).length, 0);
});

test('another thread’s note is not shown', () => {
  assert.equal(stillPending([note({ threadId: 't2' })], 't1', 1, 2000).length, 0);
});

test('two sends wait in order: the first message in settles the first note only', () => {
  const notes = [note({ key: 'a', at: 1000 }), note({ key: 'b', at: 2000 })];
  assert.deepEqual(
    stillPending(notes, 't1', 1, 3000).map(n => n.key),
    ['a', 'b'],
  );
  assert.deepEqual(
    stillPending(notes, 't1', 2, 3000).map(n => n.key),
    ['b'],
  );
  assert.equal(stillPending(notes, 't1', 3, 3000).length, 0);
});

test('a note the engine never answered is dropped after its life', () => {
  assert.equal(stillPending([note({})], 't1', 1, 1000 + PENDING_SENT_LIFE_MS).length, 0);
});

test('the store replaces a note with the same key and tells its listeners', () => {
  pendingSentStore.clear();
  let heard = 0;
  const off = pendingSentStore.subscribe(() => (heard += 1));
  pendingSentStore.add(note({}));
  pendingSentStore.add(note({ at: 5000 }));
  off();
  assert.equal(pendingSentStore.get().length, 1);
  assert.equal(pendingSentStore.get()[0]!.at, 5000);
  assert.equal(heard, 2);
  pendingSentStore.clear();
});
