import test from 'node:test';
import assert from 'node:assert/strict';
import type { Frame, NotificationItem } from '@aplos/contract';
import { inboxIds, nextOp } from './acts';
import { worldEngine, type TestEngine } from './harness';

/*
 * `Thread/act` and `Operation/undo` tell the timer loop (`deadlines.changed`) after a commit that moves `reminder_at` or
 * `later_until`, so a deadline set while the loop sleeps fires at its time, not at the next 60 s re-read.
 */

const SEC = 1_000;
const MIN = 60 * SEC;

type Env = Awaited<ReturnType<typeof worldEngine>>;

function listen(t: Env) {
  const events: NotificationItem[] = [];
  const host = t.engine.connect({ kind: 'host', scopes: ['host', 'read', 'triage'] });
  host.subscribe((f: Frame) => {
    if (f.frame === 'host' && f.event.type === 'reminder') events.push(f.event.item);
  });
  return { events, host };
}

async function act(
  t: TestEngine,
  id: string,
  action: Parameters<typeof t.call<'Thread/act'>>[1]['action'],
) {
  return t.call('Thread/act', { opId: nextOp('dl'), ids: [id], action });
}

const kinds = (events: NotificationItem[]) => events.map(e => e.kind);

test('a reminder set 5 minutes ahead fires at its time, not up to a minute late', async () => {
  const t = await worldEngine(5);
  try {
    const { events } = listen(t);
    const id = (await inboxIds(t, 'acct-1'))[0]!;
    await t.clock.advance(30 * SEC); // off the loop's 60 s re-read grid
    await act(t, id, { type: 'reminder', at: t.clock.now() + 5 * MIN });
    await t.clock.advance(5 * MIN - SEC);
    assert.equal(events.length, 0, 'not before its time');
    await t.clock.advance(2 * SEC);
    assert.deepEqual(kinds(events), ['reminder']);
    assert.equal(events[0]!.wasDueAt, undefined, 'on time, not late');
  } finally {
    await t.close();
  }
});

test('a reminder due sooner than the next re-read fires at its time', async () => {
  const t = await worldEngine(5);
  try {
    const { events } = listen(t);
    const id = (await inboxIds(t, 'acct-1'))[0]!;
    await t.clock.advance(5 * SEC);
    await act(t, id, { type: 'reminder', at: t.clock.now() + 10 * SEC });
    await t.clock.advance(11 * SEC);
    assert.deepEqual(kinds(events), ['reminder']);
  } finally {
    await t.close();
  }
});

test('a Later return time fires at its time', async () => {
  const t = await worldEngine(5);
  try {
    const { events } = listen(t);
    const id = (await inboxIds(t, 'acct-1'))[0]!;
    await t.clock.advance(5 * SEC);
    await act(t, id, { type: 'later', until: t.clock.now() + 10 * SEC });
    await t.clock.advance(9 * SEC);
    assert.equal(events.length, 0);
    await t.clock.advance(2 * SEC);
    assert.deepEqual(kinds(events), ['later']);
  } finally {
    await t.close();
  }
});

test('undoing a cleared reminder puts the deadline back in the loop', async () => {
  const t = await worldEngine(5);
  try {
    const { events } = listen(t);
    const id = (await inboxIds(t, 'acct-1'))[0]!;
    await t.clock.advance(5 * SEC);
    await act(t, id, { type: 'reminder', at: t.clock.now() + 10 * SEC });
    const cleared = await act(t, id, { type: 'reminder', clear: true });
    await t.clock.advance(SEC);
    await t.call('Operation/undo', { opId: cleared.opId, undoOpId: nextOp('undo') });
    await t.clock.advance(10 * SEC);
    assert.deepEqual(kinds(events), ['reminder']);
  } finally {
    await t.close();
  }
});

test('an action that touches neither column does not wake the sources', async () => {
  const t = await worldEngine(5);
  try {
    const id = (await inboxIds(t, 'acct-1'))[0]!;
    const calls: string[] = [];
    const registry = t.engine.services.deadlines;
    const original = registry.changed.bind(registry);
    registry.changed = name => {
      calls.push(String(name));
      original(name);
    };
    await act(t, id, { type: 'bookmark', on: true });
    await act(t, id, { type: 'reminder', at: t.clock.now() + MIN });
    await act(t, id, { type: 'later', until: t.clock.now() + MIN });
    assert.deepEqual(
      calls.filter(c => c === 'reminders' || c === 'later'),
      ['reminders', 'later'],
    );
  } finally {
    await t.close();
  }
});
