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

/** The globals `answerClose` may answer through. */
interface AnswerGlobals {
  aplosEngine?: unknown;
  aplos?: { invoke?: unknown };
}

const answerHost = globalThis as AnswerGlobals;

/** Runs `fn` with `stubs` on `globalThis`, restoring whatever was there before even on a throw. */
async function withGlobals(stubs: AnswerGlobals, fn: () => Promise<void>): Promise<void> {
  const saved: AnswerGlobals = { aplosEngine: answerHost.aplosEngine, aplos: answerHost.aplos };
  answerHost.aplosEngine = stubs.aplosEngine;
  answerHost.aplos = stubs.aplos;
  try {
    await fn();
  } finally {
    answerHost.aplosEngine = saved.aplosEngine;
    answerHost.aplos = saved.aplos;
  }
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
  let calls = 0;
  let release: (safe: boolean) => void = () => undefined;
  const hold: CloseGuard = () => {
    calls += 1;
    return new Promise<boolean>(resolve => (release = resolve));
  };
  listenPrepareClose(b.api, answer, { guards: [hold] });
  b.send('prepare-close');
  b.send('prepare-close');
  // The second event never reached the guards.
  assert.equal(calls, 1);
  release(true);
  await flush();
  assert.deepEqual(answers, ['ready']);
  // The lock released: a later event gets its own answer.
  b.send('prepare-close');
  assert.equal(calls, 2);
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

test('an answer owed when unsubscribe lands mid-guard is still sent once the guards settle', async () => {
  const b = bridge();
  const { answers, answer } = collector();
  let release: (safe: boolean) => void = () => undefined;
  const hold: CloseGuard = () => new Promise<boolean>(resolve => (release = resolve));
  const stop = listenPrepareClose(b.api, answer, { guards: [hold] });
  b.send('prepare-close');
  stop();
  assert.equal(b.offs(), 1);
  release(true);
  await flush();
  // StrictMode's first cleanup unsubscribes mid-flight: the held close is still answered.
  assert.deepEqual(answers, ['ready']);
  b.send('prepare-close');
  await flush();
  assert.deepEqual(answers, ['ready']);
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

test('answerClose prefers the engine bridge: Window/closeReady|closeCancel, and never subscribes', async () => {
  const calls: { method: string; args: unknown }[] = [];
  const invokes: string[] = [];
  let subscribes = 0;
  await withGlobals(
    {
      aplosEngine: {
        call: (method: string, args: unknown) => {
          calls.push({ method, args });
          return Promise.resolve({});
        },
        subscribe: () => {
          subscribes += 1;
          return () => undefined;
        },
      },
      aplos: { invoke: (method: string) => void invokes.push(method) },
    },
    async () => {
      await answerClose('ready');
      await answerClose('cancel');
    },
  );
  assert.deepEqual(calls, [
    { method: 'Window/closeReady', args: {} },
    { method: 'Window/closeCancel', args: {} },
  ]);
  assert.equal(subscribes, 0);
  assert.deepEqual(invokes, []);
});

test('answerClose falls back to the legacy invoke when the engine call rejects', async () => {
  const calls: string[] = [];
  const invokes: { method: string; payload: unknown }[] = [];
  await withGlobals(
    {
      aplosEngine: {
        call: (method: string) => {
          calls.push(method);
          return Promise.reject(new Error('refused'));
        },
        subscribe: () => () => undefined,
      },
      aplos: {
        invoke: (method: string, payload?: unknown) => {
          invokes.push({ method, payload });
          return Promise.resolve();
        },
      },
    },
    async () => {
      await answerClose('ready');
      await answerClose('cancel');
    },
  );
  assert.deepEqual(calls, ['Window/closeReady', 'Window/closeCancel']);
  assert.deepEqual(invokes, [
    { method: 'window.closeReady', payload: undefined },
    { method: 'window.closeCancel', payload: undefined },
  ]);
});

test('answerClose with only the legacy invoke calls window.closeReady|closeCancel', async () => {
  const invokes: string[] = [];
  await withGlobals(
    { aplosEngine: undefined, aplos: { invoke: (method: string) => void invokes.push(method) } },
    async () => {
      await answerClose('ready');
      await answerClose('cancel');
    },
  );
  assert.deepEqual(invokes, ['window.closeReady', 'window.closeCancel']);
});

test('answerClose with no bridge resolves quietly', async () => {
  await withGlobals({ aplosEngine: undefined, aplos: undefined }, async () => {
    await answerClose('ready');
    await answerClose('cancel');
  });
  // An `aplos` without an invoke is no bridge either.
  await withGlobals({ aplosEngine: undefined, aplos: {} }, () => answerClose('ready'));
});
