/**
 * What the Settings screen does when the owner acts. Plain functions over injected dependencies (the ports, the shell
 * host, and where state lives), so the container, the preview and the tests run the same code. It owns the rules:
 * a write is optimistic and, when rejected, puts the control back and says so in one inline line with Retry
 * (DESIGN 5 rule 11, 7.15); a key goes out once and is never kept (DESIGN 7.10); a destructive step asks first.
 */
import type { Settings, SettingsPatch } from '../../data';
import { createAppRegistry } from '../../commands';
import type { AiFeature, ProviderId } from '../../ui/props';
import {
  addressPatch,
  backgroundPlan,
  capPatch,
  cascadeChoice,
  featureLabel,
  featurePatch,
  paidPatch,
  providerName,
  testResultStatus,
  type LocalId,
} from './settings.model';
import {
  applyRemap,
  judgeChord,
  remapLabel,
  RESET_ALL_TOAST,
  resetKeys,
  SINGLE_KEY_OFF_TOAST,
  SINGLE_KEY_ON_TOAST,
  type KeyFields,
} from './keyboard.model';
import type { SettingsApiPort, SettingsData, SettingsHost, WriteFailure } from './ports';
import type { Confirmation, SettingsView } from './view';

export interface ControllerDeps {
  readonly ports: SettingsApiPort;
  readonly host: SettingsHost;
  data(): SettingsData;
  view(): SettingsView;
  setView(patch: Partial<SettingsView>): void;
  setData(patch: Partial<SettingsData>): void;
  /** Shows a patch at once over the live settings; null takes it away. */
  overlay(patch: SettingsPatch | null): void;
  fail(failure: WriteFailure | null): void;
  /** Runs `fn` after `ms`; returns a cancel. Defaults to a timer. */
  schedule?(fn: () => void, ms: number): () => void;
}

const message = (error: unknown, fallback: string): string =>
  error &&
  typeof error === 'object' &&
  'message' in error &&
  typeof (error as { message: unknown }).message === 'string'
    ? (error as { message: string }).message
    : fallback;

export type SettingsController = ReturnType<typeof createController>;

export function createController(deps: ControllerDeps) {
  const { ports, host } = deps;
  const schedule =
    deps.schedule ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    });
  const view = () => deps.view();
  const data = () => deps.data();
  const busy = (key: string, on: boolean) => deps.setView({ busy: { ...view().busy, [key]: on } });

  /** Runs a write; on rejection the failure line offers Retry for the same step. */
  async function guard(op: string, run: () => Promise<void>): Promise<boolean> {
    try {
      await run();
      deps.fail(null);
      return true;
    } catch {
      deps.fail({ op, retry: () => void guard(op, run), dismiss: () => deps.fail(null) });
      return false;
    }
  }

  /* The optimistic overlay is one slot per write in flight, not one for the page: a write that settles takes
   * down only its own, so a slow write never snaps a concurrent one back. */
  let overlaySeq = 0;
  const inFlight = new Map<number, SettingsPatch>();
  const overlayNow = (): SettingsPatch | null => {
    if (inFlight.size === 0) return null;
    const out: Record<string, Record<string, unknown>> = {};
    for (const patch of inFlight.values())
      for (const section of Object.keys(patch)) {
        const part = (patch as Record<string, Record<string, unknown> | undefined>)[section];
        if (part) out[section] = { ...(out[section] ?? {}), ...part };
      }
    return out as SettingsPatch;
  };
  const pushOverlay = (patch: SettingsPatch): number => {
    const id = ++overlaySeq;
    inFlight.set(id, patch);
    deps.overlay(overlayNow());
    return id;
  };
  const dropOverlay = (id: number): void => {
    inFlight.delete(id);
    deps.overlay(overlayNow());
  };

  /** `Settings/set` with the optimistic overlay: the control moves at once and goes back if the write is refused. */
  async function set(patch: SettingsPatch, op = 'save that setting'): Promise<boolean> {
    const id = pushOverlay(patch);
    const ok = await guard(op, () => ports.settingsSet(patch));
    dropOverlay(id);
    return ok;
  }

  /** The provider table re-read after a key changed; it failing quietly must never skip what follows. */
  const refreshProviders = async (): Promise<void> => {
    try {
      await ports.loadProviders?.();
    } catch {
      /* the table keeps what it had */
    }
  };

  /* Feature choices the engine has not echoed back yet. `ai.features` is written whole, so a feature write built
   * on the stale read would silently revert a change that is still on its way (or just landed). */
  type FeatureChoice = Settings['ai']['features'][AiFeature];
  const pendingFeatures = new Map<AiFeature, FeatureChoice>();
  const featuresNow = (settings: Settings): Settings['ai']['features'] => {
    const stored = settings.ai.features;
    for (const [feature, choice] of [...pendingFeatures]) {
      const s = stored[feature];
      if (s.provider === choice.provider && s.model === choice.model)
        pendingFeatures.delete(feature);
    }
    return { ...stored, ...Object.fromEntries(pendingFeatures) } as Settings['ai']['features'];
  };

  const keyFields = (): KeyFields => data().settings.ui;

  const addressTimers = new Map<LocalId, () => void>();
  /** Bumped by leave(), so a provider test that lands after the page was left writes nothing. */
  let testGeneration = 0;

  const self = {
    set,

    /* ───────────── General, Mail, Notifications ───────────── */
    setUi(patch: NonNullable<SettingsPatch['ui']>) {
      return set({ ui: patch });
    },

    /* ───────────── Accounts ───────────── */
    setAccount(
      accountId: string,
      patch: { colorTag?: string; aiAllowed?: boolean; notifications?: boolean },
    ) {
      return guard('save that account setting', () => ports.accountSet(accountId, patch));
    },
    startReconnect(accountId: string, mode: 'reconnect' | 'grant') {
      deps.setView({ reconnect: { accountId, mode } });
    },
    closeReconnect() {
      deps.setView({ reconnect: null });
    },
    askRemoveAccount(accountId: string) {
      const account = data().accounts.find(a => a.id === accountId);
      if (account)
        deps.setView({ confirm: { kind: 'removeAccount', accountId, address: account.address } });
    },
    takeLease(accountId: string, pin: boolean) {
      const key = `lease:${accountId}`;
      busy(key, true);
      return guard('change where background work runs', () =>
        ports.accountLease(accountId, pin),
      ).finally(() => busy(key, false));
    },
    askRemoveDemo() {
      deps.setView({ confirm: { kind: 'removeDemo' } });
    },
    async resetDemo() {
      busy('demo', true);
      const ok = await guard('reset the demo mail', () => ports.demoReset());
      busy('demo', false);
      if (ok) host.toast?.('Demo mail reset');
    },
    async loadDemo() {
      busy('demo', true);
      const ok = await guard('load the demo mail', () => ports.demoLoad());
      busy('demo', false);
      if (ok) host.toast?.('Demo mail loaded');
    },
    openAddAccount() {
      deps.setView({ addAccount: true });
    },
    closeAddAccount() {
      deps.setView({ addAccount: false });
    },

    /* ───────────── AI ───────────── */
    /** A feature's provider or model changed; a new provider resets the model to its first one. */
    async changeFeature(feature: AiFeature, choice: { provider: ProviderId; model: string }) {
      const d = data();
      const features = featuresNow(d.settings);
      const current = features[feature];
      let models = d.models;
      if (choice.provider !== current.provider && !models?.[choice.provider]?.length) {
        try {
          const list = await ports.aiModels(choice.provider);
          models = { ...(models ?? {}), [choice.provider]: list };
          deps.setData({ models });
        } catch {
          /* the cascade below refuses without a model */
        }
      }
      const next = cascadeChoice(feature, choice, current, models ?? {});
      if (!next) {
        deps.fail({
          op: `use ${providerName(choice.provider)} for ${featureLabel(feature)}`,
          retry: () => void self.changeFeature(feature, choice),
          dismiss: () => deps.fail(null),
        });
        return false;
      }
      pendingFeatures.set(feature, next);
      const ok = await set(
        featurePatch({ ai: { ...d.settings.ai, features } }, feature, next),
        `change the ${featureLabel(feature)} model`,
      );
      // A refused write puts the control back and drops the intent; a newer one for the same feature stays.
      if (!ok && pendingFeatures.get(feature) === next) pendingFeatures.delete(feature);
      return ok;
    },
    async loadModels(provider: string) {
      if (data().models?.[provider]) return;
      try {
        deps.setData({
          models: { ...(data().models ?? {}), [provider]: await ports.aiModels(provider) },
        });
      } catch {
        /* the picker keeps the current model */
      }
    },
    /** The address as typed shows at once; it is saved a moment after the last keystroke. */
    changeAddress(provider: LocalId, address: string) {
      deps.setView({
        addressDraft: { ...view().addressDraft, [provider]: address },
        addressError: { ...view().addressError, [provider]: undefined },
      });
      addressTimers.get(provider)?.();
      addressTimers.set(
        provider,
        schedule(() => {
          addressTimers.delete(provider);
          void (async () => {
            const patch = addressPatch(data().settings, provider, address);
            const overlayId = pushOverlay(patch);
            try {
              await ports.settingsSet(patch);
              // Only this save clears its own draft; typing that arrived since must stay.
              if (view().addressDraft[provider] === address)
                deps.setView({
                  addressDraft: { ...view().addressDraft, [provider]: undefined },
                });
            } catch (error) {
              deps.setView({
                addressError: {
                  ...view().addressError,
                  [provider]: message(error, 'That address didn’t work. Check it and try again.'),
                },
              });
            }
            dropOverlay(overlayId);
          })();
        }, 600),
      );
    },
    /** Test a provider's key: one cheap request, no mail. The result replaces the status until the page is left. */
    async testProvider(provider: ProviderId) {
      const generation = testGeneration;
      deps.setView({ testing: { ...view().testing, [provider]: { kind: 'testing' } } });
      try {
        const result = await ports.aiTestKey(provider);
        if (generation === testGeneration)
          deps.setView({
            testing: { ...view().testing, [provider]: testResultStatus(result) },
          });
      } catch {
        if (generation === testGeneration)
          deps.setView({
            testing: { ...view().testing, [provider]: { kind: 'unreachable' } },
          });
      }
    },
    /** Leaving the page drops test results, anything half-typed and a stale failure line. */
    leave() {
      testGeneration += 1;
      for (const cancel of addressTimers.values()) cancel();
      addressTimers.clear();
      deps.fail(null);
      deps.setView({
        testing: {},
        addKey: null,
        addressDraft: {},
        addressError: {},
        recording: null,
      });
    },
    openAddKey(provider: ProviderId, mode: 'add' | 'replace' = 'add') {
      deps.setView({ addKey: { provider, mode } });
    },
    cancelAddKey() {
      deps.setView({ addKey: null });
    },
    /**
     * The key goes to the engine once and is not kept: nothing here stores it, logs it or puts it in state. A test
     * runs right after, as the row's status.
     */
    async submitKey(provider: ProviderId, key: string) {
      deps.setView({ addKey: null });
      let ok: boolean;
      try {
        await ports.aiSetKey(provider, key);
        deps.fail(null);
        ok = true;
      } catch {
        ok = false;
        // The key is never kept: Retry reopens the add-key dialog for a fresh paste, it does not resubmit.
        deps.fail({
          op: `save the ${providerName(provider)} key`,
          retry: () => self.openAddKey(provider, 'add'),
          dismiss: () => deps.fail(null),
        });
      }
      if (ok) {
        await refreshProviders();
        await self.testProvider(provider);
      }
      return ok;
    },
    askRemoveKey(provider: ProviderId) {
      deps.setView({ confirm: { kind: 'removeKey', provider } });
    },
    setBackground(on: boolean) {
      const consent = data().consent;
      for (const step of backgroundPlan(consent, on)) {
        if (step === 'openCard') deps.setView({ consentCard: true });
        if (step === 'enable')
          void set({ ai: { background: true } }, 'turn on background summaries');
        if (step === 'disable')
          void set({ ai: { background: false } }, 'turn off background summaries');
        if (step === 'revoke') void guard('withdraw consent', () => ports.consentRevoke());
      }
    },
    openConsentCard() {
      deps.setView({ consentCard: true });
    },
    closeConsentCard() {
      deps.setView({ consentCard: false });
    },
    /** Allow on the consent card: the engine records the version, provider and model the owner saw. */
    async allowBackground() {
      const d = data();
      const s = d.settings.ai.features.summaries;
      deps.setView({ consentCard: false });
      const ok = await guard('save your choice', () =>
        ports.consentGrant({
          version: d.consent.currentVersion,
          provider: s.provider,
          model: s.model,
        }),
      );
      if (ok) await set({ ai: { background: true } }, 'turn on background summaries');
    },
    setCap(id: string) {
      return set(capPatch(data().settings, id), 'change the daily limit');
    },
    setGeminiPaid(paid: boolean) {
      return set(paidPatch(data().settings, 'gemini', paid), 'save that setting');
    },
    toggleHow() {
      deps.setView({ howOpen: !view().howOpen });
    },

    /* ───────────── Keyboard ───────────── */
    startRecording(commandId: string) {
      deps.setView({ recording: { commandId, state: 'recording' } });
    },
    cancelRecording() {
      deps.setView({ recording: null });
    },
    /** A chord was pressed while recording: take it, or show who has it, or say why not. */
    recordChord(chord: string) {
      const rec = view().recording;
      if (!rec) return;
      const verdict = judgeChord(rec.commandId, chord, keyFields());
      if (verdict.kind === 'ok') return void self.commitRemap(rec.commandId, chord);
      if (verdict.kind === 'conflict') {
        deps.setView({
          recording: {
            commandId: rec.commandId,
            state: 'conflict',
            pendingChord: chord,
            conflictWith: verdict.with,
          },
        });
      } else {
        deps.setView({
          recording: { commandId: rec.commandId, state: 'recording', refused: verdict.text },
        });
      }
    },
    replaceConflict() {
      const rec = view().recording;
      if (rec?.state === 'conflict' && rec.pendingChord && rec.conflictWith)
        void self.commitRemap(rec.commandId, rec.pendingChord, rec.conflictWith);
    },
    async commitRemap(
      commandId: string,
      chord: string,
      replace?: { commandId: string; label: string },
    ) {
      const before = data().settings.ui.keymap;
      const keymap = applyRemap(keyFields(), commandId, chord, replace);
      deps.setView({ recording: null });
      const ok = await set({ ui: { keymap } }, 'change that shortcut');
      if (ok) {
        const label = remapLabel(commandLabel(commandId), chord);
        host.toast?.(label);
        host.pushUndo?.({
          label,
          undo: () => void set({ ui: { keymap: before } }, 'undo that change'),
        });
      }
    },
    resetShortcut(commandId: string) {
      const before = data().settings.ui.keymap;
      void set({ ui: { keymap: resetKeys(before, commandId) } }, 'reset that shortcut');
    },
    resetAllShortcuts() {
      const before = data().settings.ui.keymap;
      void set({ ui: { keymap: {} } }, 'reset the shortcuts').then(ok => {
        if (!ok) return;
        host.toast?.(RESET_ALL_TOAST);
        host.pushUndo?.({
          label: RESET_ALL_TOAST,
          undo: () => void set({ ui: { keymap: before } }),
        });
      });
    },
    setSingleKeys(on: boolean) {
      void set({ ui: { singleKeys: on } }, 'save that setting').then(ok => {
        if (ok) host.toast?.(on ? SINGLE_KEY_ON_TOAST : SINGLE_KEY_OFF_TOAST);
      });
    },

    /* ───────────── Tools, Help ───────────── */
    async setListener(enabled: boolean) {
      const ok = await guard('change that setting', () => ports.listenerSet(enabled));
      if (ok) deps.setData({ listener: { ...(data().listener ?? {}), enabled } });
    },
    revokeClient(id: string) {
      return guard('revoke that tool', async () => {
        await ports.clientsRevoke(id);
        deps.setData({ clients: (data().clients ?? []).filter(c => c.id !== id) });
      });
    },
    async openDiagnostics() {
      deps.setView({ diagnostics: true });
      busy('diagnostics', true);
      try {
        deps.setData({ bundle: await ports.diagnosticsPreview() });
      } catch {
        deps.fail({
          op: 'prepare the report',
          retry: () => void self.openDiagnostics(),
          dismiss: () => deps.fail(null),
        });
        deps.setView({ diagnostics: false });
      }
      busy('diagnostics', false);
    },
    closeDiagnostics() {
      deps.setView({ diagnostics: false });
      deps.setData({ bundle: undefined });
    },
    saveDiagnostics() {
      if (view().busy.diagnostics) return Promise.resolve(false);
      busy('diagnostics', true);
      // A failure stays inside the open dialog (the page line is behind it), so the dialog stays up on a miss.
      return guard('save the report', async () => {
        await ports.diagnosticsSave();
        deps.setView({ diagnostics: false });
        deps.setData({ bundle: undefined });
      }).finally(() => busy('diagnostics', false));
    },
    openQueue() {
      deps.setView({ queue: true });
    },
    closeQueue() {
      deps.setView({ queue: false });
    },
    retryQueueItem(id: string) {
      return guard('retry that item', () => ports.queueRetry(id));
    },
    askDiscardQueueItem(id: string, label: string, confirm: boolean) {
      if (confirm) deps.setView({ confirm: { kind: 'discardQueueItem', id, label } });
      else void guard('discard that item', () => ports.queueDiscard(id));
    },
    showWelcome() {
      host.showWelcome?.();
    },

    /* ───────────── Confirmations ───────────── */
    cancelConfirm() {
      deps.setView({ confirm: null });
    },
    /** The destructive step runs only here, after Cancel was passed over on purpose. */
    async runConfirm(c: Confirmation) {
      deps.setView({ confirm: null });
      switch (c.kind) {
        case 'removeAccount':
          return guard('remove that account', () => ports.accountDisconnect(c.accountId));
        case 'removeDemo': {
          busy('demo', true);
          const ok = await guard('remove the demo mail', () => ports.demoRemove());
          busy('demo', false);
          if (ok) host.toast?.('Demo mail removed');
          return ok;
        }
        case 'removeKey': {
          const ok = await guard(`remove the ${providerName(c.provider)} key`, () =>
            ports.aiRemoveKey(c.provider),
          );
          if (ok) await refreshProviders();
          return ok;
        }
        case 'discardQueueItem':
          return guard('discard that item', () => ports.queueDiscard(c.id));
      }
    },
  };
  return self;
}

/** A command's label from the registry, for "Done is now L". */
let labels: Map<string, string> | null = null;
function commandLabel(id: string): string {
  if (!labels) {
    const registry = createAppRegistry();
    labels = new Map(
      registry
        .bindings()
        .map(b => [b.commandId, registry.get(b.commandId)?.spec.label ?? b.commandId]),
    );
  }
  return labels.get(id) ?? id;
}
