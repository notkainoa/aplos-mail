import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { STATES } from '../states';
import {
  assertSampleLocked,
  assertStatesLocked,
  loadLocked,
  missingLocked,
  type Locked,
} from './locked';

const locked: Locked = { states: ['a', 'b'], lockedSample: ['a'] };

test('missingLocked names the locked ids that are gone and ignores new ones', () => {
  assert.deepEqual(missingLocked(['a', 'b', 'c'], ['a', 'c', 'new']), ['b']);
  assert.deepEqual(missingLocked(['a'], ['a', 'x', 'y']), []);
});

test('deleting a locked state fails; adding one does not', () => {
  assert.doesNotThrow(() => assertStatesLocked(['a', 'b', 'c'], locked));
  assert.throws(() => assertStatesLocked(['a'], locked), /locked states missing.*: b/);
});

test('shrinking the taste sample below the locked ids fails', () => {
  assert.doesNotThrow(() => assertSampleLocked(['a', 'z'], locked));
  assert.throws(() => assertSampleLocked(['z'], locked), /taste\.sample\.json: a/);
});

test('locked-states.json is sorted, matches states.ts today and covers taste.sample.json', () => {
  const file = loadLocked();
  assert.deepEqual(file.states, [...file.states].sort());
  assert.deepEqual(file.lockedSample, [...file.lockedSample].sort());
  assert.deepEqual(new Set(file.states).size, file.states.length);
  assert.doesNotThrow(() =>
    assertStatesLocked(
      STATES.map(state => state.id),
      file,
    ),
  );
  const sample = JSON.parse(
    readFileSync(join(import.meta.dirname, 'taste.sample.json'), 'utf8'),
  ) as { states: string[] };
  assert.doesNotThrow(() => assertSampleLocked(sample.states, file));
  assert.deepEqual(missingLocked(file.lockedSample, file.states), []);
});
