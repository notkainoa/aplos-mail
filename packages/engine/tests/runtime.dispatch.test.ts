import test from 'node:test';
import assert from 'node:assert/strict';
import { getMethod, methodNames, parseArgs, type EngineMethodName } from '@aplos/contract';
import { ContractError } from '@aplos/contract/contract-error';
import { methodScope } from '@aplos/contract/allowlists';
import type { Caller, Handler } from '../src/methods/types';
import { windowCaller } from '../src/index';
import { testEngine } from './runtime.helpers';

const engineMethods = methodNames.filter(
  (name): name is EngineMethodName => getMethod(name).host === 'engine',
);
const reader: Caller = { kind: 'listener', via: 'socket', clientId: 'c1', scopes: ['read'] };
const widerThanRead = engineMethods.filter(m => methodScope[m] !== 'read');
const isType = (type: string) => (e: unknown) => e instanceof ContractError && e.type === type;

test('the in-process connection serves the F5 table: unknown and desktop methods', async () => {
  const t = await testEngine();
  try {
    const s = t.engine.connect();
    // No stub method remains — Event/extract (the last) is implemented.
    await assert.rejects(s.call('Thread/explode', {}), isType('unsupported'));
    await assert.rejects(
      s.call('File/save', { blobId: 'b', name: 'x.txt' }),
      isType('unsupported'),
    );
    await assert.rejects(s.call('__proto__', {}), isType('unsupported'));
  } finally {
    await t.cleanup();
  }
});

test('the host validator runs first, with the contract sentence and path', async () => {
  const t = await testEngine({ validate: parseArgs as (m: string, a: unknown) => unknown });
  try {
    const s = t.engine.connect();
    await assert.rejects(
      s.call('Settings/set', { opId: 'o1', patch: { mail: { undoSendSeconds: 99 } } }),
      (e: unknown) =>
        isType('validation')(e) &&
        (e as ContractError).message === 'Undo send must be between 0 and 60 seconds.' &&
        JSON.stringify((e as ContractError).body.path) === '["patch","mail","undoSendSeconds"]',
    );
  } finally {
    await t.cleanup();
  }
});

test('caller bypass: a read listener reaches no triage, send or admin method by any entry', async () => {
  const ran: string[] = [];
  const record =
    (name: EngineMethodName): Handler<EngineMethodName> =>
    () => {
      ran.push(name);
      return {} as never;
    };
  const overrides = Object.fromEntries(widerThanRead.map(m => [m, record(m)]));
  // An allowed read method whose handler re-dispatches wider methods, as `Operation/retry` or a queued item would.
  overrides['Thread/get'] = (async (_args, ctx) => {
    for (const m of ['Submission/set', 'Thread/act', 'Settings/set', 'Operation/retry'] as const)
      await assert.rejects(ctx.redispatch(m, {} as never), isType('forbidden'), m);
    return { list: [], notFound: [] } as never;
  }) as Handler<'Thread/get'>;
  const t = await testEngine({ handlers: overrides });
  try {
    const caller = { ...reader, scopes: ['read'] as Caller['scopes'] };
    const s = t.engine.connect(caller);
    // Widening the caller object after connect changes nothing.
    (caller.scopes as string[]).push('send', 'admin');
    (caller as { kind: string }).kind = 'host';
    // Every wider method, one at a time and all at once (a client batching its calls).
    for (const m of widerThanRead) await assert.rejects(s.call(m, {}), isType('forbidden'), m);
    const batch = await Promise.allSettled(widerThanRead.map(m => s.call(m, {})));
    assert.ok(batch.every(r => r.status === 'rejected' && isType('forbidden')(r.reason)));
    await s.call('Thread/get', { ids: [] });
    assert.deepEqual(ran, [], 'no wider handler ever ran');
    // A window holding the scopes does reach them, re-dispatch included.
    const win = t.engine.connect();
    await win.call('Thread/act', {});
    assert.deepEqual(ran, ['Thread/act']);
  } finally {
    await t.cleanup();
  }
});

test('re-dispatch keeps the caller: a window handler reaches what the window may', async () => {
  const t = await testEngine({
    handlers: {
      'Operation/retry': (_args, ctx) => ctx.redispatch('Thread/act', {} as never),
      'Thread/act': (_args, ctx) => ({ caller: ctx.caller.kind }) as never,
      'Notification/claim': (_args, ctx) => ctx.redispatch('Notification/claim', {} as never),
    },
  });
  try {
    const win = t.engine.connect();
    assert.deepEqual(await win.call('Operation/retry', { opId: 'o1' }), { caller: 'window' });
    // A host-only method stays host-only through a window's re-dispatch.
    await assert.rejects(win.call('Notification/claim', {}), isType('forbidden'));
  } finally {
    await t.cleanup();
  }
});

test('a closed connection answers unavailable and aborts its running calls', async () => {
  let signal: AbortSignal | undefined;
  const t = await testEngine({
    handlers: {
      'Thread/get': (_args, ctx) => {
        signal = ctx.signal;
        return new Promise(() => {}) as never;
      },
    },
  });
  try {
    const s = t.engine.connect();
    void s.call('Thread/get', { ids: [] }).catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    s.close();
    assert.equal(signal?.aborted, true);
    await assert.rejects(s.call('Thread/get', { ids: [] }), isType('unavailable'));
  } finally {
    await t.cleanup();
  }
});

test('arguments and results are copied, so neither side shares objects', async () => {
  const kept: unknown[] = [];
  const result = { list: [{ id: 'x' }], notFound: [] };
  const t = await testEngine({
    handlers: {
      'Thread/get': args => {
        kept.push(args);
        return result as never;
      },
    },
  });
  try {
    const args = { ids: ['a'] };
    const answer = (await t.engine.connect().call('Thread/get', args)) as typeof result;
    args.ids.push('b');
    answer.list[0]!.id = 'changed';
    assert.deepEqual(kept[0], { ids: ['a'] });
    assert.equal(result.list[0]!.id, 'x');
  } finally {
    await t.cleanup();
  }
});

test('a caller of no known kind is refused at connect, and the default window caller is frozen', async () => {
  const t = await testEngine();
  try {
    for (const bad of [
      { kind: 'socket', scopes: ['read'] },
      { scopes: ['read'] },
      { kind: 'Listener', scopes: ['read'] },
      { kind: 'window' },
      undefined,
      null,
    ])
      assert.throws(() => t.engine.connect(bad as never), isType('forbidden'));
    assert.ok(Object.isFrozen(windowCaller) && Object.isFrozen(windowCaller.scopes));
  } finally {
    await t.cleanup();
  }
});

test('closing a session rejects its running calls and lets a handler start nothing more', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  const ran: string[] = [];
  const t = await testEngine({
    handlers: {
      'Operation/retry': async (_args, ctx) => {
        await gate;
        return ctx.redispatch('Thread/act', {} as never);
      },
      'Thread/act': () => {
        ran.push('act');
        return {} as never;
      },
    },
  });
  try {
    const s = t.engine.connect();
    const pending = s.call('Operation/retry', { opId: 'o1' });
    await new Promise(resolve => setImmediate(resolve));
    s.close();
    await assert.rejects(pending, isType('unavailable'));
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(ran, [], 'the re-dispatch after close never ran');
  } finally {
    await t.cleanup();
  }
});

test('the services are frozen: a handler cannot swap a port or the log for later calls', async () => {
  const t = await testEngine({
    handlers: {
      'Thread/get': (_args, ctx) => {
        assert.throws(() => {
          (ctx.services as { log: unknown }).log = null;
        });
        assert.throws(() => {
          (ctx.services.frames as { emit: unknown }).emit = null;
        });
        return { list: [], notFound: [] } as never;
      },
    },
  });
  try {
    await t.engine.connect().call('Thread/get', { ids: [] });
    assert.ok(Object.isFrozen(t.engine.services));
  } finally {
    await t.cleanup();
  }
});

test('arguments that cannot be copied answer validation, not internal', async () => {
  const t = await testEngine();
  try {
    const s = t.engine.connect();
    await assert.rejects(s.call('Thread/get', { ids: [], f: () => 1 }), isType('validation'));
    assert.doesNotMatch(t.logText(), /rpc\.failed/);
  } finally {
    await t.cleanup();
  }
});
