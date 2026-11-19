/**
 * The Home cursor's memory of rows that left under it (`settleHome`): Undo hands the card back to the mail it came
 * from, but only soon after, only while the cursor has not been moved, and in the order the mail left.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { settleHome, UNDO_WINDOW_MS } from './homeModel';

const plain = (id: string) => ({ kind: 'row', id, section: 'do' }) as const;

test('a mail that comes back long after it left does not pull the card to it', () => {
  const all = ['a', 'b', 'c'].map(plain);
  const left = settleHome(all, all.slice(1), 'a', [], 0);
  assert.equal(left.key, 'b');
  assert.equal(settleHome(all.slice(1), all, 'b', left.displaced, 5_000).key, 'a', 'Undo in time');
  assert.equal(settleHome(all.slice(1), all, 'b', left.displaced, UNDO_WINDOW_MS + 1).key, 'b');
});

test('a cursor the owner moved (notes cleared) stays put when the mail comes back', () => {
  const all = ['a', 'b', 'c'].map(plain);
  assert.equal(settleHome(all.slice(1), all, 'c', [], 0).key, 'c');
});

test('Undo of the older action first leaves the card, then Undo of the newer one lands on it, not past it', () => {
  const [a, b, c] = ['a', 'b', 'c', 'd'].map(plain);
  const abcd = ['a', 'b', 'c', 'd'].map(plain);
  const afterA = settleHome(abcd, abcd.slice(1), 'a', [], 0);
  const afterB = settleHome(abcd.slice(1), abcd.slice(2), afterA.key, afterA.displaced, 1);
  assert.equal(afterB.key, 'c');
  const aBack = settleHome(abcd.slice(2), [a, ...abcd.slice(2)], 'c', afterB.displaced, 2);
  assert.equal(aBack.key, 'c', 'the card stays while an older Undo brings a row back');
  const bBack = settleHome([a, ...abcd.slice(2)], [a, b, c, abcd[3]], 'c', aBack.displaced, 3);
  assert.equal(bBack.key, 'b', 'the newer Undo puts the card on it');
  assert.equal(
    settleHome([a, b, c, abcd[3]], [a, b, c, abcd[3]], 'b', bBack.displaced, 4).key,
    'b',
  );
});
