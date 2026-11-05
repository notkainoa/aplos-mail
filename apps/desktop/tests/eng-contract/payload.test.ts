import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { MessageChannel } from 'node:worker_threads';
import type { Frame } from '@aplos/contract';
import type { EngineSession } from '@aplos/contract/client';
import { windowCaller } from '@aplos/engine';
import {
  MAX_ARGS_BYTES,
  MAX_BLOB_MESSAGE_BYTES,
  MAX_MEASURED_NODES,
  MAX_WINDOW_MESSAGE_BYTES,
  MAX_WINDOW_NODES,
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

test('messageBytes measures what the structured clone carries, not what toJSON shows', () => {
  // JSON.stringify turns a Map or a Set into `{}`; the structured clone carries every entry.
  const text = big(MAX_ARGS_BYTES);
  assert.ok(messageBytes({ m: new Map([['k', text]]) }) > MAX_ARGS_BYTES, 'a Map’s values count');
  assert.ok(messageBytes({ m: new Map([[text, 1]]) }) > MAX_ARGS_BYTES, 'a Map’s keys count');
  assert.ok(messageBytes({ s: new Set([text]) }) > MAX_ARGS_BYTES, 'a Set’s entries count');
  assert.ok(messageBytes({ r: new RegExp(text) }) > MAX_ARGS_BYTES, 'a RegExp’s source counts');
  assert.ok(messageBytes({ e: new Error(text) }) > MAX_ARGS_BYTES, 'an Error’s message counts');
  // A Node Buffer is its bytes, not `{"type":"Buffer","data":[...]}` (about 3.5 times larger).
  const envelope = messageBytes({ bytes: 0 });
  assert.equal(messageBytes({ bytes: Buffer.alloc(1000) }), envelope + 1000);
  assert.equal(messageBytes({ bytes: new ArrayBuffer(1000) }), envelope + 1000);
  assert.equal(messageBytes({ bytes: new DataView(new ArrayBuffer(1000)) }), envelope + 1000);
  // A Date still counts as its JSON text.
  assert.equal(messageBytes(new Date(0)), JSON.stringify(new Date(0)).length);
});

/** Runs `measure` and returns its result and how long it took. */
function timed<T>(measure: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = measure();
  return { value, ms: performance.now() - start };
}

test('messageBytes: a self-containing Map or Set of 100,000 entries is refused at once, without exhausting memory', () => {
  const map = new Map<unknown, unknown>();
  const set = new Set<unknown>();
  for (let i = 0; i < 100_000; i++) {
    map.set(i, map);
    set.add([set]);
  }
  for (const value of [{ m: map }, { s: set }, map, set]) {
    const run = timed(() => messageBytes(value, MAX_ARGS_BYTES));
    assert.equal(run.value, Number.POSITIVE_INFINITY);
    assert.ok(run.ms < 200, `measured in ${run.ms.toFixed(0)} ms`);
  }
});

test('messageBytes: shared children are counted once, so a deep DAG returns at once', () => {
  let nested: unknown[] = [];
  for (let depth = 0; depth < 30; depth++) nested = [nested, nested];
  const run = timed(() => messageBytes(nested, MAX_ARGS_BYTES));
  assert.ok(run.value < 1000, `${run.value} bytes`);
  assert.ok(run.ms < 200, `measured in ${run.ms.toFixed(0)} ms`);
  const child = { text: big(100) };
  const dag = { a: child, b: child, c: [child, child] };
  assert.ok(messageBytes(dag) < messageBytes({ a: child, b: { text: big(100) } }) + 20);
});

test('messageBytes: cycles in plain objects and arrays are refused without hanging', () => {
  const object: Record<string, unknown> = { a: 1 };
  object.deep = { again: [object] };
  const array: unknown[] = [1];
  array.push([array]);
  const error = new Error('x');
  error.cause = error;
  for (const value of [object, array, error]) {
    const run = timed(() => messageBytes(value));
    assert.equal(run.value, Number.POSITIVE_INFINITY);
    assert.ok(run.ms < 200);
  }
});

test('messageBytes: a huge sparse array or too many nodes is refused at once', () => {
  const sparse: unknown[] = [];
  sparse.length = 1_000_000_000;
  const run = timed(() => messageBytes({ sparse }));
  assert.equal(run.value, Number.POSITIVE_INFINITY);
  assert.ok(run.ms < 200, `measured in ${run.ms.toFixed(0)} ms`);
  assert.equal(messageBytes(new Array(2_000_000).fill(0)), Number.POSITIVE_INFINITY);
  const entries = Array.from({ length: MAX_MEASURED_NODES }, (_, i) => i);
  assert.equal(messageBytes(new Set(entries)), Number.POSITIVE_INFINITY, 'a Set past the budget');
  const pairs = entries.slice(0, MAX_MEASURED_NODES / 2 + 1).map(i => [i, 0] as const);
  assert.equal(messageBytes(new Map(pairs)), Number.POSITIVE_INFINITY, 'a Map past the budget');
});

test('messageBytes: a boxed String, Number or Boolean is a leaf measured by its value, at once', () => {
  const run = timed(() => messageBytes({ s: new String('x'.repeat(8_000_000)) }, MAX_ARGS_BYTES));
  assert.equal(run.value, Number.POSITIVE_INFINITY);
  assert.ok(run.ms < 100, `measured in ${run.ms.toFixed(0)} ms`);
  // A string longer than the room left is refused before it is copied or scanned.
  const huge = 'x'.repeat(100_000_000);
  const plain = timed(() => messageBytes({ html: huge }, MAX_ARGS_BYTES));
  assert.equal(plain.value, Number.POSITIVE_INFINITY);
  assert.ok(plain.ms < 50, `a 100M-character string measured in ${plain.ms.toFixed(0)} ms`);
  assert.equal(messageBytes(new String('é')), 4);
  assert.equal(messageBytes(new Number(42)), 2);
  assert.equal(messageBytes(new Boolean(false)), 5);
  assert.equal(messageBytes(Object(1n)), Number.POSITIVE_INFINITY);
});

test('messageBytes: a view counts its whole buffer, and a buffer shared by two views counts once', () => {
  const view = new Uint8Array(new ArrayBuffer(50_000_000), 0, 1);
  assert.equal(messageBytes({ bytes: view }, MAX_BLOB_MESSAGE_BYTES), Number.POSITIVE_INFINITY);
  const buffer = new ArrayBuffer(1000);
  const envelope = messageBytes({ a: 0, b: 0, c: 0 });
  const shared = { a: new Uint8Array(buffer), b: new DataView(buffer), c: buffer };
  assert.equal(messageBytes(shared), envelope + 1000);
});

test('messageBytes: named properties on an array count', () => {
  const list: unknown[] & { foo?: string } = [1, 2];
  list.foo = 'y'.repeat(MAX_ARGS_BYTES);
  assert.equal(messageBytes({ list }, MAX_ARGS_BYTES), Number.POSITIVE_INFINITY);
  // A plain array still measures exactly as JSON.
  assert.equal(messageBytes([1, 2]), 5);
});

test('messageBytes stops reading as soon as the total passes the limit', () => {
  let reads = 0;
  const item = () => ({
    get text() {
      reads++;
      return 'x'.repeat(100);
    },
  });
  const list = Array.from({ length: 1000 }, item);
  assert.equal(messageBytes(list, 500), Number.POSITIVE_INFINITY);
  assert.ok(reads < 30, `${reads} values read`);
});

test('messageBytes: a normal message measures exactly its JSON text in UTF-8, as before', () => {
  const samples: unknown[] = [
    { kind: 'reply', id: 7, ok: true, result: { list: [{ id: 't1', subject: 'Hi', n: -0.5 }] } },
    { text: 'é € 😀 "quoted" back\\slash \n\t\u0001 \ud800 lone', empty: '', zero: 0 },
    { skip: undefined, fn: () => 1, keep: null, list: [undefined, () => 1, null, true, false] },
    [1e21, -0, Number.NaN, Number.POSITIVE_INFINITY, 1.5e-7],
    { when: new Date(0), nested: { a: [{ b: [{ c: 'd' }] }] } },
    'just a string',
    42,
    null,
    [],
    {},
  ];
  for (const sample of samples)
    assert.equal(
      messageBytes(sample),
      Buffer.byteLength(JSON.stringify(sample), 'utf8'),
      JSON.stringify(sample),
    );
  assert.equal(messageBytes(undefined), 0);
});

test('every caller stops measuring at its own cap: engine dispatch, engine replies, preload', async () => {
  let reads = 0;
  // Getters count how far a measure reads; each item is about 110 bytes, 100,000 of them about 11 MB.
  const items = () =>
    Array.from({ length: 100_000 }, () => ({
      get text() {
        reads++;
        return 'x'.repeat(100);
      },
    }));
  const posted: PortMessage[] = [];
  let deliver: (data: unknown) => void = () => undefined;
  const end = {
    post: (message: PortMessage) => void posted.push(message),
    onMessage: (handler: (data: unknown) => void) => void (deliver = handler),
    onClose: () => undefined,
    close: () => undefined,
  };
  const replying = sessionAnswering(() => ({ list: items() }));
  serveWindowPort(() => replying.session, end, { position });
  // Dispatch: arguments over MAX_ARGS_BYTES (4 MB) are refused after reading about 4 MB of them.
  deliver({ v: 1, id: 1, method: 'Draft/set', args: { list: items() } });
  const refused = posted.at(-1);
  assert.equal(refused?.kind === 'reply' && !refused.ok && refused.error.type, 'tooLarge');
  assert.ok(reads < 100_000, `dispatch read ${reads} values`);
  // A reply over 256 KB is refused after reading about 256 KB of it.
  reads = 0;
  deliver({ v: 1, id: 2, method: 'Counts/get', args: {} });
  await until(() => posted.length === 3, 'the reply to be refused');
  assert.ok(reads < 10_000, `the reply check read ${reads} values`);
  // Preload: refused before posting, after reading about 4 MB.
  reads = 0;
  const client = createPortClient();
  await assert.rejects(client.call('Draft/set', { list: items() }), { type: 'tooLarge' });
  assert.ok(reads < 100_000, `preload read ${reads} values`);
});

test('payload: a self-containing Map posted raw is refused tooLarge and the engine keeps serving', async t => {
  const engine = sessionAnswering(method => ({ method }));
  const { port1, port2 } = new MessageChannel();
  t.after(() => {
    port1.close();
    port2.close();
  });
  serveWindowPort(() => engine.session, engineEndOf(port1), { position });
  const replies: PortMessage[] = [];
  port2.on('message', message => replies.push(message));
  const map = new Map<unknown, unknown>();
  for (let i = 0; i < 100_000; i++) map.set(i, map);
  port2.postMessage({ v: 1, id: 1, method: 'Draft/set', args: { m: map } });
  port2.postMessage({ v: 1, id: 2, method: 'Counts/get', args: {} });
  await until(() => replies.length === 3, 'the hello and two answers', 2000);
  const errorOf = (message: PortMessage) =>
    message.kind === 'reply' && !message.ok ? message.error.type : 'ok';
  assert.deepEqual(replies.slice(1).map(errorOf), ['tooLarge', 'ok']);
});

test('payload: a Map or Set over the argument cap is refused; a Buffer is measured by its bytes', async t => {
  const engine = sessionAnswering(method => ({ method }));
  const { port1, port2 } = new MessageChannel();
  t.after(() => {
    port1.close();
    port2.close();
  });
  serveWindowPort(() => engine.session, engineEndOf(port1), { position });
  const replies: PortMessage[] = [];
  port2.on('message', message => replies.push(message));
  const text = big(MAX_ARGS_BYTES);
  // A page past preload posts raw envelopes: the engine side must still see the Map's and the Set's content.
  port2.postMessage({ v: 1, id: 1, method: 'Draft/set', args: { m: new Map([['k', text]]) } });
  port2.postMessage({ v: 1, id: 2, method: 'Draft/set', args: { s: new Set([text]) } });
  port2.postMessage({ v: 1, id: 3, method: 'Draft/set', args: { m: new Map([['k', 'small']]) } });
  await until(() => replies.length === 4, 'the hello and three answers');
  const errorOf = (message: PortMessage) =>
    message.kind === 'reply' && !message.ok ? message.error.type : 'ok';
  assert.deepEqual(replies.slice(1).map(errorOf), ['tooLarge', 'tooLarge', 'ok']);

  // A Blob/get reply carrying a Node Buffer: just under the blob cap goes out, just over it is refused.
  let size = 0;
  const blob = sessionAnswering(() => ({ bytes: Buffer.alloc(size), mime: 'application/pdf' }));
  const w = served(t, blob.session);
  const envelope = (id: number) =>
    messageBytes({ kind: 'reply', id, ok: true, result: { bytes: 0, mime: 'application/pdf' } });
  size = MAX_BLOB_MESSAGE_BYTES - envelope(1);
  const reply = (await w.client.call('Blob/get', { blobId: 'b1' })) as { bytes: Uint8Array };
  assert.equal(reply.bytes.byteLength, size);
  size = MAX_BLOB_MESSAGE_BYTES - envelope(2) + 1;
  await assert.rejects(w.client.call('Blob/get', { blobId: 'b1' }), { type: 'tooLarge' });
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

// ---------------------------------------------------------------- the two LOWs of the final Opus check (LOW-A, LOW-B)

test('window arguments are measured with a node bound of MAX_WINDOW_NODES: more values than that are refused, however few bytes they are', () => {
  const some = { many: Array.from({ length: MAX_WINDOW_NODES + 1 }, () => ({})) };
  assert.ok(
    Number.isFinite(messageBytes(some)),
    'the default bound (a reply from the engine) allows it',
  );
  assert.equal(messageBytes(some, MAX_ARGS_BYTES, MAX_WINDOW_NODES), Number.POSITIVE_INFINITY);
  const million = { many: Array.from({ length: 1_000_000 }, () => ({})) };
  assert.equal(messageBytes(million, MAX_ARGS_BYTES, MAX_WINDOW_NODES), Number.POSITIVE_INFINITY);
  // A sparse array is refused on its length (4 bytes a hole, and past MAX_MEASURED_NODES at once) without being walked.
  const sparse: unknown[] = [];
  sparse[1_999_990] = 0;
  assert.equal(
    messageBytes({ sparse }, MAX_ARGS_BYTES, MAX_WINDOW_NODES),
    Number.POSITIVE_INFINITY,
  );
  // A legitimate call (hundreds of values) is unaffected.
  const fine = { ids: Array.from({ length: 500 }, (_, i) => `t${i}`), n: 1 };
  assert.ok(messageBytes(fine, MAX_ARGS_BYTES, MAX_WINDOW_NODES) < 5_000);
  assert.equal(MAX_WINDOW_NODES, 100_000);
});

test('a key longer than the bytes still allowed is refused before it is stringified', () => {
  // Deterministic: no key (or anything else) longer than the cap may ever reach JSON.stringify while measuring.
  const realStringify = JSON.stringify;
  let longest = 0;
  JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
    if (typeof value === 'string') longest = Math.max(longest, value.length);
    return (realStringify as (...a: unknown[]) => string)(value, ...rest);
  }) as typeof JSON.stringify;
  try {
    const huge = { ['x'.repeat(1e8)]: 0 };
    assert.equal(messageBytes(huge, MAX_ARGS_BYTES, MAX_WINDOW_NODES), Number.POSITIVE_INFINITY);
    const keys: Record<string, number> = {};
    for (let i = 0; i < 100; i++) keys[`${i}${'k'.repeat(1_000_000)}`] = i;
    assert.equal(messageBytes(keys, MAX_ARGS_BYTES, MAX_WINDOW_NODES), Number.POSITIVE_INFINITY);
  } finally {
    JSON.stringify = realStringify;
  }
  assert.ok(longest <= MAX_ARGS_BYTES, `a key of ${longest} characters was stringified`);
  // A key that fits still measures exactly as JSON writes it.
  assert.equal(messageBytes({ ab: 1 }, 1000), JSON.stringify({ ab: 1 }).length);
  assert.equal(
    messageBytes({ ['é'.repeat(3)]: [] }, 1000),
    Buffer.byteLength(JSON.stringify({ ['é'.repeat(3)]: [] })),
  );
});

test('payload: a window message with more than MAX_WINDOW_NODES values is refused tooLarge at the port, and the engine keeps serving', async t => {
  const engine = sessionAnswering(method => ({ method }));
  const { port1, port2 } = new MessageChannel();
  t.after(() => {
    port1.close();
    port2.close();
  });
  serveWindowPort(() => engine.session, engineEndOf(port1), { position });
  const replies: PortMessage[] = [];
  port2.on('message', message => replies.push(message));
  // Under the byte cap (about 450 KB), over the value bound.
  const many = Array.from({ length: MAX_WINDOW_NODES + 1 }, () => ({}));
  port2.postMessage({ v: 1, id: 1, method: 'Draft/set', args: { many } });
  port2.postMessage({ v: 1, id: 2, method: 'Counts/get', args: {} });
  await until(() => replies.length === 3, 'the hello and two answers', 2000);
  const errorOf = (message: PortMessage) =>
    message.kind === 'reply' && !message.ok ? message.error.type : 'ok';
  assert.deepEqual(replies.slice(1).map(errorOf), ['tooLarge', 'ok']);
});

// ---------------------------------------------------------------- the two LOWs of the #201 review (sparse holes, upload text)

test('a hole in an array costs 4 bytes and no entry, so a sparse array is counted by its length, never walked', () => {
  const sparse: unknown[] = [];
  sparse[99_990] = 0;
  // Room for the slots: the length must fit the node bound, but the holes are not walked or counted as entries.
  const size = messageBytes({ sparse }, MAX_ARGS_BYTES, MAX_WINDOW_NODES);
  assert.equal(size, Buffer.byteLength(JSON.stringify({ sparse })), 'a hole is JSON null');
  // The slots still count as bytes: a sparse array cannot hide behind its few real values.
  const wide: unknown[] = [];
  wide[MAX_WINDOW_NODES - 1] = 0;
  assert.ok(messageBytes({ wide }, 600_000, MAX_WINDOW_NODES + 10) < 600_000);
  assert.equal(
    messageBytes({ wide }, 400_000, MAX_WINDOW_NODES + 10),
    Number.POSITIVE_INFINITY,
    '4 bytes a hole',
  );
  // A length past the bound is refused on the length alone, before any slot is read.
  const huge = new Array(1_000_000_000);
  assert.equal(messageBytes({ huge }, MAX_ARGS_BYTES, MAX_WINDOW_NODES), Number.POSITIVE_INFINITY);
  // An array longer than the room left is refused on its length before any key is built, dense or not (a 600,000
  // zeros array used to cost 60 ms and 35 MB of keys before the refusal).
  let keyed = 0;
  const longRun = new Proxy(new Array<number>(600_000).fill(0), {
    ownKeys: target => (keyed++, Reflect.ownKeys(target)),
  });
  assert.equal(
    messageBytes({ longRun }, MAX_ARGS_BYTES, MAX_WINDOW_NODES),
    Number.POSITIVE_INFINITY,
  );
  assert.equal(keyed, 0, 'no key of the long array was listed');
  // Named properties on a sparse array are still found and counted.
  const named: unknown[] & { note?: string } = [];
  named[5] = 1;
  named.note = 'y'.repeat(MAX_ARGS_BYTES);
  assert.equal(messageBytes({ named }, MAX_ARGS_BYTES, 10), Number.POSITIVE_INFINITY);
});

test('a text limit holds everything except binary payloads: an upload’s big allowance is for its bytes only', () => {
  const upload = (extra: Record<string, unknown>, bytes = 1000) => ({
    bytes: new Uint8Array(bytes),
    mime: 'audio/webm',
    ...extra,
  });
  const measureUpload = (value: unknown) =>
    messageBytes(value, MAX_BLOB_MESSAGE_BYTES, MAX_WINDOW_NODES, MAX_ARGS_BYTES);
  // Bytes use the whole allowance...
  const full = upload({}, 25 * 1024 * 1024);
  assert.equal(measureUpload(full), messageBytes(full));
  // ...text does not: a long string value, a long key, a boxed string, and the same inside a Map.
  const inf = Number.POSITIVE_INFINITY;
  assert.equal(measureUpload(upload({ mime: big(MAX_ARGS_BYTES) })), inf);
  assert.equal(measureUpload(upload({ ['k'.repeat(MAX_ARGS_BYTES)]: 1 })), inf);
  assert.equal(measureUpload(upload({ note: new String(big(MAX_ARGS_BYTES)) })), inf);
  assert.equal(measureUpload(upload({ m: new Map([['k', big(MAX_ARGS_BYTES)]]) })), inf);
  // Text and bytes are counted apart: 3 MB of text next to 20 MB of bytes is fine, 5 MB of text is not.
  assert.ok(Number.isFinite(measureUpload(upload({ n: big(3_000_000) }, 20_000_000))));
  assert.equal(measureUpload(upload({ n: big(5_000_000) }, 20_000_000)), inf);
  // The default text limit is the limit itself, so every other caller measures as before.
  assert.ok(Number.isFinite(messageBytes(upload({ n: big(5_000_000) }), MAX_BLOB_MESSAGE_BYTES)));
});

test('Blob/put: text in the arguments is held to MAX_ARGS_BYTES at the port, and its bytes still pass', async t => {
  const calls: string[] = [];
  const engine = sessionAnswering(method => (calls.push(method), {}));
  const { port1, port2 } = new MessageChannel();
  t.after(() => {
    port1.close();
    port2.close();
  });
  serveWindowPort(() => engine.session, engineEndOf(port1), { position });
  const replies: PortMessage[] = [];
  port2.on('message', message => replies.push(message));
  const bytes = new Uint8Array(MAX_ARGS_BYTES + 1);
  const mime = big(MAX_ARGS_BYTES + 1);
  port2.postMessage({ v: 1, id: 1, method: 'Blob/put', args: { bytes, mime: 'audio/webm' } });
  port2.postMessage({ v: 1, id: 2, method: 'Blob/put', args: { bytes: new Uint8Array(8), mime } });
  await until(() => replies.length === 3, 'the hello and two answers', 2000);
  const errorOf = (message: PortMessage) =>
    message.kind === 'reply' && !message.ok ? message.error.type : 'ok';
  assert.deepEqual(replies.slice(1).map(errorOf), ['ok', 'tooLarge']);
  assert.deepEqual(calls, ['Blob/put'], 'the text-heavy upload never reached the engine');
});

test(
  'Blob/put: the window’s own client refuses text past MAX_ARGS_BYTES before the port copies it',
  { timeout: 5000 },
  async t => {
    const { port1, port2 } = new MessageChannel();
    t.after(() => {
      port1.close();
      port2.close();
    });
    const client = createPortClient();
    client.attach(windowEndOf(port2));
    const args = { bytes: new Uint8Array(8), mime: big(MAX_ARGS_BYTES + 1) };
    await assert.rejects(client.call('Blob/put', args), { type: 'tooLarge' });
  },
);
