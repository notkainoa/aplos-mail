// Additive F3 changes asked for by the Providers lane: connect cancel, discardCredential, clearedFailures, partial search.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Governor } from '../src/sync/governor';
import { ActorHost } from '../src/sync/host';
import type {
  AdapterAccount,
  ConnectRequest,
  ConnectResult,
  ProviderFactory,
  SearchResult,
  StepResult,
  Quarantine,
} from '../src/ports';
import { effectiveClearedFailures } from '../src/ports';
import { stepWrites } from '../src/sync/facts';
import type { StorePort } from '../src/store';
import {
  FakeClock,
  FakeDeadlines,
  fakeLogger,
  portClock,
  type LogLine,
} from './sync-actor-helpers';

/** A store that holds one committed account row (`committed`) and nothing else. */
function storeWith(committed?: string): StorePort {
  const row = {
    provider: 'google',
    address: 'owner@example.test',
    capabilities: '{}',
    granted_scopes: null,
    baseline_done_at: null,
    refresh_expires_at: null,
    status: 'ok',
  };
  const read = (fn: (q: { get: (sql: string, id: string) => unknown }) => unknown) =>
    fn({ get: (_sql, id) => (id === committed ? row : undefined) });
  return { commit() {}, read } as unknown as StorePort;
}

function hostWith(factory: ProviderFactory, committed?: string, lines: LogLine[] = []): ActorHost {
  const clock = new FakeClock({ auto: false });
  return new ActorHost({
    store: storeWith(committed),
    governor: new Governor({ clock, role: 'secondary', random: () => 0 }),
    providers: [factory],
    tokens: { cached: () => undefined, refresh: async () => ({ token: 'x', expiresAt: 0 }) },
    clock: portClock(clock),
    log: fakeLogger(lines),
    deadlines: new FakeDeadlines(),
    deviceId: 'device-a',
    env: () => ({ now: 0, focused: false, windowVisible: false, onBattery: false }),
  });
}

function abortableFactory(seen: { signal?: AbortSignal }): ProviderFactory {
  return {
    kind: 'google',
    connect: (_req, ctx) => {
      seen.signal = ctx.signal;
      return new Promise((_resolve, reject) => {
        if (ctx.signal.aborted) reject(new Error('cancelled'));
        ctx.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    },
    budgets: () => [],
    open: () => {
      throw new Error('not used');
    },
  };
}

test('ConnectRequest.signal reaches ConnectContext.signal and aborts the flow', async () => {
  const seen: { signal?: AbortSignal } = {};
  const host = hostWith(abortableFactory(seen));
  const controller = new AbortController();
  const req: ConnectRequest = { mode: 'new', signal: controller.signal };
  const pending = host.connect('acct-1', 'google', req);
  assert.equal(seen.signal?.aborted, false);
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(seen.signal?.aborted, true);
  await host.dispose();
});

test('a signal already aborted before connect aborts the context at once', async () => {
  const seen: { signal?: AbortSignal } = {};
  const host = hostWith(abortableFactory(seen));
  const pending = host.connect('acct-1', 'google', {
    mode: 'new',
    signal: AbortSignal.abort(),
  });
  await assert.rejects(pending, /cancelled/);
  await host.dispose();
});

function fakeFactory(extra: Partial<ProviderFactory> = {}): ProviderFactory {
  return {
    kind: 'google',
    connect: async () => RESULT,
    budgets: () => [],
    open: () => {
      throw new Error('not used');
    },
    ...extra,
  };
}

const RESULT = { credentialRef: 'vault:new' } as unknown as ConnectResult;

/** A signal that counts the abort listeners currently attached. */
function countingSignal(signal: AbortSignal): { signal: AbortSignal; live: () => number } {
  let live = 0;
  const wrapper = new Proxy(signal, {
    get(target, key) {
      if (key === 'addEventListener')
        return (...args: Parameters<AbortSignal['addEventListener']>) => {
          live += 1;
          target.addEventListener(...args);
        };
      if (key === 'removeEventListener')
        return (...args: Parameters<AbortSignal['removeEventListener']>) => {
          live -= 1;
          target.removeEventListener(...args);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { signal: wrapper, live: () => live };
}

test('discardCredential forwards the kind and ref to the provider factory', async () => {
  const discarded: string[] = [];
  const host = hostWith(
    fakeFactory({
      discardCredential: async ref => {
        discarded.push(ref);
      },
    }),
  );
  await host.discardCredential('acct-1', 'google', 'vault:test');
  assert.deepEqual(discarded, ['vault:test']);
  await host.dispose();
});

test("discardCredential never discards the ref the account's committed row may point at", async () => {
  const discarded: string[] = [];
  const host = hostWith(
    fakeFactory({
      discardCredential: async ref => {
        discarded.push(ref);
      },
    }),
    'acct-1',
  );
  await host.discardCredential('acct-1', 'google', 'acct-1');
  assert.deepEqual(discarded, []);
  // Another account without a committed row (a first-time connect) is still discarded.
  await host.discardCredential('acct-2', 'google', 'vault:new');
  assert.deepEqual(discarded, ['vault:new']);
  await host.dispose();
});

test('a late result after the abort keeps an existing account credential and still rejects', async () => {
  const discarded: string[] = [];
  const controller = new AbortController();
  const host = hostWith(
    fakeFactory({
      connect: async () => {
        controller.abort(new Error('cancelled'));
        return { credentialRef: 'acct-1' } as unknown as ConnectResult;
      },
      discardCredential: async ref => {
        discarded.push(ref);
      },
    }),
    'acct-1',
  );
  await assert.rejects(
    host.connect('acct-1', 'google', { mode: 'reconnect', signal: controller.signal }),
    /cancelled/,
  );
  assert.deepEqual(discarded, []);
  await host.dispose();
});

test('discardCredential fails closed when the factory cannot discard', async () => {
  const host = hostWith(fakeFactory());
  await assert.rejects(
    host.discardCredential('acct-1', 'google', 'vault:test'),
    /unavailable|cannot/i,
  );
  await host.dispose();
});

test('a result that arrives after the abort is discarded and connect rejects', async () => {
  const discarded: string[] = [];
  const controller = new AbortController();
  const host = hostWith(
    fakeFactory({
      connect: async () => {
        controller.abort(new Error('cancelled'));
        return RESULT;
      },
      discardCredential: async ref => {
        discarded.push(ref);
      },
    }),
  );
  await assert.rejects(
    host.connect('acct-1', 'google', { mode: 'new', signal: controller.signal }),
    /cancelled/,
  );
  assert.deepEqual(discarded, ['vault:new']);
  await host.dispose();
});

test('a failing discard after an abort still rejects with the abort reason', async () => {
  const controller = new AbortController();
  const host = hostWith(
    fakeFactory({
      connect: async () => {
        controller.abort(new Error('cancelled'));
        return RESULT;
      },
      discardCredential: async () => {
        throw new Error('vault down');
      },
    }),
  );
  await assert.rejects(
    host.connect('acct-1', 'google', { mode: 'new', signal: controller.signal }),
    /cancelled/,
  );
  await host.dispose();
});

test('connect removes its abort listener when the factory throws synchronously', async () => {
  const counted = countingSignal(new AbortController().signal);
  const host = hostWith(
    fakeFactory({
      connect: () => {
        throw new Error('boom');
      },
    }),
  );
  await assert.rejects(
    host.connect('acct-1', 'google', { mode: 'new', signal: counted.signal }),
    /boom/,
  );
  assert.equal(counted.live(), 0);
  await host.dispose();
});

test('effectiveClearedFailures drops items that are also quarantined', () => {
  const error = { kind: 'permanent' } as unknown as Quarantine['error'];
  assert.deepEqual(
    effectiveClearedFailures({
      clearedFailures: ['a', 'b', 'c'],
      quarantine: [{ item: 'b', error }],
    }),
    ['a', 'c'],
  );
  assert.deepEqual(effectiveClearedFailures({ quarantine: [] }), []);
});

test('StepResult.clearedFailures and SearchResult.partial are optional and typed', () => {
  const quarantine: Quarantine[] = [];
  const step: StepResult = {
    nextStates: [],
    done: true,
    quarantine,
    clearedFailures: ['m1'],
    costUnits: 0,
  };
  const search: SearchResult = { upserts: [], remoteThreadIds: [], partial: true, costUnits: 0 };
  assert.deepEqual(step.clearedFailures, ['m1']);
  assert.equal(search.partial, true);
});

test('stepWrites turns clearedFailures into failure:null writes after the quarantine writes, quarantine winning', () => {
  const account = { id: 'acct-1', provider: 'google', address: 'a@b.test' } as AdapterAccount;
  const error = { reason: 'bad' } as unknown as Quarantine['error'];
  const result = {
    nextStates: [],
    done: false,
    costUnits: 0,
    clearedFailures: ['ok-1', 'poison', 'ok-2'],
    quarantine: [{ item: 'poison', error }],
  } as unknown as StepResult;
  const writes = stepWrites(result, {
    account,
    step: { scope: 'window:inbox', lane: 'incremental', origin: 'incremental', trigger: 'poll' },
    state: { scope: 'window:inbox', generation: 1, updatedAt: 0 },
    now: 0,
    failures: new Map(),
    baselineDone: true,
  });
  const failures = writes.flatMap(w =>
    w.kind === 'syncFailure' ? [[w.item, w.failure === null ? null : 'set']] : [],
  );
  assert.deepEqual(failures, [
    ['poison', 'set'],
    ['ok-1', null],
    ['ok-2', null],
  ]);
});

test('stepWrites carries a remote draft body up to the draft limit and cuts one over it just past the limit', () => {
  const account = { id: 'acct-1', provider: 'google', address: 'a@b.test' } as AdapterAccount;
  const draft = (id: string, size: number) => ({
    remoteDraftId: id,
    remoteMessageId: `m-${id}`,
    changedAt: 1,
    html: 'x'.repeat(size),
    text: 'y'.repeat(size),
  });
  const result = {
    nextStates: [],
    done: false,
    costUnits: 0,
    drafts: [draft('fits', 1_000_000), draft('over', 1_000_001)],
  } as unknown as StepResult;
  const writes = stepWrites(result, {
    account,
    step: { scope: 'window:inbox', lane: 'incremental', origin: 'incremental', trigger: 'poll' },
    state: { scope: 'window:inbox', generation: 1, updatedAt: 0 },
    now: 0,
    failures: new Map(),
    baselineDone: true,
  });
  const byId = new Map(
    writes.flatMap(w => (w.kind === 'remoteDraft' ? [[w.remoteDraftId, w]] : [])),
  );
  assert.equal(byId.get('fits')!.html?.length, 1_000_000);
  assert.equal(byId.get('fits')!.text?.length, 1_000_000);
  assert.equal(byId.get('over')!.html?.length, 1_000_001, 'still over, so the engine sees it');
  assert.equal(byId.get('over')!.text?.length, 1_000_001);
});

test('stepWrites marks a remote draft copy with an inline part as having parts the engine cannot carry', () => {
  const account = { id: 'acct-1', provider: 'google', address: 'a@b.test' } as AdapterAccount;
  const message = (
    remoteId: string,
    attachments: { part: string; inline: boolean }[] | undefined,
  ) => ({
    remoteId,
    remoteThreadId: 't',
    to: [],
    cc: [],
    date: 1,
    internalDate: 1,
    flags: { seen: true, flagged: false, draft: true, fromMe: true },
    placements: [],
    list: {},
    partial: false,
    ...(attachments ? { attachments } : {}),
  });
  const draft = (id: string, attachments: { part: string; inline: boolean }[] | undefined) => ({
    remoteDraftId: id,
    remoteMessageId: `m-${id}`,
    changedAt: 1,
    html: '<p>x</p>',
    message: message(`m-${id}`, attachments),
  });
  const result = {
    nextStates: [],
    done: false,
    costUnits: 0,
    drafts: [
      draft('inline', [{ part: '1', inline: true }]),
      draft('file', [{ part: '2', inline: false }]),
      draft('none', []),
      draft('unknown', undefined),
    ],
  } as unknown as StepResult;
  const writes = stepWrites(result, {
    account,
    step: { scope: 'window:inbox', lane: 'incremental', origin: 'incremental', trigger: 'poll' },
    state: { scope: 'window:inbox', generation: 1, updatedAt: 0 },
    now: 0,
    failures: new Map(),
    baselineDone: true,
  });
  const has = new Map(
    writes.flatMap(w =>
      w.kind === 'remoteDraft' ? [[w.remoteDraftId, w.message?.hasAttachments]] : [],
    ),
  );
  assert.equal(has.get('inline'), true, 'an inline image counts');
  assert.equal(has.get('file'), true);
  assert.equal(has.get('none'), false);
  assert.equal(has.get('unknown'), undefined, 'a provider that does not say stays unsaid');
});

test('a failed factory discard is logged once, with the kind and no ref, and still rejects', async () => {
  const lines: LogLine[] = [];
  const host = hostWith(
    fakeFactory({
      discardCredential: async () => {
        throw new Error('vault locked: secret-ref-123');
      },
    }),
    undefined,
    lines,
  );
  await assert.rejects(host.discardCredential('acct-1', 'google', 'secret-ref-123'));
  const failed = lines.filter(l => l.fields.method === 'Account/discardCredential');
  assert.deepEqual(
    failed.map(l => l.fields.reason),
    ['google.failed'],
  );
  assert.doesNotMatch(JSON.stringify(lines), /secret-ref-123/);
  await host.dispose();
});
