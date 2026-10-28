/**
 * The thin container: reads `useSettings`, `useAccounts`, `useConsent`, `useSession` and the one clock, loads what a
 * section needs through the ports, keeps Settings' own view state, and hands it all to the presentational screen.
 * It cannot run until `ui-shell` implements the data layer (every hook is a stub today); it must typecheck.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, useAccounts, useConsent, useNow, useSession, useSettings } from '../../data';
import type { Api as ClientApi } from '@aplos/contract/client';
import { parseSettingRoute, type SettingRoute, type SettingSection } from '../../commands';
import { createController, type SettingsController } from './controller';
import './paletteEntries';
import type { SettingsApiPort, SettingsData, SettingsHost, WriteFailure } from './ports';
import { SettingsScreen } from './SettingsScreen';
import { mergePatch, type AiModelInfo } from './settings.model';
import { INITIAL_VIEW, type SettingsView } from './view';
import type { SettingsPatch } from '../../data';

/**
 * The contract methods Settings calls, through the client surface `api` is. `DataApi` lists only some of them
 * today (REQUEST to ui-shell), so this reaches the rest by the contract's own names.
 */
export function dataPorts(): SettingsApiPort {
  const c = api as unknown as ClientApi;
  return {
    settingsSet: async patch => void (await api.settings.set({ patch })),
    accountSet: async (accountId, patch) => void (await api.account.set({ accountId, ...patch })),
    accountDisconnect: async accountId =>
      void (await c.account.disconnect({ opId: crypto.randomUUID(), accountId })),
    accountLease: async (accountId, pin) => void (await c.account.lease({ accountId, pin })),
    demoLoad: async () => void (await api.demo.load({})),
    demoReset: async () => void (await api.demo.reset({})),
    demoRemove: async () => void (await api.demo.remove({})),
    aiModels: async provider => (await c.ai.models({ provider: provider as never })).list,
    aiSetKey: async (provider, key) =>
      void (await c.ai.setKey({ provider: provider as never, key })),
    aiRemoveKey: async provider => void (await c.ai.removeKey({ provider: provider as never })),
    aiTestKey: async provider => {
      const r = await c.ai.testKey({ provider: provider as never });
      return { ok: r.ok, ms: r.ms, reasonCode: r.reasonCode };
    },
    consentGrant: async ({ version, provider, model }) =>
      void (await api.consent.grant({
        scope: 'background',
        version,
        provider: provider as never,
        model,
      })),
    consentRevoke: async () => void (await api.consent.revoke({ scope: 'background' })),
    listenerSet: async enabled => void (await c.listener.set({ enabled })),
    clientsRevoke: async id => void (await c.clients.revoke({ id })),
    diagnosticsPreview: () => api.diagnostics.preview({}),
    diagnosticsSave: async () => void (await api.diagnostics.copy({})),
    queueRetry: async id => void (await c.queue.retry({ id })),
    queueDiscard: async id => void (await c.queue.discard({ id })),
    aiProviders: async () => (await c.ai.providers({})).list,
    aiUsage: () => c.ai.usage({}),
    listenerGet: () => c.listener.get({}),
    clientsList: async () => (await c.clients.list({})).list,
    queueList: async () => (await c.queue.list({})).list,
  };
}

export interface SettingsContainerProps {
  /** The route the shell is on: "settings/mail" or "settings/mail#undoSend". */
  readonly route?: SettingRoute;
  /** The shell follows the section the owner picks. */
  onRoute?(route: SettingRoute): void;
  readonly host?: SettingsHost;
  /** For tests and the preview; the app uses `dataPorts()`. */
  readonly ports?: SettingsApiPort;
}

export function SettingsContainer({ route, onRoute, host = {}, ports }: SettingsContainerProps) {
  const settings = useSettings();
  const accounts = useAccounts();
  const consent = useConsent();
  const session = useSession();
  const now = useNow({ granularity: 'minute' });
  if (!settings || !consent || !session) return null;
  return (
    <Loaded
      {...{ route, onRoute, host, ports }}
      base={{ settings, accounts, consent, session, now }}
    />
  );
}

type Base = Pick<SettingsData, 'settings' | 'accounts' | 'consent' | 'session' | 'now'>;

function Loaded({
  route,
  onRoute,
  host,
  ports,
  base,
}: SettingsContainerProps & { host: SettingsHost; base: Base }) {
  const parsed = route ? parseSettingRoute(route) : null;
  const [section, setSection] = useState<SettingSection>(parsed?.section ?? 'general');
  useEffect(() => {
    if (parsed) setSection(parsed.section);
  }, [parsed?.section, parsed?.row]);

  const resolved = useMemo(() => ports ?? dataPorts(), [ports]);
  const { data, view, actions, failure } = useSettingsState(base, host, resolved, section);

  const choose = useCallback(
    (next: SettingSection) => {
      actions.leave();
      setSection(next);
      onRoute?.(`settings/${next}` as SettingRoute);
    },
    [actions, onRoute],
  );
  return (
    <SettingsScreen
      {...{ data, view, actions, host, failure }}
      section={section}
      anchor={parsed?.row}
      onSection={choose}
    />
  );
}

/**
 * Settings' state: the view, what the sections loaded, the optimistic overlay and the last failed write. The
 * controller reads the latest of each through refs, so a step that sets state twice never works from a stale copy.
 */
export function useSettingsState(
  base: Base,
  host: SettingsHost,
  ports: SettingsApiPort,
  section: SettingSection,
): {
  data: SettingsData;
  view: SettingsView;
  actions: SettingsController;
  failure: WriteFailure | null;
} {
  const [view, setViewState] = useState<SettingsView>(INITIAL_VIEW);
  const [loaded, setLoaded] = useState<Partial<SettingsData>>({});
  const [overlay, setOverlay] = useState<SettingsPatch | null>(null);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const viewRef = useRef(view);
  const loadedRef = useRef(loaded);
  const dataRef = useRef<SettingsData>(null as never);

  const data: SettingsData = {
    ...base,
    ...loaded,
    settings: overlay ? mergePatch(base.settings, overlay) : base.settings,
  };
  dataRef.current = data;

  const actions = useMemo(
    () =>
      createController({
        ports: {
          ...ports,
          loadProviders: () => setProvidersFrom(ports),
          queueRetry: async id => {
            await ports.queueRetry(id);
            await ports.queueList().then(queue => keepData({ queue }));
          },
          queueDiscard: async id => {
            await ports.queueDiscard(id);
            await ports.queueList().then(queue => keepData({ queue }));
          },
        },
        host,
        data: () => dataRef.current,
        view: () => viewRef.current,
        setView: patch => {
          viewRef.current = { ...viewRef.current, ...patch };
          setViewState(viewRef.current);
        },
        setData: patch => {
          loadedRef.current = { ...loadedRef.current, ...patch };
          setLoaded(loadedRef.current);
        },
        overlay: patch => setOverlay(patch),
        fail: setFailure,
      }),
    // The ports and host are stable for the life of the screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function keepData(patch: Partial<SettingsData>) {
    loadedRef.current = { ...loadedRef.current, ...patch };
    setLoaded(loadedRef.current);
  }
  function setProvidersFrom(p: SettingsApiPort) {
    return p.aiProviders().then(providers => keepData({ providers }));
  }

  // Each section asks only for what it shows.
  useEffect(() => {
    const keep = keepData;
    const quiet = (p: Promise<unknown>) => void p.catch(() => {});
    if (section === 'ai') {
      quiet(ports.aiProviders().then(providers => keep({ providers })));
      quiet(ports.aiUsage().then(usage => keep({ usage })));
      const providers = new Set(Object.values(base.settings.ai.features).map(f => f.provider));
      for (const provider of providers) quiet(actions.loadModels(provider));
    }
    if (section === 'general') {
      quiet(ports.listenerGet().then(listener => keep({ listener })));
      quiet(ports.clientsList().then(clients => keep({ clients })));
    }
    if (section === 'help' && view.queue) {
      quiet(ports.queueList().then(queue => keep({ queue })));
    }
  }, [section, view.queue]);

  useEffect(() => () => actions.leave(), [actions]);

  return { data, view, actions, failure };
}

export type { AiModelInfo };
