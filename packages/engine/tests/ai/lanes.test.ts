import test from 'node:test';
import assert from 'node:assert/strict';
import { laneFor } from '../../src/ai/lanes';
import { LANE_CASES, SPOOF_CASES, build } from './lanes.table';

for (const c of [...LANE_CASES, ...SPOOF_CASES]) {
  test(`laneFor: ${c.name}`, () => {
    const got = laneFor(c.input);
    assert.equal(got.lane, c.expect.lane);
    if (c.expect.importance) assert.equal(got.importance, c.expect.importance);
    assert.equal(got.due, c.expect.due);
  });
}

test('the table has 60 cases plus the spoofing set', () => {
  assert.ok(LANE_CASES.length >= 60, `${LANE_CASES.length} cases`);
  assert.ok(SPOOF_CASES.length >= 10);
});

test('laneFor is pure: same input, same answer, input untouched', () => {
  for (const c of [...LANE_CASES, ...SPOOF_CASES]) {
    const before = JSON.stringify(c.input);
    assert.deepEqual(laneFor(c.input), laneFor(c.input));
    assert.equal(JSON.stringify(c.input), before);
  }
});

test('a low lane never carries a due date', () => {
  const low = laneFor(
    build({ precedence: 'bulk', structured: [{ kind: 'bill', due: '2026-11-12' }] }),
  );
  assert.equal(low.lane, 'low');
  assert.equal(low.due, undefined);
});

test('malformed due dates are dropped', () => {
  const got = laneFor(
    build({ from: 'noreply@power.example', structured: [{ kind: 'bill', due: 'next week' }] }),
  );
  assert.equal(got.due, undefined);
});
