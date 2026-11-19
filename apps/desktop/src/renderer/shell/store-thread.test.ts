import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import {
  closeThread,
  navigate,
  openThread,
  useHomeShellProps,
  useOpenThreadContext,
  type OpenThreadContext,
} from './index';
import { getOpenThread, getOpenThreadContext } from './store-thread';
import { getScreen } from './store-route';

afterEach(() => {
  closeThread();
  navigate('home');
});

test('openThread(id) stays valid: no place, no list; closing goes to Home', () => {
  navigate('later');
  openThread('t1');
  assert.equal(getOpenThread(), 't1');
  assert.deepEqual(getScreen(), { label: 'thread' });
  assert.deepEqual(getOpenThreadContext(), { from: null, listIds: null });
  closeThread();
  assert.equal(getOpenThread(), null);
  assert.equal(getScreen(), 'home');
});

test('from and listIds are recorded, exposed and closeThread goes back to from', () => {
  openThread('t1', { from: 'later', listIds: ['t1', 't2', 't3'] });
  assert.equal(getOpenThreadContext().from, 'later');
  let seen: OpenThreadContext | undefined;
  renderToString(
    createElement(() => {
      seen = useOpenThreadContext();
      return null;
    }),
  );
  assert.deepEqual(seen, { from: 'later', listIds: ['t1', 't2', 't3'] });
  closeThread();
  assert.equal(getScreen(), 'later');
  assert.deepEqual(getOpenThreadContext(), { from: null, listIds: null });
});

test('a label view is a valid from', () => {
  openThread('t1', { from: { label: 'Receipts' } });
  closeThread();
  assert.deepEqual(getScreen(), { label: 'Receipts' });
});

test('J and K reopen from the reader without options: the place and list carry on', () => {
  openThread('t1', { from: 'done', listIds: ['t1', 't2'] });
  const first = getOpenThreadContext();
  openThread('t2');
  assert.equal(getOpenThread(), 't2');
  assert.equal(getOpenThreadContext(), first, 'the same snapshot, so nothing re-renders');
  openThread('t2', { listIds: ['t2', 't3'] });
  assert.deepEqual(getOpenThreadContext(), { from: 'done', listIds: ['t2', 't3'] });
});

test('opening from a list replaces an earlier place and list', () => {
  openThread('t1', { from: 'done', listIds: ['t1'] });
  closeThread();
  openThread('t5');
  assert.deepEqual(getOpenThreadContext(), { from: null, listIds: null });
});

test('a non-object second argument (Home used to pass its open "how") is ignored', () => {
  openThread('t1', 'open' as never);
  assert.deepEqual(getOpenThreadContext(), { from: null, listIds: null });
});

test('closeThread elsewhere clears the thread but does not move the screen', () => {
  openThread('t1', { from: 'later' });
  navigate('settings');
  closeThread();
  assert.equal(getOpenThread(), null);
  assert.equal(getScreen(), 'settings');
});

test('Home opens a thread from home, even when it passes its open "how" as a second argument', () => {
  let props: ReturnType<typeof useHomeShellProps> | undefined;
  renderToString(
    createElement(() => {
      props = useHomeShellProps();
      return null;
    }),
  );
  (props?.onOpen as (id: string, how?: string) => void)('t1', 'open');
  assert.equal(getOpenThreadContext().from, 'home');
  closeThread();
  assert.equal(getScreen(), 'home');
});
