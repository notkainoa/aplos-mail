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
import { withNativeStubs } from './native-stub';
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

export interface HarnessOptions {
  readonly scenario?: Scenario;
  readonly seed?: number;
  readonly checkResults?: boolean;
  /**
   * Hand each call to the engine on a later task, as a real transport does. The in-process stand-in otherwise runs
   * the engine's work inside `call()`, so a timing of `act()` would include it.
   */
  readonly deferred?: boolean;
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const engine = createFixtureEngine({
    scenario: options.scenario ?? 'demo',
    clock: defaultNow,
    seed: options.seed ?? 1,
    checkResults: options.checkResults ?? true,
  });
  const calls: RecordedCall[] = [];
  const inner = withNativeStubs(engine.connect());
  const session: EngineSession = {
    call(method, args, callOptions) {
      calls.push({ method: method as MethodName, args });
      if (!options.deferred) return inner.call(method, args, callOptions);
      return nextTask().then(() => inner.call(method, args, callOptions));
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
