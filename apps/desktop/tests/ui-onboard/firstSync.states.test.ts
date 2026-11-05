// WP8.3: the first-sync screen's keys, live region and preview fixtures (DESIGN 7.12; Appendix C F8, F11). Split out
// of firstSync.model.test.ts so each file stays under the line cap; fixtures come from firstSync.helpers.ts.
// Run: cd apps/desktop && npx tsx --test tests/ui-onboard/firstSync.states.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DEFAULT_KEY_PREFS,
  createAppRegistry,
  type CommandContext,
  type ContextName,
} from '../../src/renderer/commands';
import type { SetupAccount } from '../../src/renderer/data';
import {
  buildFirstSyncView,
  firstSyncCommands,
  tagColor,
  type FirstSyncView,
} from '../../src/renderer/onboarding/firstSync/model';
import {
  DRILL_LETTERS,
  DRILL_START,
  drillCount,
  drillPick,
  drillPreset,
  drillReduce,
  type DrillState,
} from '../../src/renderer/onboarding/firstSync/drill.model';
import {
  FIXTURE_NOW,
  firstSyncScenes,
  firstSyncStates,
} from '../../src/renderer/onboarding/firstSync/states';
import { A, acct, ready, status, view } from './firstSync.helpers';

/* ───────────────────────── Esc [F8] and keys ───────────────────────── */

describe('first sync: Esc always opens Aplos [F8]', () => {
  const ctx = (stack: ContextName[]): CommandContext => ({
    stack,
    target: null,
    selection: [],
    conditions: {},
    prefs: DEFAULT_KEY_PREFS,
    focus: 'none',
  });
  const key = (k: string) => ({
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  });

  function wired(v: FirstSyncView, drill: DrillState | null) {
    const registry = createAppRegistry();
    const calls: string[] = [];
    let current = drill;
    const handlers = firstSyncCommands({
      view: () => v,
      drillOpen: () => current !== null,
      notice: () => undefined,
      onOpen: () => calls.push('open'),
      onDrill: k => {
        calls.push(`drill:${k}`);
        if (current) current = drillReduce(current, k);
      },
      onLeaveDrill: () => {
        calls.push('leave');
        current = null;
      },
    });
    for (const [id, h] of Object.entries(handlers)) registry.attach(id, h);
    const press = (k: string, stack: ContextName[]) => {
      const c = ctx(stack);
      const r = registry.resolve(key(k), c);
      if (r) registry.run(r.commandId, c);
      return r?.commandId ?? null;
    };
    return { calls, press, state: () => current };
  }

  test('keys-sync-esc-every-state-F8 – Esc opens Aplos in every fixture state, including the failed screen and inside the drill', () => {
    for (const [name, { scene }] of Object.entries(firstSyncScenes)) {
      const v = buildFirstSyncView({
        status: scene.status,
        accounts: [A],
        aiProvider: 'Groq',
        consentStored: true,
        now: FIXTURE_NOW,
      });
      const stack: ContextName[] = scene.drill
        ? ['onboarding', 'firstSync', 'drill']
        : ['onboarding', 'firstSync'];
      const w = wired(v, scene.drill ?? null);
      assert.equal(w.press('Escape', stack), 'onboarding.openAplos', name);
      assert.deepEqual(w.calls, ['open'], name);
    }
  });

  test('F8 failed screen: Esc continues to Aplos, and Return does too', () => {
    const v = view(status([acct('a', { state: 'failed', reasonCode: 'server.unavailable' })]));
    assert.equal(v.primary.label, 'Continue to Aplos');
    const w = wired(v, null);
    w.press('Escape', ['onboarding', 'firstSync']);
    w.press('Enter', ['onboarding', 'firstSync']);
    assert.deepEqual(w.calls, ['open', 'open']);
  });

  test('Return opens Aplos only once the button is on; before that it does nothing', () => {
    const waiting = wired(view(status([acct('a')])), null);
    waiting.press('Enter', ['onboarding', 'firstSync']);
    assert.deepEqual(waiting.calls, []);
    const inn = wired(view(status([ready('a', 8, 40, { state: 'sorting' })])), null);
    inn.press('Enter', ['onboarding', 'firstSync']);
    assert.deepEqual(inn.calls, ['open']);
  });

  test('keys-drill-letters – J/K, Space, E, A advance the drill through the registry; Return goes back to progress', () => {
    const w = wired(view(status([acct('a')])), DRILL_START);
    const drill: ContextName[] = ['onboarding', 'firstSync', 'drill'];
    for (const k of ['j', ' ', 'e', 'a']) w.press(k, drill);
    assert.equal(w.state()?.step, 4);
    w.press('Enter', drill);
    assert.deepEqual(w.calls, [
      'drill:next',
      'drill:suggested',
      'drill:done',
      'drill:ask',
      'leave',
    ]);
    assert.equal(
      w.press('e', ['onboarding', 'firstSync']),
      null,
      'E outside the drill does nothing',
    );
  });
});

/* ───────────────────────── one announcement per phase [F11] ───────────────────────── */

describe('first sync: one status announcement per phase [F11]', () => {
  test('F11 a full run announces connected, found, ready – and counting never re-announces', () => {
    const steps: SetupAccount[] = [
      acct('a', { state: 'connecting', firstWindow: { read: 0, total: 50, done: false } }),
      acct('a', { state: 'finding', firstWindow: { read: 0, total: 50, done: false } }),
      acct('a', { state: 'reading', firstWindow: { read: 0, total: 50, done: false } }),
      ...[5, 12, 24, 38, 49].map(n =>
        acct('a', { firstWindow: { read: n, total: 50, done: false } }),
      ),
      ready('a', 0, 40, { state: 'sorting' }),
      ...[8, 20, 33].map(n => ready('a', n, 40, { state: 'sorting' })),
      ready('a', 40, 40),
    ];
    let previous: FirstSyncView | undefined;
    const said: string[] = [];
    for (const [i, a] of steps.entries()) {
      const v = view(status([a], { done: i === steps.length - 1 }), { previous });
      if (v.announcement !== (previous?.announcement ?? '')) said.push(v.announcement);
      previous = v;
    }
    assert.deepEqual(said, [
      'Connected. Finding your recent mail.',
      'Found your recent mail. Reading the newest first.',
      'Your newest mail is in. Aplos can open now.',
    ]);
    assert.equal(previous?.autoOpen, true);
  });

  test('a failure is announced once, and the region text depends on the phase only', () => {
    const v = view(status([acct('a', { state: 'failed', reasonCode: 'server.unavailable' })]));
    assert.equal(v.phase, 'failed');
    assert.equal(v.announcement, 'Some mail didn’t come through.');
    const again = view(
      status([
        acct('a', {
          state: 'failed',
          firstWindow: { read: 30, total: 50, done: false },
          reasonCode: 'server.unavailable',
        }),
      ]),
      {
        previous: v,
      },
    );
    assert.equal(again.announcement, v.announcement);
  });

  test('the screen passes the announcement to the one OnboardingStep status region', () => {
    const markup = renderToStaticMarkup(firstSyncStates.progress.render());
    assert.match(
      markup,
      /<p class="ui-onboarding-step__sr" role="status">Found your recent mail\. Reading the newest first\.<\/p>/,
    );
  });

  test.todo(
    'F11 exactly one live region on the screen – blocked: ProgressSegments renders its own role="status" per account and in the ready variant (REQUEST R2 to ui-foundation); dom + axe once the Playwright base exists',
  );
});

/* ───────────────────────── fixtures render ───────────────────────── */

describe('first sync: preview fixtures', () => {
  const REQUIRED = [
    'progress',
    'progress-estimate',
    'paused',
    'paused-before-first-window',
    'ready',
    'partial',
    'ai-failed',
    'no-ai',
    'failed',
    'not-connected',
    'multi-account',
    'drill-step1',
    'drill-step3',
    'drill-done',
  ];

  test('every required state exists with a title and renders', () => {
    for (const name of REQUIRED) assert.ok(firstSyncStates[name], `missing ${name}`);
    for (const [name, entry] of Object.entries(firstSyncStates)) {
      assert.ok(entry.title.length > 0, name);
      const markup = renderToStaticMarkup(entry.render());
      assert.ok(markup.length > 0, name);
    }
  });

  test('design-one-filled-button – exactly one filled button in every state (a disabled Open Aplos still counts)', () => {
    // Mid-drill the practice surface owns the action row: "Back to progress" stays text until the drill is done
    // (onboarding-drill.html step1/step3 vs done), so those states carry no filled button at all.
    const MID_DRILL = new Set(['drill-step1', 'drill-step3']);
    for (const [name, entry] of Object.entries(firstSyncStates)) {
      const markup = renderToStaticMarkup(entry.render());
      const filled = markup.match(/<button[^>]*data-variant="filled"/g) ?? [];
      assert.equal(
        filled.length,
        MID_DRILL.has(name) ? 0 : 1,
        `${name}: ${filled.length} filled buttons`,
      );
    }
  });

  test('"Esc opens Aplos" is said on every state; bars are labelled "<address> sync"; no AI glyph', () => {
    for (const [name, entry] of Object.entries(firstSyncStates)) {
      const markup = renderToStaticMarkup(entry.render());
      assert.match(markup, /<kbd[^>]*>Esc<\/kbd> opens Aplos/, name);
      for (const m of markup.matchAll(/role="progressbar"[^>]*aria-label="([^"]*)"/g))
        assert.match(m[1], / sync$/, name);
      assert.doesNotMatch(markup, /sparkle|wand|lucide-star|brain|backdrop-filter|gradient/i, name);
    }
  });

  test('the ready state shows the drawn check and "Your mail is ready"; partial never does', () => {
    assert.match(renderToStaticMarkup(firstSyncStates.ready.render()), /Your mail is ready/);
    for (const name of ['partial', 'ai-failed', 'paused', 'failed']) {
      assert.doesNotMatch(
        renderToStaticMarkup(firstSyncStates[name].render()),
        /Your mail is ready|opens by itself/,
        name,
      );
    }
  });

  test('tagColor maps colour names and falls back to sky', () => {
    assert.equal(tagColor('hill'), 'hill');
    assert.equal(tagColor('tag-dusk'), 'dusk');
    assert.equal(tagColor('--tag-ember'), 'ember');
    assert.equal(tagColor('purple'), 'sky');
    assert.equal(tagColor(undefined), 'sky');
  });

  test('starting and empty never wait forever: Esc and a pointer path open Aplos', () => {
    const starting = view(undefined);
    assert.equal(starting.outcome, 'starting');
    assert.equal(starting.continueAnyway, true);
    const empty = view(status([]));
    assert.equal(empty.outcome, 'empty');
    assert.deepEqual(empty.primary, { label: 'Continue to Aplos', enabled: true });
  });
});

/* ───────────────────────── the drill ───────────────────────── */

describe('first sync: Try the keys', () => {
  test('the drill walks J/K → Space → E → A, ignores keys out of turn, and Z brings a letter back', () => {
    let s = DRILL_START;
    assert.equal(drillCount(s), '1 of 4');
    s = drillReduce(s, 'suggested');
    assert.equal(s.step, 0, 'Space before moving does nothing');
    s = drillReduce(s, 'next');
    assert.deepEqual([s.step, s.cursor], [1, 1]);
    s = drillReduce(s, 'done');
    assert.equal(s.step, 1, 'E out of turn does nothing');
    s = drillReduce(s, 'suggested');
    assert.deepEqual([s.step, s.ran], [2, true]);
    s = drillReduce(s, 'done');
    assert.deepEqual([s.step, s.ids.length, s.ran], [3, 2, false]);
    const undone = drillReduce(s, 'undo');
    assert.deepEqual(
      undone.ids,
      DRILL_LETTERS.map(l => l.id),
    );
    s = drillReduce(s, 'ask');
    assert.equal(s.step, 4);
    assert.equal(drillReduce(s, 'next'), s, 'keys do nothing after the end');
    assert.equal(drillPick(DRILL_START, 2).cursor, 2);
    assert.equal(drillPick(DRILL_START, 2).step, 1);
  });

  test('presets match the mockup states', () => {
    assert.equal(drillPreset('step1').step, 0);
    assert.deepEqual([drillPreset('step3').step, drillPreset('step3').ran], [2, true]);
    assert.deepEqual([drillPreset('done').step, drillPreset('done').ids.length], [4, 2]);
  });

  test('drill-no-engine-calls – the practice letters are invented and the drill files import no data hooks or api', async () => {
    const { readFile } = await import('node:fs/promises');
    for (const file of ['Drill.tsx', 'drill.model.ts']) {
      const src = await readFile(
        new URL(`../../src/renderer/onboarding/firstSync/${file}`, import.meta.url),
        'utf8',
      );
      assert.doesNotMatch(
        src,
        /\buse(SetupStatus|Accounts|View|Row|Home|Consent|Settings)\b|\bapi\./,
        file,
      );
    }
    for (const l of DRILL_LETTERS)
      assert.doesNotMatch(`${l.sender} ${l.subject} ${l.summary}`, /@(?!example)/);
  });

  test(
    'no auto-open while the drill is open (UNCLEAR-10) – container behaviour, dom',
    { todo: 'needs the Playwright base' },
    () => undefined,
  );
});
