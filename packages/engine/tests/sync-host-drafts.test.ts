import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PausedError,
  type AdapterContext,
  type DraftSaveResult,
  type DraftUpload,
} from '../src/ports';
import { NotSentError, ProviderError } from '../src/ports/base';
import { ACCOUNT, ADDRESS, FakeAdapter, disk, world, type World } from './sync-actor-helpers';

/**
 * `ActorHost` as the engine's `DraftSyncPort` (plan 20 PV3): `save` and `remove` reach the named account's adapter
 * under that account's actor context on the `opFlush` lane, and refuse with a `permanent` reason code otherwise.
 */

const OTHER = 'acct-2';

interface Seen {
  ctx: AdapterContext;
  what: string;
}

class DraftAdapter extends FakeAdapter {
  readonly seen: Seen[] = [];
  bodyRuns = 0;
  result: DraftSaveResult = {
    kind: 'saved',
    remoteDraftId: 'r-1',
    remoteMessageId: 'm-1',
    revision: 1,
  };

  constructor() {
    super(() => [], {});
  }

  async saveDraft(draft: DraftUpload, ctx: AdapterContext): Promise<DraftSaveResult> {
    this.seen.push({ ctx, what: `save:${draft.draftId}` });
    return this.governedDraft(ctx, 'write', () => this.result);
  }

  async deleteDraft(id: string, ctx: AdapterContext, expected?: string): Promise<void> {
    this.seen.push({ ctx, what: `delete:${id}:${expected ?? '-'}:${arguments.length}` });
    return this.governedDraft(ctx, 'idempotentWrite', () => undefined);
  }

  private governedDraft<T>(ctx: AdapterContext, kind: 'write' | 'idempotentWrite', body: () => T) {
    return ctx.governor.run(
      { budget: 'gmail', lane: 'opFlush', kind, method: 'fake.drafts', cost: 10 },
      async () => {
        this.bodyRuns++;
        return body();
      },
    );
  }
}

const upload = (draftId = 'd-1'): DraftUpload => ({
  draftId,
  revision: 1,
  fingerprint: 'f',
  internetId: '<x@example.test>',
  mime: new Uint8Array([1, 2, 3]),
});

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

const isNotStarted = (error: unknown) =>
  error instanceof NotSentError &&
  error.error.class === 'transient' &&
  error.error.reason === 'accountNotStarted';

const isPermanent = (reason: string) => (error: unknown) =>
  error instanceof ProviderError &&
  error.error.class === 'permanent' &&
  error.error.reason === reason &&
  !String(error.message).includes('d-1');

test('save routes to the named account adapter with its actor context and returns the result unchanged', async () => {
  const a = new DraftAdapter();
  const b = new DraftAdapter();
  const { w, done } = rig({ [ACCOUNT]: a, [OTHER]: b });
  try {
    await w.host.start(ACCOUNT);
    await w.host.start(OTHER);
    const saved = await w.host.save(OTHER, upload());
    assert.deepEqual(saved, {
      kind: 'saved',
      remoteDraftId: 'r-1',
      remoteMessageId: 'm-1',
      revision: 1,
    });
    assert.equal(a.seen.length, 0, 'the other account was never asked');
    assert.deepEqual(
      b.seen.map(s => s.what),
      ['save:d-1'],
    );
    assert.equal(b.seen[0]!.ctx.account.id, OTHER);
    assert.equal(b.seen[0]!.ctx.account.address, `${OTHER}@example.test`);
    await w.host.save(ACCOUNT, upload('d-2'));
    assert.equal(a.seen[0]!.ctx.account.id, ACCOUNT);
    assert.equal(a.seen[0]!.ctx.account.address, ADDRESS);
    assert.equal(b.seen.length, 1, 'still one: the call for acct-1 never reached acct-2');
  } finally {
    await done();
  }
});

test('save passes gone and conflict (with the remote ids) through untouched', async () => {
  const a = new DraftAdapter();
  const { w, done } = rig({ [ACCOUNT]: a, [OTHER]: new DraftAdapter() });
  try {
    await w.host.start(ACCOUNT);
    const results: DraftSaveResult[] = [
      { kind: 'gone' },
      {
        kind: 'conflict',
        remoteMessageId: 'm-9',
        remoteDraftId: 'r-9',
        remoteInternetId: '<theirs@example.test>',
      },
      { kind: 'conflict' },
    ];
    for (const result of results) {
      a.result = result;
      assert.deepEqual(await w.host.save(ACCOUNT, upload()), result);
    }
  } finally {
    await done();
  }
});

test('remove forwards the remote id and expectedMessageId, and omits it when absent', async () => {
  const a = new DraftAdapter();
  const b = new DraftAdapter();
  const { w, done } = rig({ [ACCOUNT]: a, [OTHER]: b });
  try {
    await w.host.start(ACCOUNT);
    await w.host.start(OTHER);
    await w.host.remove(ACCOUNT, 'r-1', 'm-1');
    await w.host.remove(ACCOUNT, 'r-2');
    assert.deepEqual(
      a.seen.map(s => s.what),
      ['delete:r-1:m-1:3', 'delete:r-2:-:2'],
    );
    assert.equal(b.seen.length, 0);
    assert.equal(a.seen[0]!.ctx.account.id, ACCOUNT);
  } finally {
    await done();
  }
});

test('an account that is not started is a transient refusal that wrote nothing and reaches no adapter', async () => {
  const a = new DraftAdapter();
  const b = new DraftAdapter();
  const { w, done } = rig({ [ACCOUNT]: a, [OTHER]: b });
  try {
    await w.host.start(ACCOUNT);
    await assert.rejects(w.host.save(OTHER, upload()), isNotStarted);
    await assert.rejects(w.host.remove(OTHER, 'r-1', 'm-1'), isNotStarted);
    await assert.rejects(w.host.save('acct-unknown', upload()), isNotStarted);
    await w.host.stop(ACCOUNT, 'restart');
    await assert.rejects(w.host.save(ACCOUNT, upload()), isNotStarted);
    assert.equal(a.seen.length + b.seen.length, 0);
  } finally {
    await done();
  }
});

test('an adapter without saveDraft or deleteDraft is a permanent refusal', async () => {
  const bare = new FakeAdapter(() => [], {});
  const { w, done } = rig({ [ACCOUNT]: bare, [OTHER]: new DraftAdapter() });
  try {
    await w.host.start(ACCOUNT);
    await assert.rejects(w.host.save(ACCOUNT, upload()), isPermanent('draftsUnsupported'));
    await assert.rejects(w.host.remove(ACCOUNT, 'r-1'), isPermanent('draftsUnsupported'));
  } finally {
    await done();
  }
});

test('a paused account throws PausedError from the governor and runs no request; the other account is unaffected', async () => {
  const a = new DraftAdapter();
  const b = new DraftAdapter();
  const { w, done } = rig({ [ACCOUNT]: a, [OTHER]: b });
  try {
    await w.host.start(ACCOUNT);
    await w.host.start(OTHER);
    w.governor.observe(ACCOUNT, 'gmail', {
      class: 'auth',
      provider: 'gmail',
      method: 'gmail.drafts.update',
      reason: 'invalid_grant',
    });
    await assert.rejects(w.host.save(ACCOUNT, upload()), PausedError);
    await assert.rejects(w.host.remove(ACCOUNT, 'r-1', 'm-1'), PausedError);
    assert.equal(a.bodyRuns, 0, 'no request left the paused account');
    assert.equal((await w.host.save(OTHER, upload())).kind, 'saved');
    assert.equal(b.bodyRuns, 1);
  } finally {
    await done();
  }
});
