/** The pane header parts a screen adds: the latest mounted wins, and removing it gives the earlier one back. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addPaneHeaderPart, getPaneHeaderPart } from './store-pane';

const bulk = (count: number) => ({
  bulk: { count, actions: [], onMore: () => {}, onClear: () => {} },
});

test('nothing set: an empty part', () => {
  assert.deepEqual(getPaneHeaderPart(), {});
});

test('the latest part wins and the earlier one returns when it goes', () => {
  const screen = { crumb: { label: 'Home' } };
  const picked = bulk(3);
  const removeScreen = addPaneHeaderPart(screen);
  const removePicked = addPaneHeaderPart(picked);
  assert.equal(getPaneHeaderPart(), picked);
  removePicked();
  assert.equal(getPaneHeaderPart(), screen);
  removeScreen();
  assert.deepEqual(getPaneHeaderPart(), {});
});

test('removing a part twice, or out of order, never throws or drops another', () => {
  const a = bulk(1);
  const b = bulk(2);
  const removeA = addPaneHeaderPart(a);
  const removeB = addPaneHeaderPart(b);
  removeA();
  removeA();
  assert.equal(getPaneHeaderPart(), b);
  removeB();
  assert.deepEqual(getPaneHeaderPart(), {});
});
