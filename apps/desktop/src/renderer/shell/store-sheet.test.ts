import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { closeSheet, openSheet, registerSheetCancel, setSheetOpener } from './index';
import { getSheet } from './store-sheet';
import type { OpenSheet } from './index';

afterEach(() => {
  closeSheet();
  Reflect.deleteProperty(globalThis, 'document');
});

test('opening the same sheet with equal arguments keeps it', () => {
  openSheet('reconnect', { accountId: 'a1', mode: 'reconnect' });
  const first = getSheet();
  openSheet('reconnect', { accountId: 'a1', mode: 'reconnect' });
  assert.equal(getSheet(), first);
});

test('a different sheet or different arguments replaces it and cancels the first', () => {
  const cancelled: OpenSheet[] = [];
  const off = registerSheetCancel(sheet => cancelled.push(sheet));
  openSheet('reconnect', { accountId: 'a1', mode: 'reconnect' });
  openSheet('reconnect', { accountId: 'a1', mode: 'grant' });
  openSheet('consent');
  off();
  openSheet('reconnect', { accountId: 'a2', mode: 'reconnect' });
  assert.deepEqual(
    cancelled.map(s => s.name),
    ['reconnect', 'reconnect'],
  );
  assert.deepEqual(cancelled[0]?.args, { accountId: 'a1', mode: 'reconnect' });
  assert.equal(getSheet()?.name, 'reconnect');
});

test('closeSheet is a no-op when nothing is open and does not call cancel hooks', () => {
  let calls = 0;
  const off = registerSheetCancel(() => (calls += 1));
  closeSheet();
  openSheet('consent');
  closeSheet();
  off();
  assert.equal(calls, 0);
  assert.equal(getSheet(), null);
});

test('a throwing cancel hook does not keep the old sheet open', () => {
  const off = registerSheetCancel(() => {
    throw new Error('boom');
  });
  const log = console.error;
  console.error = () => undefined;
  try {
    openSheet('consent');
    openSheet('reconnect', { accountId: 'a1', mode: 'grant' });
  } finally {
    console.error = log;
    off();
  }
  assert.equal(getSheet()?.name, 'reconnect');
});

test('focus returns to the opener, once, and survives a replacement', () => {
  const focused: string[] = [];
  const opener = { focus: () => focused.push('opener'), isConnected: true };
  const other = { focus: () => focused.push('other'), isConnected: true };
  const doc = { activeElement: opener, body: {} };
  Object.assign(globalThis, { document: doc });
  openSheet('consent');
  doc.activeElement = other;
  openSheet('reconnect', { accountId: 'a1', mode: 'reconnect' });
  closeSheet();
  closeSheet();
  assert.deepEqual(focused, ['opener']);
});

test('a detached opener is not focused', () => {
  const focused: string[] = [];
  const doc = { activeElement: { focus: () => focused.push('x'), isConnected: false }, body: {} };
  Object.assign(globalThis, { document: doc });
  openSheet('consent');
  closeSheet();
  assert.deepEqual(focused, []);
});

test('setSheetOpener names the element focus returns to, even when another is focused at open', () => {
  const focused: string[] = [];
  const el = (name: string) => ({ focus: () => focused.push(name), isConnected: true });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { activeElement: el('menu item'), body: {} },
  });
  setSheetOpener(el('trigger'));
  openSheet('reconnect', { accountId: 'a1', mode: 'reconnect' });
  closeSheet();
  assert.deepEqual(focused, ['trigger']);
});
