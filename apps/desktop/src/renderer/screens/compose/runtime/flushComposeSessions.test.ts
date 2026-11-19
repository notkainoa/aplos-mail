// What a closing window may do about unsaved compose text (flushComposeSessions): it asks every kept composer to save,
// waits, and reports from the state whether any text is still only in memory. Fakes for the sessions.
// Run: cd apps/desktop && npx tsx --test src/renderer/screens/compose/runtime/flushComposeSessions.test.ts

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { FRESH_SAVE } from '../model/autosave';
import { freshCompose, type ComposeState } from '../model/composeState';
import { keepUntilSaved, releaseAllKept } from './recovery';
import type { ComposeSession } from './session';
import { flushComposeSessions } from './useComposeSession';

const base = freshCompose(
  { accountId: 'a1', mode: 'reply', threadId: 't1' },
  { to: [], cc: [], bcc: [], subject: 'Re: plans', body: '' },
);

/** A composer with an edit the engine has not confirmed (editSeq ahead of savedSeq). */
const dirty: ComposeState = {
  ...base,
  save: { ...FRESH_SAVE, draftId: 'd1', revision: 1, rowRev: 1, editSeq: 2, savedSeq: 1 },
};
const clean: ComposeState = { ...dirty, save: { ...dirty.save, savedSeq: 2 } };

function fakeSession(start: ComposeState, onFlush: () => ComposeState = () => start) {
  let state = start;
  const dispatched: string[] = [];
  const session: ComposeSession = {
    getState: () => state,
    subscribe: () => () => undefined,
    dispatch: action => {
      dispatched.push(action.type);
      if (action.type === 'flush') state = onFlush();
    },
    settled: async () => undefined,
    dispose: () => undefined,
  };
  return { session, dispatched };
}

afterEach(() => releaseAllKept());

test('nothing mounted or kept is saved', async () => {
  assert.equal(await flushComposeSessions(50), 'saved');
});

test('a kept composer is asked to save and, once its text is in, the window may go', async () => {
  const fake = fakeSession(dirty, () => clean);
  keepUntilSaved(fake.session);
  assert.equal(await flushComposeSessions(50), 'saved');
  assert.deepEqual(fake.dispatched, ['flush']);
});

test('text the engine still has not taken is unsaved even though settled() resolved', async () => {
  const fake = fakeSession(dirty);
  keepUntilSaved(fake.session);
  assert.equal(await flushComposeSessions(50), 'unsaved');
  assert.deepEqual(fake.dispatched, ['flush']);
});

test('a save that never answers gives up at the limit and reports unsaved', async () => {
  const fake = fakeSession(dirty);
  fake.session.settled = () => new Promise<void>(() => undefined);
  keepUntilSaved(fake.session);
  const began = Date.now();
  assert.equal(await flushComposeSessions(40), 'unsaved');
  assert.ok(Date.now() - began < 1000);
});
