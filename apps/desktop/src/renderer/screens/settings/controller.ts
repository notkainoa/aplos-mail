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
  mailAllowedLabel,
  mailAllowedOp,
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
import {
  grantUnconfirmed,
  removalDiscards,
  removalRefusal,
  removedToast,
  GRANT_UNCONFIRMED_LINE,
  withoutKeyPath,
  type AccountWrite,
  type ClientEntry,
  type QueueEntry,
  type ToolKind,
  type ToolScope,
} from './settings.model';
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
  /** Shows account writes at once over the live accounts, by account id; null takes them away. */
  accountOverlay(patch: Readonly<Record<string, AccountWrite>> | null): void;
  fail(failure: WriteFailure | null): void;
  /** The failure on screen right now, so a write can clear its own line without touching a sibling's. */
  failure?(): WriteFailure | null;
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

  /* The failure line is one shared slot, but a write takes down only the line it put up itself: each path
   * remembers the failure object it last wrote and, on success, clears the slot only while it still holds that
   * same object — so a refused bulk-mail line survives an unrelated write. A host that cannot answer
   * `failure` keeps the old unconditional clear. */
  const ownFailure = () => {
    let written: WriteFailure | null = null;
    return {
      write(failure: WriteFailure): void {
        written = failure;
        deps.fail(failure);
      },
      clearIfOwn(): void {
        if (!deps.failure || deps.failure() === written) deps.fail(null);
      },
    };
  };
  type OwnFailure = ReturnType<typeof ownFailure>;

  const setFail = ownFailure();
  const accountFail = ownFailure();
  const featureFail = ownFailure();
  const keyFail = ownFailure();
  const mailFail = ownFailure();
  /* `guard` is shared by every one-off write; each op keeps the line it last wrote so one action's success
   * never clears another's refusal. */
  const guardFails = new Map<string, OwnFailure>();

  /**
   * Runs a write; on rejection the failure line offers Retry for the same step. `failure` can answer a
   * different line for a rejection Retry would make worse (a grant that may have committed anyway).
   */
  async function guard(
    op: string,
    run: () => Promise<void>,
    failure?: (error: unknown, retry: () => void) => WriteFailure,
  ): Promise<boolean> {
    let own = guardFails.get(op);
    if (!own) guardFails.set(op, (own = ownFailure()));
    try {
      await run();
      own.clearIfOwn();
      return true;
    } catch (error) {
      const retry = () => void guard(op, run, failure);
      own.write(failure?.(error, retry) ?? { op, retry, dismiss: () => deps.fail(null) });
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

  /* The account overlay works the same way, per account: a switch or a colour moves at once, and several writes
   * in flight each hold only their own patch until they settle. */
  let accountSeq = 0;
  const accountInFlight = new Map<number, { accountId: string; patch: AccountWrite }>();
  const accountOverlayNow = (): Record<string, AccountWrite> | null => {
    if (accountInFlight.size === 0) return null;
    const out: Record<string, AccountWrite> = {};
    for (const { accountId, patch } of accountInFlight.values())
      out[accountId] = { ...(out[accountId] ?? {}), ...patch };
    return out;
  };
  const pushAccountOverlay = (accountId: string, patch: AccountWrite): number => {
    const id = ++accountSeq;
    accountInFlight.set(id, { accountId, patch });
    deps.accountOverlay(accountOverlayNow());
    return id;
  };
  const dropAccountOverlay = (id: number): void => {
    accountInFlight.delete(id);
    deps.accountOverlay(accountOverlayNow());
  };

  /** `Settings/set` with the optimistic overlay: the control moves at once and goes back if the write is refused. */
  async function set(
    patch: SettingsPatch,
    op = 'save that setting',
    own: OwnFailure = setFail,
  ): Promise<boolean> {
    const id = pushOverlay(patch);
    let ok: boolean;
    try {
      await ports.settingsSet(patch);
      own.clearIfOwn();
      ok = true;
    } catch {
      // Retry is the same write again, overlay and all — the control moves at once on Retry too.
      own.write({ op, retry: () => void set(patch, op, own), dismiss: () => deps.fail(null) });
      ok = false;
    }
    dropOverlay(id);
    return ok;
  }

  /* "Turn on for existing accounts" (Settings → AI): a bulk write still holds one optimistic overlay per
   * account and each write settles on its own, but the outcome is ONE line — naming the refused accounts
   * only, with a Retry that writes only those — and ONE undo covering exactly the accounts the press
   * turned on. The single failure slot is never cleared for a sibling: a full success takes down only a
   * line this path wrote itself. */
  async function writeMailAllowed(ids: readonly string[], on: boolean): Promise<readonly string[]> {
    const results = await Promise.allSettled(
      ids.map(id => {
        const overlayId = pushAccountOverlay(id, { aiAllowed: on });
        return Promise.resolve()
          .then(() => ports.accountSet(id, { aiAllowed: on }))
          .finally(() => dropAccountOverlay(overlayId));
      }),
    );
    const refused = ids.filter((_, i) => results[i]!.status === 'rejected');
    if (refused.length === 0) {
      // A success clears the slot only while it still holds this path's own line.
      mailFail.clearIfOwn();
      return refused;
    }
    mailFail.write({
      op: mailAllowedOp(data().accounts, refused, on),
      retry: () => void writeMailAllowed(refused, on),
      dismiss: () => deps.fail(null),
    });
    return refused;
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

  /** The admin-scope grant whose owner has not answered yet: the draft, the dialog's answer-back, and how
   * the `grantClient` call that parked it settles — it stays open for the whole ask so the dialog stays
   * busy and cannot be closed with the one-time key path still undelivered. */
  let pendingAdminGrant: {
    input: { name: string; kind: ToolKind; scopes: readonly ToolScope[] };
    onGranted: (client: ClientEntry) => void;
    settle: (ok: boolean) => void;
  } | null = null;

  /** Ends a parked admin ask, if any: its waiting `grantClient` call answers false. */
  const dropPendingAdminGrant = (): void => {
    pendingAdminGrant?.settle(false);
    pendingAdminGrant = null;
  };

  /** Re-reads the tool list so a grant the engine may have committed becomes visible; quiet on a miss. */
  async function refreshClients(): Promise<void> {
    try {
      deps.setData({ clients: (await ports.clientsList()).map(withoutKeyPath) });
    } catch {
      /* the list keeps what it had */
    }
  }

  /** The guarded `Clients/grant` itself; `onGranted` hands the new tool (with its key path) back to the dialog. */
  async function doGrant(
    input: { name: string; kind: ToolKind; scopes: readonly ToolScope[] },
    onGranted: (client: ClientEntry) => void,
  ): Promise<boolean> {
    if (view().busy.grant) return false;
    busy('grant', true);
    let unconfirmedRefresh: Promise<void> | null = null;
    /* Only `Clients/grant` is guarded: once it resolves the tool exists, so handing it back is best-effort
     * and a throw there must not read as a failed grant — the line's Retry would mint a second one. A
     * refused grant's Retry re-runs the step, so it still delivers the key path to the dialog. */
    const ok = await guard(
      'allow that tool',
      async () => {
        const granted = await ports.clientsGrant({ ...input, name: input.name.trim() });
        try {
          onGranted(granted);
        } catch {
          /* the dialog dropped its answer-back; the path is simply not shown */
        }
        try {
          const listed = withoutKeyPath(granted);
          deps.setData({
            clients: [...(data().clients ?? []).filter(c => c.id !== listed.id), listed],
          });
        } catch {
          /* the next list read picks the tool up */
        }
      },
      (error, retry) => {
        if (!grantUnconfirmed(error))
          return { op: 'allow that tool', retry, dismiss: () => deps.fail(null) };
        // The grant may have committed before the engine stopped answering: a Retry could make a second
        // tool, so the line offers none and says to check the list — re-read so a landed grant shows.
        unconfirmedRefresh = refreshClients();
        return {
          op: 'allow that tool',
          line: GRANT_UNCONFIRMED_LINE,
          dismiss: () => deps.fail(null),
        };
      },
    );
    busy('grant', false);
    await unconfirmedRefresh;
    return ok;
  }

  const self = {
    set,

    /* ───────────── General, Mail, Notifications ───────────── */
    setUi(patch: NonNullable<SettingsPatch['ui']>) {
      return set({ ui: patch });
    },

    /* ───────────── Accounts ───────────── */
    /** `Account/set` with the optimistic overlay: the control moves at once and goes back if the write is refused. */
    async setAccount(accountId: string, patch: AccountWrite) {
      const id = pushAccountOverlay(accountId, patch);
      let ok: boolean;
      try {
        await ports.accountSet(accountId, patch);
        accountFail.clearIfOwn();
        ok = true;
      } catch {
        // Retry is the same write again, overlay and all — the control moves at once on Retry too.
        accountFail.write({
          op: 'save that account setting',
          retry: () => void self.setAccount(accountId, patch),
          dismiss: () => deps.fail(null),
        });
        ok = false;
      }
      dropAccountOverlay(id);
      return ok;
    },
    startReconnect(accountId: string, mode: 'reconnect' | 'grant' | 'enableEditing') {
      deps.setView({ reconnect: { accountId, mode } });
    },
    closeReconnect() {
      deps.setView({ reconnect: null });
    },
    /** The confirm names the failed sends and calendar changes that go with the account; without the queue it still asks. */
    async askRemoveAccount(accountId: string) {
      const account = data().accounts.find(a => a.id === accountId);
      if (!account) return;
      let queue: readonly QueueEntry[] | undefined;
      try {
        queue = await ports.queueList();
      } catch {
        queue = undefined;
      }
      // Another dialog opened while the queue was read: that one stays.
      if (view().confirm) return;
      deps.setView({
        confirm: {
          kind: 'removeAccount',
          accountId,
          address: account.address,
          ...(queue ? { discards: removalDiscards(queue, accountId) } : {}),
        },
      });
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
    /** "Turn on for existing accounts": each account settles on its own; the line and the undo are one. */
    async allowMailForAccounts(ids: readonly string[]) {
      const refused = await writeMailAllowed(ids, true);
      const turnedOn = ids.filter(id => !refused.includes(id));
      if (turnedOn.length > 0)
        host.pushUndo?.({
          label: mailAllowedLabel(data().accounts, turnedOn),
          undo: () => void writeMailAllowed(turnedOn, false),
        });
      return refused.length === 0;
    },
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
        featureFail.write({
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
        featureFail,
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
      dropPendingAdminGrant();
      deps.fail(null);
      deps.setView({
        // An unanswered admin ask does not outlive the page.
        ...(view().confirm?.kind === 'grantAdmin' ? { confirm: null } : {}),
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
      // Leaving the page while the save is in flight cancels the refresh and the test that follow it.
      const generation = testGeneration;
      deps.setView({ addKey: null });
      let ok: boolean;
      try {
        await ports.aiSetKey(provider, key);
        keyFail.clearIfOwn();
        ok = true;
      } catch {
        ok = false;
        // The key is never kept: Retry reopens the add-key dialog for a fresh paste, it does not resubmit.
        keyFail.write({
          op: `save the ${providerName(provider)} key`,
          retry: () => self.openAddKey(provider, 'add'),
          dismiss: () => deps.fail(null),
        });
      }
      if (ok && generation === testGeneration) {
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
      const consent = d.consent;
      // No consent record, no version to agree to — the card only opens with one anyway.
      if (!consent) return;
      deps.setView({ consentCard: false });
      const ok = await guard('save your choice', () =>
        ports.consentGrant({
          version: consent.currentVersion,
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
    askRevokeClient(id: string, name: string) {
      deps.setView({ confirm: { kind: 'revokeClient', id, name } });
    },
    revokeClient(id: string) {
      return guard('revoke that tool', async () => {
        await ports.clientsRevoke(id);
        deps.setData({ clients: (data().clients ?? []).filter(c => c.id !== id) });
      });
    },
    openAddTool() {
      // The dialog shows the shared failure slot: another action's line must not appear inside it.
      deps.fail(null);
      deps.setView({ addTool: true });
    },
    closeAddTool() {
      // A failed grant's Retry must not outlive the dialog: it would make a tool whose key path nobody sees.
      if (deps.failure?.()?.op === 'allow that tool') deps.fail(null);
      // A parked admin ask dies with its dialog, and so does the question drawing over it.
      dropPendingAdminGrant();
      deps.setView({
        addTool: false,
        ...(view().confirm?.kind === 'grantAdmin' ? { confirm: null } : {}),
      });
    },
    /**
     * Allows a tool. 'admin' asks twice: Allow opens the shared confirm (Cancel is the default), and only its
     * answer grants. The new tool joins the list without its key file's path; the path goes back to the dialog
     * once and is kept nowhere else. Resolves when the flow is over — a refusal or a cancelled ask is false —
     * so the dialog stays busy for the whole admin ask and the one-time key path cannot be lost mid-flow.
     */
    async grantClient(
      input: { name: string; kind: ToolKind; scopes: readonly ToolScope[] },
      onGranted: (client: ClientEntry) => void,
    ): Promise<boolean> {
      if (view().busy.grant || pendingAdminGrant) return false;
      if (input.scopes.includes('admin')) {
        // The draft and where its key path goes wait here, not in view state: the add dialog stays mounted
        // and busy under the question, so cancelling leaves the form exactly as it was.
        deps.setView({ confirm: { kind: 'grantAdmin', name: input.name.trim() } });
        return new Promise<boolean>(resolve => {
          pendingAdminGrant = { input, onGranted, settle: resolve };
        });
      }
      return doGrant(input, onGranted);
    },
    async openDiagnostics() {
      // The dialog shows the shared failure slot: another action's line must not appear inside it.
      deps.fail(null);
      deps.setView({ diagnostics: true, diagnosticsCopied: false, diagnosticsSaved: false });
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
      // A copy or save line belongs to the dialog; it does not stay on the page once the report is closed.
      if (['copy the report', 'save the report'].includes(deps.failure?.()?.op ?? ''))
        deps.fail(null);
      deps.setView({ diagnostics: false, diagnosticsCopied: false, diagnosticsSaved: false });
      deps.setData({ bundle: undefined });
    },
    copyDiagnostics() {
      if (view().busy.diagnostics) return Promise.resolve(false);
      busy('diagnostics', true);
      // A failure stays inside the open dialog (the page line is behind it), so the dialog stays up on a miss.
      return guard('copy the report', async () => {
        await ports.diagnosticsCopy();
        deps.setView({ diagnosticsCopied: true, diagnosticsSaved: false });
        host.announce?.('Copied.');
      }).finally(() => busy('diagnostics', false));
    },
    saveDiagnostics() {
      if (view().busy.diagnostics) return Promise.resolve(false);
      busy('diagnostics', true);
      // Closing the save dialog is an answer, not a failure: nothing is said and the report stays open.
      return guard('save the report', async () => {
        const { canceled } = await ports.diagnosticsSave();
        if (canceled) return;
        deps.setView({ diagnosticsSaved: true, diagnosticsCopied: false });
        host.announce?.('Saved.');
      }).finally(() => busy('diagnostics', false));
    },
    setVerbose(on: boolean) {
      // One call at a time: two in flight could answer out of order and leave the switch saying the opposite.
      if (view().busy.verbose) return Promise.resolve(false);
      busy('verbose', true);
      return guard('change verbose logging', async () => {
        const { until } = await ports.verboseSet(on);
        deps.setData({ verbose: on ? { until } : undefined });
      }).finally(() => busy('verbose', false));
    },
    exportData() {
      if (view().busy.dataExport) return Promise.resolve(false);
      busy('dataExport', true);
      return guard('export your data', async () => {
        const { canceled } = await ports.dataExport();
        if (canceled) return;
        deps.setView({ dataExported: true });
        host.announce?.('Saved.');
      }).finally(() => busy('dataExport', false));
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
      dropPendingAdminGrant();
      deps.setView({ confirm: null });
    },
    /** The destructive step runs only here, after Cancel was passed over on purpose. */
    async runConfirm(c: Confirmation) {
      deps.setView({ confirm: null });
      switch (c.kind) {
        case 'removeAccount': {
          const op = 'remove that account';
          // A refusal for unsent mail says what is waiting; Retry works once it is sent or cancelled.
          // The toast rides inside the step, so a Retry from the failure line that lands says so too.
          const remove = async () => {
            const { signInKept } = await ports.accountDisconnect(c.accountId);
            host.toast?.(removedToast(c.address, signInKept));
          };
          return guard(op, remove, (error, retry) => {
            const line = removalRefusal(error);
            return { op, ...(line ? { line } : {}), retry, dismiss: () => deps.fail(null) };
          });
        }
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
        case 'revokeClient':
          return self.revokeClient(c.id);
        case 'grantAdmin': {
          const pending = pendingAdminGrant;
          pendingAdminGrant = null;
          if (!pending) return false;
          const ok = await doGrant(pending.input, pending.onGranted);
          pending.settle(ok);
          return ok;
        }
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
