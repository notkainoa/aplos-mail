import test from 'node:test';
import assert from 'node:assert/strict';
import { windowReaches } from './restoreWindow';

const ids = Array.from({ length: 200 }, (_, i) => `t${i}`);
const at = (index: number | undefined) => ({ cursorId: 't', order: [], scrollTop: 0, index });

test('a point with no index has nothing to reach', () => {
  assert.equal(windowReaches(at(undefined), { ids: [], position: 0, total: 0 }), true);
  assert.equal(windowReaches(null, { ids: [], position: 0, total: 0 }), true);
});

test('a window that holds the saved index reaches it, one that starts elsewhere does not', () => {
  assert.equal(windowReaches(at(450), { ids, position: 350, total: 800 }), true);
  assert.equal(windowReaches(at(450), { ids, position: 0, total: 800 }), false);
  assert.equal(windowReaches(at(450), { ids: [], position: 0, total: 800 }), false);
});

test('a list that shrank past the saved index is reached by its last window', () => {
  assert.equal(windowReaches(at(450), { ids: ids.slice(0, 50), position: 0, total: 50 }), true);
});
