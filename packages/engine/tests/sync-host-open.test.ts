import test from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterContext, OpenedThread, ThreadOpenRef } from '../src/ports';
import { readBody } from '../src/store/bodies';
import { ACCOUNT, FakeAdapter, deferred, disk, fact, settle, world } from './sync-actor-helpers';

/**
 * `ActorHost.openThread` (fix-bodies, 2026-11-11). S2: one open of an email asked for the same thread twice on the
 * interactive lane (`Thread/open` and `MessageBody/get`) and each waited its turn for the one reserved Gmail slot; a
 * caller now joins the read already going out on its lane. R3: a message whose body part did not arrive was stored
 * with an empty body and `complete: true`, so it read as a blank letter forever; it is now left unstored and the
 * thread stays partial, so the next open fetches it again.
 */

type Opened = OpenedThread['messages'][number];

class OpenAdapter extends FakeAdapter {
  readonly opens: string[] = [];
  answer: () => Promise<OpenedThread> = async () => ({ messages: [], costUnits: 0 });

  constructor() {
    super(() => [], {});
  }

  async openThread(
    ref: ThreadOpenRef,
    lane: 'interactive' | 'prefetch',
    _ctx: AdapterContext,
  ): Promise<OpenedThread> {
    this.opens.push(`${lane} ${ref.remoteThreadId}`);
    return this.answer();
  }
}

async function rig() {
  const adapter = new OpenAdapter();
  const d = disk();
  const w = world(d, () => adapter);
  await w.host.start(ACCOUNT);
  return {
    w,
    adapter,
    done: async () => {
      await w.kill();
      d.cleanup();
    },
  };
}

const message = (remoteId: string, partial: boolean, html: string): Opened => ({
  ...fact(remoteId, 1, { remoteThreadId: 't-1', partial }),
  body: partial ? { cidMap: {} } : { html, text: 'Hello', cidMap: {} },
});

test('a second open of the same thread on the same lane joins the read in flight', async () => {
  const { w, adapter, done } = await rig();
  try {
    const gate = deferred<OpenedThread>();
    adapter.answer = () => gate.promise;
    const first = w.host.openThread(ACCOUNT, 't-1', { lane: 'interactive' });
    const second = w.host.openThread(ACCOUNT, 't-1', { lane: 'interactive' });
    const prefetch = w.host.openThread(ACCOUNT, 't-1', { lane: 'prefetch' });
    await settle();
    assert.deepEqual(adapter.opens, ['interactive t-1', 'prefetch t-1'], 'one read per lane');
    gate.resolve({ messages: [], costUnits: 1 });
    const answers = await Promise.all([first, second, prefetch]);
    assert.equal(answers[0], answers[1], 'the joined caller gets the same answer');
    await w.host.openThread(ACCOUNT, 't-1', { lane: 'interactive' });
    assert.equal(
      adapter.opens.length,
      3,
      'a settled read is not reused: the next open reads again',
    );
  } finally {
    await done();
  }
});

test('a failed read fails every caller that joined it and is not kept', async () => {
  const { w, adapter, done } = await rig();
  try {
    const gate = deferred<OpenedThread>();
    adapter.answer = () => gate.promise;
    const first = w.host.openThread(ACCOUNT, 't-1', { lane: 'interactive' });
    const second = w.host.openThread(ACCOUNT, 't-1', { lane: 'interactive' });
    await settle();
    gate.reject(new Error('network'));
    await assert.rejects(first, /network/);
    await assert.rejects(second, /network/);
    adapter.answer = async () => ({ messages: [], costUnits: 1 });
    await w.host.openThread(ACCOUNT, 't-1', { lane: 'interactive' });
    assert.equal(adapter.opens.length, 2, 'the retry reads again');
  } finally {
    await done();
  }
});

test('a message whose body part did not arrive is not stored, and the thread stays partial', async () => {
  const { w, adapter, done } = await rig();
  try {
    adapter.answer = async () => ({
      messages: [message('m-1', false, '<p>Hello</p>'), message('m-2', true, '')],
      costUnits: 1,
    });
    await w.host.openThread(ACCOUNT, 't-1', { lane: 'interactive' });
    const stored = w.store.read(q => readBody(q, ACCOUNT, 'm-1'));
    assert.equal(stored?.html, '<p>Hello</p>', 'the complete message keeps its body');
    assert.equal(
      w.store.read(q => readBody(q, ACCOUNT, 'm-2')),
      undefined,
      'the partial message has no stored body, so the next open fetches it',
    );
    const thread = w.store.read(q =>
      q.get<{ complete: number }>(
        'SELECT complete FROM threads WHERE account_id = ? AND remote_id = ?',
        ACCOUNT,
        't-1',
      ),
    );
    assert.equal(thread?.complete, 0, 'the thread stays partial');

    adapter.answer = async () => ({
      messages: [message('m-1', false, '<p>Hello</p>'), message('m-2', false, '<p>Later</p>')],
      costUnits: 1,
    });
    await w.host.openThread(ACCOUNT, 't-1', { lane: 'interactive' });
    assert.equal(w.store.read(q => readBody(q, ACCOUNT, 'm-2'))?.html, '<p>Later</p>');
  } finally {
    await done();
  }
});
