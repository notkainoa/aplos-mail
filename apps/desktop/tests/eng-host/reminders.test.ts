import test from 'node:test';
import assert from 'node:assert/strict';
import type { Frame, NotificationItem } from '@aplos/contract';
import { announceMissedReminders, type ReminderSession } from '../../src/host/reminders';

const NOW = Date.UTC(2026, 9, 29, 17, 0);

const listed = (n: number, at = NOW - 3_600_000) => ({
  threadId: `acct:t${n}`,
  at,
  firedAt: NOW,
  ifNoReply: false,
  title: `Thread ${n}`,
});

const liveItem = (n: number, at = NOW - 3_600_000): NotificationItem => ({
  id: `reminder:acct:t${n}:${at}`,
  kind: 'reminder',
  accountId: 'acct',
  threadId: `acct:t${n}`,
  title: `Thread ${n}`,
  at: NOW,
});

const hostFrame = (item: NotificationItem): Frame =>
  ({ frame: 'host', event: { type: 'reminder', item } }) as Frame;

/** A session whose `Reminder/list` answers when the test says so, so frames can arrive while it is in flight. */
function fakeSession(list: () => Promise<unknown> | unknown) {
  const listeners = new Set<(frame: Frame) => void>();
  const calls: string[] = [];
  const session: ReminderSession = {
    async call(method) {
      calls.push(method);
      return list();
    },
    subscribe(listener) {
      calls.push('subscribe');
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return {
    session,
    calls,
    emit: (frame: Frame) => listeners.forEach(l => l(frame)),
    listeners: () => listeners.size,
  };
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function collect() {
  const seen: NotificationItem[] = [];
  return { seen, notify: (item: NotificationItem) => void seen.push(item) };
}

test('a reminder that fired before the host connected is announced once', async () => {
  const s = fakeSession(() => ({ items: [listed(1)] }));
  const { seen, notify } = collect();
  announceMissedReminders(s.session, notify);
  await settle();
  assert.deepEqual(s.calls, ['subscribe', 'Reminder/list'], 'subscribes first, lists once');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.id, `reminder:acct:t1:${NOW - 3_600_000}`);
  assert.equal(seen[0]!.kind, 'reminder');
  assert.equal(seen[0]!.threadId, 'acct:t1');
  assert.equal(seen[0]!.title, 'Thread 1');
  assert.equal(seen[0]!.at, NOW);
  assert.equal(seen[0]!.wasDueAt, NOW - 3_600_000, 'it was late');
});

test('upcoming reminders (not fired yet) are not announced', async () => {
  const upcoming = { threadId: 'acct:t2', at: NOW + 60_000, ifNoReply: false, title: 'Later' };
  const s = fakeSession(() => ({ items: [upcoming] }));
  const { seen, notify } = collect();
  announceMissedReminders(s.session, notify);
  await settle();
  assert.deepEqual(seen, []);
});

test('a live frame for the same reminder first means the list does not announce it again', async () => {
  const s = fakeSession(() => ({ items: [listed(1), listed(2)] }));
  const { seen, notify } = collect();
  announceMissedReminders(s.session, notify);
  s.emit(hostFrame(liveItem(1)));
  await settle();
  assert.deepEqual(seen.map(i => i.threadId).sort(), ['acct:t1', 'acct:t2']);
});

test('a live frame that arrives while the list call is in flight is not doubled', async () => {
  let answer: (value: unknown) => void = () => undefined;
  const s = fakeSession(() => new Promise(resolve => (answer = resolve)));
  const { seen, notify } = collect();
  announceMissedReminders(s.session, notify);
  await settle();
  s.emit(hostFrame(liveItem(1)));
  assert.equal(seen.length, 1);
  answer({ items: [listed(1)] });
  await settle();
  assert.equal(seen.length, 1, 'the list does not repeat the live one');
  s.emit(hostFrame(liveItem(1)));
  assert.equal(seen.length, 1, 'nor does a repeated live frame');
});

test('other frames and non-reminder host events are ignored', async () => {
  const s = fakeSession(() => ({ items: [] }));
  const { seen, notify } = collect();
  announceMissedReminders(s.session, notify);
  s.emit({ frame: 'host', event: { type: 'clock', now: NOW } } as Frame);
  s.emit({ frame: 'operation' } as unknown as Frame);
  await settle();
  assert.deepEqual(seen, []);
});

test('a failing list call does not throw, and live frames still notify', async () => {
  const s = fakeSession(() => {
    throw new Error('engine parked');
  });
  const { seen, notify } = collect();
  assert.doesNotThrow(() => announceMissedReminders(s.session, notify));
  await settle();
  s.emit(hostFrame(liveItem(3)));
  assert.equal(seen.length, 1);
  const rejecting = fakeSession(() => Promise.reject(new Error('unavailable')));
  announceMissedReminders(rejecting.session, notify);
  await settle();
});

test('a throwing notify does not stop the other reminders', async () => {
  const s = fakeSession(() => ({ items: [listed(1), listed(2)] }));
  const seen: string[] = [];
  announceMissedReminders(s.session, item => {
    seen.push(item.id);
    throw new Error('notification center refused');
  });
  await settle();
  assert.equal(seen.length, 2);
});

test('unsubscribe stops live notifications and a list still in flight', async () => {
  let answer: (value: unknown) => void = () => undefined;
  const s = fakeSession(() => new Promise(resolve => (answer = resolve)));
  const { seen, notify } = collect();
  const off = announceMissedReminders(s.session, notify);
  assert.equal(s.listeners(), 1);
  off();
  assert.equal(s.listeners(), 0);
  s.emit(hostFrame(liveItem(1)));
  answer({ items: [listed(2)] });
  await settle();
  assert.deepEqual(seen, []);
});

test('a late reminder from the list carries the was-due text in the owner zone', async () => {
  // 17:00 UTC on 29 Oct 2026 is 10:00 AM in Los Angeles; the reminder was due an hour before.
  const s = fakeSession(() => ({ items: [listed(1)] }));
  const { seen, notify } = collect();
  announceMissedReminders(s.session, notify, { zone: 'America/Los_Angeles' });
  await settle();
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.body, 'Was due Thu, Oct 29, 9:00 AM');
  assert.equal(seen[0]!.wasDueAt, NOW - 3_600_000);
});

test('the same reminder re-set to the same time and fired again (a new fire time) notifies again', async () => {
  const s = fakeSession(() => ({ items: [listed(1)] }));
  const { seen, notify } = collect();
  announceMissedReminders(s.session, notify);
  await settle();
  assert.equal(seen.length, 1);
  s.emit(hostFrame({ ...liveItem(1), at: NOW }));
  assert.equal(seen.length, 1, 'the same fire seen live is not a duplicate');
  s.emit(hostFrame({ ...liveItem(1), at: NOW + 3_600_000 }));
  assert.equal(seen.length, 2, 'a later fire of the same id is a new notification');
});
