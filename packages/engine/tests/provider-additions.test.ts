// Additive F3 changes asked for by the Providers lane: connect cancel, discardCredential, clearedFailures, partial search.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Governor } from '../src/sync/governor';
import { ActorHost } from '../src/sync/host';
import type {
  AccountActorHost,
  ConnectRequest,
  ProviderFactory,
  SearchResult,
  StepResult,
  Quarantine,
} from '../src/ports';
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

test('discardCredential is an optional host method that takes the stored credential ref', async () => {
  const discarded: string[] = [];
  const host: Pick<AccountActorHost, 'discardCredential'> = {
    discardCredential: async ref => {
      discarded.push(ref);
    },
  };
  await host.discardCredential?.('vault:test');
  assert.deepEqual(discarded, ['vault:test']);
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
