import assert from 'node:assert/strict';
import test from 'node:test';
import { createEventHub, type HubEvent } from '../../src/shared/event-hub';

const collect = () => {
  const heard: HubEvent[] = [];
  return { heard, listener: (e: HubEvent) => void heard.push(e) };
};
const link = { type: 'deep-link', payload: 'aplos://x' };
const key = { type: 'mail-key', payload: { key: 'j' } };

test('events sent before anyone listens go to the first listener, once', () => {
  const hub = createEventHub();
  hub.emit(link);
  hub.emit({ type: 'command', payload: 'compose' });
  hub.emit({ type: 'state' });
  const first = collect();
  const second = collect();
  hub.subscribe(first.listener);
  hub.subscribe(second.listener);
  assert.deepEqual(
    first.heard.map(e => e.type),
    ['deep-link', 'command'],
  );
  assert.deepEqual(second.heard, [], 'a later listener never sees the queued events');
});

test('the queue goes to the app subscriber even when a mail-key subscriber registered first', () => {
  const hub = createEventHub();
  hub.emit(link);
  hub.emit({ type: 'prepare-close' });
  const keys = collect();
  hub.subscribe(keys.listener, { only: ['mail-key'] });
  assert.deepEqual(keys.heard, []);
  const app = collect();
  hub.subscribe(app.listener);
  assert.deepEqual(
    app.heard.map(e => e.type),
    ['deep-link', 'prepare-close'],
  );
});

test('a keys-only listener hears only its type; the app listener still hears everything', () => {
  const hub = createEventHub();
  const keys = collect();
  const app = collect();
  hub.subscribe(keys.listener, { only: ['mail-key'] });
  hub.subscribe(app.listener);
  hub.deliver(key);
  hub.emit({ type: 'state' });
  hub.emit(link);
  assert.deepEqual(keys.heard, [key]);
  assert.deepEqual(
    app.heard.map(e => e.type),
    ['mail-key', 'state', 'deep-link'],
  );
});

test('with only a typed listener present, an app event is held for the app as well as heard live', () => {
  const hub = createEventHub();
  const typed = collect();
  hub.subscribe(typed.listener, { only: ['deep-link'] });
  hub.emit(link);
  assert.deepEqual(typed.heard, [link]);
  const app = collect();
  hub.subscribe(app.listener);
  assert.deepEqual(app.heard, [link]);
});

test('a typed listener never drains the queue, even naming a waiting type', () => {
  const hub = createEventHub();
  hub.emit(link);
  hub.emit({ type: 'command', payload: 'compose' });
  const typed = collect();
  hub.subscribe(typed.listener, { only: ['command', 'deep-link'] });
  assert.deepEqual(typed.heard, []);
  const app = collect();
  hub.subscribe(app.listener);
  assert.deepEqual(
    app.heard.map(e => e.type),
    ['deep-link', 'command'],
  );
});

test('a listener that subscribes from inside its replay cannot take events from the replay', () => {
  const hub = createEventHub();
  hub.emit(link);
  hub.emit({ type: 'command', payload: 'a' });
  const outer: HubEvent[] = [];
  const inner = collect();
  hub.subscribe(event => {
    outer.push(event);
    if (outer.length === 1) hub.subscribe(inner.listener);
  });
  assert.equal(outer.length, 2);
  assert.deepEqual(inner.heard, []);
});

test('a listener that throws during its replay is not left registered', () => {
  const hub = createEventHub();
  hub.emit(link);
  let calls = 0;
  assert.throws(() =>
    hub.subscribe(() => {
      calls += 1;
      throw new Error('boom');
    }),
  );
  hub.emit({ type: 'state' });
  assert.equal(calls, 1, 'not called again for a later event');
});

test('the same function subscribed twice is one registration', () => {
  const hub = createEventHub();
  const app = collect();
  hub.subscribe(app.listener);
  hub.subscribe(app.listener);
  hub.emit({ type: 'state' });
  assert.equal(app.heard.length, 1);
});

test('a mail key nobody wants is dropped, never queued; unsubscribe stops delivery; the queue is bounded', () => {
  const hub = createEventHub();
  hub.deliver(key);
  const app = collect();
  const off = hub.subscribe(app.listener);
  assert.deepEqual(app.heard, []);
  off();
  hub.emit({ type: 'state' });
  assert.equal(app.heard.length, 0);
  const late = createEventHub();
  for (let n = 0; n < 60; n += 1) late.emit({ type: 'command', payload: n });
  const one = collect();
  late.subscribe(one.listener);
  assert.equal(one.heard.length, 50);
  assert.equal(one.heard[0]!.payload, 10, 'the oldest ten were dropped');
});

test('a mail-key event on the general event channel is dropped; only deliver() makes one', () => {
  const hub = createEventHub();
  const keys = collect();
  const app = collect();
  hub.subscribe(keys.listener, { only: ['mail-key'] });
  hub.subscribe(app.listener);
  hub.emit(key);
  assert.deepEqual([keys.heard, app.heard], [[], []]);
  hub.deliver(key);
  assert.deepEqual([keys.heard, app.heard], [[key], [key]]);
});
