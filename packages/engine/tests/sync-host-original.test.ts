import test from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterContext } from '../src/ports';
import { ProviderError } from '../src/ports/base';
import { ACCOUNT, FakeAdapter, disk, world, type World } from './sync-actor-helpers';

/**
 * `ActorHost` as the engine's `ProviderPort.original` (plan 20, `Message/original`): the call reaches the named
 * account's adapter under that account's actor context, and an adapter without `original` answers permanent
 * `unavailable` rather than hanging or reaching the wrong account.
 */

const OTHER = 'acct-2';

class OriginalAdapter extends FakeAdapter {
  readonly seen: { id: string; ctx: AdapterContext; signal?: AbortSignal }[] = [];

  constructor() {
    super(() => [], {});
  }

  async original(
    remoteMessageId: string,
    ctx: AdapterContext,
    opts?: { signal?: AbortSignal },
  ): Promise<AsyncIterable<Uint8Array>> {
    this.seen.push({ id: remoteMessageId, ctx, signal: opts?.signal });
    return (async function* () {
      yield new Uint8Array([82, 70, 67]);
    })();
  }
}

function addAccount(w: World, id: string): void {
  w.store.commit({
    opId: `setup-${id}`,
    origin: 'system',
    writes: [
      {
        kind: 'account',
        id,
        provider: 'google',
        address: `${id}@example.test`,
        capabilities: { labels: true, drafts: true, threading: 'native' },
        status: { state: 'ok' },
      },
    ],
  });
}

function rig(adapters: Record<string, FakeAdapter>) {
  const d = disk();
  const w = world(d, account => adapters[account.id]!);
  addAccount(w, OTHER);
  return {
    w,
    done: async () => {
      await w.kill();
      d.cleanup();
    },
  };
}

async function collected(iter: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of iter) parts.push(chunk);
  return Uint8Array.from(parts.flatMap(p => [...p]));
}

test('original routes to the named account adapter under that account’s actor context', async () => {
  const a = new OriginalAdapter();
  const b = new OriginalAdapter();
  const { w, done } = rig({ [ACCOUNT]: a, [OTHER]: b });
  try {
    await w.host.start(ACCOUNT);
    await w.host.start(OTHER);
    const deadline = new AbortController();
    const bytes = await collected(await w.host.original(OTHER, 'm-9', { signal: deadline.signal }));
    assert.deepEqual([...bytes], [82, 70, 67]);
    assert.equal(a.seen.length, 0, 'the other account was never asked');
    assert.equal(b.seen.length, 1);
    assert.equal(b.seen[0].id, 'm-9');
    assert.equal(b.seen[0].ctx.account.id, OTHER);
    assert.equal(b.seen[0].signal, deadline.signal, 'the caller signal reaches the adapter');
    await w.host.original(ACCOUNT, 'm-3');
    assert.equal(a.seen.length, 1);
    assert.equal(a.seen[0].ctx.account.id, ACCOUNT);
    assert.equal(b.seen.length, 1, 'still one: the call for acct-1 never reached acct-2');
  } finally {
    await done();
  }
});

test('an adapter without original answers permanent unavailable', async () => {
  const { w, done } = rig({
    [ACCOUNT]: new FakeAdapter(() => [], {}),
    [OTHER]: new OriginalAdapter(),
  });
  try {
    await w.host.start(ACCOUNT);
    await assert.rejects(
      () => w.host.original(ACCOUNT, 'm-9'),
      (error: unknown) =>
        error instanceof ProviderError &&
        error.error.class === 'permanent' &&
        error.error.reason === 'unavailable' &&
        error.error.uncertain === false,
    );
  } finally {
    await done();
  }
});
