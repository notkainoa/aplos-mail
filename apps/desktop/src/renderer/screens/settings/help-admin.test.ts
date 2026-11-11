/** Settings → Help & about: saving the diagnostics report, verbose logging and "Export my data" (the controller's rules). */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createController } from './controller';
import type { SettingsApiPort, SettingsData, WriteFailure } from './ports';
import { verboseFrom, verboseLine, verboseOn } from './settings.model';
import { INITIAL_VIEW, type SettingsView } from './view';

function harness({ ports }: { ports: Partial<SettingsApiPort> }) {
  let view: SettingsView = { ...INITIAL_VIEW };
  let data = {} as SettingsData;
  const failures: (WriteFailure | null)[] = [];
  const actions = createController({
    ports: ports as SettingsApiPort,
    host: {},
    data: () => data,
    view: () => view,
    setView: patch => {
      view = { ...view, ...patch };
    },
    setData: patch => {
      data = { ...data, ...patch };
    },
    overlay: () => {},
    accountOverlay: () => {},
    fail: failure => void failures.push(failure),
    failure: () => failures.at(-1) ?? null,
  });
  return { actions, view: () => view, data: () => data, failures };
}

describe('ui-settings: help and support', () => {
  test('help.verbose.read – the switch opens as the engine says: a switch-off time means on, none means off', () => {
    assert.deepEqual(verboseFrom({ until: 5_000 }), { until: 5_000 });
    assert.equal(verboseFrom({}), undefined);
    assert.equal(verboseOn(verboseFrom({ until: 5_000 }), 1_000), true);
    assert.equal(
      verboseOn(verboseFrom({ until: 5_000 }), 6_000),
      false,
      'a time already past is off',
    );
    assert.equal(verboseOn(verboseFrom({}), 1_000), false);
  });

  test('help.diagnostics.save – Save report exports then saves; closing the save dialog says nothing; a failure keeps the dialog open', async () => {
    const calls: string[] = [];
    const h = harness({
      ports: {
        diagnosticsSave: async () => {
          calls.push('save');
          return { canceled: false };
        },
      },
    });
    await h.actions.saveDiagnostics();
    assert.deepEqual(calls, ['save']);
    assert.equal(h.view().diagnosticsSaved, true);
    assert.equal(h.view().diagnosticsCopied, false);

    const closed = harness({ ports: { diagnosticsSave: async () => ({ canceled: true }) } });
    await closed.actions.saveDiagnostics();
    assert.equal(closed.view().diagnosticsSaved, false, 'closing the save dialog is not a save');
    assert.equal(
      closed.failures.some(f => f !== null),
      false,
      'and not an error either',
    );

    const bad = harness({
      ports: {
        diagnosticsSave: async () => {
          throw new Error('disk full');
        },
      },
    });
    await bad.actions.saveDiagnostics();
    assert.equal(bad.failures.at(-1)?.op, 'save the report');
    bad.actions.closeDiagnostics();
    assert.equal(bad.failures.at(-1), null, "the dialog's line does not stay on the page");
    assert.equal(bad.view().busy.diagnostics, false);
  });

  test("help.verbose – the switch follows the engine's switch-off time and goes back to off by itself", async () => {
    const calls: boolean[] = [];
    const h = harness({
      ports: {
        verboseSet: async on => {
          calls.push(on);
          return { until: on ? 1_000 + 15 * 60_000 : undefined };
        },
      },
    });
    await h.actions.setVerbose(true);
    assert.deepEqual(calls, [true]);
    assert.equal(verboseOn(h.data().verbose, 1_000), true);
    assert.equal(verboseOn(h.data().verbose, 1_000 + 15 * 60_000), false, 'off at the time given');
    assert.match(verboseLine(h.data().verbose, 1_000), /^On until .+Headers only/);
    assert.match(verboseLine(h.data().verbose, 2_000_000), /in 15 minutes/);
    await h.actions.setVerbose(false);
    assert.equal(h.data().verbose, undefined);

    const bad = harness({
      ports: {
        verboseSet: async () => {
          throw new Error('nope');
        },
      },
    });
    await bad.actions.setVerbose(true);
    assert.equal(bad.data().verbose, undefined, 'the switch stays off when the engine refused');
    assert.equal(bad.failures.at(-1)?.op, 'change verbose logging');

    const keeps = harness({
      ports: {
        verboseSet: async on => {
          if (!on) throw new Error('nope');
          return { until: 5_000_000 };
        },
      },
    });
    await keeps.actions.setVerbose(true);
    await keeps.actions.setVerbose(false);
    assert.equal(verboseOn(keeps.data().verbose, 1_000), true, 'still on when turning off failed');

    const resolvers: ((r: { until?: number }) => void)[] = [];
    const slow = harness({
      ports: { verboseSet: () => new Promise(r => resolvers.push(r)) },
    });
    const first = slow.actions.setVerbose(true);
    assert.equal(await slow.actions.setVerbose(false), false, 'a second toggle waits');
    resolvers[0]({ until: 9_000_000 });
    await first;
    assert.equal(resolvers.length, 1);
    assert.equal(slow.view().busy.verbose, false);
  });

  test('help.exportData – Export my data saves once at a time; a refusal says so with Retry', async () => {
    const resolvers: ((r: { canceled: boolean }) => void)[] = [];
    let calls = 0;
    const h = harness({
      ports: {
        dataExport: () => {
          calls += 1;
          return new Promise(r => resolvers.push(r));
        },
      },
    });
    const first = h.actions.exportData();
    assert.equal(h.view().busy.dataExport, true);
    assert.equal(await h.actions.exportData(), false, 'a second Export does nothing');
    resolvers[0]({ canceled: false });
    await first;
    assert.equal(calls, 1);
    assert.equal(h.view().dataExported, true);

    const bad = harness({
      ports: {
        dataExport: async () => {
          throw new Error('too large');
        },
      },
    });
    await bad.actions.exportData();
    assert.equal(bad.view().dataExported, false);
    assert.equal(bad.failures.at(-1)?.op, 'export your data');
  });
});
