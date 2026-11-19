/**
 * The stand-in engine (F6, `@aplos/contract-fixture`) in-process, behind the F2 typed client: what the new renderer
 * boots on in development and what the data tests read windows from. Development and tests only. It is never part of
 * a release (plan 30 4.1 release rule): `renderer/main.tsx` reaches it only in a development build, and the real
 * transports (`../bridge.ts`'s MessagePort in Electron, tokenised HTTP and SSE in the browser preview) sit beside it.
 *
 * Kept apart from `./index.ts` so the data surface itself never pulls the fixture or zod into a bundle.
 */
import { configureZodForCsp } from '@aplos/contract';
import { createClient, type Client, type EngineConnection } from '@aplos/contract/client';
import { createFixtureEngine, type FixtureOptions, type Scenario } from '@aplos/contract-fixture';

/** Options for `connectStandIn`. */
export interface StandInOptions {
  /** The fixture scenario. Default `demo`: two accounts, 18 threads across every place, a week of events. */
  readonly scenario?: Scenario;
  /** The fixture clock: a start time for a fake clock (tests advance it), `'real'` for wall time (the running app, where nobody advances it). Default `'real'`. */
  readonly clock?: FixtureOptions['clock'];
}

/** One connection to an in-process stand-in engine. */
export interface StandIn {
  /** The F2 typed client on the connection: `client.api.view.watch(...)`, `client.subscribe(listener)`. */
  readonly client: Client;
  /** The engine itself, for a second connection: tests drive it with `fixtureControl(engine)` (`@aplos/contract-fixture/control`). */
  readonly engine: EngineConnection;
  /** Close the connection (its windows close with it). */
  close(): void;
}

/** Creates a stand-in engine on `scenario` and connects the typed client to it. The renderer's CSP forbids eval, so zod runs jitless. */
export function connectStandIn(options: StandInOptions = {}): StandIn {
  configureZodForCsp();
  const engine = createFixtureEngine({
    scenario: options.scenario ?? 'demo',
    clock: options.clock ?? 'real',
  });
  const client = createClient(engine.connect());
  return { client, engine, close: () => client.close() };
}
