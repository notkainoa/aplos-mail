/**
 * The thin container: reads `useSettings`, `useAccounts`, `useConsent`, `useSession` and the one clock, loads what a
 * section needs through the ports, keeps Settings' own view state, and hands it all to the presentational screen.
 * It cannot run until `ui-shell` implements the data layer (every hook is a stub today); it must typecheck.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  useAccounts,
  useAccountsLoaded,
  useConsent,
  useNow,
  useSession,
  useSettings,
} from '../../data';
import { parseSettingRoute, type SettingRoute, type SettingSection } from '../../commands';
import { calendarListedKey } from '../calendar/accountCalendarState';
import { ErrorLine } from '../../ui/list';
import type { ProviderId } from '../../ui/props';
import { createController, type SettingsController } from './controller';
import './paletteEntries';
import { clearAvailability, publishAvailability } from './availability';
import type { SettingsApiPort, SettingsData, SettingsHost, WriteFailure } from './ports';
import { SettingsScreen } from './SettingsScreen';
import {
  actThenList,
  mergeAccounts,
  mergePatch,
  verboseFrom,
  withoutKeyPath,
  type AccountWrite,
  type AiModelInfo,
} from './settings.model';
import { INITIAL_VIEW, type SettingsView } from './view';
import type { SettingsPatch } from '../../data';

/**
 * The contract methods Settings calls, straight off the data layer's `api` (`DataApi` declares them all). The AI
 * and consent inputs take the contract's closed provider enum; the port's `string` is narrowed to `ProviderId`
 * once here — Settings only ever passes provider ids it got from `Ai/providers` or the pickers.
 */
export function dataPorts(): SettingsApiPort {
  const providerId = (id: string) => id as ProviderId;
  return {
    settingsSet: async patch => void (await api.settings.set({ patch })),
    accountSet: async (accountId, patch) => void (await api.account.set({ accountId, ...patch })),
    accountDisconnect: async accountId => ({
      signInKept: (await api.account.disconnect({ accountId })).signInKept === true,
    }),
    accountLease: async (accountId, pin) => void (await api.account.lease({ accountId, pin })),
    demoLoad: async () => void (await api.demo.load({})),
    demoReset: async () => void (await api.demo.reset({})),
    demoRemove: async () => void (await api.demo.remove({})),
    aiModels: async provider => (await api.ai.models({ provider: providerId(provider) })).list,
    aiSetKey: async (provider, key) =>
      void (await api.ai.setKey({ provider: providerId(provider), key })),
    aiRemoveKey: async provider =>
      void (await api.ai.removeKey({ provider: providerId(provider) })),
    aiTestKey: async provider => {
      const r = await api.ai.testKey({ provider: providerId(provider) });
      return { ok: r.ok, ms: r.ms, reasonCode: r.reasonCode };
    },
    consentGrant: async ({ version, provider, model }) =>
      void (await api.consent.grant({
        scope: 'background',
        version,
        provider: providerId(provider),
        model,
      })),
    consentRevoke: async () => void (await api.consent.revoke({ scope: 'background' })),
    listenerSet: async enabled => void (await api.listener.set({ enabled })),
    clientsRevoke: async id => void (await api.clients.revoke({ id })),
    clientsGrant: async input =>
      (await api.clients.grant({ ...input, scopes: [...input.scopes] })).client,
    workflowStatus: () => api.workflow.status({}),
    diagnosticsPreview: () => api.diagnostics.preview({}),
    diagnosticsCopy: async () => void (await api.diagnostics.copy({})),
    diagnosticsSave: async () => saveBlob(await api.diagnostics.export({})),
    verboseSet: async on => {
      const { until } = await api.diagnostics.verbose({ on });
      return { until };
    },
    verboseGet: async () => {
      const { until } = await api.diagnostics.verbose({});
      return { until };
    },
    dataExport: async () => saveBlob(await api.data.export({})),
    queueRetry: async id => void (await api.queue.retry({ id })),
    queueDiscard: async id => void (await api.queue.discard({ id })),
    aiProviders: async () => (await api.ai.providers({})).list,
    aiUsage: () => api.ai.usage({}),
    listenerGet: () => api.listener.get({}),
    clientsList: async () => (await api.clients.list({})).list.map(withoutKeyPath),
    queueList: async () => (await api.queue.list({})).list,
    calendarsGet: async () => (await api.calendar.get({})).list,
  };
}

/** The file blob an export made goes to main's save dialog under its own name. */
export async function saveBlob(
  blob: { blobId: string; name: string },
  calls: {
    save: (a: { blobId: string; name: string }) => Promise<{ canceled?: boolean }>;
    release: (a: { blobId: string }) => Promise<unknown>;
  } = { save: a => api.file.save(a), release: a => api.blob.release(a) },
): Promise<{ canceled: boolean }> {
  const { canceled } = await calls.save({ blobId: blob.blobId, name: blob.name });
  // The window owns the caller-bound blob — it frees it once the file is saved. A cancelled dialog keeps it.
  if (!canceled)
    try {
      await calls.release({ blobId: blob.blobId });
    } catch {
      // Best effort: the next sweep finds the staged file if release ever fails.
    }
  return { canceled: canceled === true };
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
  const accountsLoaded = useAccountsLoaded();
  const consent = useConsent();
  const session = useSession();
  const now = useNow({ granularity: 'minute' });
  // Consent leaves the hard gate: a failed `Consent/get` is the AI section's own error line, not a blank
  // pane. Settings and Session are core — their failure is the pane's single error line, still not a blank.
  if (!settings || !session)
    return (
      <ErrorLine
        kind="reason"
        text="Couldn’t load Settings."
        retryable={false}
        placement="settings"
        onAction={() => {}}
      />
    );
  return (
    <Loaded
      {...{ route, onRoute, host, ports, accountsLoaded }}
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
  accountsLoaded,
}: SettingsContainerProps & { host: SettingsHost; base: Base; accountsLoaded: boolean }) {
  const parsed = route ? parseSettingRoute(route) : null;
  const [section, setSection] = useState<SettingSection>(parsed?.section ?? 'general');
  const routeSection = parsed?.section;
  const routeRow = parsed?.row;

  const resolved = useMemo(() => ports ?? dataPorts(), [ports]);
  const { data, view, actions, failure } = useSettingsState(
    base,
    host,
    resolved,
    section,
    accountsLoaded,
  );

  // A route-driven section change (a deep link, back/forward) leaves like the nav does: drafts and failures drop.
  useEffect(() => {
    if (routeSection && routeSection !== section) {
      actions.leave();
      setSection(routeSection);
    }
  }, [routeSection, routeRow, section, actions]);

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
  accountsLoaded: boolean,
): {
  data: SettingsData;
  view: SettingsView;
  actions: SettingsController;
  failure: WriteFailure | null;
} {
  const [view, setViewState] = useState<SettingsView>(INITIAL_VIEW);
  const [loaded, setLoaded] = useState<Partial<SettingsData>>({});
  const [overlay, setOverlay] = useState<SettingsPatch | null>(null);
  const [accountsOverlay, setAccountsOverlay] = useState<Record<string, AccountWrite> | null>(null);
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const viewRef = useRef(view);
  const loadedRef = useRef(loaded);
  const dataRef = useRef<SettingsData>(null as never);
  const failureRef = useRef(failure);
  failureRef.current = failure;

  const data: SettingsData = {
    ...base,
    ...loaded,
    settings: overlay ? mergePatch(base.settings, overlay) : base.settings,
    accounts: mergeAccounts(loaded.accounts ?? base.accounts, accountsOverlay),
  };
  dataRef.current = data;

  const keepData = useCallback((patch: Partial<SettingsData>) => {
    loadedRef.current = { ...loadedRef.current, ...patch };
    setLoaded(loadedRef.current);
  }, []);

  const actions = useMemo(
    () =>
      createController({
        ports: {
          ...ports,
          loadProviders: () => setProvidersFrom(ports),
          queueRetry: async id => {
            const queue = await actThenList(
              () => ports.queueRetry(id),
              () => ports.queueList(),
            );
            if (queue) keepData({ queue });
          },
          queueDiscard: async id => {
            const queue = await actThenList(
              () => ports.queueDiscard(id),
              () => ports.queueList(),
            );
            if (queue) keepData({ queue });
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
        accountOverlay: patch => setAccountsOverlay(patch ? { ...patch } : null),
        fail: setFailure,
        failure: () => failureRef.current,
      }),
    // The ports and host are stable for the life of the screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function setProvidersFrom(p: SettingsApiPort) {
    return p.aiProviders().then(providers => keepData({ providers }));
  }

  // The latest ports and AI features, read by the loading effect without making it re-run when they change identity.
  const portsRef = useRef(ports);
  portsRef.current = ports;
  const featuresRef = useRef(base.settings.ai.features);
  featuresRef.current = base.settings.ai.features;

  // Each section asks only for what it shows. `listedKey` re-runs the calendar read when an account's
  // `calendarListedAt` lands: the stamp arrives live through `useAccounts`, while `Calendar/get` here
  // answered once — a first list commits rows plus the stamp, and the block must not stay "No calendars"
  // beside calendars that now exist.
  const listedKey = calendarListedKey(base.accounts);
  useEffect(() => {
    const ports = portsRef.current;
    const keep = keepData;
    const quiet = (p: Promise<unknown>) => void p.catch(() => {});
    if (section === 'ai') {
      quiet(ports.aiProviders().then(providers => keep({ providers })));
      quiet(ports.aiUsage().then(usage => keep({ usage })));
      const providers = new Set(Object.values(featuresRef.current).map(f => f.provider));
      for (const provider of providers) quiet(actions.loadModels(provider));
    }
    if (section === 'general') {
      quiet(ports.listenerGet().then(listener => keep({ listener })));
      quiet(ports.clientsList().then(clients => keep({ clients })));
      quiet(ports.workflowStatus().then(workflow => keep({ workflow })));
    }
    if (section === 'help') {
      quiet(
        Promise.resolve()
          .then(() => ports.verboseGet())
          .then(r => keep({ verbose: verboseFrom(r) })),
      );
    }
    if (section === 'help' && view.queue) {
      quiet(ports.queueList().then(queue => keep({ queue })));
    }
    if (section === 'accounts' || section === 'calendar') {
      quiet(
        Promise.resolve(ports.calendarsGet?.()).then(calendars => calendars && keep({ calendars })),
      );
    }
  }, [section, view.queue, actions, keepData, listedKey]);

  useEffect(() => () => actions.leave(), [actions]);

  // The palette's conditional rows read the live data while Settings is mounted; it goes back to optimistic on
  // unmount so a row is hidden only once its state was actually seen.
  const { accounts, providers, session } = data;
  useEffect(() => {
    publishAvailability({ accounts, providers, session, accountsLoaded });
    return clearAvailability;
  }, [accounts, providers, session, accountsLoaded]);

  return { data, view, actions, failure };
}

export type { AiModelInfo };
