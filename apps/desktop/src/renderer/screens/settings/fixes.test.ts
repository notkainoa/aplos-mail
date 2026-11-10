// Regression tests for the third review of the Settings screen: the leave() guard around a saved key's post-save
// work, the queue reload being best-effort, and Retry re-pushing the optimistic overlay. The anchor effect's pure
// decision is covered in screens.test.tsx.
// Run: npx tsx --test 'src/renderer/screens/settings/**/*.test.{ts,tsx}'   (from apps/desktop)
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createController } from './controller';
import type { SettingsApiPort, SettingsData, SettingsHost, WriteFailure } from './ports';
import { actThenList } from './settings.model';
import { INITIAL_VIEW, type SettingsView } from './view';
import {
  ALEX,
  baseSettings,
  consent,
  models,
  NOW,
  providers,
  queue,
  session,
  usage,
} from './preview/fixtures';
import type { SettingsPatch } from '../../data';

const dataAt = (over: Partial<SettingsData> = {}): SettingsData => ({
  settings: baseSettings(),
  accounts: [ALEX],
  session: session(),
  consent: consent(),
  now: NOW,
  providers: providers(),
  models: models(),
  usage: usage(),
  listener: { enabled: false },
  clients: [],
  queue: queue(),
  ...over,
});

function harness(
  over: {
    ports?: Partial<SettingsApiPort>;
    data?: Partial<SettingsData>;
    host?: SettingsHost;
  } = {},
) {
  let view: SettingsView = { ...INITIAL_VIEW };
  let data: SettingsData = dataAt(over.data);
  const overlays: (SettingsPatch | null)[] = [];
  const failures: (WriteFailure | null)[] = [];
  const actions = createController({
    ports: (over.ports ?? {}) as SettingsApiPort,
    host: over.host ?? {},
    data: () => data,
    view: () => view,
    setView: patch => {
      view = { ...view, ...patch };
    },
    setData: patch => {
      data = { ...data, ...patch };
    },
    overlay: patch => void overlays.push(patch),
    accountOverlay: () => {},
    fail: failure => void failures.push(failure),
  });
  return { actions, view: () => view, data: () => data, overlays, failures };
}

describe('ui-settings: third review fixes', () => {
  test('ai.key.leaveMidSave – leaving while the key saves skips the refresh and the post-save test', async () => {
    let resolveSet!: () => void;
    const calls: string[] = [];
    const h = harness({
      ports: {
        aiSetKey: () =>
          new Promise<void>(r => {
            resolveSet = r;
          }),
        loadProviders: async () => void calls.push('loadProviders'),
        aiTestKey: async p => {
          calls.push(`test:${p}`);
          return { ok: true, ms: 10 };
        },
      },
    });
    const pending = h.actions.submitKey('groq', 'k');
    h.actions.leave();
    resolveSet();
    assert.equal(await pending, true, 'the save itself still counts');
    assert.deepEqual(calls, [], 'no refresh or test runs after the page was left');
    assert.deepEqual(h.view().testing, {}, 'no test state appears after leave');
  });

  test('help.queue.reload – a failed reload after a successful action is best-effort, not a failure line', async () => {
    const calls: string[] = [];
    const wrapped = harness({
      ports: {
        queueRetry: async id => {
          const next = await actThenList(
            async () => void calls.push(`retry:${id}`),
            async () => {
              throw new Error('list down');
            },
          );
          assert.equal(next, undefined, 'the reload result is dropped');
        },
      },
    });
    await wrapped.actions.retryQueueItem('q-op');
    assert.deepEqual(calls, ['retry:q-op']);
    assert.equal(wrapped.failures.at(-1), null, 'the action succeeded, so no failure line');
    // The action's own rejection still propagates, so Retry means the write.
    await assert.rejects(
      actThenList(
        async () => {
          throw new Error('retry refused');
        },
        async () => [],
      ),
    );
    assert.deepEqual(
      await actThenList(
        async () => {},
        async () => queue(),
      ),
      queue(),
    );
  });

  test('overlay.retry – Retry on a rejected write pushes the optimistic patch again', async () => {
    let attempts = 0;
    let finish!: () => void;
    const h = harness({
      ports: {
        settingsSet: () => {
          attempts += 1;
          if (attempts === 1) return Promise.reject(new Error('rejected'));
          return new Promise<void>(r => {
            finish = r;
          });
        },
      },
    });
    assert.equal(await h.actions.set({ ui: { singleKeys: false } }), false);
    assert.equal(h.overlays.at(-1), null, 'the refusal took the patch down');
    const lines = h.failures.length;
    h.failures.at(-1)!.retry?.();
    assert.deepEqual(
      h.overlays.at(-1),
      { ui: { singleKeys: false } },
      'Retry moves the control at once',
    );
    finish();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(h.overlays.at(-1), null);
    assert.equal(h.failures.at(-1), null, 'the retry cleared the line');
    assert.equal(h.failures.length, lines + 1);
  });
});
