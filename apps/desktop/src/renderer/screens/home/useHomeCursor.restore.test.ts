import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { ReturnPoint } from '../../shell/store-return';
import type { HomeItem } from './homeModel';
import { useHomeCursor } from './useHomeCursor';

const row = (id: string): HomeItem => ({ kind: 'row', id, section: 'do' });
const IDS = ['a', 'b', 'c', 'd'];
const point = (cursorId: string): ReturnPoint => ({ cursorId, order: IDS, scrollTop: 0 });

function keyAfterReturn(restore: ReturnPoint | null, ids: readonly string[]): string | null {
  let seen: string | null = null;
  renderToString(
    createElement(() => {
      seen = useHomeCursor(ids.map(row), restore).key;
      return null;
    }),
  );
  return seen;
}

test('Home puts the cursor back on the opened row', () => {
  assert.equal(keyAfterReturn(point('c'), IDS), 'c');
});

test('the opened row left Home while the reader was open: the row that took its place', () => {
  assert.equal(keyAfterReturn(point('b'), ['a', 'c', 'd']), 'c');
});

test('Home still loading keeps the saved row; with no saved place the first row', () => {
  assert.equal(keyAfterReturn(point('c'), []), 'c');
  assert.equal(keyAfterReturn(null, IDS), 'a');
});
