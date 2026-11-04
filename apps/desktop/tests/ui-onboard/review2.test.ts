// Regression tests for the round-2 adversarial review of the onboarding lane. Each test replays the reviewer's
// sequence. Pure logic in node, plus static renders of the presentational parts; DOM wiring is checked through a
// minimal fake and, where only wiring can regress, the source.
// Run: cd apps/desktop && npx tsx --test tests/ui-onboard/review2.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createAppRegistry,
  DEFAULT_KEY_PREFS,
  type CommandId,
  type KeyPrefs,
} from '../../src/renderer/commands';
import type { AiProvider } from '../../src/renderer/data';
import { focusTarget, buttonLabel } from '../../src/renderer/onboarding/focusTarget';
import { Drill } from '../../src/renderer/onboarding/firstSync/Drill';
import { DRILL_START, DRILL_STEPS } from '../../src/renderer/onboarding/firstSync/drill.model';
import { pauseLede, resumePhrase } from '../../src/renderer/onboarding/firstSync/model';
import {
  aiView,
  DEFAULT_VOICE,
  featuresFor,
  initialAi,
} from '../../src/renderer/onboarding/steps/ai.model';
import { NOW, acct, at, ready, status, view } from './firstSync.helpers';

const ROOT = path.resolve(import.meta.dirname, '../../src/renderer/onboarding');
const source = (file: string) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const noop = () => {};

/* ───────────────────────── A. a backfill error never blocks a clean finish ───────────────────────── */

describe('review2 finding A: backfill errors and the clean finish', () => {
  test('a transient backfill error does not flip a ready finish to partial', () => {
    const v = view(status([ready('a')], { done: true }), {
      // Build over a status that carries a backfill error; the screen still opens by itself.
    });
    const withBackfillError = view(
      status([ready('a')], {
        done: true,
        errors: [{ accountId: 'a', phase: 'backfill', reasonCode: 'rate.minute', at: at(9) }],
      }),
    );
    assert.equal(withBackfillError.outcome, 'ready');
    assert.equal(withBackfillError.autoOpen, true);
    assert.equal(v.autoOpen, true);
    // A first-window error is this screen's business and still blocks auto-open.
    const withScreenError = view(
      status([ready('a')], {
        done: true,
        errors: [{ accountId: 'a', phase: 'firstWindow', reasonCode: 'rate.minute', at: at(9) }],
      }),
    );
    assert.equal(withScreenError.autoOpen, false);
    assert.notEqual(withScreenError.outcome, 'ready');
  });
});

/* ───────────────────────── B. a retry's new run keeps the committed window ───────────────────────── */

describe('review2 finding B: first window across runs', () => {
  test('a Setup/retry that starts a new run never turns "Open Aplos" back off', () => {
    const committed = view(status([ready('a')], { done: true }));
    assert.equal(committed.canOpen, true);
    assert.equal(committed.rows[0].firstWindowIn, true);
    // Try again: the engine reports the same account under a new runId, still reading.
    const retried = view(
      status([acct('a', { runId: 'a-2', firstWindow: { read: 5, total: 50, done: false } })]),
      { previous: committed },
    );
    assert.equal(retried.rows[0].firstWindowIn, true, 'the retired run committed the window');
    assert.equal(retried.canOpen, true, 'Open Aplos stays enabled across the retry');
    assert.equal(retried.memory.accounts.a.firstWindowIn, true);
    // The new run's own progress still shows; only the committed flag carries.
    const read = retried.rows[0].checkpoints.find(c => c.step === 'read');
    assert.notEqual(read?.state, 'done');
  });
});

/* ───────────────────────── C. an AI pause names the AI provider ───────────────────────── */

describe('review2 finding C: the paused lede names the right party', () => {
  test('a pause carried on the ai block (ai.rateLimited) says "Groq asked", never Google', () => {
    const v = view(
      status([
        acct('a', {
          state: 'paused',
          firstWindow: { read: 50, total: 50, done: true },
          ai: { sorted: 12, total: 40, capped: 0, failed: 0, reasonCode: 'ai.rateLimited' },
          pausedUntil: at(14, 14),
        }),
      ]),
    );
    assert.equal(v.outcome, 'paused');
    assert.match(v.lede, /^Groq asked us to slow down\. Resuming at /);
    assert.doesNotMatch(v.lede, /Google/);
    const unnamed = view(
      status([
        acct('a', {
          state: 'paused',
          firstWindow: { read: 50, total: 50, done: true },
          ai: { sorted: 12, total: 40, capped: 0, failed: 0, reasonCode: 'ai.rateLimited' },
          pausedUntil: at(14, 14),
        }),
      ]),
      { aiProvider: 'your AI provider' },
    );
    assert.match(unnamed.lede, /^Your AI provider asked us to slow down\./);
  });
});

/* ───────────────────────── D. drill keycaps follow the owner's remaps ───────────────────────── */

describe('review2 finding D: drill keycaps come from the configured registry', () => {
  const drillProps = { state: DRILL_START, now: NOW, onKey: noop, onPick: noop };

  test('a remapped drill key shows its new keycap, not the default', () => {
    const remapped: KeyPrefs = {
      ...DEFAULT_KEY_PREFS,
      keymap: { 'drill.next': ['x'] } as KeyPrefs['keymap'],
    };
    const registry = createAppRegistry(remapped);
    const markup = renderToStaticMarkup(createElement(Drill, { ...drillProps, registry }));
    const kbds = markup.match(/<kbd[^>]*>[^<]*<\/kbd>/g) ?? [];
    assert.ok(
      kbds.some(k => k.includes('>X<')),
      `no X keycap in ${kbds}`,
    );
    assert.ok(!kbds.some(k => k.includes('>J<')), `stale J keycap in ${kbds}`);
    // Without a registry the caps are the catalog defaults (the preview's case).
    const defaults = renderToStaticMarkup(createElement(Drill, drillProps));
    assert.match(defaults, />J</);
    assert.match(defaults, />K</);
  });
});

/* ───────────────────────── E. no dead buttons on the practice letter ───────────────────────── */

describe('review2 finding E: the drill shows no Later or ⋯ button', () => {
  test('the drill has no Later or More step, and the lane hides those dead buttons', () => {
    // If a drill step ever teaches Later or ⋯, the buttons must be wired instead of hidden.
    const commands = new Set<CommandId>(DRILL_STEPS.flatMap(s => s.commands));
    assert.ok(!commands.has('mail.later' as CommandId) && !commands.has('list.more' as CommandId));
    // FocusLetter always draws them (its props require onLater/onMore), so the lane's CSS hides them.
    const markup = renderToStaticMarkup(
      createElement(Drill, { state: DRILL_START, now: NOW, onKey: noop, onPick: noop }),
    );
    assert.match(markup, /title="Later[^"]*"/, 'the dead Later control exists in the markup');
    const css = source('firstSync/firstSync.css');
    assert.match(
      css,
      /\.fs-drill[^{]*\.ui-focus-letter__actions[^{]*\{[^}]*display:\s*none/,
      "firstSync.css must hide the practice letter's dead Later and ⋯ buttons",
    );
  });
});

/* ───────────────────────── F. AI step focus while loading, and the voice fallback ───────────────────────── */

describe('review2 finding F: AI step focus and the voice fallback', () => {
  const hosted = (
    id: string,
    label: string,
    envVar: string,
    keySource: AiProvider['keySource'] = 'none',
  ): AiProvider => ({
    id,
    label,
    group: 'hosted',
    envVar,
    keySource,
    status: keySource === 'none' ? 'missingKey' : 'ready',
    keyOptional: false,
    trainsOnInputs: false,
    sttCapable: true,
    local: false,
  });
  const providers = (): AiProvider[] => [hosted('groq', 'Groq', 'GROQ_API_KEY', 'env')];

  test('while providers load the step focuses nothing, so Return cannot skip', () => {
    const vm = aiView(initialAi(), {
      providers: undefined,
      models: {},
      features: undefined,
      consent: undefined,
    });
    assert.equal(vm.loading, true);
    assert.equal(vm.focus, undefined, 'nothing may be focused while the table loads');
    assert.match(vm.focusKey, /:none$/, 'the key records that no target resolved yet');
  });

  test('the focus key changes when the resolved target does (loading → key field → Continue)', () => {
    const loading = aiView(initialAi(), {
      providers: undefined,
      models: {},
      features: undefined,
      consent: undefined,
    });
    // Providers in, Groq has a key, models not yet: Continue is not usable, Skip is the target.
    const waitingModels = aiView(initialAi(), {
      providers: providers(),
      models: {},
      features: undefined,
      consent: undefined,
    });
    const readyVm = aiView(initialAi(), {
      providers: providers(),
      models: {
        groq: [{ id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B', tools: true }],
      },
      features: undefined,
      consent: undefined,
    });
    assert.notEqual(loading.focusKey, waitingModels.focusKey);
    assert.notEqual(
      waitingModels.focusKey,
      readyVm.focusKey,
      'the key must change when Continue becomes the target',
    );
    assert.deepEqual(readyVm.focus, { kind: 'button', label: 'Continue' });
  });

  test('a voice choice that cannot resolve yet keeps the stored or default voice instead of failing', () => {
    const choice = { provider: 'groq', model: 'openai/gpt-oss-120b' };
    const noFeatures = {
      providers: providers(),
      models: {},
      features: undefined,
      consent: undefined,
    };
    const features = featuresFor(choice, noFeatures);
    assert.deepEqual(features?.voice, DEFAULT_VOICE, 'missing voice falls back to the default');
    assert.equal(features?.ask, choice);
    // A stored voice choice is kept, never overwritten by the default.
    const stored = { provider: 'openai' as const, model: 'gpt-4o-transcribe' };
    const kept = featuresFor(choice, {
      providers: providers(),
      models: {},
      features: {
        ask: choice,
        summaries: choice,
        drafts: choice,
        plans: choice,
        voice: stored,
      },
      consent: undefined,
    });
    assert.deepEqual(kept?.voice, stored);
  });
});

/* ───────────────────────── G. focus lands on the step's action, never the notice's ───────────────────────── */

describe('review2 finding G: the window notice never shadows the step action', () => {
  /** The smallest DOM `focusTarget` needs: labelled buttons in containers, a focus() that records. */
  function fakeButton(
    label: string,
    where: 'actions' | 'consent' | 'footButtons' | 'main',
    opts: { disabled?: boolean; notice?: boolean } = {},
  ) {
    return {
      disabled: opts.disabled === true,
      childNodes: [
        { nodeName: '#text', textContent: label },
        { nodeName: 'KBD', textContent: 'Return' },
      ],
      where,
      notice: opts.notice === true,
      focus() {
        (globalThis.document as { activeElement?: unknown }).activeElement = this;
      },
      closest(selector: string) {
        return selector === '[data-notice]' && this.notice ? this : null;
      },
    };
  }
  type FakeButton = ReturnType<typeof fakeButton>;

  function fakeRoot(buttons: FakeButton[]) {
    const inActions = (b: FakeButton) =>
      b.where === 'actions' || b.where === 'consent' || b.where === 'footButtons';
    return {
      querySelectorAll(selector: string): FakeButton[] {
        if (selector.includes('__actions') || selector.includes('__buttons'))
          return buttons.filter(inActions);
        if (selector === 'main button, footer button') return buttons;
        return [];
      },
      querySelector(): null {
        return null;
      },
    };
  }

  test("Return retries the step's connect, not the notice's demo load", () => {
    const glob = globalThis as { document?: { activeElement: unknown } };
    const doc = glob.document;
    glob.document = { activeElement: null };
    try {
      // WindowNoticeLine's "Try again" sits in `main` before the step's filled "Try again".
      const noticeRetry = fakeButton('Try again', 'main', { notice: true });
      const stepRetry = fakeButton('Try again', 'actions');
      const different = fakeButton('Use a different address', 'actions');
      const root = fakeRoot([noticeRetry, stepRetry, different]);
      assert.equal(
        focusTarget(root as unknown as HTMLElement, { kind: 'button', label: 'Try again' }),
        true,
      );
      assert.equal(glob.document?.activeElement, stepRetry);
      // A target that exists only in the body (the local screen's "Check again" row) is still found.
      const check = fakeButton('Check again', 'main');
      const root2 = fakeRoot([noticeRetry, check, stepRetry]);
      assert.equal(
        focusTarget(root2 as unknown as HTMLElement, { kind: 'button', label: 'Check again' }),
        true,
      );
      assert.equal(glob.document?.activeElement, check);
      // buttonLabel strips the keycap, so a label with a Return cap still matches.
      assert.equal(buttonLabel(stepRetry as unknown as Element), 'Try again');
    } finally {
      glob.document = doc;
    }
  });
});

/* ───────────────────────── H. resume times use the owner's locale ───────────────────────── */

describe("review2 finding H: the paused lede uses the owner's locale", () => {
  test('resumePhrase and the pause lede format with the process locale, not a hardcoded en-US', () => {
    const time = { hour: 'numeric' as const, minute: '2-digit' as const };
    assert.equal(
      resumePhrase(at(14, 14), NOW),
      `at ${new Date(at(14, 14)).toLocaleTimeString(undefined, time)}`,
    );
    assert.equal(
      resumePhrase(at(9, 0, 1), NOW),
      `tomorrow at ${new Date(at(9, 0, 1)).toLocaleTimeString(undefined, time)}`,
    );
    const weekday = new Date(at(9, 0, 3)).toLocaleDateString(undefined, { weekday: 'long' });
    assert.equal(
      resumePhrase(at(9, 0, 3), NOW),
      `on ${weekday} at ${new Date(at(9, 0, 3)).toLocaleTimeString(undefined, time)}`,
    );
    assert.match(pauseLede('rate.minute', at(14, 14), NOW, false), /Resuming at /);
    assert.doesNotMatch(source('firstSync/model.ts'), /'en-US'|"en-US"/);
  });
});
