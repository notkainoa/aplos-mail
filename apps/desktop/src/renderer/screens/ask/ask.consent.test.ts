/**
 * The consent gate behind every run start (final review findings 1–3): "Not now" dismisses only the
 * line — the gate still holds the next Return, suggestion pick, send-now or Retry — an unloaded
 * consent record holds rather than waves a run through, and the palette's pending question waits
 * for it. Plus the dock width write-back's persist rule.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Consent } from '../../data';
import {
  consentGate,
  consentLineNeeded,
  consentNeededInput,
  dockView,
  initialAsk,
  pendingQuestionReady,
  setField,
  submit,
  type AskInputs,
} from './ask.model';
import { dockWidthPersisted } from './askStore';

const MODEL = { provider: 'groq', model: 'demo' } as const;

const consent = (extra: Partial<Consent> = {}): Consent => ({
  scope: 'background',
  granted: false,
  version: 1,
  currentVersion: 1,
  needsReconsent: false,
  ...extra,
});

function inputs(extra: Partial<AskInputs> = {}): AskInputs {
  return {
    frames: [],
    providers: [{ id: 'groq', label: 'Groq', local: false, status: 'ready' }],
    askReady: true,
    askModel: MODEL,
    calendars: new Map(),
    suggestions: [],
    recents: [],
    ...extra,
  };
}

test('"Not now" dismisses only the line: the next Return is held and re-shows it', () => {
  const owed = consent();
  // The gate never consults the dismissal — ungranted still holds a submit.
  assert.equal(consentNeededInput(true, MODEL, owed), true);
  // The line itself is dismissed for this version.
  assert.equal(consentLineNeeded(owed, owed.currentVersion, false), false);

  const state = setField(initialAsk, 'what next?');
  const gate = inputs({ consentNeeded: consentNeededInput(true, MODEL, owed) });
  const held = submit(state, dockView(state, gate), 'ask');
  assert.deepEqual(held.effects, [], 'the question is not sent without Allow');
  assert.deepEqual(held.state.consentHeld, { question: 'what next?', searchAll: false });
  assert.equal(held.state.field, 'what next?', 'the typed text stays in the field');
  // The hold brings the line back, so the owner is never stuck silently.
  assert.equal(
    consentLineNeeded(owed, owed.currentVersion, held.state.consentHeld !== undefined),
    true,
  );
});

test('an unknown consent record holds every run start; granted, stale and no-provider behave', () => {
  assert.equal(consentGate(undefined), true, 'an unloaded record is not consent');
  assert.equal(consentGate(consent()), true);
  assert.equal(consentGate(consent({ granted: true })), false);
  assert.equal(consentGate(consent({ granted: true, needsReconsent: true })), true);
  // The input the host computes for `consentNeeded`.
  assert.equal(consentNeededInput(false, MODEL, undefined), true, 'sources still loading');
  assert.equal(consentNeededInput(true, MODEL, undefined), true, 'consent still loading');
  assert.equal(consentNeededInput(false, MODEL, consent({ granted: true })), false);
  assert.equal(consentNeededInput(true, MODEL, consent({ granted: true })), false);
  // No provider: the gate steps aside and the run's refusal shows the no-provider pane.
  assert.equal(consentNeededInput(true, undefined, undefined), false);
  assert.equal(consentNeededInput(true, undefined, consent()), false);
});

test('the pending palette question waits for the sources and the consent record', () => {
  assert.equal(pendingQuestionReady(false, undefined), false);
  assert.equal(
    pendingQuestionReady(true, undefined),
    false,
    'consent unknown: it would run past the gate',
  );
  assert.equal(pendingQuestionReady(false, consent({ granted: true })), false);
  assert.equal(pendingQuestionReady(true, consent({ granted: true })), true);
  assert.equal(pendingQuestionReady(true, consent()), true);
});

test('once the record answers, a pending question runs when granted and holds when ungranted', () => {
  const question = 'Ask about this email';
  const ready = setField(initialAsk, question);

  const grantedView = dockView(
    ready,
    inputs({ consentNeeded: consentNeededInput(true, MODEL, consent({ granted: true })) }),
  );
  const ran = submit(ready, grantedView, 'ask');
  assert.deepEqual(
    ran.effects.map(e => e.kind),
    ['run'],
  );
  assert.equal(ran.state.run?.question, question);

  const owedView = dockView(
    ready,
    inputs({ consentNeeded: consentNeededInput(true, MODEL, consent()) }),
  );
  const held = submit(ready, owedView, 'ask');
  assert.deepEqual(held.effects, []);
  assert.equal(held.state.consentHeld?.question, question);
  // The consent line is up even if an earlier "Not now" dismissed this version.
  assert.equal(consentLineNeeded(consent(), 1, held.state.consentHeld !== undefined), true);
});

test('the line shows while consent is owed and hides only for the dismissed version', () => {
  const owed = consent({ currentVersion: 2 });
  assert.equal(consentLineNeeded(owed, undefined, false), true);
  assert.equal(consentLineNeeded(owed, 1, false), true, 'an older dismissal misses a new version');
  assert.equal(consentLineNeeded(owed, 2, false), false);
  assert.equal(
    consentLineNeeded(consent({ granted: true }), undefined, true),
    false,
    'granted: no line while a hold releases',
  );
  assert.equal(
    consentLineNeeded(undefined, undefined, true),
    false,
    'unloaded record: no line yet',
  );
});

test('only a dragged width is written back; the seed and the restored value are not', () => {
  assert.equal(dockWidthPersisted(360, 360, undefined, false), undefined, 'the seed stays absent');
  assert.equal(dockWidthPersisted(320, 320, undefined, false), undefined, 'the narrow seed too');
  assert.equal(
    dockWidthPersisted(400, 360, 400, false),
    undefined,
    'the restored save is not rewritten',
  );
  assert.equal(dockWidthPersisted(400, 360, undefined, true), 400, 'a drag persists');
  assert.equal(dockWidthPersisted(360, 360, 400, true), 360, 'even dragged back to the seed');
  assert.equal(dockWidthPersisted(400, 360, 400, true), undefined, 'a no-op write is skipped');
});
