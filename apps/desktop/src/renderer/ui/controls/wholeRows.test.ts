// The shortcut sheet's first view ends between rows. Run: cd apps/desktop && npx tsx --test src/renderer/ui/controls/wholeRows.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wholeRowsHeight } from './sheetModel';

const row = (top: number, height = 28) => ({ top, bottom: top + height });

test('the cut falls on the tallest row end that no column straddles', () => {
  // Column one's rows end at 28, 56, 84, 112; column two has a taller row from 50 to 100 that 56 and 84 would cut.
  const edges = [row(0), row(28), row(56), row(84), row(50, 50)];
  assert.equal(wholeRowsHeight(edges, 90), 28);
  assert.equal(wholeRowsHeight(edges, 112), 112);
});

test('with room to spare the height is the last row end', () => {
  assert.equal(wholeRowsHeight([row(0), row(28)], 200), 56);
});

test('no edge that fits returns the room unchanged', () => {
  assert.equal(wholeRowsHeight([row(0, 300)], 100), 100);
});
