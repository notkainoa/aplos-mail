import assert from 'node:assert/strict';
import test from 'node:test';
import { createEventHub } from '../../shared/event-hub';
import {
  answerClose,
  listenPrepareClose,
  registerCloseGuard,
  type CloseGuard,
  type PrepareCloseBridge,
} from './closeHandshake';

function bridge() {
  let listener: ((event: { type: string; payload?: unknown }) => void) | undefined;
  let offs = 0;
  const api: PrepareCloseBridge = {
    subscribe(l) {
      listener = l;
      return () => {
        offs += 1;
        listener = undefined;
      };
    },
  };
  return {
    api,
    send: (type: string) => listener?.({ type }),
    offs: () => offs,
  };
}

/** Collects every answer a mounted listener makes. */
function collector() {
  const answers: string[] = [];
  return { answers, answer: (a: string) => void answers.push(a) };
}

const flush = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

test('a prepare-close with no guards answers ready, once', async () => {
  const b = bridge();
  const { answers, answer } = collector();
  listenPrepareClose(b.api, answer);
  b.send('prepare-close');
  await flush();
  assert.deepEqual(answers, ['ready']);
});

test('guards that all resolve true answer ready', async () => {
  const b = bridge();
  const { answers, answer } = collector();
  const guards: CloseGuard[] = [() => true, async () => true];
  listenPrepareClose(b.api, answer, { guards });
  b.send('prepare-close');
  await flush();
  assert.deepEqual(answers, ['ready']);
});

test('one false, throwing or timed-out guard answers cancel', async () => {
  for (const guard of [
    () => false,
    () => {
      throw new Error('save failed');
    },
    async () => {
      throw new Error('save failed');
    },
  ]) {
    const b = bridge();
    const { answers, answer } = collector();
    listenPrepareClose(b.api, answer, { guards: [() => true, guard] });
    b.send('prepare-close');
    await flush();
    assert.deepEqual(answers, ['cancel']);
  }
  const b = bridge();
  const { answers, answer } = collector();
  listenPrepareClose(b.api, answer, {
    guards: [() => new Promise<boolean>(() => undefined)],
    guardTimeoutMs: 5,
  });
  b.send('prepare-close');
  await flush(30);
  assert.deepEqual(answers, ['cancel']);
});

test('registered guards run, and unregistering removes them', async () => {
  const b = bridge();
  const { answers, answer } = collector();
  let safe = false;
  const off = registerCloseGuard(() => safe);
  listenPrepareClose(b.api, answer);
  b.send('prepare-close');
  await flush();
  safe = true;
  b.send('prepare-close');
  await flush();
  off();
  b.send('prepare-close');
  await flush();
  assert.deepEqual(answers, ['cancel', 'ready', 'ready']);
});

test('a second prepare-close while one is in flight is ignored', async () => {
  const b = bridge();
  const { answers, answer } = collector();
  let release: (safe: boolean) => void = () => undefined;
  const hold: CloseGuard = () => new Promise<boolean>(resolve => (release = resolve));
  listenPrepareClose(b.api, answer, { guards: [hold] });
  b.send('prepare-close');
  b.send('prepare-close');
  release(true);
  await flush();
  assert.deepEqual(answers, ['ready']);
  // The lock released: a later event gets its own answer.
  b.send('prepare-close');
  release(true);
  await flush();
  assert.deepEqual(answers, ['ready', 'ready']);
});

test('a prepare-close held before the listener mounts is answered exactly once', async () => {
  const hub = createEventHub();
  hub.emit({ type: 'deep-link', payload: 'mailto:a@b.c' });
  hub.emit({ type: 'prepare-close' });
  const { answers, answer } = collector();
  const stop = listenPrepareClose(hub, answer);
  await flush();
  assert.deepEqual(answers, ['ready']);
  hub.emit({ type: 'prepare-close' });
  await flush();
  assert.deepEqual(answers, ['ready', 'ready']);
  stop();
});

test('unsubscribe stops answering, and a kept listener is not answered after off', async () => {
  const b = bridge();
  const { answers, answer } = collector();
  const stop = listenPrepareClose(b.api, answer);
  stop();
  assert.equal(b.offs(), 1);
  b.send('prepare-close');
  await flush();
  assert.deepEqual(answers, []);
  // A real hub behaves the same way.
  const hub = createEventHub();
  const stop2 = listenPrepareClose(hub, answer);
  stop2();
  hub.emit({ type: 'prepare-close' });
  await flush();
  assert.deepEqual(answers, []);
});

test('a rejecting or throwing answer is swallowed', async () => {
  const b = bridge();
  listenPrepareClose(b.api, () => Promise.reject(new Error('gone')));
  b.send('prepare-close');
  await flush();
  const b2 = bridge();
  listenPrepareClose(b2.api, () => {
    throw new Error('gone');
  });
  b2.send('prepare-close');
  await flush();
  // Reaching here without an unhandled rejection or throw is the assertion.
});

test('anything but a prepare-close is ignored', async () => {
  const b = bridge();
  const { answers, answer } = collector();
  listenPrepareClose(b.api, answer);
  for (const type of ['navigate', 'command', 'deep-link', 'mail-key']) b.send(type);
  await flush();
  assert.deepEqual(answers, []);
});

test('no bridge mounts nothing and never throws', () => {
  const off = listenPrepareClose(undefined);
  assert.doesNotThrow(() => off());
  const off2 = listenPrepareClose({} as unknown as PrepareCloseBridge);
  off2();
});

test('answerClose with no bridge resolves quietly', async () => {
  await answerClose('ready');
  await answerClose('cancel');
});
