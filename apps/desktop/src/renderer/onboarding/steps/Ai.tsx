/**
 * Step 3, AI (DESIGN 7.11 step 3, 7.10, 9; plan 30 4.5 row 1; onboarding-ai.html groq, byok, local, consent).
 * Optional. Groq is preselected; "More options" holds another hosted provider and a model on this Mac; the consent
 * card is the step's one card. "Skip for now" writes nothing, so skipping never produces an error later.
 *
 * `AiStep` is presentational (the preview draws it from fixtures); `AiContainer` reads the engine, runs the calls and
 * tells the window its keys and focus. Key characters only ever live in the field and in the one `Ai/setKey` call.
 */
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { api, useConsent, useSettings } from '../../data';
import type { AiProvider, Input, Output } from '../../data';
import { backFooter, missingMethod, type StepChrome, type StepKeys } from '../flow';
import { reasonOf } from '../reason';
import { ChoiceRow, ConsentCard, OnboardingStep } from '../../ui/onboarding';
import { Button } from '../../ui/buttons-keys';
import { TextField } from '../../ui/controls';
import { Menu, Text } from '../../ui/surfaces';
import type { StepButton } from '../../ui/props';
import {
  AI_KEY_FIELD_ID,
  AI_LABELS,
  aiEsc,
  aiView,
  consentGrant,
  currentChoice,
  featuresFor,
  initialAi,
  needsConsent,
  reduceAi,
  type AddressFieldView,
  type AiInputs,
  type AiModelInfo,
  type AiRowView,
  type AiState,
  type AiViewModel,
} from './ai.model';

/* ---------- Presentational ---------- */

export interface AiStepProps {
  readonly chrome: StepChrome;
  readonly vm: AiViewModel;
  readonly moreOpen: boolean;
  readonly onToggleMore: () => void;
  readonly onOpenHosted: () => void;
  readonly onOpenLocal: () => void;
  readonly onChoose: (provider: string) => void;
  /** Test (hosted) or Check again (local). */
  readonly onCheck: (provider: string) => void;
  readonly onPickModel: (provider: string, model: string) => void;
  readonly onEditKey: (text: string) => void;
  /** Return in the key field. */
  readonly onSaveKey: () => void;
  readonly onEditAddress: (provider: string, text: string) => void;
  readonly onSaveAddress: (provider: string) => void;
  readonly onContinue: () => void;
  readonly onSkip: () => void;
  readonly onAllow: () => void;
  readonly onNotNow: () => void;
}

/** A local server's model picker: a text button with a chevron and a Menu of models (the frozen Select, ui/README). */
function ModelPicker({
  provider,
  label,
  value,
  options,
  onPick,
}: {
  provider: string;
  label: string;
  value: string;
  options: readonly AiModelInfo[];
  onPick: (model: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const menuId = `onb-ai-models-${provider}`;
  return (
    <>
      <Button
        ref={anchor}
        variant="text"
        size="sm"
        label={value}
        trailingIcon="chevron-down"
        popup={{ kind: 'menu', expanded: open, controls: menuId }}
        onPress={() => setOpen(o => !o)}
      />
      <Menu
        open={open}
        anchor={open ? anchor.current : null}
        label={`${label} model`}
        entries={options.map(m => ({ kind: 'item' as const, id: m.id, label: m.label || m.id }))}
        checkedId={value}
        onSelect={id => {
          onPick(id);
          setOpen(false);
        }}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

function ProviderRows({
  rows,
  label,
  onChoose,
  onCheck,
  onPickModel,
}: {
  rows: readonly AiRowView[];
  label: string;
  onChoose: (id: string) => void;
  onCheck: (id: string) => void;
  onPickModel: (id: string, model: string) => void;
}) {
  return (
    <div className="onb-rows" role="radiogroup" aria-label={label}>
      {rows.map(row => (
        <ChoiceRow
          key={row.id}
          id={`onb-ai-${row.id}`}
          role="radio"
          label={row.label}
          {...(row.detail ? { detail: row.detail } : {})}
          {...(row.keySource ? { keySource: row.keySource } : {})}
          selected={row.selected}
          onPress={() => onChoose(row.id)}
          {...(row.tag ? { tag: row.tag } : {})}
          {...(row.detailDot ? { detailDot: row.detailDot } : {})}
          {...(row.status ? { status: row.status } : {})}
          control={
            row.modelPicker ? (
              <ModelPicker
                provider={row.id}
                label={row.label}
                value={row.modelPicker.value}
                options={row.modelPicker.options}
                onPick={model => onPickModel(row.id, model)}
              />
            ) : row.check ? (
              <Button
                variant="text"
                size="sm"
                label={row.check.label}
                busy={row.check.busy}
                onPress={() => onCheck(row.id)}
              />
            ) : undefined
          }
        />
      ))}
    </div>
  );
}

function KeyField({
  field,
  onEditKey,
  onSaveKey,
}: {
  field: NonNullable<AiViewModel['keyField']>;
  onEditKey: (text: string) => void;
  onSaveKey: () => void;
}) {
  return (
    <div className="onb-field-block">
      <TextField
        id={AI_KEY_FIELD_ID}
        type="password"
        size="lg"
        icon="key"
        label={field.label}
        placeholder={field.placeholder}
        value={field.value}
        disabled={field.saving}
        trailingKeys="Return"
        onChange={onEditKey}
        onSubmit={onSaveKey}
        {...(field.error ? { error: field.error } : {})}
      />
      <Text variant="small" icon="lock">
        Saved in Keychain on this Mac. Never shown again.
      </Text>
    </div>
  );
}

function AddressField({
  field,
  onEdit,
  onSave,
}: {
  field: AddressFieldView;
  onEdit: (provider: string, text: string) => void;
  onSave: (provider: string) => void;
}) {
  return (
    <TextField
      id={field.id}
      type="url"
      mono
      icon="server"
      label={field.label}
      labelVisible
      placeholder={field.placeholder}
      value={field.value}
      onChange={text => onEdit(field.provider, text)}
      onSubmit={() => onSave(field.provider)}
    />
  );
}

export function AiStep(props: AiStepProps) {
  const { chrome, vm } = props;
  const common = {
    titleId: 'onb-title',
    footer: backFooter(chrome),
    layout: 'step' as const,
    title: vm.title,
    lede: vm.lede,
    ...(chrome.status || vm.notice ? { phaseStatus: chrome.status ?? vm.notice } : {}),
  };

  if (vm.view === 'consent' && vm.consent) {
    return (
      <OnboardingStep {...common}>
        <ConsentCard
          provider={vm.consent.provider}
          model={vm.consent.model}
          sent={vm.consent.sent}
          showLocalNote={vm.consent.showLocalNote}
          onAllow={props.onAllow}
          onNotNow={props.onNotNow}
        />
      </OnboardingStep>
    );
  }

  const actions: StepButton[] = [
    {
      label: AI_LABELS.continue,
      emphasis: 'filled',
      keys: 'Return',
      keyHint: 'always',
      disabled: !vm.canContinue && !vm.writing,
      busy: vm.writing,
      onSelect: props.onContinue,
    },
    { label: AI_LABELS.skip, emphasis: 'text', onSelect: props.onSkip },
  ];

  const rows = vm.loading ? (
    <Text variant="small">Checking which providers are set up…</Text>
  ) : (
    <ProviderRows
      rows={vm.rows}
      label={vm.view === 'local' ? 'Model on this Mac' : 'AI provider'}
      onChoose={props.onChoose}
      onCheck={props.onCheck}
      onPickModel={props.onPickModel}
    />
  );

  const notice = vm.notice ? (
    <Text variant="small" tone="ink-2" icon="alert">
      {vm.notice}
    </Text>
  ) : null;

  if (vm.view === 'pick') {
    return (
      <OnboardingStep
        {...common}
        actions={actions}
        moreOptions={{
          expanded: props.moreOpen,
          onToggle: props.onToggleMore,
          content: (
            <div className="onb-rows">
              <ChoiceRow
                id="onb-ai-more-hosted"
                role="link"
                icon="key"
                label={AI_LABELS.another}
                onPress={props.onOpenHosted}
              />
              <ChoiceRow
                id="onb-ai-more-local"
                role="link"
                icon="laptop"
                label={AI_LABELS.local}
                onPress={props.onOpenLocal}
              />
            </div>
          ),
        }}
        {...(chrome.onTryDemo ? { onTryDemo: chrome.onTryDemo } : {})}
      >
        {rows}
        {vm.keyField ? (
          <KeyField field={vm.keyField} onEditKey={props.onEditKey} onSaveKey={props.onSaveKey} />
        ) : null}
        {notice}
      </OnboardingStep>
    );
  }

  if (vm.view === 'hosted') {
    return (
      <OnboardingStep {...common} actions={actions}>
        {rows}
        {vm.keyField ? (
          <KeyField field={vm.keyField} onEditKey={props.onEditKey} onSaveKey={props.onSaveKey} />
        ) : null}
        {notice}
      </OnboardingStep>
    );
  }

  // local
  return (
    <OnboardingStep
      {...common}
      actions={actions}
      {...(vm.moreAddresses.length > 0
        ? {
            moreOptions: {
              expanded: props.moreOpen,
              onToggle: props.onToggleMore,
              content: (
                <div className="onb-fields">
                  {vm.moreAddresses.map(field => (
                    <AddressField
                      key={field.id}
                      field={field}
                      onEdit={props.onEditAddress}
                      onSave={props.onSaveAddress}
                    />
                  ))}
                </div>
              ),
            },
          }
        : {})}
    >
      {rows}
      {vm.addressField ? (
        <AddressField
          field={vm.addressField}
          onEdit={props.onEditAddress}
          onSave={props.onSaveAddress}
        />
      ) : null}
      {notice}
    </OnboardingStep>
  );
}

/* ---------- Container ---------- */

/** The calls the AI step makes. Defaults come from `renderer/data`; the preview and tests pass their own. */
export interface AiPorts {
  providers(): Promise<Output<'Ai/providers'>>;
  models(input: Input<'Ai/models'>): Promise<Output<'Ai/models'>>;
  setKey(input: Input<'Ai/setKey'>): Promise<Output<'Ai/setKey'>>;
  testKey(input: Input<'Ai/testKey'>): Promise<Output<'Ai/testKey'>>;
  setSettings(patch: Input<'Settings/set'>['patch']): Promise<unknown>;
  grantConsent(input: Input<'Consent/grant'>): Promise<unknown>;
}

// REQUEST ui-shell: `api.ai.providers`, `api.ai.models`, `api.ai.setKey` and `api.ai.testKey` (contract
// `Ai/providers`, `Ai/models`, `Ai/setKey`, `Ai/testKey`) are not on the data surface yet.
export const defaultAiPorts: AiPorts = {
  providers: async () => {
    throw missingMethod('Ai/providers');
  },
  models: async () => {
    throw missingMethod('Ai/models');
  },
  setKey: async () => {
    throw missingMethod('Ai/setKey');
  },
  testKey: async () => {
    throw missingMethod('Ai/testKey');
  },
  setSettings: async patch => api.settings.set({ patch }),
  grantConsent: async input => api.consent.grant(input),
};

export interface AiContainerProps {
  readonly chrome: StepChrome;
  /** Tell the window this step's keys and focus (every render). */
  readonly bindKeys: (keys: StepKeys) => void;
  /** The step is over: Continue (after the consent answer) or "Skip for now". */
  readonly onDone: () => void;
  readonly ports?: Partial<AiPorts>;
}

export function AiContainer({ chrome, bindKeys, onDone, ports: given }: AiContainerProps) {
  const ports = useRef({ ...defaultAiPorts, ...given }).current;
  const settings = useSettings();
  const consent = useConsent();
  const [state, dispatch] = useReducer(reduceAi, undefined, initialAi);
  const [providers, setProviders] = useState<readonly AiProvider[] | undefined>(undefined);
  const [models, setModels] = useState<Readonly<Record<string, readonly AiModelInfo[]>>>({});
  const asked = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const refreshProviders = useCallback(async () => {
    try {
      const out = await ports.providers();
      if (alive.current) setProviders(out.list);
    } catch {
      // Unknown table: the step shows Groq with a key field, and Skip for now always works.
      if (alive.current) setProviders(prev => prev ?? []);
    }
  }, [ports]);

  const loadModels = useCallback(
    async (provider: string, force = false) => {
      if (!force && asked.current.has(provider)) return;
      asked.current.add(provider);
      try {
        const out = await ports.models({ provider: provider as Input<'Ai/models'>['provider'] });
        if (alive.current) setModels(prev => ({ ...prev, [provider]: out.list }));
      } catch {
        asked.current.delete(provider);
      }
    },
    [ports],
  );

  useEffect(() => {
    void refreshProviders();
    void loadModels('groq');
    void loadModels('openai');
  }, [refreshProviders, loadModels]);

  useEffect(() => {
    void loadModels(state.chosen);
  }, [state.chosen, loadModels]);

  const inputs: AiInputs = {
    providers,
    models,
    features: settings?.ai.features,
    consent,
  };
  const vm = aiView(state, inputs);
  const latest = useRef({ state, inputs, vm });
  latest.current = { state, inputs, vm };

  const onContinue = useCallback(async () => {
    const { state: s, inputs: i } = latest.current;
    if (s.writing) return;
    const choice = currentChoice(s, i);
    if (!choice) return;
    // Settings still loading: writing now would replace a stored voice choice with the default. Wait for them.
    if (!i.features) return;
    const features = featuresFor(choice, i);
    dispatch({ type: 'writing' });
    try {
      await ports.setSettings({ ai: { features } });
    } catch {
      dispatch({ type: 'writeFailed' });
      return;
    }
    if (!alive.current) return; // the owner left the step while it saved: never move the window from here
    const ask = needsConsent(i.consent, choice);
    dispatch({ type: 'written', consent: ask });
    if (!ask) onDone();
  }, [ports, onDone]);

  const onAllow = useCallback(async () => {
    const { state: s, inputs: i } = latest.current;
    const choice = currentChoice(s, i);
    if (choice) {
      try {
        await ports.grantConsent(consentGrant(i.consent, choice));
      } catch {
        // Without a stored consent the sorting pass is simply omitted; nothing on the mail surface fails.
      }
    }
    if (alive.current) onDone();
  }, [ports, onDone]);

  const onSaveKey = useCallback(async () => {
    const { state: s, vm: v } = latest.current;
    const field = v.keyField;
    const key = s.keyDraft.trim();
    if (!field || s.savingKey) return;
    if (!key) {
      // An empty field: Return means Continue when the choice can already run.
      if (v.canContinue) void onContinue();
      return;
    }
    dispatch({ type: 'keySaving' }); // clears the field before the call
    try {
      await ports.setKey({ provider: field.provider as Input<'Ai/setKey'>['provider'], key });
      dispatch({ type: 'keySaved' });
      await refreshProviders();
      void loadModels(field.provider, true);
    } catch (error) {
      dispatch({ type: 'keyFailed', reasonCode: reasonOf(error) });
    }
  }, [ports, refreshProviders, loadModels, onContinue]);

  const onCheck = useCallback(
    async (provider: string) => {
      const p = latest.current.inputs.providers?.find(x => x.id === provider);
      dispatch({ type: 'testStarted', provider });
      if (p?.group === 'local') {
        await refreshProviders();
        void loadModels(provider, true);
        dispatch({ type: 'testCleared', provider });
        return;
      }
      try {
        const out = await ports.testKey({ provider: provider as Input<'Ai/testKey'>['provider'] });
        dispatch({
          type: 'testDone',
          provider,
          test: out.ok
            ? { kind: 'works', ...(out.ms !== undefined ? { ms: out.ms } : {}) }
            : { kind: 'failed', ...(out.reasonCode ? { reasonCode: out.reasonCode } : {}) },
        });
      } catch (error) {
        dispatch({
          type: 'testDone',
          provider,
          test: { kind: 'failed', reasonCode: reasonOf(error) },
        });
      }
    },
    [ports, refreshProviders, loadModels],
  );

  const onSaveAddress = useCallback(
    async (provider: string) => {
      const draft = latest.current.state.addressDraft[provider];
      if (draft === undefined || !settings) return;
      const current = settings.ai.providers;
      try {
        await ports.setSettings({
          ai: {
            providers: { ...current, [provider]: { ...current[provider], address: draft.trim() } },
          },
        });
        await refreshProviders();
        void loadModels(provider, true);
      } catch {
        // The field keeps the text; Skip for now and the other providers still work.
      }
    },
    [ports, settings, refreshProviders, loadModels],
  );

  const keys: StepKeys = {
    focusKey: vm.focusKey,
    focus: vm.focus,
    keepUserFocus: true, // a late models or provider answer never pulls focus from where the owner went
    main: () => {
      const v = latest.current.vm;
      if (v.view === 'consent') void onAllow();
      else if (v.canContinue) void onContinue();
    },
    esc: () => {
      const out = aiEsc(latest.current.state);
      if (out.handled) dispatch({ type: 'replace', state: out.state });
      return out.handled;
    },
  };
  useLayoutEffect(() => bindKeys(keys));

  return (
    <AiStep
      chrome={chrome}
      vm={vm}
      moreOpen={state.moreOpen}
      onToggleMore={() => dispatch({ type: 'toggleMore' })}
      onOpenHosted={() => dispatch({ type: 'open', view: 'hosted', providers: providers ?? [] })}
      onOpenLocal={() => dispatch({ type: 'open', view: 'local', providers: providers ?? [] })}
      onChoose={provider => dispatch({ type: 'choose', provider })}
      onCheck={provider => void onCheck(provider)}
      onPickModel={(provider, model) => dispatch({ type: 'pickModel', provider, model })}
      onEditKey={text => dispatch({ type: 'editKey', text })}
      onSaveKey={() => void onSaveKey()}
      onEditAddress={(provider, text) => dispatch({ type: 'editAddress', provider, text })}
      onSaveAddress={provider => void onSaveAddress(provider)}
      onContinue={() => void onContinue()}
      onSkip={onDone}
      onAllow={() => void onAllow()}
      onNotNow={onDone}
    />
  );
}

/** For the preview: the model's state type, re-exported so fixtures build states without the reducer. */
export type { AiState };
