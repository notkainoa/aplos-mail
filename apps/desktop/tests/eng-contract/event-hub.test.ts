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

test('with only a keys-only listener present, an app event is still held for the app', () => {
  const hub = createEventHub();
  hub.subscribe(collect().listener, { only: ['mail-key'] });
  hub.emit(link);
  const app = collect();
  hub.subscribe(app.listener);
  assert.deepEqual(app.heard, [link]);
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
