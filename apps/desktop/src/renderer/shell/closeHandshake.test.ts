// The new roots' answer to main's prepare-close (closeHandshake.ts), with fakes.
// Run: cd apps/desktop && npx tsx --test src/renderer/shell/closeHandshake.test.ts

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerPrepareClose, type CloseBridge } from './closeHandshake';

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

test('prepare-close saves, then answers closeReady once; other events are ignored', async () => {
  const fake = fakeBridge();
  const calls: string[] = [];
  answerPrepareClose(fake.bridge, {
    save: async () => void calls.push('save'),
    stillUnsaved: () => false,
    onUnsaved: () => void calls.push('unsaved'),
    ready: async () => void calls.push('ready'),
    cancel: async () => void calls.push('cancel'),
  });
  assert.deepEqual(fake.options, [{ only: ['prepare-close'] }]);
  fake.send('deep-link');
  fake.send('prepare-close');
  fake.send('prepare-close');
  await tick();
  assert.deepEqual(calls, ['save', 'ready']);
});

test('a failing save still answers ready; a failing ready answers cancel so the window is never left disabled', async () => {
  const fake = fakeBridge();
  const calls: string[] = [];
  let failReady = false;
  answerPrepareClose(fake.bridge, {
    save: async () => {
      calls.push('save');
      throw new Error('engine down');
    },
    stillUnsaved: () => false,
    onUnsaved: () => void calls.push('unsaved'),
    ready: async () => {
      calls.push('ready');
      if (failReady) throw new Error('main refused');
    },
    cancel: async () => void calls.push('cancel'),
  });
  fake.send('prepare-close');
  await tick();
  assert.deepEqual(calls, ['save', 'ready']);
  calls.length = 0;
  failReady = true;
  fake.send('prepare-close');
  await tick();
  assert.deepEqual(calls, ['save', 'ready', 'cancel']);
});

test('no bridge subscribes nothing, and the returned function unsubscribes', () => {
  const none = answerPrepareClose(undefined, {
    save: async () => undefined,
    stillUnsaved: () => false,
    onUnsaved: () => undefined,
    ready: async () => undefined,
    cancel: async () => undefined,
  });
  assert.equal(typeof none, 'function');
  const fake = fakeBridge();
  const stop = answerPrepareClose(fake.bridge, {
    save: async () => undefined,
    stillUnsaved: () => false,
    onUnsaved: () => undefined,
    ready: async () => undefined,
    cancel: async () => undefined,
  });
  assert.equal(fake.count(), 1);
  stop();
  assert.equal(fake.count(), 0);
});

test('still-unsaved text after save cancels the close with a toast, never ready', async () => {
  const fake = fakeBridge();
  const calls: string[] = [];
  answerPrepareClose(fake.bridge, {
    save: async () => void calls.push('save'),
    stillUnsaved: () => true,
    onUnsaved: () => void calls.push('unsaved'),
    ready: async () => void calls.push('ready'),
    cancel: async () => void calls.push('cancel'),
  });
  fake.send('prepare-close');
  await tick();
  assert.deepEqual(calls, ['save', 'unsaved', 'cancel']);
});

test('a failing cancel after still-unsaved never reaches ready and never throws', async () => {
  const fake = fakeBridge();
  const calls: string[] = [];
  answerPrepareClose(fake.bridge, {
    save: async () => void calls.push('save'),
    stillUnsaved: () => true,
    onUnsaved: () => void calls.push('unsaved'),
    ready: async () => void calls.push('ready'),
    cancel: async () => {
      calls.push('cancel');
      throw new Error('main refused');
    },
  });
  fake.send('prepare-close');
  await tick();
  assert.deepEqual(calls, ['save', 'unsaved', 'cancel']);
});
