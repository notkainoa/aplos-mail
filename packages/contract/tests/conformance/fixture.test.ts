import { createFixtureEngine } from '@aplos/contract-fixture';
import { fixtureControl } from '@aplos/contract-fixture/control';
import { conformance } from './suite';

/**
 * The conformance suite against the stand-in engine (`@aplos/contract-fixture`) on `demo`, with its fake clock.
 * A runner may import its engine; the suite may not (see rules.test.ts). The real engine adds `engine.test.ts` here
 * with its own `expected-fail.engine.json`.
 */
conformance({
  name: 'fixture',
  async create() {
    const connection = createFixtureEngine({ scenario: 'demo' });
    const control = fixtureControl(connection);
    return {
      connection,
      advance: async ms => {
        await control.advanceClock({ ms });
      },
      connectAs: caller => connection.connect(caller),
      sleep: async ms => {
        await control.sleep({ ms });
      },
      standIn: true,
      compactLog: async () => {
        await control.compactLog();
      },
      reset: async reason => {
        await control.reset({ reason });
      },
      orderings: {
        modes: ['receiptFirst', 'frameFirst', 'together'],
        set: async mode => {
          await control.setOrdering({ ordering: { mode } });
        },
      },
    };
  },
});
