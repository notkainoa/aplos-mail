/**
 * What a bulk action sends: named ids while the pick fits in the window, a whole-view selector once ⌘A goes
 * past it, and the toast words. Run:
 * `cd apps/desktop && npx tsx --test 'src/renderer/screens/lists/bulkTarget.test.ts'`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { State, ThreadListSpec } from '../../data';
import { bulkCount, bulkMessage, bulkTargetOf, type BulkScope } from './bulkTarget';

const SPEC: ThreadListSpec = { kind: 'mailbox', role: 'all' };
const STATE: State = { dbEpoch: 'e1', seq: 12 };

const scope = (over: Partial<BulkScope> = {}): BulkScope => ({
  loadedIds: ['t0', 't1', 't2'],
  total: 40,
  spec: SPEC,
  state: STATE,
  allPicked: true,
  ...over,
});

test('a partial pick sends the picked ids', () => {
  const target = bulkTargetOf({ ...scope(), picked: ['t0', 't2'] });
  assert.deepEqual(target, { ids: ['t0', 't2'] });
});

test('⌘A past the window sends a selector over the whole view at the seen state', () => {
  const target = bulkTargetOf({ ...scope(), picked: ['t0', 't1', 't2'] });
  assert.deepEqual(target, { selector: { spec: SPEC, atState: STATE } });
});

test('⌘A still sends ids when the whole view fits in the window or a row is unpicked', () => {
  const loaded = ['t0', 't1', 't2'];
  const fits = bulkTargetOf({ ...scope({ total: 3 }), picked: loaded });
  assert.deepEqual(fits, { ids: loaded }, 'nothing beyond the window: ids do');
  const unpicked = bulkTargetOf({ ...scope(), picked: ['t0', 't1'] });
  assert.deepEqual(unpicked, { ids: ['t0', 't1'] }, 'a loaded row left out breaks the selector');
  const noKey = bulkTargetOf({ ...scope({ allPicked: false }), picked: loaded });
  assert.deepEqual(noKey, { ids: loaded }, 'picking every row by hand is still a pick of ids');
});

test('a selector needs a spec and a state', () => {
  const picked = ['t0', 't1', 't2'];
  assert.deepEqual(bulkTargetOf({ ...scope({ spec: null }), picked }), { ids: picked });
  assert.deepEqual(bulkTargetOf({ ...scope({ state: null }), picked }), { ids: picked });
});

test('bulkCount reports the view total for a selector, else the picked count', () => {
  assert.equal(bulkCount({ ...scope(), count: 3 }), 40, 'the bar says how big the view is');
  assert.equal(bulkCount({ ...scope({ total: 3 }), count: 3 }), 3, 'a view that fits is its pick');
  assert.equal(bulkCount({ ...scope({ allPicked: false }), count: 2 }), 2);
  assert.equal(bulkCount({ ...scope({ spec: null }), count: 3 }), 3);
});

test('bulkMessage words the toast', () => {
  assert.equal(bulkMessage('done', 3), 'Done · 3 emails');
  assert.equal(bulkMessage('later', 3), 'Moved to Later · 3 emails');
  assert.equal(bulkMessage('trash', 3), 'Moved to Trash · 3 emails');
  assert.equal(bulkMessage('done', 1), 'Done · 1 email');
});
