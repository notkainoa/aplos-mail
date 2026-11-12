import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { closeThread, navigate, openThread, setAccountScope } from './index';
import {
  registerReturnSource,
  resetReturnPoints,
  restoreKey,
  returnKeyOf,
  takeReturnPoint,
  type ReturnPoint,
} from './store-return';

afterEach(() => {
  closeThread();
  navigate('home');
  resetReturnPoints();
});

const ORDER = ['a', 'b', 'c', 'd', 'e'];

function pointAt(cursorId: string | null): ReturnPoint {
  return { cursorId, order: ORDER, scrollTop: 0 };
}

test('restoreKey: the saved row when it is still there', () => {
  assert.equal(restoreKey(pointAt('c'), ['a', 'b', 'c', 'd']), 'c');
  assert.equal(restoreKey(pointAt('c'), ['x', 'c']), 'c');
});

test('restoreKey: a row that left hands the cursor to the one that took its place, then the one above', () => {
  assert.equal(restoreKey(pointAt('c'), ['a', 'b', 'd', 'e']), 'd');
  assert.equal(restoreKey(pointAt('e'), ['a', 'b', 'c', 'd']), 'd');
  assert.equal(restoreKey(pointAt('b'), ['a', 'e']), 'a');
});

test('restoreKey: reaches outwards, and gives up when nothing saved survives', () => {
  assert.equal(restoreKey(pointAt('c'), ['a', 'e']), 'e');
  assert.equal(restoreKey(pointAt('c'), ['x', 'y']), null);
  assert.equal(restoreKey(pointAt(null), ['a']), null);
});

test('returnKeyOf names a place or a label screen', () => {
  assert.equal(returnKeyOf('home'), 'home');
  assert.equal(returnKeyOf({ label: 'Search' }), 'label:Search');
});

function mountList(key: string, cursor: string, scrollTop: number): () => void {
  return registerReturnSource(key, () => ({ cursorId: cursor, order: ORDER, scrollTop }));
}

test('Esc from the reader returns to the place with its scroll offset and the opened row', () => {
  mountList('all', 'a', 420);
  openThread('c', { from: 'all', listIds: ORDER });
  closeThread();
  const point = takeReturnPoint('all');
  assert.equal(point?.cursorId, 'c');
  assert.equal(point?.scrollTop, 420);
});

test('J and K in the reader: Esc lands on the thread last read', () => {
  const unregister = mountList('all', 'b', 100);
  openThread('b', { from: 'all', listIds: ORDER });
  unregister();
  openThread('d');
  closeThread();
  assert.equal(takeReturnPoint('all')?.cursorId, 'd');
});

test('a thread outside the saved rows leaves the cursor where it was', () => {
  mountList('all', 'b', 0);
  openThread('b', { from: 'all' });
  openThread('zzz');
  closeThread();
  assert.equal(takeReturnPoint('all')?.cursorId, 'b');
});

test('going anywhere else than back drops the saved place', () => {
  mountList('all', 'b', 90);
  openThread('b', { from: 'all' });
  navigate('later');
  navigate('all');
  assert.equal(takeReturnPoint('all'), null);
});

test('the place is returned once, and twice within a render that runs twice', async () => {
  mountList('home', 'a', 5);
  openThread('a', { from: 'home' });
  closeThread();
  const first = takeReturnPoint('home');
  assert.notEqual(first, null);
  assert.equal(takeReturnPoint('home'), first);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(takeReturnPoint('home'), null);
});

test('a surface that is not mounted keeps nothing, and the extras ride along', () => {
  const stop = registerReturnSource('home', () => ({
    cursorId: 'a',
    order: ORDER,
    scrollTop: 1,
    extra: { lowOpen: true },
  }));
  mountList('home/low', 'b', 7);
  openThread('b', { from: 'home' });
  stop();
  closeThread();
  assert.deepEqual(takeReturnPoint('home')?.extra, { lowOpen: true });
  assert.equal(takeReturnPoint('home/low')?.cursorId, 'b');
  assert.equal(takeReturnPoint('later'), null);
});

test('the reader popping out to the compose page and back keeps the saved place', () => {
  mountList('all', 'b', 90);
  openThread('b', { from: 'all' });
  navigate({ label: 'compose' });
  navigate({ label: 'thread' });
  closeThread();
  assert.equal(takeReturnPoint('all')?.scrollTop, 90);
});

test('another account selected while the reader is open drops the saved place', () => {
  mountList('home', 'b', 90);
  openThread('b', { from: 'home' });
  setAccountScope('acct');
  closeThread();
  setAccountScope(null);
  assert.equal(takeReturnPoint('home'), null);
});
