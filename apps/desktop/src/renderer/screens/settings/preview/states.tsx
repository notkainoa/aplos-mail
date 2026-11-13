/**
 * Every Settings state the gallery draws and the tests render (DESIGN 7.10; plan 30 U7), as data: which section, the
 * contract values behind it, and the view state. `PreviewScreen` makes one alive with stand-in ports; `staticScreen`
 * renders it once, for tests. Original demo data only.
 */
import { useMemo, useRef, useState, type JSX } from 'react';
import type { SettingSection } from '../../../commands';
import { ReconnectSheet } from '../../../ui/status';
import { createController } from '../controller';
import type { SettingsApiPort, SettingsData, SettingsHost, WriteFailure } from '../ports';
import { SettingsScreen } from '../SettingsScreen';
import { mergeAccounts, mergePatch, type AccountWrite } from '../settings.model';
import { INITIAL_VIEW, type SettingsView } from '../view';
import {
  account,
  ALEX,
  baseSettings,
  bundle,
  calendars,
  CANARY,
  clients,
  consent,
  DEMO,
  editingOn,
  IMAP,
  JORDAN,
  models,
  needsReauth,
  NOW,
  providers,
  queue,
  reconnectIn,
  session,
  usage,
  writeRefused,
} from './fixtures';
import { standInPorts } from './standin';

export interface StateSpec {
  readonly title: string;
  readonly section: SettingSection;
  readonly anchor?: string;
  readonly data: SettingsData;
  readonly view?: Partial<SettingsView>;
  /** The window, when it is not 1440 × 900. */
  readonly size?: { readonly width: number; readonly height: number };
  readonly failure?: WriteFailure;
}

const noop = () => {};

/** The data every state starts from; a state overrides what it is about. */
export function dataOf(over: Partial<SettingsData> = {}): SettingsData {
  return {
    settings: baseSettings(),
    accounts: [ALEX],
    session: session(),
    consent: consent(),
    now: NOW,
    providers: providers(),
    models: models(),
    usage: usage(),
    listener: { enabled: false },
    clients: [],
    queue: queue(),
    calendars: calendars(),
    ...over,
  };
}

const withSettings = (
  over: (s: ReturnType<typeof baseSettings>) => ReturnType<typeof baseSettings>,
) => over(baseSettings());

/** A 40-character provider name and a 200-character address (break-ui, plan 30 U7 Verify). */
/** Provider names are fixed copy (AGENTS.md), so the long name is a model: 40 characters, on the custom server. */
const LONG_MODEL = 'northwind-research-compute-cooperative-q';
const LONG_ADDRESS = `https://${'inference-gateway-'.repeat(11)}example.com/v1`.slice(0, 200);
const LONG_EMAIL =
  `${'a-very-long-local-part-for-a-test-mailbox.'.repeat(4)}name@example.com`.slice(0, 120);

function worstCase(): SettingsData {
  const ps = providers().map(p =>
    p.id === 'custom' ? { ...p, status: 'ready', keySource: 'keychain', address: LONG_ADDRESS } : p,
  );
  const long = { ...ALEX, id: 'acct-long', address: LONG_EMAIL, name: LONG_EMAIL };
  return dataOf({
    models: { ...models(), custom: [{ id: LONG_MODEL, label: LONG_MODEL, tools: true }] },
    providers: ps,
    accounts: [
      long,
      needsReauth({ ...JORDAN, name: 'Jordan Lee with a name that goes on and on and on' }),
    ],
    settings: withSettings(s => ({
      ...s,
      ai: {
        ...s.ai,
        providers: { custom: { address: LONG_ADDRESS } },
        features: { ...s.ai.features, ask: { provider: 'custom', model: LONG_MODEL } },
      },
      mail: { ...s.mail, imageAllowList: [LONG_EMAIL] },
    })),
  });
}

/** Two accounts whose display names look alike: only the address tells them apart. */
const SIMILAR = [
  { ...ALEX, name: 'Kainoa Newton', address: 'kainoa.newton@example.com' },
  { ...JORDAN, name: 'Kainoa', address: 'kainoa@example.org', aiAllowed: true },
];

const tools = (over: Partial<SettingsData> = {}) =>
  dataOf({ listener: { enabled: true }, clients: clients(), ...over });

export const STATES: Record<string, StateSpec> = {
  general: { title: 'General', section: 'general', data: dataOf() },
  appearance: {
    title: 'General, dark and roomy chosen',
    section: 'general',
    data: dataOf({
      settings: withSettings(s => ({
        ...s,
        ui: { ...s.ui, theme: 'dark', density: 'roomy', keyHints: 'always' },
      })),
    }),
  },
  mail: { title: 'Mail', section: 'mail', data: dataOf() },
  calendar: {
    title: 'Calendar, with a missing permission',
    section: 'calendar',
    data: dataOf({
      accounts: [
        {
          ...ALEX,
          missingPermissions: [{ capability: 'calendar', reasonCode: 'permission.calendar' }],
        },
      ],
    }),
  },
  'calendar-accounts-on': {
    title: 'Calendar, two accounts with calendars on',
    section: 'calendar',
    data: dataOf({ accounts: [ALEX, JORDAN] }),
  },
  'calendar-accounts-syncing': {
    title: 'Calendar, an account still syncing whose list was never read: Syncing…',
    section: 'calendar',
    data: dataOf({
      accounts: [
        { ...ALEX, health: { status: { state: 'syncing' } }, calendarListedAt: undefined },
      ],
      calendars: [],
    }),
  },
  'calendar-accounts-unlisted': {
    title: 'Calendar, mail caught up but the calendar list was never read: Syncing…',
    section: 'calendar',
    data: dataOf({
      accounts: [{ ...ALEX, calendarListedAt: undefined }],
      calendars: [],
    }),
  },
  'calendar-accounts-signin': {
    title: 'Calendar, sign-in expired',
    section: 'calendar',
    data: dataOf({ accounts: [needsReauth(ALEX)] }),
  },
  'calendar-accounts-empty': {
    title: 'Calendar, access on and the list answered empty: No calendars',
    section: 'calendar',
    data: dataOf({ calendars: [] }),
  },
  'calendar-editing-off': {
    title: 'Calendar, editing off on both accounts: Enable editing',
    section: 'calendar',
    data: dataOf({ accounts: [ALEX, JORDAN] }),
  },
  'calendar-editing-on': {
    title: 'Calendar, the events scope granted: Editing on, no action',
    section: 'calendar',
    data: dataOf({ accounts: [editingOn(ALEX)] }),
  },
  'calendar-editing-refused': {
    title: 'Calendar, a write was refused: Turn on editing (attention)',
    section: 'calendar',
    data: dataOf({ accounts: [writeRefused(ALEX)] }),
  },
  'calendar-editing-na': {
    title: 'Calendar, demo and non-Google accounts claim nothing about editing',
    section: 'calendar',
    data: dataOf({ accounts: [DEMO, IMAP] }),
  },
  'calendar-no-accounts': {
    title: 'Calendar, no accounts yet',
    section: 'calendar',
    data: dataOf({ accounts: [], calendars: [] }),
  },
  notifications: {
    title: 'Notifications',
    section: 'notifications',
    data: dataOf({ accounts: [ALEX, JORDAN] }),
  },
  'accounts-default': {
    title: 'Accounts, two healthy',
    section: 'accounts',
    data: dataOf({ accounts: [ALEX, JORDAN] }),
  },
  'accounts-reconnect': {
    title: 'Accounts, sign-in expired',
    section: 'accounts',
    data: dataOf({ accounts: [needsReauth(ALEX), JORDAN] }),
  },
  'accounts-reconnect-due': {
    title: 'Accounts, reconnect due within 24 hours',
    section: 'accounts',
    data: dataOf({ accounts: [reconnectIn(ALEX, 23 * 3_600_000 - 60_000), JORDAN] }),
  },
  'accounts-two-reconnect': {
    title: 'Accounts, two need a sign-in: one filled button',
    section: 'accounts',
    data: dataOf({ accounts: [needsReauth(ALEX), needsReauth(JORDAN)] }),
  },
  'accounts-permission': {
    title: 'Accounts, permission missing',
    section: 'accounts',
    data: dataOf({
      accounts: [
        {
          ...ALEX,
          health: {
            status: { state: 'needsPermission', missingScopes: ['calendar'] },
            reasonCode: 'permission.mailModify',
            lastSyncAt: NOW - 3_600_000,
          },
        },
      ],
    }),
  },
  'accounts-calendar-missing': {
    title: 'Accounts, calendar not allowed yet',
    section: 'accounts',
    data: dataOf({
      accounts: [
        {
          ...ALEX,
          missingPermissions: [{ capability: 'calendar', reasonCode: 'permission.calendar' }],
        },
      ],
    }),
  },
  'accounts-calendar-syncing': {
    title: 'Accounts, calendar list never read yet: Syncing…',
    section: 'accounts',
    data: dataOf({
      accounts: [
        { ...ALEX, health: { status: { state: 'syncing' } }, calendarListedAt: undefined },
      ],
      calendars: [],
    }),
  },
  'accounts-none': {
    title: 'Accounts, none yet',
    section: 'accounts',
    data: dataOf({ accounts: [], calendars: [] }),
  },
  'accounts-demo': {
    title: 'Accounts, demo mail with Reset and Remove',
    section: 'accounts',
    data: dataOf({ accounts: [ALEX, DEMO] }),
  },
  'accounts-remove-demo': {
    title: 'Accounts, confirm removing demo mail',
    section: 'accounts',
    data: dataOf({ accounts: [DEMO] }),
    view: { confirm: { kind: 'removeDemo' } },
  },
  'accounts-lease': {
    title: 'Accounts, background work on another Mac',
    section: 'accounts',
    data: dataOf({
      accounts: [{ ...ALEX, lease: { role: 'secondary', holderDeviceName: 'MacBook Air' } }],
    }),
  },
  'reconnect-sheet': {
    title: 'Reconnect, waiting for the browser',
    section: 'accounts',
    data: dataOf({ accounts: [needsReauth(ALEX)] }),
    view: { reconnect: { accountId: ALEX.id, mode: 'reconnect' } },
  },
  'reconnect-sheet-editing': {
    title: 'Reconnect sheet, turning on calendar editing',
    section: 'calendar',
    data: dataOf(),
    view: { reconnect: { accountId: ALEX.id, mode: 'enableEditing' } },
  },
  'ai-default': { title: 'AI, Groq from the environment', section: 'ai', data: dataOf() },
  'ai-testing': {
    title: 'AI, testing',
    section: 'ai',
    data: dataOf(),
    view: {
      testing: {
        groq: { kind: 'works', latencyMs: 400 },
        openai: { kind: 'testing' },
        openrouter: { kind: 'refused' },
      },
    },
  },
  'ai-add-key': {
    title: 'AI, add a key',
    section: 'ai',
    data: dataOf(),
    view: { addKey: { provider: 'anthropic', mode: 'add' } },
  },
  'ai-remove-key': {
    title: 'AI, confirm removing a saved key',
    section: 'ai',
    data: dataOf(),
    view: { confirm: { kind: 'removeKey', provider: 'openai' } },
  },
  'ai-local-servers': {
    title: 'AI, local servers: Ollama running, LM Studio not, a typed address',
    section: 'ai',
    anchor: 'server-ollama',
    data: dataOf(),
    view: { addressDraft: { custom: 'https://models.example.com/v1' } },
  },
  'ai-consent-review': {
    title: 'AI, the provider changed: summaries wait for you',
    section: 'ai',
    data: dataOf({
      consent: consent({ needsReconsent: true, currentVersion: 2 }),
      settings: withSettings(s => ({
        ...s,
        ai: {
          ...s.ai,
          features: { ...s.ai.features, summaries: { provider: 'openai', model: 'gpt-5-mini' } },
        },
      })),
    }),
  },
  'ai-consent-card': {
    title: 'AI, the consent card',
    section: 'ai',
    data: dataOf({
      consent: consent({ needsReconsent: true, currentVersion: 2 }),
      settings: withSettings(s => ({
        ...s,
        ai: {
          ...s.ai,
          features: { ...s.ai.features, summaries: { provider: 'openai', model: 'gpt-5-mini' } },
        },
      })),
    }),
    view: { consentCard: true },
  },
  'ai-cap-reached': {
    title: 'AI, daily limit reached',
    section: 'ai',
    data: dataOf({
      usage: usage({ backgroundTokens: 150_000, pausedUntil: NOW + 14 * 3_600_000 }),
    }),
    view: { howOpen: true },
  },
  'ai-no-provider': {
    title: 'AI, nothing can answer',
    section: 'ai',
    data: dataOf({
      providers: providers().map(p => ({
        ...p,
        status: p.group === 'local' ? 'unreachable' : 'missingKey',
        keySource: 'none',
        running: false,
      })),
    }),
  },
  'ai-gemini-free': {
    title: 'AI, Gemini on its free tier is not used for mail',
    section: 'ai',
    data: dataOf({
      providers: providers().map(p =>
        p.id === 'gemini' ? { ...p, status: 'ready', keySource: 'keychain' } : p,
      ),
      settings: withSettings(s => ({
        ...s,
        ai: {
          ...s.ai,
          features: { ...s.ai.features, drafts: { provider: 'gemini', model: 'gemini-flash' } },
        },
      })),
    }),
  },
  'ai-account-mail': {
    title: 'AI, existing accounts still keep their mail out',
    section: 'ai',
    data: dataOf({ accounts: [ALEX, JORDAN] }),
  },
  'ai-accounts-mail': {
    title: 'AI, two accounts keep their mail out',
    section: 'ai',
    data: dataOf({
      accounts: [JORDAN, account({ id: 'acct-rio', address: 'rio@example.com', aiAllowed: false })],
    }),
  },
  'ai-demo-only': {
    title: 'AI, demo mail only: the account-mail row is hidden',
    section: 'ai',
    data: dataOf({ accounts: [DEMO] }),
  },
  'keyboard-default': { title: 'Keyboard', section: 'keyboard', data: dataOf() },
  'keyboard-recording': {
    title: 'Keyboard, recording a new key',
    section: 'keyboard',
    anchor: 'shortcuts',
    data: dataOf(),
    view: { recording: { commandId: 'mail.done', state: 'recording' } },
  },
  'keyboard-conflict': {
    title: 'Keyboard, a taken key and a saved clash',
    section: 'keyboard',
    anchor: 'shortcuts',
    data: dataOf({
      settings: withSettings(s => ({
        ...s,
        ui: { ...s.ui, keymap: { 'mail.laneDown': [{ chord: 'meta+j' }] } },
      })),
    }),
    view: {
      recording: {
        commandId: 'mail.done',
        state: 'conflict',
        pendingChord: 'l',
        conflictWith: { commandId: 'mail.later', label: 'Later' },
      },
    },
  },
  'keyboard-reserved': {
    title: 'Keyboard, a key macOS owns is refused',
    section: 'keyboard',
    anchor: 'shortcuts',
    data: dataOf(),
    view: {
      recording: {
        commandId: 'mail.done',
        state: 'recording',
        refused: '⌘Q belongs to macOS, so it can’t be a shortcut. Press other keys.',
      },
    },
  },
  help: { title: 'Help and about', section: 'help', data: dataOf() },
  'help-no-demo-account': {
    title: 'Help, demo mail loaded: no Load row',
    section: 'help',
    data: dataOf({ accounts: [ALEX, DEMO] }),
  },
  'diagnostics-preview': {
    title: 'Help, diagnostics preview',
    section: 'help',
    data: dataOf({ bundle: bundle() }),
    view: { diagnostics: true },
  },
  'diagnostics-copied': {
    title: 'Help, diagnostics preview after the copy',
    section: 'help',
    data: dataOf({ bundle: bundle() }),
    view: { diagnostics: true, diagnosticsCopied: true },
  },
  'diagnostics-saved': {
    title: 'Help, diagnostics preview after the save',
    section: 'help',
    data: dataOf({ bundle: bundle() }),
    view: { diagnostics: true, diagnosticsSaved: true },
  },
  'help-verbose-on': {
    title: 'Help, verbose logging on until a set time; data exported',
    section: 'help',
    data: dataOf({ verbose: { until: NOW + 12 * 60_000 } }),
    view: { dataExported: true },
  },
  'queue-inspector': {
    title: 'Help, the queue inspector',
    section: 'help',
    data: dataOf(),
    view: { queue: true },
  },
  'queue-discard-confirm': {
    title: 'Help, discarding a message asks first',
    section: 'help',
    data: dataOf(),
    view: {
      queue: true,
      confirm: { kind: 'discardQueueItem', id: 'q-send', label: 'Message to 1 person' },
    },
  },
  'tool-add': {
    title: 'General, Add a tool',
    section: 'general',
    data: dataOf({ listener: { enabled: true }, clients: [] }),
    view: { addTool: true },
  },
  'tool-admin-confirm': {
    title: 'General, admin access asks twice',
    section: 'general',
    data: tools(),
    view: { addTool: true, confirm: { kind: 'grantAdmin', name: 'Terminal assistant' } },
  },
  'tool-revoke-confirm': {
    title: 'General, revoking a tool asks first',
    section: 'general',
    data: tools(),
    view: { confirm: { kind: 'revokeClient', id: 'client-cli', name: 'Terminal assistant' } },
  },
  'device-sync-later': {
    title: 'General, device sync is not available yet',
    section: 'general',
    anchor: 'deviceSync',
    data: dataOf({ workflow: { enabled: false, available: false } }),
  },
  'tools-on': {
    title: 'General, tools allowed on this Mac',
    section: 'general',
    anchor: 'allowTools',
    data: tools(),
  },
  'capabilities-off': {
    title: 'Every optional capability off: Not available yet',
    section: 'general',
    data: dataOf({
      session: session({ capabilities: { desktop: true } }),
      listener: undefined,
      clients: undefined,
    }),
  },
  'capabilities-off-help': {
    title: 'Help with diagnostics and the queue off',
    section: 'help',
    data: dataOf({ session: session({ capabilities: { desktop: true } }) }),
  },
  'min-window': {
    title: 'The smallest window: the nav sits above the column',
    section: 'mail',
    data: dataOf(),
    size: { width: 900, height: 600 },
  },
  'write-failed': {
    title: 'A rejected write: the control is back and one line says so',
    section: 'mail',
    data: dataOf(),
    failure: { op: 'change undo send', retry: noop, dismiss: noop },
  },
  'worst-case': {
    title:
      'Worst case: a 40-character model name, a 200-character address, a 120-character account',
    section: 'ai',
    anchor: 'server-custom',
    data: worstCase(),
  },
  'accounts-similar-names': {
    title: 'Accounts, two display names that look alike',
    section: 'accounts',
    data: dataOf({ accounts: SIMILAR }),
  },
  'notifications-similar-names': {
    title: 'Notifications, two display names that look alike',
    section: 'notifications',
    data: dataOf({ accounts: SIMILAR }),
  },
  'calendar-similar-names': {
    title: 'Calendar, two display names that look alike',
    section: 'calendar',
    data: dataOf({ accounts: SIMILAR }),
  },
  'worst-case-accounts': {
    title: 'Worst case, accounts',
    section: 'accounts',
    data: worstCase(),
  },
};

/** The same data with the canary planted wherever a key could leak: extra fields no component should ever read. */
export function withCanary(data: SettingsData): SettingsData {
  const poison = <T extends object>(o: T): T =>
    ({ ...o, apiKey: CANARY, key: CANARY, last4: CANARY.slice(-4), token: CANARY }) as T;
  return {
    ...data,
    providers: data.providers?.map(poison),
    accounts: data.accounts.map(poison),
    settings: {
      ...data.settings,
      ai: {
        ...data.settings.ai,
        providers: Object.fromEntries(
          Object.entries(data.settings.ai.providers).map(([k, v]) => [k, poison(v)]),
        ),
      },
    },
    clients: data.clients?.map(c => ({ ...c, tokenPath: `/tmp/${CANARY}` })),
  };
}

/** A controller whose every write does nothing, for rendering a state once. */
export function staticScreen(spec: StateSpec, host: SettingsHost = HOST): JSX.Element {
  const view = { ...INITIAL_VIEW, ...spec.view };
  const actions = createController({
    ports: {} as SettingsApiPort,
    host,
    data: () => spec.data,
    view: () => view,
    setView: noop,
    setData: noop,
    overlay: noop,
    accountOverlay: noop,
    fail: noop,
  });
  return (
    <SettingsScreen
      data={spec.data}
      view={view}
      actions={actions}
      host={host}
      section={spec.section}
      onSection={noop}
      anchor={spec.anchor}
      failure={spec.failure}
    />
  );
}

/** The shell's side of the host, as stand-ins: the reconnect flow is ui-onboard's, drawn here with the status family's sheet. */
export const HOST: SettingsHost = {
  renderReconnect: (accountId, mode, onClose) => (
    <ReconnectSheet
      open
      address={ALEX.address}
      state="waiting"
      mode={mode}
      onCancel={onClose}
      onRetry={noop}
    />
  ),
  renderAddAccount: () => null,
  showWelcome: noop,
  openShortcuts: noop,
  toast: noop,
  announce: noop,
};

/**
 * A state made alive: the same screen, controller and view as the app, over in-memory ports. A toggle moves, Test
 * answers, a key saves and is forgotten. Used by the gallery; the tests use `staticScreen`.
 */
export function PreviewScreen({ spec }: { spec: StateSpec }): JSX.Element {
  const [data, setData] = useState(spec.data);
  const [view, setView] = useState<SettingsView>({ ...INITIAL_VIEW, ...spec.view });
  const [section, setSection] = useState(spec.section);
  const [failure, setFailure] = useState<WriteFailure | null>(spec.failure ?? null);
  const [overlay, setOverlay] = useState<Parameters<typeof mergePatch>[1] | null>(null);
  const [accountOverlay, setAccountOverlay] = useState<Record<string, AccountWrite> | null>(null);
  const dataRef = useRef(data);
  const viewRef = useRef(view);
  const failureRef = useRef(failure);
  dataRef.current = data;
  failureRef.current = failure;
  const shown = {
    ...data,
    settings: overlay ? mergePatch(data.settings, overlay) : data.settings,
    accounts: mergeAccounts(data.accounts, accountOverlay),
  };
  const actions = useMemo(() => {
    const ports = standInPorts(
      () => dataRef.current,
      patch => {
        dataRef.current = { ...dataRef.current, ...patch };
        setData(dataRef.current);
      },
    );
    return createController({
      ports,
      host: HOST,
      data: () => dataRef.current,
      view: () => viewRef.current,
      setView: patch => {
        viewRef.current = { ...viewRef.current, ...patch };
        setView(viewRef.current);
      },
      setData: patch => {
        dataRef.current = { ...dataRef.current, ...patch };
        setData(dataRef.current);
      },
      overlay: setOverlay,
      accountOverlay: setAccountOverlay,
      fail: setFailure,
      failure: () => failureRef.current,
    });
  }, []);
  viewRef.current = view;
  return (
    <SettingsScreen
      data={shown}
      view={view}
      actions={actions}
      host={HOST}
      section={section}
      onSection={next => {
        actions.leave();
        setSection(next);
      }}
      anchor={spec.anchor}
      failure={failure}
    />
  );
}
