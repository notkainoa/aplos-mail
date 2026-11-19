// The new roots' answer to main's prepare-close (closeHandshake.ts), with fakes.
// Run: cd apps/desktop && npx tsx --test src/renderer/shell/closeHandshake.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  answerPrepareClose,
  FORCE_CLOSE_MS,
  HELD_MESSAGE,
  type CloseBridge,
  type SaveResult,
} from './closeHandshake';

type Listener = Parameters<CloseBridge['subscribe']>[0];

function fakeBridge() {
  const listeners = new Set<Listener>();
  const options: unknown[] = [];
  const bridge: CloseBridge = {
    subscribe(listener, opts) {
      listeners.add(listener);
      options.push(opts);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const send = (type: string) => {
    for (const listener of [...listeners]) listener({ type });
  };
  return { bridge, send, options, count: () => listeners.size };
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

/** One window's answer with a scripted save result, a clock and a log of what happened. */
function rig(results: Array<SaveResult | 'throw'>, failReady = false) {
  const fake = fakeBridge();
  const calls: string[] = [];
  let clock = 0;
  const queue = [...results];
  answerPrepareClose(fake.bridge, {
    save: async () => {
      calls.push('save');
      const next = queue.shift() ?? 'saved';
      if (next === 'throw') throw new Error('engine down');
      return next;
    },
    ready: async () => {
      calls.push('ready');
      if (failReady) throw new Error('main refused');
    },
    cancel: async () => void calls.push('cancel'),
    notify: message => void calls.push(`notify:${message}`),
    now: () => clock,
  });
  return {
    fake,
    calls,
    close: async () => {
      fake.send('prepare-close');
      await tick();
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test('prepare-close saves, then answers closeReady once; other events are ignored', async () => {
  const r = rig(['saved']);
  assert.deepEqual(r.fake.options, [{ only: ['prepare-close'] }]);
  r.fake.send('deep-link');
  r.fake.send('prepare-close');
  r.fake.send('prepare-close');
  await tick();
  assert.deepEqual(r.calls, ['save', 'ready']);
});

test('text that could not be saved keeps the window open: cancel and a notice, never closeReady', async () => {
  const r = rig(['unsaved']);
  await r.close();
  assert.deepEqual(r.calls, ['save', `notify:${HELD_MESSAGE}`, 'cancel']);
});

test('a save that throws counts as unsaved', async () => {
  const r = rig(['throw']);
  await r.close();
  assert.deepEqual(r.calls, ['save', `notify:${HELD_MESSAGE}`, 'cancel']);
});

test("a second close within the window is the owner's choice and closes; later it saves again", async () => {
  const r = rig(['unsaved', 'unsaved', 'saved']);
  await r.close();
  r.calls.length = 0;
  r.advance(FORCE_CLOSE_MS - 1);
  await r.close();
  assert.deepEqual(r.calls, ['ready']);
  r.calls.length = 0;
  await r.close();
  assert.deepEqual(r.calls, ['save', `notify:${HELD_MESSAGE}`, 'cancel']);
  r.calls.length = 0;
  r.advance(FORCE_CLOSE_MS + 1);
  await r.close();
  assert.deepEqual(r.calls, ['save', 'ready']);
});

test('a failing closeReady answers cancel so the window is never left disabled', async () => {
  const r = rig(['saved'], true);
  await r.close();
  assert.deepEqual(r.calls, ['save', 'ready', 'cancel']);
});

test('no bridge subscribes nothing, and the returned function unsubscribes', () => {
  const deps = {
    save: async () => 'saved' as const,
    ready: async () => undefined,
    cancel: async () => undefined,
    notify: () => undefined,
  };
  const none = answerPrepareClose(undefined, deps);
  assert.equal(typeof none, 'function');
  const fake = fakeBridge();
  const stop = answerPrepareClose(fake.bridge, deps);
  assert.equal(fake.count(), 1);
  stop();
  assert.equal(fake.count(), 0);
});
