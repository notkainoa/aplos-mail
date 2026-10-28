/**
 * A data layer on a fake-clock stand-in engine, for node tests with no DOM: a manual frame scheduler and manual
 * timers, every engine call recorded, `fixtureControl` on a second session, and a second client to read engine truth.
 * Test support only; never imported by the app.
 */
import { createClient, type Client, type EngineSession } from '@aplos/contract/client';
import { createFixtureEngine, defaultNow, type Scenario } from '@aplos/contract-fixture';
import { fixtureControl, type FixtureControl } from '@aplos/contract-fixture/control';
import type { MethodName } from './contract-shapes';
import { createDataLayer, type DataLayer } from './layer';
import {
  createManualScheduler,
  createManualTimers,
  type ManualScheduler,
  type ManualTimers,
} from './scheduler';

export interface RecordedCall {
  readonly method: MethodName;
  readonly args: unknown;
}

export interface Harness {
  readonly layer: DataLayer;
  readonly control: FixtureControl;
  /** A separate client on the same engine, for reading what the engine holds. */
  readonly truth: Client;
  readonly scheduler: ManualScheduler;
  readonly timers: ManualTimers;
  readonly calls: RecordedCall[];
  /** Calls of one method since the last `clearCalls()`. */
  callsOf(method: MethodName): RecordedCall[];
  clearCalls(): void;
  /** Let answers land and frames apply until nothing moves. */
  settle(): Promise<void>;
  close(): void;
}

const nextTask = () => new Promise<void>(resolve => setImmediate(resolve));

export function createHarness(
  options: { scenario?: Scenario; seed?: number; checkResults?: boolean } = {},
): Harness {
  const engine = createFixtureEngine({
    scenario: options.scenario ?? 'demo',
    clock: defaultNow,
    seed: options.seed ?? 1,
    checkResults: options.checkResults ?? true,
  });
  const calls: RecordedCall[] = [];
  const inner = engine.connect();
  const session: EngineSession = {
    call(method, args, callOptions) {
      calls.push({ method: method as MethodName, args });
      return inner.call(method, args, callOptions);
    },
    subscribe: listener => inner.subscribe(listener),
    close: () => inner.close(),
  };
  const scheduler = createManualScheduler();
  const timers = createManualTimers(defaultNow);
  let minted = 0;
  const layer = createDataLayer({
    session,
    scheduler,
    timers,
    mintId: prefix => `${prefix}-t${++minted}`,
  });
  const truthSession = engine.connect();
  const truth = createClient(truthSession);
  const control = fixtureControl(engine);
  return {
    layer,
    control,
    truth,
    scheduler,
    timers,
    calls,
    callsOf: method => calls.filter(c => c.method === method),
    clearCalls: () => {
      calls.length = 0;
    },
    async settle() {
      // Stop once nothing moves: a reply the engine holds back on its fake clock never lands by waiting.
      let quiet = 0;
      let last = '';
      for (let i = 0; i < 200 && quiet < 3; i++) {
        await nextTask();
        scheduler.flush();
        const now = `${layer.emitter.version}:${layer.client.inFlight}:${calls.length}:${scheduler.pending}`;
        quiet = now === last && !scheduler.pending ? quiet + 1 : 0;
        last = now;
      }
    },
    close() {
      layer.close();
      truth.close();
    },
  };
}
