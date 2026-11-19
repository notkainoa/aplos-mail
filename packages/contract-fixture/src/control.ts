import type { EngineConnection, EngineSession } from '@aplos/contract/client';
import { controlMethod, type Knob, type KnobArgs, type KnobResult } from './control-types';

export type {
  ControlArgs,
  Knob,
  KnobArgs,
  KnobResult,
  Ordering,
  SetupState,
  Snapshot,
} from './control-types';
export { controlMethod };

/** A knob that takes no arguments, e.g. `control.unpark()` or `control.snapshot()`. */
type EmptyArgs = Record<string, never>;

/** `control.failNextWrite({mode: 'reject'})`, `control.advanceClock({ms: 250})`: one typed function per knob. */
export type FixtureControl = {
  [K in Knob]: EmptyArgs extends KnobArgs<K>
    ? (args?: KnobArgs<K>) => Promise<KnobResult<K>>
    : (args: KnobArgs<K>) => Promise<KnobResult<K>>;
};

/**
 * The typed client for the test-only `Fixture/control` channel (`@aplos/contract-fixture/control`). It calls the channel
 * on a session like any method, so a harness can drive a fixture behind a MessagePort or the preview's HTTP binding
 * exactly as it drives one in-process. A real engine refuses the call with `unsupported`.
 */
export function fixtureControl(target: EngineSession | EngineConnection): FixtureControl {
  const session = 'call' in target ? target : target.connect();
  return new Proxy({} as FixtureControl, {
    get: (_t, knob) =>
      typeof knob === 'string'
        ? (args: object = {}) => session.call(controlMethod, { ...args, knob })
        : undefined,
  });
}
