/**
 * A stand-in for the ports, so the gallery is alive: a toggle moves, a key saves, Test answers, a queue item
 * retries. It lives in memory and never leaves the page. Not the data layer (that is `ui-shell`'s); a thin mirror
 * of what the engine would answer.
 */
import { mergePatch } from '../settings.model';
import type { SettingsApiPort, SettingsData } from '../ports';

export interface StandIn {
  readonly ports: SettingsApiPort;
}

/** Ports over a store the caller owns: `get` reads the current data, `set` replaces part of it. */
export function standInPorts(
  get: () => SettingsData,
  set: (patch: Partial<SettingsData>) => void,
  options: { testMs?: number; failSettings?: () => boolean } = {},
): SettingsApiPort {
  const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  const testMs = options.testMs ?? 700;
  return {
    async settingsSet(patch) {
      if (options.failSettings?.()) throw new Error('rejected');
      set({ settings: mergePatch(get().settings, patch) });
    },
    async accountSet(accountId, patch) {
      set({
        accounts: get().accounts.map(a =>
          a.id === accountId ? { ...a, ...(patch as Partial<typeof a>) } : a,
        ),
      });
    },
    async accountDisconnect(accountId) {
      set({ accounts: get().accounts.filter(a => a.id !== accountId) });
      return { signInKept: false };
    },
    async accountLease(accountId, pin) {
      set({
        accounts: get().accounts.map(a =>
          a.id === accountId
            ? {
                ...a,
                lease: {
                  role: pin ? 'primary' : (a.lease?.role ?? 'primary'),
                  pinned: pin,
                  holderDeviceName: get().session.device.name,
                },
              }
            : a,
        ),
      });
    },
    async demoLoad() {},
    async demoReset() {},
    async demoRemove() {
      set({ accounts: get().accounts.filter(a => !a.demo) });
    },
    async aiModels(provider) {
      return get().models?.[provider] ?? [];
    },
    async aiSetKey(provider) {
      set({
        providers: get().providers?.map(p =>
          p.id === provider ? { ...p, keySource: 'keychain', status: 'ready' } : p,
        ),
      });
    },
    async aiRemoveKey(provider) {
      set({
        providers: get().providers?.map(p =>
          p.id === provider ? { ...p, keySource: 'none', status: 'missingKey' } : p,
        ),
      });
    },
    async aiTestKey() {
      await wait(testMs);
      return { ok: true, ms: 420 };
    },
    async consentGrant() {
      const consent = get().consent;
      if (!consent) return;
      set({
        consent: {
          ...consent,
          granted: true,
          needsReconsent: false,
          version: consent.currentVersion,
        },
      });
    },
    async consentRevoke() {
      const consent = get().consent;
      if (!consent) return;
      set({ consent: { ...consent, granted: false } });
    },
    async listenerSet(enabled) {
      set({ listener: { enabled } });
    },
    async clientsGrant(input) {
      const client = {
        id: `client-${Date.now()}`,
        name: input.name,
        kind: input.kind,
        scopes: [...input.scopes],
        createdAt: Date.now(),
        tokenPath: `/Users/someone/Library/Application Support/Aplos Mail/run/clients/${Date.now()}.token`,
      };
      set({ clients: [...(get().clients ?? []), client] });
      return client;
    },
    async workflowStatus() {
      return get().workflow ?? { enabled: false, available: false };
    },
    async clientsRevoke(id) {
      set({ clients: get().clients?.filter(c => c.id !== id) });
    },
    async diagnosticsPreview() {
      return get().bundle!;
    },
    async diagnosticsCopy() {},
    async diagnosticsSave() {
      return { canceled: false };
    },
    async verboseSet(on) {
      const until = on ? Date.now() + 15 * 60_000 : undefined;
      set({ verbose: on ? { until } : undefined });
      return { until };
    },
    async verboseGet() {
      return get().verbose ?? {};
    },
    async dataExport() {
      return { canceled: false };
    },
    async queueRetry(id) {
      set({ queue: get().queue?.filter(q => q.id !== id) });
    },
    async queueDiscard(id) {
      set({ queue: get().queue?.filter(q => q.id !== id) });
    },
    async aiProviders() {
      return get().providers ?? [];
    },
    async aiUsage() {
      return get().usage!;
    },
    async listenerGet() {
      return get().listener ?? { enabled: false };
    },
    async clientsList() {
      return get().clients ?? [];
    },
    async queueList() {
      return get().queue ?? [];
    },
    async calendarsGet() {
      return get().calendars ?? [];
    },
  };
}
