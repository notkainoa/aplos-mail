import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MessageChannel } from 'node:worker_threads';
import type { Frame } from '@aplos/contract';
import type { EngineSession } from '@aplos/contract/client';
import { windowCaller } from '@aplos/engine';
import {
  MAX_WINDOW_MESSAGE_BYTES,
  blobRoutes,
  createPortClient,
  messageBytes,
  serveWindowPort,
  type PortMessage,
} from '../../src/host/transports/port';
import { composeEngineHost } from '../../src/host/compose';
import { dataDir, engineEndOf, fakeClock, T0, testOptions, until, windowEndOf } from './rig';

const position = () => ({ dbEpoch: 'e1', seq: 9 });
const big = (bytes: number) => 'x'.repeat(bytes);

/** Serves a window over a real channel and records every message the engine side posts to it. */
function served(t: test.TestContext, session: EngineSession) {
  const { port1, port2 } = new MessageChannel();
  t.after(() => {
    port1.close();
    port2.close();
  });
  const sent: PortMessage[] = [];
  const end = engineEndOf(port1);
  const recording = {
    ...end,
    post: (message: PortMessage) => (sent.push(message), end.post(message)),
  };
  const drops: string[] = [];
  serveWindowPort(() => session, recording, {
    position,
    onDrop: (reason, what) => drops.push(`${reason}:${what}`),
  });
  const client = createPortClient();
  client.attach(windowEndOf(port2));
  const frames: Frame[] = [];
  client.subscribe(frame => frames.push(frame as Frame));
  return { client, sent, drops, frames };
}

/** No message the engine side posted is over 256 KB unless it answers a blob route. */
function assertWithinBudget(sent: PortMessage[], blobIds: ReadonlySet<number> = new Set()) {
  for (const message of sent) {
    if (message.kind === 'reply' && blobIds.has(message.id)) continue;
    const size = messageBytes(message);
    assert.ok(
      size <= MAX_WINDOW_MESSAGE_BYTES,
      `a ${message.kind} of ${size} bytes left the engine`,
    );
  }
}

function sessionAnswering(answer: (method: string) => unknown) {
  const listeners = new Set<(frame: Frame) => void>();
  const session: EngineSession = {
    call: async method => answer(method),
    subscribe: listener => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    close: () => listeners.clear(),
  };
  return { session, push: (frame: Frame) => listeners.forEach(listener => listener(frame)) };
}

test('messageBytes counts UTF-8 text and binary bytes', () => {
  assert.equal(messageBytes('é'), 4); // "é" with its quotes: 2 + 2
  assert.equal(messageBytes({ b: new Uint8Array(1000) }), messageBytes({ b: 0 }) + 1000);
  assert.equal(messageBytes({ a: 1n }), Number.POSITIVE_INFINITY);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.equal(messageBytes(cycle), Number.POSITIVE_INFINITY);
});

test('payload: a reply over 256 KB never reaches a window outside blob routes', async t => {
  const engine = sessionAnswering(() => ({ list: [{ id: 't1', snippet: big(300 * 1024) }] }));
  const w = served(t, engine.session);
  await assert.rejects(w.client.call('Thread/get', { ids: ['t1'] }), { type: 'tooLarge' });
  // Multi-byte text counts by its UTF-8 size: 100,000 three-byte characters are about 300 KB.
  const wide = sessionAnswering(() => ({ text: '€'.repeat(100_000) }));
  const w2 = served(t, wide.session);
  await assert.rejects(w2.client.call('Thread/get', { ids: ['t1'] }), { type: 'tooLarge' });
  assertWithinBudget(w.sent);
  assertWithinBudget(w2.sent);
  assert.deepEqual(w.drops, ['tooLarge:Thread/get']);
});

test('payload: a frame over 256 KB is replaced by a reset at the same position', async t => {
  const engine = sessionAnswering(() => ({}));
  const w = served(t, engine.session);
  const progress: Frame = {
    frame: 'progress',
    dbEpoch: 'e1',
    seq: 12,
    runId: 'r1',
    source: 'ask',
    kind: 'text',
    delta: '€'.repeat(100_000),
  };
  engine.push(progress);
  await until(() => w.frames.length === 1, 'the replacement frame');
  assert.deepEqual(w.frames[0], {
    frame: 'reset',
    dbEpoch: 'e1',
    seq: 12,
    reason: 'cannotCalculateChanges',
  });
  assertWithinBudget(w.sent);
});

test('payload: a blob route carries its bytes, binary and over 256 KB', async t => {
  assert.ok(blobRoutes.has('Blob/get'));
  const bytes = new Uint8Array(1024 * 1024).fill(1);
  const engine = sessionAnswering(() => ({ bytes, mime: 'application/pdf', size: bytes.length }));
  const w = served(t, engine.session);
  const reply = (await w.client.call('Blob/get', { blobId: 'b1' })) as { bytes: Uint8Array };
  assert.ok(reply.bytes instanceof Uint8Array);
  assert.equal(reply.bytes.byteLength, bytes.byteLength);
  const blobReplies = new Set(w.sent.flatMap(m => (m.kind === 'reply' ? [m.id] : [])));
  assertWithinBudget(w.sent, blobReplies);
});

test('payload: real engine traffic over a window port stays under 256 KB', async t => {
  const dir = dataDir(t);
  const clock = fakeClock(T0);
  const bridge = { power: new EventEmitter(), request: async () => 'posted' };
  const host = await composeEngineHost(await testOptions(dir, clock)({}, bridge));
  t.after(() => host.close());
  const store = host.engine.services.store;
  const { port1, port2 } = new MessageChannel();
  t.after(() => {
    port1.close();
    port2.close();
  });
  const sent: PortMessage[] = [];
  const end = engineEndOf(port1);
  serveWindowPort(
    () => host.engine.connect(windowCaller),
    { ...end, post: message => (sent.push(message), end.post(message)) },
    { position: () => ({ dbEpoch: store.dbEpoch, seq: store.seq() }) },
  );
  const client = createPortClient();
  client.attach(windowEndOf(port2));
  await client.call('Demo/load', {});
  await clock.advance(500);
  const win = (await client.call('View/watch', { spec: { kind: 'mailbox', role: 'inbox' } })) as {
    ids: string[];
  };
  assert.ok(win.ids.length > 0, 'the demo inbox has threads');
  await client.call('Thread/get', { ids: win.ids });
  await client.call('Counts/get', {});
  await client.call('Draft/get', { ids: ['no-such-draft'] });
  await clock.advance(500);
  assert.ok(sent.length > 5);
  assertWithinBudget(sent);
});
