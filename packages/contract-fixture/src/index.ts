import { buildScenario } from './scenarios';
import { controlHandler } from './control-impl';
import { Fixture, FixtureEngine, scenarios, type FixtureOptions, type Scenario } from './engine';
import { handlers } from './methods';

export { defaultNow, fakeClock, realClock, type FixtureClock } from './clock';
export {
  FixtureEngine,
  holdLapseMs,
  scenarios,
  stateCoalesceMs,
  windowIntervalMs,
  type FixtureOptions,
  type Scenario,
} from './engine';
export { controlMethod } from './control-types';

/**
 * The stand-in engine (plan 10 section 4.1): the whole v1 contract on in-memory data, behind the same `EngineConnection`
 * the real engine's transports implement. Deterministic for a seed and a fake clock. Test support only: nothing from
 * this package ships in the app.
 */
export function createFixtureEngine(
  options: FixtureOptions & { scenario: Scenario },
): FixtureEngine {
  if (!scenarios.includes(options.scenario))
    throw new Error(`Unknown scenario ${String(options.scenario)}.`);
  const fx = new Fixture(options.scenario, options);
  buildScenario(fx, options.scenario);
  fx.scheduleLater(true);
  fx.handlers = handlers(fx);
  fx.control = controlHandler(fx);
  return new FixtureEngine(fx);
}
