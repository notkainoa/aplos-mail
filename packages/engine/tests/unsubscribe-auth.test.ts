import test from 'node:test';
import assert from 'node:assert/strict';
import type { PinnedTarget } from '../../../apps/desktop/src/host/proxy/resolve';
import { createUnsubscribeExecutor } from '../../../apps/desktop/src/host/providers/google/unsubscribe';
import { handlers, type EngineServices, type MethodContext } from '../src/methods/index';
import { openStore, type MessageWrite, type StorePort } from '../src/store';
import { ACCOUNT, accountWrite, folderWrites, msg, tempDb } from './store/helpers';

/**
 * RFC 8058 section 4 in `methods/unsubscribe.ts`: one-click only for an authenticated message
 * (`ListHeaders.authenticated === true`), and an authenticated message is the thread's target over any newer one. Runs
 * the real host executor with a fake resolver and transport: no network, and every POST it would send is recorded.
 */

type Executor = EngineServices['unsubscribe'];

const PUBLIC = '93.184.216.34';
const ONE_CLICK = { oneClick: true } as const;
const REAL = 'https://real.example/u';
const EVIL = 'https://evil.example/u';

function recordingExecutor() {
  const posts: PinnedTarget[] = [];
  const executor = createUnsubscribeExecutor({
    resolve: async () => [{ address: PUBLIC, family: 4 }],
    transport: async target => {
      posts.push(target);
      return { status: 200, body: (async function* () {})(), close: () => undefined };
    },
  });
  return { posts, executor };
}

function context(store: StorePort, unsubscribe: Executor): MethodContext {
  return {
    caller: { kind: 'window', scopes: ['read', 'triage'] },
    signal: new AbortController().signal,
    services: { store, unsubscribe } as EngineServices,
    connectionId: 'c1',
    redispatch: () => Promise.reject(new Error('no re-dispatch in these tests')),
  };
}

async function withThread(writes: MessageWrite[], fn: (store: StorePort) => Promise<void>) {
  const file = tempDb();
  const store = openStore(file.open());
  try {
    store.commit({ opId: 'setup', origin: 'sync', writes: [accountWrite, ...folderWrites] });
    store.commit({ opId: 'mail', origin: 'sync', writes });
    await fn(store);
  } finally {
    store.close();
    file.cleanup();
  }
}

const T = `${ACCOUNT}:t1`;

function listMsg(id: string, minutes: number, urls: string[], verdict?: unknown): MessageWrite {
  const auth = verdict === undefined ? {} : { listAuthenticated: verdict as boolean };
  return msg(id, 't1', minutes, { listUnsubscribe: { urls, ...ONE_CLICK }, ...auth });
}

async function getAndRun(store: StorePort, executor: Executor, opId: string) {
  const ctx = context(store, executor);
  const get = await handlers['Unsubscribe/get']({ threadId: T }, ctx);
  const run = await handlers['Unsubscribe/run']({ opId, threadId: T }, ctx);
  return { get, run };
}

test('one-click is allowed for an authenticated message: the POST goes to its URL', async () => {
  await withThread([listMsg('m1', 0, [REAL], true)], async store => {
    const { posts, executor } = recordingExecutor();
    const { get, run } = await getAndRun(store, executor, 'op-1');
    assert.deepEqual(get, { method: 'oneClick' });
    assert.equal(run.outcome, 'done');
    assert.deepEqual(
      posts.map(p => p.hostHeader),
      ['real.example'],
    );
  });
});

test('one-click is refused for a message that is not authenticated, unknown, or carries a non-boolean verdict', async () => {
  for (const verdict of [false, undefined, 'true', 1]) {
    await withThread([listMsg('m1', 0, [REAL], verdict)], async store => {
      const { posts, executor } = recordingExecutor();
      const { get, run } = await getAndRun(store, executor, 'op-1');
      const label = JSON.stringify(verdict) ?? 'absent';
      assert.deepEqual(get, { method: 'link', url: REAL }, label);
      assert.deepEqual(run, { outcome: 'openLink', message: run.message, url: REAL }, label);
      assert.equal(posts.length, 0, `${label}: no POST`);
    });
  }
});

test('a spoofed newer message cannot swap the target: the older authenticated one is used', async () => {
  for (const spoof of [false, undefined]) {
    const writes = [listMsg('m1', 0, [REAL], true), listMsg('m2', 5, [EVIL], spoof)];
    await withThread(writes, async store => {
      const { posts, executor } = recordingExecutor();
      const seen: Parameters<Executor['run']>[0][] = [];
      const watching: Executor = {
        describe: h => executor.describe(h),
        run: request => {
          seen.push(request);
          return executor.run(request);
        },
      };
      const { get, run } = await getAndRun(store, watching, 'op-1');
      assert.deepEqual(get, { method: 'oneClick' });
      assert.equal(run.outcome, 'done');
      assert.equal(seen[0].headers.listUnsubscribe, `<${REAL}>`);
      assert.equal(seen[0].headers.authenticated, true);
      assert.deepEqual(
        posts.map(p => p.hostHeader),
        ['real.example'],
      );
    });
  }
});

test('with no authenticated message the newest one is used, gated to the owner-visible ways', async () => {
  const writes = [listMsg('m1', 0, [REAL]), listMsg('m2', 5, [EVIL], false)];
  await withThread(writes, async store => {
    const { posts, executor } = recordingExecutor();
    const { get, run } = await getAndRun(store, executor, 'op-1');
    assert.deepEqual(get, { method: 'link', url: EVIL }, 'the owner sees where it goes');
    assert.equal(run.outcome, 'openLink');
    assert.equal(run.url, EVIL);
    assert.equal(posts.length, 0);
  });
});

test('mailto stays offered for an unauthenticated message, as a prepared email the owner reviews', async () => {
  const urls = ['mailto:leave@list.example', REAL];
  await withThread([listMsg('m1', 0, urls)], async store => {
    const { posts, executor } = recordingExecutor();
    const { get, run } = await getAndRun(store, executor, 'op-1');
    const mailto = 'mailto:leave@list.example?subject=unsubscribe';
    assert.deepEqual(get, { method: 'mailto', url: mailto });
    assert.equal(run.outcome, 'compose');
    assert.equal(run.url, mailto);
    assert.equal(posts.length, 0);
  });
});
