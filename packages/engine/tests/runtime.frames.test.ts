import test from 'node:test';
import assert from 'node:assert/strict';
import { Frame } from '@aplos/contract';
import { STATE_COALESCE_MS } from '../src/index';
import { accountWrite, folderWrites } from './store/helpers';
import { framesOf, testEngine } from './runtime.helpers';

test('commits leave as one coalesced state frame, stamped with dbEpoch and seq', async () => {
  const t = await testEngine();
  try {
    const frames = framesOf(t.engine.connect());
    const store = t.engine.services.store;
    store.commit({ opId: 'a', origin: 'sync', writes: [accountWrite] });
    store.commit({ opId: 'b', origin: 'sync', writes: [...folderWrites] });
    t.clock.advance(STATE_COALESCE_MS - 1);
    assert.equal(frames.length, 0, 'nothing before the coalescing window ends');
    t.clock.advance(1);
    assert.equal(frames.length, 1, 'two commits, one frame');
    const [state] = frames;
    assert.ok(Frame.safeParse(state).success);
    assert.equal(state!.frame, 'state');
    assert.equal(state!.dbEpoch, store.dbEpoch);
    assert.equal(state!.seq, store.seq());
    assert.deepEqual(state!.frame === 'state' && state!.types, { Account: 1, Folder: 2 });
    // A replayed commit lands nothing and sends nothing.
    store.commit({ opId: 'a', origin: 'sync', writes: [accountWrite] });
    t.clock.advance(1_000);
    assert.equal(frames.length, 1);
  } finally {
    await t.cleanup();
  }
});

test('every frame is stamped and one connection never sees seq go backwards', async () => {
  const t = await testEngine();
  try {
    const s = t.engine.connect();
    const frames = framesOf(s);
    const { store, frames: bus } = t.engine.services;
    bus.emit({ frame: 'host', event: { type: 'badge', count: 1 } });
    store.commit({ opId: 'a', origin: 'sync', writes: [accountWrite] });
    bus.emit({ frame: 'host', event: { type: 'badge', count: 2 } });
    t.clock.advance(STATE_COALESCE_MS);
    store.commit({ opId: 'b', origin: 'sync', writes: [...folderWrites] });
    t.clock.advance(STATE_COALESCE_MS);
    bus.reset('restart');
    assert.deepEqual(
      frames.map(f => f.frame),
      ['host', 'host', 'state', 'state', 'reset'],
    );
    let seq = 0;
    for (const f of frames) {
      assert.ok(Frame.safeParse(f).success, f.frame);
      assert.ok('dbEpoch' in f && f.dbEpoch === store.dbEpoch && f.seq >= seq);
      seq = f.seq;
    }
  } finally {
    await t.cleanup();
  }
});

test('a reset drops the pending state frame', async () => {
  const t = await testEngine();
  try {
    const frames = framesOf(t.engine.connect());
    t.engine.services.store.commit({ opId: 'a', origin: 'sync', writes: [accountWrite] });
    t.engine.services.frames.reset('dbEpoch');
    t.clock.advance(1_000);
    assert.deepEqual(
      frames.map(f => f.frame),
      ['reset'],
    );
  } finally {
    await t.cleanup();
  }
});

test('a frame for one connection reaches only it, and a closed connection gets nothing', async () => {
  const t = await testEngine({
    handlers: {
      'Thread/get': (_args, ctx) => {
        ctx.services.frames.emit(
          {
            frame: 'progress',
            runId: 'r1',
            source: 'ask',
            kind: 'text',
            delta: 'Private answer text',
          },
          ctx.connectionId,
        );
        return { list: [], notFound: [] } as never;
      },
    },
  });
  try {
    const a = t.engine.connect();
    const b = t.engine.connect();
    const closed = t.engine.connect();
    const [fa, fb, fc] = [framesOf(a), framesOf(b), framesOf(closed)];
    closed.close();
    await a.call('Thread/get', { ids: [] });
    t.engine.services.frames.emit({ frame: 'host', event: { type: 'badge', count: 3 } });
    assert.deepEqual(
      fa.map(f => f.frame),
      ['progress', 'host'],
    );
    assert.deepEqual(
      fb.map(f => f.frame),
      ['host'],
    );
    assert.equal(fc.length, 0);
    assert.doesNotMatch(t.logText(), /Private answer/, 'progress frames are never logged');
  } finally {
    await t.cleanup();
  }
});

test("a listener's bug does not stop delivery, and frames are copies", async () => {
  const t = await testEngine();
  try {
    const a = t.engine.connect();
    a.subscribe(() => {
      throw new Error('listener bug');
    });
    const seen = framesOf(a);
    const other = framesOf(t.engine.connect());
    t.engine.services.frames.emit({ frame: 'host', event: { type: 'badge', count: 1 } });
    assert.equal(seen.length, 1);
    (seen[0] as { seq: number }).seq = 999;
    assert.notEqual(other[0]!.frame !== 'desktop' && other[0]!.seq, 999);
  } finally {
    await t.cleanup();
  }
});

test('the bus refuses frames only it or main may send, and is silent after close', async () => {
  const t = await testEngine();
  const bus = t.engine.services.frames;
  const frames = framesOf(t.engine.connect());
  for (const frame of ['state', 'reset', 'desktop'])
    assert.throws(
      () => bus.emit({ frame, types: { Thread: 1 } } as never),
      /sends .* frames itself/,
    );
  assert.equal(frames.length, 0);
  await t.engine.close();
  t.engine.services.store.commit({ opId: 'late', origin: 'sync', writes: [accountWrite] });
  assert.equal(t.clock.pending(), 0, 'no coalescing timer after close');
  await t.cleanup();
});
