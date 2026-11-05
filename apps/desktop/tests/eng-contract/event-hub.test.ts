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

test('events a throwing replay did not deliver wait for the next plain subscriber', () => {
  const hub = createEventHub();
  hub.emit(link);
  hub.emit({ type: 'prepare-close' });
  assert.throws(() =>
    hub.subscribe(event => {
      if (event.type === 'deep-link') throw new Error('boom');
    }),
  );
  const next = collect();
  hub.subscribe(next.listener);
  assert.deepEqual(
    next.heard.map(e => e.type),
    ['prepare-close'],
  );
});

test('re-subscribing a registered function returns its unsubscribe and keeps its first options', () => {
  const hub = createEventHub();
  const app = collect();
  const off = hub.subscribe(app.listener);
  assert.equal(hub.subscribe(app.listener, { only: ['x'] }), off);
  hub.emit({ type: 'state' });
  assert.equal(app.heard.length, 1, 'still a plain listener');
  off();
  hub.emit({ type: 'state' });
  assert.equal(app.heard.length, 1);
});

test('a typed listener cannot change the event held for the app; one removed mid-delivery is skipped', () => {
  const hub = createEventHub();
  const payload = { to: 'a' };
  hub.subscribe(
    event => {
      (event.payload as { to: string }).to = 'changed';
    },
    { only: ['deep-link'] },
  );
  hub.emit({ type: 'deep-link', payload });
  const app = collect();
  hub.subscribe(app.listener);
  // The copy is shallow: the top-level event is the app's own, so a typed listener cannot retype or drop it.
  assert.equal(app.heard[0]!.type, 'deep-link');

  const hub2 = createEventHub();
  const second = collect();
  let offSecond = () => {};
  hub2.subscribe(() => offSecond());
  offSecond = hub2.subscribe(second.listener);
  hub2.emit({ type: 'state' });
  assert.deepEqual(second.heard, [], 'removed by the first listener in the same pass: not called');
});

test('a navigate event waits for a listener that names it, and plain listeners never take it', () => {
  const hub = createEventHub();
  const nav = { type: 'navigate', payload: { to: 'settings.ai' } };
  hub.emit(nav);
  const app = collect();
  hub.subscribe(app.listener);
  assert.deepEqual(app.heard, [], "the app's plain subscribe does not take it");
  const keys = collect();
  hub.subscribe(keys.listener, { only: ['mail-key'] });
  assert.deepEqual(keys.heard, [], 'a listener naming other types does not take it');
  const router = collect();
  hub.subscribe(router.listener, { only: ['navigate'] });
  assert.deepEqual(router.heard, [nav]);
  const later = collect();
  hub.subscribe(later.listener, { only: ['navigate'] });
  assert.deepEqual(later.heard, [], 'taken once');
});

test('a navigate event is heard live by plain and naming listeners, and not held once someone names it', () => {
  const hub = createEventHub();
  const router = collect();
  const app = collect();
  hub.subscribe(router.listener, { only: ['navigate'] });
  hub.subscribe(app.listener);
  const nav = { type: 'navigate', payload: { to: 'settings.ai' } };
  hub.emit(nav);
  assert.deepEqual([router.heard, app.heard], [[nav], [nav]]);
  const late = collect();
  hub.subscribe(late.listener, { only: ['navigate'] });
  assert.deepEqual(late.heard, [], 'it was delivered live, not held');
});

test('held navigate events are bounded, and a throwing replay hands the rest back', () => {
  const hub = createEventHub();
  for (let n = 0; n < 15; n += 1) hub.emit({ type: 'navigate', payload: n });
  let seen = 0;
  assert.throws(() =>
    hub.subscribe(
      () => {
        seen += 1;
        if (seen === 2) throw new Error('boom');
      },
      { only: ['navigate'] },
    ),
  );
  const next = collect();
  hub.subscribe(next.listener, { only: ['navigate'] });
  assert.equal(next.heard.length, 8, '10 held, 2 delivered to the one that threw');
});

test('the boot order: the app subscribes plain first, navigate arrives, then the router names it and gets it', () => {
  const hub = createEventHub();
  const app = collect();
  hub.subscribe(app.listener);
  const nav = { type: 'navigate', payload: { to: 'settings.ai' } };
  hub.emit(nav);
  assert.deepEqual(app.heard, [nav], 'heard live');
  const router = collect();
  hub.subscribe(router.listener, { only: ['navigate'] });
  assert.deepEqual(router.heard, [nav], 'and still held for the one that names it');
});
