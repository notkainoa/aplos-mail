import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeSession, shownId } from './oneByOneSession';

const QUEUE = ['t1', 't2', 't3', 't4'];

test('the walk resumes on the thread the reader opened over', () => {
  const session = resumeSession(QUEUE, 2);
  assert.equal(shownId(session, new Set(QUEUE)), 't3');
});

test('a walk resumed at the start is the plain walk', () => {
  assert.equal(shownId(resumeSession(QUEUE, 0), new Set(QUEUE)), 't1');
});
