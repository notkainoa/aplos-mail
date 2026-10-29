import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '@aplos/emulators';
import {
  boundedKnownSubject,
  knownSubjectTimeoutMs,
} from '../../src/host/providers/oauth/known-subject';

const manual = () => new FakeClock({ auto: false });
const never = () => new Promise<boolean>(() => {});

/** Whether the promise has settled by the time pending callbacks have run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  return done;
}

test('a lookup that answers false is the only way to say "unknown"', async () => {
  const clock = manual();
  assert.equal(await boundedKnownSubject(() => false, { clock })('s1'), false);
  assert.equal(await boundedKnownSubject(async () => false, { clock })('s1'), false);
  assert.equal(await boundedKnownSubject(() => true, { clock })('s1'), true);
  assert.equal(clock.pending, 0, 'an answered lookup clears its timer');
});

test('a lookup that throws or rejects counts as known', async () => {
  const clock = manual();
  const throwing = () => {
    throw new Error('boom');
  };
  assert.equal(await boundedKnownSubject(throwing, { clock })('s1'), true);
  const rejecting = () => Promise.reject(new Error('boom'));
  assert.equal(await boundedKnownSubject(rejecting, { clock })('s1'), true);
  assert.equal(clock.pending, 0);
});

test('a lookup that never answers counts as known after the 2 s default, on the injected clock', async () => {
  const clock = manual();
  const answer = boundedKnownSubject(never, { clock })('s1');
  await clock.advance(knownSubjectTimeoutMs - 1);
  assert.equal(await settled(answer), false, 'still waiting just before the timeout');
  await clock.advance(1);
  assert.equal(await answer, true);
  assert.equal(knownSubjectTimeoutMs, 2_000);
});

test('an abort answers known at once and clears the timer', async () => {
  const clock = manual();
  const controller = new AbortController();
  const answer = boundedKnownSubject(never, { clock })('s1', controller.signal);
  await settled(answer);
  assert.equal(clock.pending, 1);
  controller.abort();
  assert.equal(await answer, true);
  assert.equal(clock.pending, 0, 'the timer is gone');
});

test('an already-aborted signal answers known without asking', async () => {
  const clock = manual();
  let asked = 0;
  const lookup = () => {
    asked += 1;
    return false;
  };
  assert.equal(await boundedKnownSubject(lookup, { clock })('s1', AbortSignal.abort()), true);
  assert.equal(asked, 0);
  assert.equal(clock.pending, 0);
});

test('a non-boolean answer is not "unknown"', async () => {
  const clock = manual();
  assert.equal(await boundedKnownSubject((() => undefined) as never, { clock })('s1'), true);
});
