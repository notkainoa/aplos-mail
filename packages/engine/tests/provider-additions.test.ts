// Additive F3 changes asked for by the Providers lane: connect cancel, discardCredential, clearedFailures, partial search.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Governor } from '../src/sync/governor';
import { ActorHost } from '../src/sync/host';
import type {
  ConnectRequest,
  ConnectResult,
  ProviderFactory,
  SearchResult,
  StepResult,
  Quarantine,
} from '../src/ports';
import { effectiveClearedFailures } from '../src/ports';
import type { StorePort } from '../src/store';
import { FakeClock, FakeDeadlines, fakeLogger, portClock } from './sync-actor-helpers';

function hostWith(factory: ProviderFactory): ActorHost {
  const clock = new FakeClock({ auto: false });
  return new ActorHost({
    store: { commit() {} } as unknown as StorePort,
    governor: new Governor({ clock, role: 'secondary', random: () => 0 }),
    providers: [factory],
    tokens: { cached: () => undefined, refresh: async () => ({ token: 'x', expiresAt: 0 }) },
    clock: portClock(clock),
    log: fakeLogger(),
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
  await host.discardCredential('google', 'vault:test');
  assert.deepEqual(discarded, ['vault:test']);
  await host.dispose();
});

test('discardCredential fails closed when the factory cannot discard', async () => {
  const host = hostWith(fakeFactory());
  await assert.rejects(host.discardCredential('google', 'vault:test'), /unavailable|cannot/i);
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
