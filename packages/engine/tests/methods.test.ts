import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { engineAreas, getMethod, methodNames, type Scope } from '@aplos/contract';
import { ContractError, NotImplementedError } from '@aplos/contract/contract-error';
import { listenerMethods, mcpMethods } from '@aplos/contract/allowlists';
import {
  dispatch,
  handlers,
  type Caller,
  type EngineServices,
  type MethodContext,
} from '../src/methods/index';
import { createReceipts } from '../src/methods/unsubscribe';
import { openStore, type StorePort } from '../src/store';
import { testEngine } from './runtime.helpers';
import { ACCOUNT, accountWrite, folderWrites, msg, tempDb } from './store/helpers';

const dir = join(import.meta.dirname, '..', 'src', 'methods');
const grantable: Scope[] = ['read', 'triage', 'draft', 'send', 'ai', 'admin'];
const as = (caller: Caller): MethodContext => ({
  caller,
  signal: new AbortController().signal,
  services: {} as EngineServices,
  connectionId: 'c1',
  redispatch: () => Promise.reject(new Error('no re-dispatch in these tests')),
});
const ctx = as({ kind: 'window', scopes: grantable });
const forbidden = (e: unknown) => e instanceof ContractError && e.type === 'forbidden';
const reached = (e: unknown) => e instanceof NotImplementedError;

test("every engine method has exactly one handler entry, in its own area's file", async () => {
  const seen = new Map<string, string[]>();
  for (const area of engineAreas) {
    const module = (await import(join(dir, `${area}.ts`))) as { handlers: Record<string, unknown> };
    for (const name of Object.keys(module.handlers)) {
      seen.set(name, [...(seen.get(name) ?? []), area]);
      assert.equal(
        getMethod(name).area,
        area,
        `${name} sits in ${area}.ts but belongs to ${getMethod(name).area}`,
      );
    }
  }
  const engine = methodNames.filter(name => getMethod(name).host === 'engine');
  assert.deepEqual(
    engine.filter(name => seen.get(name)?.length !== 1),
    [],
    'missing or duplicated handlers',
  );
  assert.deepEqual(
    [...seen.keys()].filter(name => getMethod(name).host !== 'engine'),
    [],
    'desktop methods never reach the engine',
  );
  assert.deepEqual(Object.keys(handlers).sort(), [...engine].sort());
});

test('there is one file per engine area and nothing else besides the table and its types', () => {
  const files = readdirSync(dir)
    .map(f => f.replace(/\.ts$/, ''))
    .sort();
  assert.deepEqual(files, [...engineAreas, 'index', 'types'].sort());
});

test('a stub rejects with notImplemented, and an unknown method with unsupported', async () => {
  await assert.rejects(
    dispatch('Conversation/destroy', { id: 'c1' }, ctx),
    (e: unknown) => e instanceof NotImplementedError && e.type === 'notImplemented',
  );
  await assert.rejects(
    dispatch('File/save', {}, ctx),
    (e: unknown) => e instanceof ContractError && e.type === 'unsupported',
  );
  await assert.rejects(
    dispatch('toString', {}, ctx),
    (e: unknown) => e instanceof ContractError && e.type === 'unsupported',
  );
});

/** What a call with empty arguments comes to: the error it threw, or undefined. A built handler may fail or answer; only `forbidden` is the gate's. */
const outcomeOf = (method: string, caller: MethodContext) =>
  dispatch(method, {}, caller).then(
    () => undefined,
    (e: unknown) => e,
  );

test('dispatch denies by default: scope, host-only, uiOnly, secret and MCP are checked before any handler', async () => {
  const reader = as({ kind: 'listener', via: 'socket', clientId: 'c1', scopes: ['read'] });
  // A read-only listener can neither send nor reach main's own methods, whatever the transport checked.
  await assert.rejects(
    dispatch('Submission/set', { action: { type: 'send', id: 's1', revision: 1 } }, reader),
    forbidden,
  );
  await assert.rejects(dispatch('Mail/serve', {}, reader), forbidden);
  assert.ok(!forbidden(await outcomeOf('Account/get', reader)), 'its own scope gets through');
  // Host methods need main's control connection even when a window claims the scope.
  await assert.rejects(
    dispatch('Notification/claim', {}, as({ kind: 'window', scopes: [...grantable, 'host'] })),
    forbidden,
  );
  assert.ok(
    !forbidden(await outcomeOf('Notification/claim', as({ kind: 'host', scopes: ['host'] }))),
  );
  // An admin listener still cannot reach a uiOnly (Data/export) or secret (Ai/setKey) method; a window can.
  const admin = as({ kind: 'listener', via: 'http', clientId: 'c1', scopes: grantable });
  for (const method of ['Data/export', 'Ai/setKey']) {
    await assert.rejects(dispatch(method, {}, admin), forbidden, method);
    assert.ok(!forbidden(await outcomeOf(method, ctx)), method);
  }
  // A window without a scope is refused too: the grant, not the kind, carries permission.
  await assert.rejects(
    dispatch('Thread/act', {}, as({ kind: 'window', scopes: ['read'] })),
    forbidden,
  );
  // MCP clients reach only the MCP tools, even with a wider grant.
  const mcp = as({ kind: 'listener', via: 'mcp', clientId: 'c2', scopes: grantable });
  const notTool = listenerMethods.find(m => !(mcpMethods as readonly string[]).includes(m))!;
  await assert.rejects(dispatch(notTool, {}, mcp), forbidden, notTool);
  // Every MCP tool is past the gate, whatever its handler does; the first one still a stub is reached and says so.
  const outcomes = await Promise.all(mcpMethods.map(m => outcomeOf(m, mcp)));
  outcomes.forEach((outcome, i) => assert.ok(!forbidden(outcome), `${mcpMethods[i]} is reachable`));
  const stub = mcpMethods.find((_, i) => reached(outcomes[i]));
  assert.ok(stub, 'a stub MCP method is left to check');
  await assert.rejects(dispatch(stub, {}, mcp), reached);
});

test('every engine method is refused to a caller that holds no scope', async () => {
  const none = as({ kind: 'host', scopes: [] });
  for (const name of Object.keys(handlers))
    await assert.rejects(dispatch(name, {}, none), forbidden, name);
});

// ---------------------------------------------------------------- Unsubscribe (prov-gmail-write)

type Executor = EngineServices['unsubscribe'];
type RunRequest = Parameters<Executor['run']>[0];

/** A real store with one thread: an older inbound list message, a newer one, and the owner's own reply on top. */
async function withUnsubStore(fn: (store: StorePort) => Promise<void>) {
  const file = tempDb();
  const store = openStore(file.open());
  try {
    store.commit({ opId: 'setup', origin: 'sync', writes: [accountWrite, ...folderWrites] });
    const own = { seen: true, flagged: false, draft: false, fromMe: true };
    store.commit({
      opId: 'mail',
      origin: 'sync',
      writes: [
        msg('m1', 't1', 0, { listUnsubscribe: { urls: ['https://old.example/u'] } }),
        msg('m2', 't1', 5, {
          listUnsubscribe: {
            urls: ['mailto:leave@list.example', 'https://list.example/u'],
            oneClick: true,
          },
        }),
        msg('m3', 't1', 9, { flags: own, listUnsubscribe: { urls: ['https://mine.example/u'] } }),
        msg('m4', 't2', 1),
      ],
    });
    await fn(store);
  } finally {
    store.close();
    file.cleanup();
  }
}

function unsubCtx(store: StorePort, unsubscribe: Executor): MethodContext {
  return { ...ctx, services: { store, unsubscribe } as EngineServices };
}

/** The stand-in `createEngine` gives a method when the host left the port out (truthy, every member rejects). */
async function withAbsentPort(fn: (absent: Executor) => Promise<void>) {
  const t = await testEngine();
  try {
    await fn(t.engine.services.unsubscribe);
  } finally {
    await t.cleanup();
  }
}

function fakeExecutor(
  result: Awaited<ReturnType<Executor['run']>>,
  seen: RunRequest[] = [],
): Executor {
  return {
    describe: () => ({ method: 'oneClick' }),
    run: async request => {
      seen.push(request);
      return result;
    },
  };
}

const T1 = `${ACCOUNT}:t1`;

test('Unsubscribe/run hands the newest inbound list message and its receiving account to the executor', async () => {
  await withUnsubStore(async store => {
    const seen: RunRequest[] = [];
    const out = await handlers['Unsubscribe/run'](
      { opId: 'op-1', threadId: T1 },
      unsubCtx(store, fakeExecutor({ kind: 'done', message: 'Unsubscribed.' }, seen)),
    );
    assert.deepEqual(out, { outcome: 'done', message: 'Unsubscribed.' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].from, 'owner@mail.example');
    assert.deepEqual(
      seen[0].headers.listUnsubscribe,
      '<mailto:leave@list.example>, <https://list.example/u>',
    );
    assert.equal(seen[0].headers.listUnsubscribePost, 'List-Unsubscribe=One-Click');
  });
});

test('Unsubscribe/run maps every executor result to the contract outcome and drops an unsafe url', async () => {
  await withUnsubStore(async store => {
    const cases = [
      [
        { kind: 'open', message: 'm', url: 'https://list.example/u' },
        { outcome: 'openLink', url: 'https://list.example/u' },
      ],
      [
        { kind: 'compose', message: 'm', url: 'mailto:a@list.example' },
        { outcome: 'compose', url: 'mailto:a@list.example' },
      ],
      [{ kind: 'unsure', message: 'm' }, { outcome: 'unsure' }],
      [{ kind: 'failed', message: 'm' }, { outcome: 'failed' }],
      [{ kind: 'none', message: 'm' }, { outcome: 'unavailable' }],
      [
        { kind: 'open', message: 'm', url: `https://list.example/${'a'.repeat(2_000)}` },
        { outcome: 'openLink' },
      ],
      [{ kind: 'open', message: 'm', url: 'https://list.example/u\nx' }, { outcome: 'openLink' }],
    ] as const;
    for (const [result, expected] of cases) {
      const out = await handlers['Unsubscribe/run'](
        { opId: 'op-1', threadId: T1 },
        unsubCtx(store, fakeExecutor(result)),
      );
      assert.deepEqual(out, { message: 'm', ...expected });
    }
  });
});

test('Unsubscribe/run: no list header is unavailable without calling the executor; a missing thread or executor is refused', async () => {
  await withUnsubStore(async store => {
    const seen: RunRequest[] = [];
    const executor = fakeExecutor({ kind: 'done', message: 'x' }, seen);
    const none = await handlers['Unsubscribe/run'](
      { opId: 'op-1', threadId: `${ACCOUNT}:t2` },
      unsubCtx(store, executor),
    );
    assert.equal(none.outcome, 'unavailable');
    assert.equal(seen.length, 0);
    await assert.rejects(
      Promise.resolve().then(() =>
        handlers['Unsubscribe/run'](
          { opId: 'op-1', threadId: `${ACCOUNT}:nope` },
          unsubCtx(store, executor),
        ),
      ),
      (e: unknown) => e instanceof ContractError && e.type === 'notFound',
    );
    await withAbsentPort(async absent => {
      await assert.rejects(
        Promise.resolve().then(() =>
          handlers['Unsubscribe/run']({ opId: 'op-1', threadId: T1 }, unsubCtx(store, absent)),
        ),
        (e: unknown) => e instanceof ContractError && e.type === 'unavailable',
      );
    });
  });
});

test('Unsubscribe/get without a host executor degrades to none; Unsubscribe/run stays unavailable', async () => {
  await withUnsubStore(async store => {
    await withAbsentPort(async absent => {
      const ctx = unsubCtx(store, absent);
      assert.deepEqual(await handlers['Unsubscribe/get']({ threadId: T1 }, ctx), {
        method: 'none',
      });
      await assert.rejects(
        Promise.resolve().then(() =>
          handlers['Unsubscribe/run']({ opId: 'op-1', threadId: T1 }, ctx),
        ),
        (e: unknown) => e instanceof ContractError && e.type === 'unavailable',
      );
    });
  });
});

test('Unsubscribe/run passes the opId to the port, and omits it when the call has none', async () => {
  await withUnsubStore(async store => {
    const seen: RunRequest[] = [];
    const ctx = unsubCtx(store, fakeExecutor({ kind: 'done', message: 'm' }, seen));
    await handlers['Unsubscribe/run']({ opId: 'op-seen', threadId: T1 }, ctx);
    assert.equal(seen[0].opId, 'op-seen');
    await handlers['Unsubscribe/run']({ threadId: T1 } as never, ctx);
    assert.equal('opId' in seen[1], false);
  });
});

test('Unsubscribe/run passes each outcome name and message through unchanged', async () => {
  await withUnsubStore(async store => {
    const kinds = [
      ['done', 'done'],
      ['open', 'openLink'],
      ['compose', 'compose'],
      ['unsure', 'unsure'],
      ['failed', 'failed'],
    ] as const;
    for (const [kind, outcome] of kinds) {
      const message = `The ${kind} sentence, exactly.`;
      const out = await handlers['Unsubscribe/run'](
        { opId: `op-${kind}`, threadId: T1 },
        unsubCtx(store, fakeExecutor({ kind, message })),
      );
      assert.deepEqual(out, { outcome, message });
    }
  });
});

test('Unsubscribe/get reports the executor’s method for the thread, and none without a list header', async () => {
  await withUnsubStore(async store => {
    const executor: Executor = {
      describe: h => ({
        method: 'link',
        url: /https:\/\/list\.example\/u/.test(h.listUnsubscribe ?? '')
          ? 'https://list.example/u'
          : 'x',
      }),
      run: () => Promise.reject(new Error('get never runs')),
    };
    const get = (threadId: string) =>
      handlers['Unsubscribe/get']({ threadId }, unsubCtx(store, executor));
    assert.deepEqual(await get(T1), { method: 'link', url: 'https://list.example/u' });
    assert.deepEqual(await get(`${ACCOUNT}:t2`), { method: 'none' });
  });
});

/** An executor whose `run` counts calls and answers when released, so a retry can arrive while the first is in flight. */
function countingExecutor() {
  const state = { runs: 0, release: () => {} };
  const gate = new Promise<void>(resolve => (state.release = resolve));
  const executor: Executor = {
    describe: () => ({ method: 'oneClick' }),
    run: async () => {
      state.runs += 1;
      await gate;
      return { kind: 'done', message: `Unsubscribed #${state.runs}.` };
    },
  };
  return { executor, state };
}

test('Unsubscribe/run: a retry with the same opId gets the stored outcome and never reaches the executor again', async () => {
  await withUnsubStore(async store => {
    const { executor, state } = countingExecutor();
    state.release();
    const call = (opId: string, threadId = T1) =>
      handlers['Unsubscribe/run']({ opId, threadId }, unsubCtx(store, executor));
    const first = await call('op-a');
    assert.deepEqual(await call('op-a'), first);
    assert.deepEqual(await call('op-a'), first);
    assert.equal(state.runs, 1);
    await call('op-b');
    assert.equal(state.runs, 2);
  });
});

test('Unsubscribe/run: a concurrent retry joins the call in flight instead of POSTing again', async () => {
  await withUnsubStore(async store => {
    const { executor, state } = countingExecutor();
    const ctx = unsubCtx(store, executor);
    const a = handlers['Unsubscribe/run']({ opId: 'op-a', threadId: T1 }, ctx);
    const b = handlers['Unsubscribe/run']({ opId: 'op-a', threadId: T1 }, ctx);
    state.release();
    assert.deepEqual(await b, await a);
    assert.equal(state.runs, 1);
  });
});

test('Unsubscribe/run: a call that is cancelled leaves no receipt, so the owner can try again', async () => {
  await withUnsubStore(async store => {
    let runs = 0;
    const executor: Executor = {
      describe: () => ({ method: 'oneClick' }),
      run: async () => {
        runs += 1;
        if (runs === 1) throw new Error('cancelled');
        return { kind: 'done', message: 'ok' };
      },
    };
    const call = async () =>
      handlers['Unsubscribe/run']({ opId: 'op-a', threadId: T1 }, unsubCtx(store, executor));
    await assert.rejects(call(), /cancelled/);
    assert.equal((await call()).outcome, 'done');
    assert.equal(runs, 2);
  });
});

test('receipts expire after the TTL and the oldest is evicted past the bound; no opId never dedupes', async () => {
  let clock = 0;
  const receipts = createReceipts(() => clock, { maxEntries: 3, ttlMs: 1_000 });
  let made = 0;
  const make = async () => ({ outcome: 'done' as const, message: String(++made) });
  const once = (opId: string | undefined) => receipts.once(opId, T1, make);
  await once('a');
  await once('a');
  assert.equal(made, 1);
  clock = 1_001;
  await once('a');
  assert.equal(made, 2);
  await once('b');
  await once('c');
  await once('d');
  assert.equal(made, 5);
  await once('a');
  assert.equal(made, 6);
  await once('d');
  assert.equal(made, 6);
  await once(undefined);
  await once(undefined);
  assert.equal(made, 8);
});
