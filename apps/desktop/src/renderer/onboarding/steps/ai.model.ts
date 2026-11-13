/**
 * The AI step's view model (DESIGN 7.10, 7.11 step 3, 9; plan 30 4.5 row 1; AGENTS.md). Pure: contract values in,
 * component props and decisions out.
 *
 * - Groq is preselected. The step shows where its key comes from ("Key found in the environment as GROQ_API_KEY",
 *   "Saved in Keychain") or a write-only field. Key characters never enter the model: the field's text is cleared on save,
 *   on failure and on every provider switch, so a key typed for one provider is never sent to another.
 * - "More options" holds "Use another provider" (the other hosted providers) and "Run on this Mac" (Ollama,
 *   LM Studio, a custom server with its address).
 * - A provider that may learn from what it is sent (`trainsOnInputs`, free-tier Gemini) is never offered for mail.
 * - Continue writes `Settings.ai.features`: Ask, Summaries, Drafts and Plans to the chosen provider's default model;
 *   Voice to Groq when Groq has a key, else OpenAI when it has one, else Voice is left as it was. Then the consent
 *   card asks before anything runs in the background. "Skip for now" writes nothing and never causes an error later.
 */
import type { AiProvider, Consent, Input, Output, Settings } from '../../data';
import type { KeySource } from '../../ui/props';
import { keySaveSentence } from '../copy';
import type { FocusTarget } from '../flow';

/** One model from `Ai/models`. */
export type AiModelInfo = Output<'Ai/models'>['list'][number];
/** The five feature choices in Settings → AI. */
export type AiFeatures = Settings['ai']['features'];
/** One feature's provider and model. */
export type FeatureChoice = AiFeatures['ask'];

/** The step's screens: the Groq default, another hosted provider, a model on this Mac, the consent card. */
export type AiView = 'pick' | 'hosted' | 'local' | 'consent';

/** A Test button's state. */
export type TestState =
  | { readonly kind: 'testing' }
  | { readonly kind: 'works'; readonly ms?: number }
  | { readonly kind: 'failed'; readonly reasonCode?: string };

export interface AiState {
  readonly view: AiView;
  /** The screen the consent card returns to on Esc. */
  readonly consentFrom: Exclude<AiView, 'consent'>;
  /** "More options" on the pick screen (the two lines) and on the local screen (server addresses). */
  readonly moreOpen: boolean;
  /** The chosen provider id. */
  readonly chosen: string;
  /** The key field's text; never stored anywhere else, cleared after every save attempt. */
  readonly keyDraft: string;
  readonly savingKey: boolean;
  /** A key save failed: a reason code for the plain sentence. */
  readonly keyFailure: string | null;
  readonly tests: Readonly<Record<string, TestState>>;
  /** The model picked for a local server. */
  readonly localModel: Readonly<Record<string, string>>;
  /** Address fields being edited, by provider. */
  readonly addressDraft: Readonly<Record<string, string>>;
  /** Settings/set is in flight. */
  readonly writing: boolean;
  /** Settings/set failed; the step says so and Skip still works. */
  readonly writeFailed: boolean;
  /** Bumped when Esc hides the focused control, so focus moves to the main action (F12). */
  readonly focusNonce: number;
}

/** The provider every feature uses by default (AGENTS.md). */
export const DEFAULT_PROVIDER = 'groq';

/** Voice's default when nothing else resolves: the contract's Voice fallback (Groq's Whisper model). */
export const DEFAULT_VOICE: FeatureChoice = { provider: 'groq', model: 'whisper-large-v3-turbo' };

export function initialAi(): AiState {
  return {
    view: 'pick',
    consentFrom: 'pick',
    moreOpen: false,
    chosen: DEFAULT_PROVIDER,
    keyDraft: '',
    savingKey: false,
    keyFailure: null,
    tests: {},
    localModel: {},
    addressDraft: {},
    writing: false,
    writeFailed: false,
    focusNonce: 0,
  };
}

/** Everything the step reads from the engine. `providers` is undefined while it loads. */
export interface AiInputs {
  readonly providers: readonly AiProvider[] | undefined;
  readonly models: Readonly<Record<string, readonly AiModelInfo[]>>;
  readonly features: AiFeatures | undefined;
  readonly consent: Consent | undefined;
}

/* ---------- Providers ---------- */

/** Providers Aplos may send mail to: never one that may learn from it (ARCH 8.3; gap list 4 item 4). */
export function offeredProviders(providers: readonly AiProvider[]): AiProvider[] {
  return providers.filter(p => !p.trainsOnInputs);
}

const isLocalServer = (p: AiProvider): boolean => p.group === 'local';

/** Hosted providers other than the default, for "Use another provider". */
export function otherHosted(providers: readonly AiProvider[]): AiProvider[] {
  return offeredProviders(providers).filter(p => !isLocalServer(p) && p.id !== DEFAULT_PROVIDER);
}

/** Ollama, LM Studio and a custom server, for "Run on this Mac". */
export function localServers(providers: readonly AiProvider[]): AiProvider[] {
  return offeredProviders(providers).filter(isLocalServer);
}

/** A hosted provider has a key; a local server answers; a custom server has an address. */
export function isUsable(p: AiProvider | undefined): boolean {
  if (!p || p.trainsOnInputs) return false;
  if (p.group === 'local') {
    if (p.id === 'custom')
      return p.status === 'ready' || (!!p.address && p.status !== 'notConfigured');
    return p.running === true || p.status === 'ready';
  }
  return p.keySource === 'env' || p.keySource === 'keychain';
}

/** "ChatGPT (OpenAI)" → "ChatGPT", for "Paste your ChatGPT API key". */
export function shortName(label: string): string {
  return label.replace(/\s*\(.*\)\s*$/, '').trim() || label;
}

/** "http://localhost:11434/v1" → "localhost:11434". */
export function hostOf(address: string | undefined): string {
  if (!address) return '';
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

/** The second line of a provider row (DESIGN 7.10: the key source, never key characters). */
export function providerDetail(p: AiProvider): { text: string; dot?: 'ok' | 'off' } {
  if (p.group === 'local') {
    if (p.id === 'custom') return { text: p.address ? hostOf(p.address) : 'No address yet' };
    return isUsable(p)
      ? { text: `Found at ${hostOf(p.address ?? p.defaultAddress)}`, dot: 'ok' }
      : { text: 'Not running', dot: 'off' };
  }
  if (p.keySource === 'env') return { text: 'Key set on this Mac' };
  if (p.keySource === 'keychain') return { text: 'Saved in Keychain' };
  return { text: 'No key yet' };
}

/** A Test result as the row's status word: "Works · 0.4 s", or a plain failure. */
export function testStatus(
  test: TestState | undefined,
): { text: string; tone: 'ok' | 'attention' } | undefined {
  if (!test || test.kind === 'testing') return undefined;
  if (test.kind === 'works') {
    return {
      text: test.ms === undefined ? 'Works' : `Works · ${(test.ms / 1000).toFixed(1)} s`,
      tone: 'ok',
    };
  }
  const code = test.reasonCode ?? '';
  if (code === 'ai.missingKey' || code.startsWith('auth.'))
    return { text: 'Key refused', tone: 'attention' };
  if (code === 'ai.unreachable' || code === 'net.offline')
    return { text: "Didn't answer", tone: 'attention' };
  if (code === 'ai.rateLimited') return { text: 'Busy, try later', tone: 'attention' };
  return { text: "Didn't work", tone: 'attention' };
}

/**
 * The sentence under the key field after a failed save (`copy.ts`): a refused key names the chosen provider; any other
 * failure says the key couldn't be saved on this Mac.
 */
export function keyFailureSentence(code: string | null, providerLabel: string): string {
  return keySaveSentence(code === 'unknown' ? undefined : code, shortName(providerLabel));
}

/* ---------- Models and settings ---------- */

/** A provider's default model for Ask, Summaries, Drafts and Plans: the first non-speech model, preferring one with tools. */
export function chatModel(models: readonly AiModelInfo[] | undefined): string | undefined {
  const text = (models ?? []).filter(m => !m.stt);
  return (text.find(m => m.tools !== false) ?? text[0])?.id;
}

/** A provider's speech-to-text model, for Voice. */
export function sttModel(models: readonly AiModelInfo[] | undefined): string | undefined {
  return (models ?? []).find(m => m.stt)?.id;
}

/** The model the chosen provider would run: the picked local model, else the provider's default. */
export function modelFor(providerId: string, state: AiState, inputs: AiInputs): string | undefined {
  const models = inputs.models[providerId];
  const picked = state.localModel[providerId];
  if (picked && (models ?? []).some(m => m.id === picked)) return picked;
  return chatModel(models);
}

const byId = (providers: readonly AiProvider[] | undefined, id: string): AiProvider | undefined =>
  providers?.find(p => p.id === id);

/**
 * Voice (AGENTS.md): Groq when Groq has a key, else OpenAI when it has one, else left as it is. The contract has no
 * "unset" for Voice (the field is required), so "unset" keeps the current choice.
 */
export function voiceChoice(inputs: AiInputs): FeatureChoice | undefined {
  for (const id of ['groq', 'openai']) {
    const p = byId(inputs.providers, id);
    if (!isUsable(p)) continue;
    const model = sttModel(inputs.models[id]);
    if (model) return { provider: id, model };
    if (inputs.features?.voice.provider === id) return inputs.features.voice;
  }
  return inputs.features?.voice;
}

/** The whole `features` object Continue writes; a voice that cannot resolve keeps the stored or default one. */
export function featuresFor(choice: FeatureChoice, inputs: AiInputs): AiFeatures {
  const voice = voiceChoice(inputs) ?? DEFAULT_VOICE;
  return { ask: choice, summaries: choice, drafts: choice, plans: choice, voice };
}

/** Background AI needs a fresh answer unless the stored consent names this provider and model and is current. */
export function needsConsent(consent: Consent | undefined, choice: FeatureChoice): boolean {
  if (!consent || !consent.granted || consent.needsReconsent) return true;
  return consent.provider !== choice.provider || consent.model !== choice.model;
}

/** `Consent/grant`'s arguments for the card on screen. */
export function consentGrant(
  consent: Consent | undefined,
  choice: FeatureChoice,
): Input<'Consent/grant'> {
  return {
    scope: 'background',
    version: consent?.currentVersion ?? consent?.version ?? 1,
    // The engine refuses an id it does not know; the choice always comes from its own provider table.
    provider: choice.provider as Input<'Consent/grant'>['provider'],
    model: choice.model,
  };
}

/** The card's "What is sent" sentence (onboarding-ai.html consent). */
export const CONSENT_SENT =
  'The sender, subject and text of each new email, and your question when you use Ask. Attachments are not sent.';

/* ---------- The reducer ---------- */

export type AiEvent =
  | { readonly type: 'toggleMore' }
  | {
      readonly type: 'open';
      readonly view: 'hosted' | 'local';
      readonly providers: readonly AiProvider[];
    }
  | { readonly type: 'choose'; readonly provider: string }
  | { readonly type: 'editKey'; readonly text: string }
  | { readonly type: 'keySaving' }
  | { readonly type: 'keySaved' }
  | { readonly type: 'keyFailed'; readonly reasonCode?: string }
  | { readonly type: 'testStarted'; readonly provider: string }
  | { readonly type: 'testDone'; readonly provider: string; readonly test: TestState }
  /** Check again finished for a local server: its row shows the fresh table, no status word. */
  | { readonly type: 'testCleared'; readonly provider: string }
  | { readonly type: 'pickModel'; readonly provider: string; readonly model: string }
  | { readonly type: 'editAddress'; readonly provider: string; readonly text: string }
  | { readonly type: 'writing' }
  | { readonly type: 'written'; readonly consent: boolean }
  | { readonly type: 'writeFailed' }
  | { readonly type: 'consentShown' }
  /** Esc's answer from `aiEsc`. */
  | { readonly type: 'replace'; readonly state: AiState };

export function reduceAi(state: AiState, event: AiEvent): AiState {
  switch (event.type) {
    case 'toggleMore':
      return { ...state, moreOpen: !state.moreOpen };
    case 'open': {
      const list =
        event.view === 'hosted' ? otherHosted(event.providers) : localServers(event.providers);
      const keepChoice = list.some(p => p.id === state.chosen);
      const chosen = keepChoice
        ? state.chosen
        : ((list.find(isUsable) ?? list[0])?.id ?? state.chosen);
      return {
        ...state,
        view: event.view,
        chosen,
        moreOpen: false,
        keyDraft: '',
        keyFailure: null,
        writeFailed: false,
      };
    }
    case 'choose':
      if (event.provider === state.chosen) return state;
      // A key typed for one provider is never kept for another.
      return {
        ...state,
        chosen: event.provider,
        keyDraft: '',
        keyFailure: null,
        writeFailed: false,
      };
    case 'editKey':
      return { ...state, keyDraft: event.text, keyFailure: null };
    case 'keySaving':
      return { ...state, keyDraft: '', savingKey: true, keyFailure: null };
    case 'keySaved':
      return { ...state, keyDraft: '', savingKey: false, keyFailure: null };
    case 'keyFailed':
      return {
        ...state,
        keyDraft: '',
        savingKey: false,
        keyFailure: event.reasonCode ?? 'unknown',
      };
    case 'testStarted':
      return { ...state, tests: { ...state.tests, [event.provider]: { kind: 'testing' } } };
    case 'testDone':
      return { ...state, tests: { ...state.tests, [event.provider]: event.test } };
    case 'testCleared': {
      const { [event.provider]: _cleared, ...tests } = state.tests;
      return { ...state, tests };
    }
    case 'pickModel':
      return { ...state, localModel: { ...state.localModel, [event.provider]: event.model } };
    case 'editAddress':
      return { ...state, addressDraft: { ...state.addressDraft, [event.provider]: event.text } };
    case 'writing':
      return { ...state, writing: true, writeFailed: false };
    case 'written':
      return event.consent
        ? {
            ...state,
            writing: false,
            view: 'consent',
            consentFrom: state.view === 'consent' ? state.consentFrom : state.view,
          }
        : { ...state, writing: false };
    case 'writeFailed':
      return { ...state, writing: false, writeFailed: true };
    case 'consentShown':
      return state.view === 'consent'
        ? state
        : { ...state, view: 'consent', consentFrom: state.view };
    case 'replace':
      return event.state;
  }
}

/**
 * Esc inside the step: the consent card goes back to the screen it came from; another provider or a model on this
 * Mac goes back to Groq (onboarding-ai.html: byok → groq); an open "More options" closes. `handled: false` means
 * the window goes back a step.
 */
export function aiEsc(state: AiState): { state: AiState; handled: boolean } {
  if (state.view === 'consent') {
    return {
      state: { ...state, view: state.consentFrom, focusNonce: state.focusNonce + 1 },
      handled: true,
    };
  }
  if (state.view === 'hosted' || state.view === 'local') {
    return {
      state: {
        ...state,
        view: 'pick',
        chosen: DEFAULT_PROVIDER,
        keyDraft: '',
        keyFailure: null,
        moreOpen: false,
        focusNonce: state.focusNonce + 1,
      },
      handled: true,
    };
  }
  if (state.moreOpen) {
    return {
      state: { ...state, moreOpen: false, focusNonce: state.focusNonce + 1 },
      handled: true,
    };
  }
  return { state, handled: false };
}

/* ---------- The view ---------- */

/** One provider row. */
export interface AiRowView {
  readonly id: string;
  readonly label: string;
  readonly tag?: string;
  /** A local server's second line ("Found at localhost:11434"). */
  readonly detail?: string;
  /** A hosted provider's second line, the key source with its variable in mono ("Key found in the environment as GROQ_API_KEY"). */
  readonly keySource?: KeySource;
  readonly detailDot?: 'ok' | 'off';
  readonly selected: boolean;
  readonly status?: { readonly text: string; readonly tone: 'ok' | 'attention' };
  /** Test (hosted with a key), or Check again (a local server that is not running). */
  readonly check?: { readonly label: 'Test' | 'Check again'; readonly busy: boolean };
  /** A model picker for a running local server. */
  readonly modelPicker?: { readonly value: string; readonly options: readonly AiModelInfo[] };
}

/** An address field for a local or custom server. */
export interface AddressFieldView {
  readonly provider: string;
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
}

export interface AiViewModel {
  readonly view: AiView;
  readonly title: string;
  readonly lede: string;
  /** The screen's radio rows. */
  readonly rows: readonly AiRowView[];
  /** Still reading the provider table. */
  readonly loading: boolean;
  /** The write-only key field for the chosen hosted provider that has no key. */
  readonly keyField?: {
    readonly provider: string;
    readonly label: string;
    readonly placeholder: string;
    readonly value: string;
    readonly saving: boolean;
    readonly error?: string;
  };
  /** The chosen custom server's address field. */
  readonly addressField?: AddressFieldView;
  /** Local servers' address fields, behind "More options" on the local screen. */
  readonly moreAddresses: readonly AddressFieldView[];
  /** Continue writes and goes on; disabled while the choice cannot work yet. */
  readonly canContinue: boolean;
  readonly writing: boolean;
  /** One plain sentence when saving the choice failed. */
  readonly notice?: string;
  /** The consent card's facts. */
  readonly consent?: {
    readonly provider: string;
    readonly model: string;
    readonly sent: string;
    readonly showLocalNote: boolean;
  };
  /** The control to focus on this screen (F12); nothing while the provider table loads. */
  readonly focus: FocusTarget | undefined;
  /** Changes when focus should move (screen change, or Esc hid the focused control). */
  readonly focusKey: string;
}

/** Fixed labels the focus targets and the step's buttons use. */
export const AI_LABELS = {
  continue: 'Continue',
  skip: 'Skip for now',
  allow: 'Allow',
  notNow: 'Not now',
  another: 'Use another provider',
  local: 'Run on this Mac',
  test: 'Test',
  checkAgain: 'Check again',
} as const;

export const AI_KEY_FIELD_ID = 'onb-ai-key';
const addressId = (provider: string): string => `onb-ai-address-${provider}`;

const TEXT: Readonly<Record<AiView, { title: string; lede: string }>> = {
  pick: {
    title: 'Set up AI',
    lede: 'AI sums up each email in a line, drafts replies and answers questions about your mail. It is optional. Your accounts allow their mail for AI by default — nothing leaves this Mac until you set up a provider and allow it.',
  },
  hosted: {
    title: 'Use your own key',
    lede: 'Pick a provider and paste its API key. Aplos saves the key in Keychain and never shows it again.',
  },
  local: {
    title: 'Run AI on this Mac',
    lede: 'Ollama and LM Studio answer from your own Mac, so your mail stays on this Mac.',
  },
  consent: {
    title: 'Allow summaries in the background?',
    lede: 'Aplos can read new mail as it arrives and write the summaries for you. Here is exactly what that sends.',
  },
};

/** The hosted row's second line as the component's `keySource` prop (mockup: "Key found in the environment as GROQ_API_KEY"). */
export function keySourceOf(p: AiProvider): KeySource {
  if (p.keySource === 'env') return { kind: 'environment', variable: p.envVar };
  if (p.keySource === 'keychain') return { kind: 'keychain' };
  return { kind: 'none', variable: p.envVar };
}

function rowFor(p: AiProvider, state: AiState, inputs: AiInputs): AiRowView {
  const detail = providerDetail(p);
  const test = state.tests[p.id];
  const usable = isUsable(p);
  const local = p.group === 'local';
  const models = (inputs.models[p.id] ?? []).filter(m => !m.stt);
  const model = modelFor(p.id, state, inputs);
  return {
    id: p.id,
    label: p.label,
    ...(p.id === DEFAULT_PROVIDER ? { tag: 'Default' } : {}),
    ...(local ? { detail: detail.text } : { keySource: keySourceOf(p) }),
    ...(detail.dot ? { detailDot: detail.dot } : {}),
    selected: state.chosen === p.id,
    ...(testStatus(test) ? { status: testStatus(test) } : {}),
    ...(!local && usable
      ? { check: { label: 'Test', busy: test?.kind === 'testing' } }
      : local && p.id !== 'custom' && !usable
        ? { check: { label: 'Check again', busy: test?.kind === 'testing' } }
        : {}),
    ...(local && usable && model && models.length > 0
      ? { modelPicker: { value: model, options: models } }
      : {}),
  };
}

/** A stand-in Groq row while the table is unknown, so the step never draws empty. */
const GROQ_FALLBACK: AiProvider = {
  id: 'groq',
  label: 'Groq',
  group: 'hosted',
  status: 'missingKey',
  keySource: 'none',
  envVar: 'GROQ_API_KEY',
  keyOptional: false,
  trainsOnInputs: false,
  sttCapable: true,
  local: false,
};

export function aiView(state: AiState, inputs: AiInputs): AiViewModel {
  const loading = inputs.providers === undefined;
  const all = inputs.providers ?? [];
  const offered = offeredProviders(all);
  const groq = byId(offered, DEFAULT_PROVIDER) ?? GROQ_FALLBACK;
  const list =
    state.view === 'hosted'
      ? otherHosted(all)
      : state.view === 'local'
        ? localServers(all)
        : [groq];
  const chosen =
    byId(offered, state.chosen) ?? (state.chosen === DEFAULT_PROVIDER ? groq : undefined);
  const model = chosen ? modelFor(chosen.id, state, inputs) : undefined;
  const usable = !loading && isUsable(chosen) && !!model;

  const rows = loading && state.view === 'pick' ? [] : list.map(p => rowFor(p, state, inputs));

  const wantsKey =
    !loading &&
    state.view !== 'local' &&
    state.view !== 'consent' &&
    chosen !== undefined &&
    chosen.group !== 'local' &&
    !isUsable(chosen);
  const keyField = wantsKey
    ? {
        provider: chosen.id,
        label: `${shortName(chosen.label)} API key`,
        placeholder: `Paste your ${shortName(chosen.label)} API key`,
        value: state.keyDraft,
        saving: state.savingKey,
        ...(state.keyFailure ? { error: keyFailureSentence(state.keyFailure, chosen.label) } : {}),
      }
    : undefined;

  const addressFor = (p: AiProvider): AddressFieldView => ({
    provider: p.id,
    id: addressId(p.id),
    label: `${p.label} address`,
    value: state.addressDraft[p.id] ?? p.address ?? '',
    placeholder: p.defaultAddress ?? 'http://localhost:8080/v1',
  });
  const customChosen = state.view === 'local' && chosen?.id === 'custom' ? chosen : undefined;
  const addressField = customChosen ? addressFor(customChosen) : undefined;
  const moreAddresses =
    state.view === 'local'
      ? localServers(all)
          .filter(p => p.id !== 'custom')
          .map(addressFor)
      : [];

  const consent =
    state.view === 'consent' && chosen && model
      ? {
          provider: shortName(chosen.label),
          model,
          sent: CONSENT_SENT,
          showLocalNote: !chosen.local,
        }
      : undefined;

  // While the table loads nothing is focused: a focused "Skip for now" would let Return skip the step.
  const focus: FocusTarget | undefined = loading
    ? undefined
    : state.view === 'consent'
      ? { kind: 'button', label: AI_LABELS.allow }
      : usable
        ? { kind: 'button', label: AI_LABELS.continue }
        : keyField
          ? { kind: 'field', id: AI_KEY_FIELD_ID }
          : addressField
            ? { kind: 'field', id: addressField.id }
            : state.view === 'local' && rows.some(r => r.check?.label === 'Check again')
              ? { kind: 'button', label: AI_LABELS.checkAgain }
              : { kind: 'button', label: AI_LABELS.skip };

  // The key names the resolved target, so a late answer (models, the provider table) still moves focus.
  const focusPart = focus
    ? `${focus.kind}:${focus.kind === 'button' ? focus.label : focus.id}`
    : 'none';

  return {
    view: state.view,
    ...TEXT[state.view],
    rows,
    loading,
    ...(keyField ? { keyField } : {}),
    ...(addressField ? { addressField } : {}),
    moreAddresses,
    canContinue: usable && !state.writing,
    writing: state.writing,
    ...(state.writeFailed
      ? { notice: "Couldn't save this choice. Try again, or skip for now." }
      : {}),
    ...(consent ? { consent } : {}),
    focus,
    focusKey: `ai:${state.view}:${state.focusNonce}:${focusPart}`,
  };
}

/** The choice Continue would write, or undefined when the chosen provider cannot run yet. */
export function currentChoice(state: AiState, inputs: AiInputs): FeatureChoice | undefined {
  const p = byId(offeredProviders(inputs.providers ?? []), state.chosen);
  if (!isUsable(p)) return undefined;
  const model = modelFor(state.chosen, state, inputs);
  return model ? { provider: state.chosen, model } : undefined;
}
