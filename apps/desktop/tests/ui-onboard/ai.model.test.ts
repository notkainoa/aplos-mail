// The AI step's view model (DESIGN 7.10, 7.11 step 3, 9; plan 30 4.5 row 1; AGENTS.md).
// Run: cd apps/desktop && npx tsx --test tests/ui-onboard/ai.model.test.ts
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AiProvider, Consent } from '../../src/renderer/data';
import {
  aiEsc,
  aiView,
  chatModel,
  consentGrant,
  currentChoice,
  featuresFor,
  initialAi,
  needsConsent,
  offeredProviders,
  providerDetail,
  reduceAi,
  testStatus,
  voiceChoice,
  type AiFeatures,
  type AiInputs,
  type AiModelInfo,
  type AiState,
} from '../../src/renderer/onboarding/steps/ai.model';

const base = {
  keyOptional: false,
  trainsOnInputs: false,
  sttCapable: false,
  local: false,
} as const;
const hosted = (
  id: string,
  label: string,
  envVar: string,
  keySource: AiProvider['keySource'] = 'none',
): AiProvider => ({
  ...base,
  id,
  label,
  group: 'hosted',
  envVar,
  keySource,
  status: keySource === 'none' ? 'missingKey' : 'ready',
});

function table(
  over: { groq?: AiProvider['keySource']; openai?: AiProvider['keySource'] } = {},
): AiProvider[] {
  return [
    hosted('groq', 'Groq', 'GROQ_API_KEY', over.groq ?? 'env'),
    hosted('openai', 'ChatGPT (OpenAI)', 'OPENAI_API_KEY', over.openai ?? 'none'),
    hosted('anthropic', 'Claude (Anthropic)', 'ANTHROPIC_API_KEY', 'keychain'),
    { ...hosted('gemini', 'Gemini', 'GEMINI_API_KEY', 'env'), trainsOnInputs: true },
    {
      ...base,
      id: 'ollama',
      label: 'Ollama',
      group: 'local',
      envVar: 'OLLAMA_API_KEY',
      keyOptional: true,
      keySource: 'none',
      local: true,
      address: 'http://localhost:11434/v1',
      running: true,
      status: 'ready',
    },
  ];
}

const MODELS: Record<string, readonly AiModelInfo[]> = {
  groq: [
    { id: 'whisper-large-v3-turbo', label: 'Whisper', stt: true },
    { id: 'openai/gpt-oss-120b', label: 'GPT-OSS 120B', tools: true },
  ],
  openai: [
    { id: 'gpt-5-mini', label: 'GPT-5 mini', tools: true },
    { id: 'gpt-4o-mini-transcribe', label: 'Transcribe', stt: true },
  ],
  anthropic: [{ id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', tools: true }],
  ollama: [{ id: 'llama3.2:3b', label: 'llama3.2:3b' }],
};

const FEATURES: AiFeatures = {
  ask: { provider: 'groq', model: 'openai/gpt-oss-120b' },
  summaries: { provider: 'groq', model: 'openai/gpt-oss-120b' },
  drafts: { provider: 'groq', model: 'openai/gpt-oss-120b' },
  plans: { provider: 'groq', model: 'openai/gpt-oss-120b' },
  voice: { provider: 'groq', model: 'whisper-large-v3-turbo' },
};

const consent = (over: Partial<Consent> = {}): Consent => ({
  scope: 'background',
  granted: false,
  version: 0,
  currentVersion: 2,
  needsReconsent: false,
  ...over,
});

const inputs = (over: Partial<AiInputs> = {}): AiInputs => ({
  providers: table(),
  models: MODELS,
  features: FEATURES,
  consent: consent(),
  ...over,
});

const state = (over: Partial<AiState> = {}): AiState => ({ ...initialAi(), ...over });

describe('providers', () => {
  test('Groq is preselected and its key source shows, never key characters (DESIGN 7.10)', () => {
    const vm = aiView(initialAi(), inputs());
    assert.equal(vm.rows.length, 1);
    assert.equal(vm.rows[0].id, 'groq');
    assert.equal(vm.rows[0].selected, true);
    assert.deepEqual(vm.rows[0].keySource, { kind: 'environment', variable: 'GROQ_API_KEY' });
    assert.equal(providerDetail(hosted('x', 'X', 'X_KEY', 'keychain')).text, 'Saved in Keychain');
    // A key from the environment reads in plain words, with no variable name in it.
    assert.equal(providerDetail(hosted('x', 'X', 'X_KEY', 'env')).text, 'Key set on this Mac');
    assert.equal(vm.keyField, undefined);
    assert.equal(vm.canContinue, true);
  });

  test('free-tier Gemini (trainsOnInputs) is never offered for mail', () => {
    assert.ok(!offeredProviders(table()).some(p => p.id === 'gemini'));
    const hostedVm = aiView(state({ view: 'hosted', chosen: 'openai' }), inputs());
    assert.ok(!hostedVm.rows.some(r => r.id === 'gemini'));
    assert.equal(currentChoice(state({ chosen: 'gemini' }), inputs()), undefined);
  });

  test('onb-ai-test-latency: Test reads "Works · 0.4 s" from the latency', () => {
    assert.deepEqual(testStatus({ kind: 'works', ms: 412 }), { text: 'Works · 0.4 s', tone: 'ok' });
    assert.equal(testStatus({ kind: 'failed', reasonCode: 'ai.missingKey' })?.text, 'Key refused');
    assert.equal(testStatus({ kind: 'testing' }), undefined);
  });

  test('Groq with no key shows the write-only field, focuses it and cannot continue', () => {
    const vm = aiView(initialAi(), inputs({ providers: table({ groq: 'none' }) }));
    assert.equal(vm.keyField?.provider, 'groq');
    assert.equal(vm.canContinue, false);
    assert.deepEqual(vm.focus, { kind: 'field', id: 'onb-ai-key' });
  });

  test('the key field clears on save, on failure, and when the provider changes', () => {
    const typedKey = reduceAi(initialAi(), { type: 'editKey', text: 'gsk-not-a-real-key' });
    assert.equal(reduceAi(typedKey, { type: 'keySaving' }).keyDraft, '');
    assert.equal(reduceAi(typedKey, { type: 'keyFailed' }).keyDraft, '');
    assert.equal(reduceAi(typedKey, { type: 'choose', provider: 'openai' }).keyDraft, '');
  });

  test('while the table loads, nothing is offered as usable and nothing is focused', () => {
    const vm = aiView(initialAi(), inputs({ providers: undefined }));
    assert.equal(vm.loading, true);
    assert.equal(vm.canContinue, false);
    assert.equal(vm.focus, undefined, 'a focused Skip for now would let Return skip the step');
  });
});

describe('what Continue writes', () => {
  test("Ask, Summaries, Drafts and Plans go to the chosen provider's default model", () => {
    const choice = currentChoice(state({ chosen: 'anthropic' }), inputs());
    assert.deepEqual(choice, { provider: 'anthropic', model: 'claude-haiku-5-5' });
    const f = featuresFor(choice!, inputs());
    for (const k of ['ask', 'summaries', 'drafts', 'plans'] as const)
      assert.deepEqual(f?.[k], choice);
  });

  test('the default chat model skips speech models', () => {
    assert.equal(chatModel(MODELS.groq), 'openai/gpt-oss-120b');
  });

  test('Voice goes to Groq when Groq has a key', () => {
    assert.deepEqual(voiceChoice(inputs()), { provider: 'groq', model: 'whisper-large-v3-turbo' });
  });

  test('Voice goes to OpenAI when only OpenAI has a key', () => {
    const i = inputs({ providers: table({ groq: 'none', openai: 'keychain' }) });
    assert.deepEqual(voiceChoice(i), { provider: 'openai', model: 'gpt-4o-mini-transcribe' });
  });

  test('Voice stays as it was when neither has a key (the contract cannot unset it)', () => {
    const current = { provider: 'groq', model: 'whisper-large-v3-turbo' };
    const i = inputs({
      providers: table({ groq: 'none', openai: 'none' }),
      features: { ...FEATURES, voice: current },
    });
    assert.deepEqual(voiceChoice(i), current);
  });

  test('a local model uses the picked model', () => {
    const choice = currentChoice(state({ view: 'local', chosen: 'ollama' }), inputs());
    assert.deepEqual(choice, { provider: 'ollama', model: 'llama3.2:3b' });
  });
});

describe('consent card (plan 30 4.5 row 1)', () => {
  const choice = { provider: 'groq', model: 'openai/gpt-oss-120b' };

  test('asks unless a current consent names this provider and model', () => {
    assert.equal(needsConsent(undefined, choice), true);
    assert.equal(needsConsent(consent(), choice), true);
    assert.equal(
      needsConsent(
        consent({ granted: true, provider: 'groq', model: 'openai/gpt-oss-120b' }),
        choice,
      ),
      false,
    );
    assert.equal(
      needsConsent(
        consent({
          granted: true,
          provider: 'groq',
          model: 'openai/gpt-oss-120b',
          needsReconsent: true,
        }),
        choice,
      ),
      true,
    );
    assert.equal(
      needsConsent(consent({ granted: true, provider: 'openai', model: 'gpt-5-mini' }), choice),
      true,
    );
  });

  test('onb-consent-record: Allow grants background scope with the version, provider and model shown', () => {
    assert.deepEqual(consentGrant(consent(), choice), {
      scope: 'background',
      version: 2,
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
    });
  });

  test('the card names provider, model and what is sent; a hosted provider adds the local note; Allow is focused', () => {
    const vm = aiView(state({ view: 'consent' }), inputs());
    assert.equal(vm.consent?.provider, 'Groq');
    assert.equal(vm.consent?.model, 'openai/gpt-oss-120b');
    assert.match(vm.consent?.sent ?? '', /Attachments are not sent\./);
    assert.equal(vm.consent?.showLocalNote, true);
    assert.deepEqual(vm.focus, { kind: 'button', label: 'Allow' });
    const local = aiView(state({ view: 'consent', chosen: 'ollama' }), inputs());
    assert.equal(local.consent?.showLocalNote, false);
  });

  test('written with consent needed opens the card and remembers where it came from', () => {
    const s = reduceAi(state({ view: 'hosted', chosen: 'anthropic' }), {
      type: 'written',
      consent: true,
    });
    assert.equal(s.view, 'consent');
    assert.equal(s.consentFrom, 'hosted');
  });
});

describe('Esc inside the step', () => {
  test('consent → the screen it came from; another provider → Groq; open More options → closed; else back a step', () => {
    const fromConsent = aiEsc(state({ view: 'consent', consentFrom: 'local', chosen: 'ollama' }));
    assert.equal(fromConsent.handled, true);
    assert.equal(fromConsent.state.view, 'local');
    const fromHosted = aiEsc(state({ view: 'hosted', chosen: 'openai', keyDraft: 'sk-x' }));
    assert.equal(fromHosted.state.view, 'pick');
    assert.equal(fromHosted.state.chosen, 'groq');
    assert.equal(fromHosted.state.keyDraft, '');
    const more = aiEsc(state({ moreOpen: true }));
    assert.equal(more.state.moreOpen, false);
    assert.notEqual(
      more.state.focusNonce,
      0,
      'focus moves because the focused control was hidden (F12)',
    );
    assert.equal(aiEsc(initialAi()).handled, false);
  });

  test('focus key changes on screen changes, not on More options or a test result (F12)', () => {
    const before = aiView(initialAi(), inputs()).focusKey;
    assert.equal(aiView(reduceAi(initialAi(), { type: 'toggleMore' }), inputs()).focusKey, before);
    assert.equal(
      aiView(
        reduceAi(initialAi(), {
          type: 'testDone',
          provider: 'groq',
          test: { kind: 'works', ms: 1 },
        }),
        inputs(),
      ).focusKey,
      before,
    );
    assert.notEqual(aiView(state({ view: 'consent' }), inputs()).focusKey, before);
  });
});
