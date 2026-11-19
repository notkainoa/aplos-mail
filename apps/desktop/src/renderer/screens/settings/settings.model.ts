/**
 * Settings, the pure layer (DESIGN 7.10, 7.1, 7.15, 9; plan 30 U7). Plain functions from contract values (`Settings`,
 * `Account[]`, `AiProvider[]`, `Consent`, `Session`, now) to exactly what the components draw, plus the decisions:
 * which Reconnect shows and which one is filled, where a key comes from, why Remove is disabled, what a consent
 * re-review says, the daily cap. No React, no hooks, no clock of its own: `now` is always passed in, so the harness
 * clock and a test clock agree.
 *
 * Sentences follow DESIGN 10: what happened, what is safe, what to do. No raw provider text ever reaches a screen:
 * a provider's own message is never read, only its reason code.
 */
import type {
  Account,
  AiProvider,
  Consent,
  Output,
  Session,
  Settings,
  SettingsPatch,
} from '../../data';
import { toIsoDateTime } from '../../data';
import { SETTING_SECTIONS, type SettingSection } from '../../commands';
import type {
  AiFeature,
  IconName,
  KeySource,
  ProviderId,
  ProviderStatus,
  ProviderTableProps,
  PuckItem,
  SyncStatus,
  TagColor,
} from '../../ui/props';
import { envKeyReason, FEATURE_COPY, keySourceText, PROVIDER_NAMES } from '../../ui/settings/names';
import { statusCopy, syncedLine } from '../../ui/status';
import { accountLabel } from '../../ui/accountLabel';

export type { SettingSection } from '../../commands';

/** The contract's output types the screen reads, named once. */
export type AiModelInfo = Output<'Ai/models'>['list'][number];
export type AiUsageInfo = Output<'Ai/usage'>;
export type QueueEntry = Output<'Queue/list'>['list'][number];
export type ClientEntry = Output<'Clients/list'>['list'][number];
export type ListenerInfo = Output<'Listener/get'>;
export type BundleInfo = Output<'Diagnostics/preview'>;

export const NOT_AVAILABLE = 'Not available yet';

/**
 * The one switch for rows that have no engine behind them yet (Tools on this Mac, the queue inspector). While it is
 * false a row whose capability is off is not drawn and not offered from ⌘K, instead of showing "Not available yet".
 * Flip it to true to bring those placeholders back; the rows' code and models stay.
 */
export const SHOW_UNBUILT_ROWS = false;
const UNBUILT_ROWS: ReadonlySet<string> = new Set([
  'general/allowTools',
  'general/addTool',
  'general/tools',
  'help/queue',
]);
/** True when `section/anchor` is a placeholder row that stays out of sight until its capability is on. */
export function hiddenUntilBuilt(
  section: string,
  anchor: string,
  show: boolean = SHOW_UNBUILT_ROWS,
): boolean {
  return !show && UNBUILT_ROWS.has(`${section}/${anchor}`);
}
const DAY_MS = 86_400_000;

/* ───────────────────────── sections and capabilities ───────────────────────── */

const SECTION_ICONS: Record<SettingSection, IconName> = {
  general: 'settings',
  mail: 'mail',
  calendar: 'calendar',
  ai: 'bubble',
  notifications: 'bell',
  accounts: 'user',
  keyboard: 'keyboard',
  help: 'help',
};

/** The nav, in DESIGN 7.10's order. AI is the speech bubble, never a sparkle. */
export function navItems(): readonly PuckItem[] {
  return SETTING_SECTIONS.map(s => ({ id: s.id, label: s.label, icon: SECTION_ICONS[s.id] }));
}

/** Capability flags are an open map: an absent key means unavailable (plan 30 section 8.1 item 9). */
export function hasCapability(
  session: Pick<Session, 'capabilities'> | undefined,
  key: string,
): boolean {
  return session?.capabilities?.[key] === true;
}

/** What the build says about itself: the short git commit and a channel suffix, injected by vite.config.ts. */
export interface BuildInfo {
  readonly commit: string;
  readonly channel: string;
}
declare const __APLOS_BUILD__: BuildInfo | undefined;
/** The injected build info; "dev" when the define is absent (tests, tools that skip Vite). */
export const BUILD_INFO: BuildInfo =
  typeof __APLOS_BUILD__ === 'undefined' ? { commit: 'dev', channel: '' } : __APLOS_BUILD__;

/** "Version 0.3.0-revamp (build abc1234) · macOS" (DESIGN 10). Without a version, just "macOS". */
export function versionLine(
  session: Pick<Session, 'appVersion'> | undefined,
  build: BuildInfo = BUILD_INFO,
): string {
  if (!session?.appVersion) return 'macOS';
  const channel = build.channel ? `-${build.channel}` : '';
  return `Version ${session.appVersion}${channel} (build ${build.commit}) · macOS`;
}

/* ───────────────────────── patches ───────────────────────── */

type Section = keyof Settings;

/**
 * Applies a `Settings/set` patch the way the engine does: per section, the fields given replace those fields and
 * object-valued fields are replaced whole. Used for the optimistic overlay and by the preview's stand-in store.
 */
export function mergePatch(settings: Settings, patch: SettingsPatch): Settings {
  const next: Record<string, unknown> = { ...settings };
  for (const section of Object.keys(patch) as Section[]) {
    const part = patch[section];
    if (part) next[section] = { ...settings[section], ...part };
  }
  return next as unknown as Settings;
}

/** The patch that puts back whatever `patch` changed (for Undo and for a rejected write). */
export function inversePatch(settings: Settings, patch: SettingsPatch): SettingsPatch {
  const out: Record<string, Record<string, unknown>> = {};
  for (const section of Object.keys(patch) as Section[]) {
    const part = patch[section] as Record<string, unknown> | undefined;
    if (!part) continue;
    const current = settings[section] as unknown as Record<string, unknown>;
    out[section] = Object.fromEntries(Object.keys(part).map(k => [k, current[k]]));
  }
  return out as SettingsPatch;
}

/* ───────────────────────── General ───────────────────────── */

export type StoredDensity = Settings['ui']['density'];

/** The stored names are F1's (`default`); the components' are `comfortable` (ui README). */
export function densityToUi(d: StoredDensity): 'roomy' | 'comfortable' | 'compact' {
  return d === 'default' ? 'comfortable' : d;
}
export function densityFromUi(d: string): StoredDensity {
  return d === 'comfortable' ? 'default' : d === 'roomy' ? 'roomy' : 'compact';
}

export const THEME_ITEMS: readonly PuckItem[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
];
export const DENSITY_ITEMS: readonly PuckItem[] = [
  { id: 'roomy', label: 'Roomy' },
  { id: 'comfortable', label: 'Comfortable' },
  { id: 'compact', label: 'Compact' },
];
export const SWIPE_OPTIONS = [
  { id: 'doneRight', label: 'Right is Done' },
  { id: 'doneLeft', label: 'Left is Done' },
] as const;

/* ───────────────────────── Mail, Calendar, Notifications ───────────────────────── */

export interface Option {
  readonly id: string;
  readonly label: string;
}

/** DESIGN 7.10: undo-send options are 0, 5, 8, 10, 20 and 30 s. */
export const UNDO_SEND_SECONDS = [0, 5, 8, 10, 20, 30] as const;
export const UNDO_SEND_OPTIONS: readonly Option[] = UNDO_SEND_SECONDS.map(s => ({
  id: String(s),
  label: s === 0 ? 'Send at once' : `${s} seconds`,
}));
export const FOLLOW_UP_OPTIONS: readonly Option[] = [1, 2, 3, 5, 7].map(d => ({
  id: String(d),
  label: d === 1 ? '1 day' : `${d} days`,
}));
export const IMAGE_ITEMS: readonly PuckItem[] = [
  { id: 'block', label: 'Ask first' },
  { id: 'allow', label: 'Always load' },
];
export const REPLY_ITEMS: readonly PuckItem[] = [
  { id: 'reply', label: 'Reply' },
  { id: 'replyAll', label: 'Reply all' },
];
export const RETENTION_DAY_OPTIONS: readonly Option[] = [30, 90, 180, 365].map(d => ({
  id: String(d),
  label: `${d} days`,
}));
const GB = 1024 ** 3;
export const RETENTION_SIZE_OPTIONS: readonly Option[] = [1, 2, 5, 10].map(g => ({
  id: String(g * GB),
  label: `${g} GB`,
}));
export const WEEK_START_OPTIONS: readonly Option[] = [
  { id: 'system', label: 'Follow the system' },
  { id: '0', label: 'Sunday' },
  { id: '1', label: 'Monday' },
  { id: '6', label: 'Saturday' },
];

/** The option list with the stored value kept visible when it is not one of the presets. */
export function withCurrent(
  options: readonly Option[],
  id: string,
  label: string,
): readonly Option[] {
  return options.some(o => o.id === id) ? options : [{ id, label }, ...options];
}

/** The storage row's description: what is kept and what never goes, without restating the pickers' values. */
export const RETENTION_LINE =
  'Keeps full message text on this Mac; opened, bookmarked and unread mail is always kept.';

/* ───────────────────────── Accounts ───────────────────────── */

const TAGS: readonly TagColor[] = ['sky', 'hill', 'stamp', 'dusk', 'sand', 'ember'];

/** An account's mark: its own colour tag when it is one of the six, else a stable pick from its position. */
export function tagColor(account: Pick<Account, 'colorTag'>, index: number): TagColor {
  const own = account.colorTag as TagColor | undefined;
  return own && TAGS.includes(own) ? own : TAGS[index % TAGS.length];
}

/** Round 1 offers Google only; a demo account says so. Anything else shows no provider word. */
export function providerLabel(provider: string): string {
  return provider === 'google' ? 'Google' : provider === 'demo' ? 'Demo' : '';
}

const iso = (ms: number | undefined): string | undefined =>
  ms === undefined ? undefined : toIsoDateTime(ms);

/** The account's health in the vocabulary the shared status copy speaks. An unknown state counts as an error. */
export function syncStatusOf(account: Account): SyncStatus {
  const { status, reconnectBy, lastSyncAt } = account.health;
  switch (status.state) {
    case 'starting':
      return { kind: 'starting' };
    case 'ok':
      return { kind: 'ok', lastSyncedAt: iso(lastSyncAt), reconnectBy: iso(reconnectBy) };
    case 'syncing':
      return { kind: 'syncing' };
    case 'backfilling':
      return status.of
        ? { kind: 'backfilling', done: status.done, of: status.of }
        : { kind: 'syncing' };
    case 'paused':
      return {
        kind: 'paused',
        reason: /^quota\.(daily|bandwidth)/.test(status.reason) ? 'dailyLimit' : 'throttle',
        resumeAt: iso(status.until),
      };
    case 'needsReauth':
      return { kind: 'needsReauth' };
    case 'needsPermission':
      return { kind: 'needsPermission' };
    case 'needsAdmin':
      return { kind: 'needsAdmin' };
    case 'misconfigured':
      return { kind: 'misconfigured' };
    case 'offline':
      return { kind: 'offline', changesWaiting: account.pendingChanges };
    default:
      return { kind: 'error' };
  }
}

export type ReconnectKind = 'reauth' | 'permission' | 'due';

/**
 * The reconnect rule (DESIGN 7.10, 7.15): Reconnect shows for `needsReauth`, for `needsPermission`, and when
 * `reconnectBy` is within 24 hours of now (a deadline already past is an expired sign-in). Demo accounts have none.
 */
export function reconnectKind(account: Account, now: number): ReconnectKind | null {
  if (account.demo) return null;
  const state = account.health.status.state;
  if (state === 'needsReauth') return 'reauth';
  if (state === 'needsPermission') return 'permission';
  const by = account.health.reconnectBy;
  if (by === undefined) return null;
  const left = by - now;
  if (left <= 0) return 'reauth';
  return left <= DAY_MS ? 'due' : null;
}

export interface AccountRow {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  /** "Google", or nothing. */
  readonly meta: string;
  readonly mark: TagColor;
  /** The state sentence on the row. */
  readonly description: string;
  readonly tone: 'default' | 'attention';
  readonly demo: boolean;
  /** Reconnect, and whether it is the one filled button (only the first account that needs one; "Reconnect now" is always text). */
  readonly reconnect?: {
    readonly kind: ReconnectKind;
    readonly label: 'Reconnect' | 'Reconnect now';
    readonly filled: boolean;
    readonly mode: 'reconnect' | 'grant';
  };
  readonly aiAllowed: boolean;
  readonly notifications: boolean;
}

/** Sentence for a row whose account is healthy: "Connected · synced 2 min ago". */
function connectedLine(account: Account, now: number): string {
  const last = account.health.lastSyncAt;
  if (last === undefined) return 'Connected';
  const synced = syncedLine(toIsoDateTime(last), new Date(now));
  return `Connected · ${synced.charAt(0).toLowerCase()}${synced.slice(1)}`;
}

const PERMISSION_SENTENCES: Record<string, string> = {
  'permission.calendar': 'Aplos needs permission to use your Google Calendar.',
  'permission.calendarWrite':
    'Aplos needs your permission to change events on your Google Calendar.',
  'permission.filters': 'Aplos needs permission to manage your Gmail filters.',
  'permission.settings': 'Aplos needs permission to read your Gmail settings.',
};

/** Settings → Calendar's editing row, in DESIGN 10's voice: quiet states carry no trailing period. The
 * refused-write line and the quiet action's label come from the Calendar screen's `EDITING_COPY` so the
 * wording is identical in both places. */
export const CALENDAR_EDITING_COPY = {
  on: 'Editing on',
  off: 'Editing off',
  /** The refused-write row's action label. */
  turnOn: 'Turn on editing',
} as const;

/** One account's row: its state in DESIGN 7.1's words, and the Reconnect it offers. */
export function accountRow(account: Account, index: number, now: number): AccountRow {
  const kind = reconnectKind(account, now);
  const base = syncStatusOf(account);
  // A deadline inside 24 hours reads from `reconnectBy` whatever else the account is doing.
  const forDeadline = kind === 'due' || (kind === 'reauth' && base.kind !== 'needsReauth');
  const copy = statusCopy(
    forDeadline ? { kind: 'ok', reconnectBy: iso(account.health.reconnectBy) } : base,
    new Date(now),
  );
  let description: string;
  let tone: 'default' | 'attention' = 'default';
  if (account.demo) {
    description = 'Sample mail and events. Nothing here is real.';
  } else if (
    kind === 'permission' &&
    account.health.reasonCode &&
    PERMISSION_SENTENCES[account.health.reasonCode]
  ) {
    description = PERMISSION_SENTENCES[account.health.reasonCode];
    tone = 'attention';
  } else if (copy) {
    description = copy.text;
    tone = copy.attention ? 'attention' : 'default';
  } else {
    description = connectedLine(account, now);
  }
  return {
    id: account.id,
    name: accountLabel(account),
    address: account.address,
    meta: providerLabel(account.provider),
    mark: tagColor(account, index),
    description,
    tone,
    demo: account.demo,
    reconnect: kind
      ? {
          kind,
          label: kind === 'due' ? 'Reconnect now' : 'Reconnect',
          filled: false,
          mode: kind === 'permission' ? 'grant' : 'reconnect',
        }
      : undefined,
    aiAllowed: account.aiAllowed,
    notifications: account.notifications,
  };
}

/**
 * Every account's row, with the one filled Reconnect given to the first account that needs one (UNCLEAR-13: one
 * filled button per screen). "Reconnect now" for a deadline that has not passed is always a text button.
 */
export function accountRows(accounts: readonly Account[], now: number): readonly AccountRow[] {
  const rows = accounts.map((a, i) => accountRow(a, i, now));
  const first = rows.findIndex(r => r.reconnect && r.reconnect.kind !== 'due');
  return rows.map((r, i) =>
    i === first && r.reconnect ? { ...r, reconnect: { ...r.reconnect, filled: true } } : r,
  );
}

/** The write an Accounts control makes (`Account/set`). */
export type AccountWrite = {
  readonly colorTag?: string;
  readonly aiAllowed?: boolean;
  readonly notifications?: boolean;
  readonly name?: string;
};

/** Accounts with the optimistic per-account overlay applied, for the rows the sections draw. */
export function mergeAccounts(
  accounts: readonly Account[],
  overlay: Readonly<Record<string, AccountWrite>> | null,
): readonly Account[] {
  if (!overlay) return accounts;
  return accounts.map(a => (overlay[a.id] ? { ...a, ...overlay[a.id] } : a));
}

/** Who the bulk mail-for-AI write names: the one account it is about, or a count of several. */
function mailAccountsTarget(
  accounts: readonly Pick<Account, 'id' | 'name' | 'address'>[],
  ids: readonly string[],
): string {
  if (ids.length !== 1) return `${ids.length} accounts`;
  const a = accounts.find(x => x.id === ids[0]);
  return a ? accountLabel(a) : 'that account';
}

/** The one failure line's op for the bulk "Mail for AI" write: "Couldn’t turn on mail for AI on …". */
export function mailAllowedOp(
  accounts: readonly Pick<Account, 'id' | 'name' | 'address'>[],
  refused: readonly string[],
  on: boolean,
): string {
  return `${on ? 'turn on' : 'turn off'} mail for AI on ${mailAccountsTarget(accounts, refused)}`;
}

/** The undo entry's label for the accounts a press turned on (DESIGN 10: what happened). */
export function mailAllowedLabel(
  accounts: readonly Pick<Account, 'id' | 'name' | 'address'>[],
  turnedOn: readonly string[],
): string {
  return `Mail for AI turned on for ${mailAccountsTarget(accounts, turnedOn)}`;
}

/** Demo controls (plan 30 section 4.5 row 8): the demo row has Reset and Remove; Help offers Load only with no demo account. */
export function demoControls(accounts: readonly Account[]): {
  readonly hasDemo: boolean;
  readonly rowActions: readonly ('reset' | 'remove')[];
  readonly helpAction: 'load' | null;
} {
  const hasDemo = accounts.some(a => a.demo);
  return {
    hasDemo,
    rowActions: hasDemo ? ['reset', 'remove'] : [],
    helpAction: hasDemo ? null : 'load',
  };
}

/** What Remove on a real account asks before it runs. Cancel is the default (DESIGN 6 Confirm). */
export function removeAccountConfirm(address: string): { question: string; consequence: string } {
  return {
    question: `Remove ${address}?`,
    consequence:
      'Aplos stops syncing this account and deletes everything it stored for it on this Mac: its mail, drafts, calendar, summaries and sign-in. Your mail stays with Google. Changes still waiting to sync are discarded.',
  };
}

/**
 * The engine's own sentence when it refused a removal because mail is still waiting to go out ("This account still
 * has 2 messages that have not gone out…"); undefined for any other failure, which keeps "Couldn't remove that
 * account." A `ContractError` carries it on `body`, the data layer's `OperationFailedError` on `error`.
 */
export function removalRefusal(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const e = error as { body?: unknown; error?: unknown; type?: unknown; message?: unknown };
  const inner = e.body ?? e.error;
  const body = inner !== null && typeof inner === 'object' ? (inner as typeof e) : undefined;
  const type = body?.type ?? e.type;
  const message = body?.message ?? e.message;
  return type === 'conflict' && typeof message === 'string' && message ? message : undefined;
}
export const REMOVE_DEMO_CONFIRM = {
  question: 'Remove the demo mail?',
  consequence:
    'The demo accounts and their sample mail are deleted. Your own accounts are not touched. This cannot be undone, but Help can load it again.',
} as const;

/**
 * Which Mac does this account's background work, and the one action that follows (ARCH 6.5): "Syncs on this Mac" or
 * "Syncs on another Mac". The Mac's name is a technical detail and joins the line only with Developer details on.
 */
export function leaseLine(
  account: Pick<Account, 'lease'>,
  thisDevice: string,
  devDetails = false,
): { readonly text: string; readonly action: 'use' | 'auto' | null } {
  const lease = account.lease;
  const line = (here: boolean, name: string): string => {
    const base = here ? 'Syncs on this Mac' : 'Syncs on another Mac';
    return devDetails && name ? `${base} · ${name}` : base;
  };
  if (!lease) return { text: line(true, thisDevice), action: null };
  const here = lease.role === 'primary';
  const text = line(here, here ? thisDevice : (lease.holderDeviceName ?? ''));
  if (lease.role === 'secondary') return { text, action: 'use' };
  return { text, action: lease.pinned ? 'auto' : null };
}

/* ───────────────────────── AI ───────────────────────── */

export const AI_FEATURES: readonly AiFeature[] = ['ask', 'summaries', 'drafts', 'plans', 'voice'];
export const HOSTED_ORDER: readonly ProviderId[] = [
  'groq',
  'openai',
  'anthropic',
  'gemini',
  'openrouter',
  'opencode-go',
];
export const LOCAL_ORDER = ['ollama', 'lmstudio', 'custom'] as const;
export type LocalId = (typeof LOCAL_ORDER)[number];

export function isLocalId(id: string): id is LocalId {
  return (LOCAL_ORDER as readonly string[]).includes(id);
}
export function providerName(id: string): string {
  return PROVIDER_NAMES[id as ProviderId] ?? id;
}
export function featureLabel(feature: string): string {
  return FEATURE_COPY[feature as AiFeature]?.label ?? feature;
}

/** Where a provider's key comes from. Key characters are never part of any value here. */
export function toKeySource(
  p: Pick<AiProvider, 'id' | 'keySource' | 'envVar'>,
  devDetails = false,
): KeySource {
  const variable = devDetails ? p.envVar : '';
  if (p.keySource === 'env') return { kind: 'environment', variable };
  if (p.keySource === 'keychain') return { kind: 'keychain' };
  // Ollama and LM Studio need no key; a custom server's is optional and can be added.
  if (p.id === 'ollama' || p.id === 'lmstudio') return { kind: 'local' };
  return { kind: 'none', variable };
}

/** "Key set on this Mac", "Saved in Keychain", "No key yet"; the variable name joins them with Developer details on. */
export function keySourceLine(
  p: Pick<AiProvider, 'id' | 'keySource' | 'envVar'>,
  devDetails = false,
): string {
  return keySourceText(toKeySource(p, devDetails));
}

/** Why Remove is disabled: a key from the environment wins and can only be removed there. Undefined when Remove works. */
export function removeDisabledReason(source: KeySource): string | undefined {
  return source.kind === 'environment' ? envKeyReason(source.variable) : undefined;
}

/** A provider's status cell, from the engine's status and a live test result when there is one. */
export function providerStatus(
  p: Pick<AiProvider, 'status' | 'lastTest'>,
  test?: ProviderStatus,
): ProviderStatus {
  if (test) return test;
  switch (p.status) {
    case 'ready':
      return { kind: 'ready' };
    case 'unreachable':
      return { kind: 'unreachable' };
    case 'error':
      return /refused|auth|key/i.test(p.lastTest?.reasonCode ?? '')
        ? { kind: 'refused' }
        : { kind: 'unreachable' };
    default:
      return { kind: 'needsKey' };
  }
}

/** A finished `Ai/testKey` as the status cell: "Works · 0.4 s", "Key refused" or "Not reachable". */
export function testResultStatus(result: {
  ok: boolean;
  ms?: number;
  reasonCode?: string;
}): ProviderStatus {
  if (result.ok) return { kind: 'works', latencyMs: result.ms ?? 0 };
  return /refused|auth|key/i.test(result.reasonCode ?? '')
    ? { kind: 'refused' }
    : { kind: 'unreachable' };
}

export const byId = (providers: readonly AiProvider[], id: string) =>
  providers.find(p => p.id === id);

export function hostedRows(
  providers: readonly AiProvider[],
  testing: Partial<Record<ProviderId, ProviderStatus>> = {},
  devDetails = false,
): Extract<ProviderTableProps, { kind: 'hosted' }>['rows'] {
  return HOSTED_ORDER.flatMap(id => {
    const p = byId(providers, id);
    return p
      ? [
          {
            provider: id,
            isDefault: id === 'groq',
            keySource: toKeySource(p, devDetails),
            status: providerStatus(p, testing[id]),
          },
        ]
      : [];
  });
}

/** A local server is Ready only after a probe saw it running; stopped says "Not running", unprobed "Not tested". */
function localStatus(p: Pick<AiProvider, 'status' | 'lastTest' | 'running'>): ProviderStatus {
  if (p.running === false) return { kind: 'notRunning' };
  if (p.running === undefined) return { kind: 'notTested' };
  return providerStatus(p);
}

export function localRows(
  providers: readonly AiProvider[],
  settings: Pick<Settings, 'ai'>,
  testing: Partial<Record<ProviderId, ProviderStatus>> = {},
  devDetails = false,
): Extract<ProviderTableProps, { kind: 'local' }>['rows'] {
  return LOCAL_ORDER.flatMap(id => {
    const p = byId(providers, id);
    if (!p) return [];
    const status: ProviderStatus = testing[id] ?? localStatus(p);
    return [
      {
        provider: id,
        // What the owner typed; empty means the default port.
        address: settings.ai.providers[id]?.address ?? '',
        defaultAddress: p.defaultAddress ?? '',
        running: p.running,
        keySource: toKeySource(p, devDetails),
        status,
      },
    ];
  });
}

/** True when mail may go to this provider for this feature: no provider that trains on inputs gets mail (ARCH 8.3). */
export function usableFor(p: AiProvider, feature: AiFeature): boolean {
  if (feature === 'voice') return p.sttCapable && p.status === 'ready';
  if (p.trainsOnInputs) return false;
  return p.status === 'ready' && p.running !== false;
}

/** Model ids a provider offers a feature: speech models for Voice, the rest for everything else. */
export function modelIds(models: readonly AiModelInfo[] | undefined, feature: AiFeature): string[] {
  return (models ?? [])
    .filter(m => (feature === 'voice' ? m.stt === true : m.stt !== true))
    .map(m => m.id);
}

/** Catalogue names for a provider's model ids; an id whose name is the id itself needs none. */
export function modelNames(
  models: readonly AiModelInfo[] | undefined,
): Readonly<Record<string, string>> {
  const names: Record<string, string> = {};
  for (const m of models ?? []) if (m.label && m.label !== m.id) names[m.id] = m.label;
  return names;
}

/** The Features table: Ask, Summaries, Drafts, Plans, Voice, each with the providers it may use and their models. */
export function featureRows(
  settings: Pick<Settings, 'ai'>,
  providers: readonly AiProvider[],
  models: Partial<Record<string, readonly AiModelInfo[]>>,
): Extract<ProviderTableProps, { kind: 'features' }>['rows'] {
  const order = [...HOSTED_ORDER, ...LOCAL_ORDER] as readonly ProviderId[];
  return AI_FEATURES.map(feature => {
    const choice = settings.ai.features[feature];
    const options = order.filter(id => {
      const p = byId(providers, id);
      return p && usableFor(p, feature);
    });
    // An unknown stored id is shown as it is (the picker prepends an unlisted value); coercing it would mislabel.
    const provider = choice.provider as ProviderId;
    return {
      feature,
      provider,
      model: choice.model,
      providerOptions: options,
      modelOptions: modelIds(models[provider], feature),
      modelNames: modelNames(models[provider]),
    };
  });
}

/** A provider change resets the model to that provider's first one for the feature; a model change keeps the provider. */
export function cascadeChoice(
  feature: AiFeature,
  choice: { provider: ProviderId; model: string },
  current: { provider: string; model: string },
  models: Partial<Record<string, readonly AiModelInfo[]>>,
): { provider: ProviderId; model: string } | null {
  if (choice.provider === current.provider) return choice;
  const first = modelIds(models[choice.provider], feature)[0];
  return first ? { provider: choice.provider, model: first } : null;
}

/** The patch for one feature's choice. `features` is replaced whole, so the other four are carried along. */
export function featurePatch(
  settings: Pick<Settings, 'ai'>,
  feature: AiFeature,
  choice: { provider: ProviderId; model: string },
): SettingsPatch {
  return { ai: { features: { ...settings.ai.features, [feature]: choice } } };
}

/** The address patch. `providers` is replaced whole. An empty address means the default port. */
export function addressPatch(
  settings: Pick<Settings, 'ai'>,
  provider: LocalId,
  address: string,
): SettingsPatch {
  const next = { ...settings.ai.providers };
  const trimmed = address.trim();
  if (trimmed) next[provider] = { ...next[provider], address: trimmed };
  else if (next[provider]) {
    const { address: _dropped, ...rest } = next[provider];
    next[provider] = rest;
  }
  return { ai: { providers: next } };
}

/** The "paid plan" mark for Gemini. */
export function paidPatch(
  settings: Pick<Settings, 'ai'>,
  provider: string,
  paid: boolean,
): SettingsPatch {
  return {
    ai: {
      providers: {
        ...settings.ai.providers,
        [provider]: { ...settings.ai.providers[provider], paid },
      },
    },
  };
}

/** Daily background cap, in tokens (ARCH 8.4, Decision 13): 150,000 by default. */
export const CAP_TOKENS = [50_000, 150_000, 300_000] as const;
export const NO_LIMIT = 'none';
export function formatTokens(n: number): string {
  return `${n.toLocaleString('en-US')} tokens`;
}
export const CAP_OPTIONS: readonly Option[] = [
  ...CAP_TOKENS.map(t => ({ id: String(t), label: formatTokens(t) })),
  { id: NO_LIMIT, label: 'No limit' },
];
export function capSelection(cap: Settings['ai']['dailyCap']): string {
  return cap.enabled ? String(cap.tokens) : NO_LIMIT;
}
export function capPatch(settings: Pick<Settings, 'ai'>, id: string): SettingsPatch {
  if (id === NO_LIMIT) return { ai: { dailyCap: { ...settings.ai.dailyCap, enabled: false } } };
  return { ai: { dailyCap: { enabled: true, tokens: Number(id) } } };
}
/** "Paused for today. Resumes tomorrow." is shown in Settings only, never on the mail surface. */
export function capNote(usage: AiUsageInfo | undefined, now: number): string | undefined {
  if (!usage) return undefined;
  const paused = usage.pausedUntil !== undefined && usage.pausedUntil > now;
  const spent = usage.cap !== undefined && usage.backgroundTokens >= usage.cap;
  return paused || spent ? 'Paused for today. Resumes tomorrow.' : undefined;
}
export function capUsage(usage: AiUsageInfo | undefined): string {
  if (!usage) return 'Background work pauses after this many tokens in a day.';
  return usage.cap === undefined
    ? `Used ${formatTokens(usage.backgroundTokens)} today.`
    : `Used ${usage.backgroundTokens.toLocaleString('en-US')} of ${usage.cap.toLocaleString('en-US')} tokens today.`;
}

export type ConsentView =
  /** Background AI is on and agreed to. */
  | { readonly state: 'granted' }
  /** The provider, model or address changed since the owner agreed: summaries wait for the card (ARCH 8.3). */
  | { readonly state: 'review'; readonly provider: string; readonly model: string }
  /** Never agreed, or withdrawn. */
  | { readonly state: 'off' };

/** The consent state for the background switch: `review` carries the Summaries provider and model the card must show. */
export function consentView(
  consent: Consent | undefined,
  settings: Pick<Settings, 'ai'>,
): ConsentView {
  if (!consent || !consent.granted) return { state: 'off' };
  if (consent.needsReconsent) {
    const s = settings.ai.features.summaries;
    return { state: 'review', provider: s.provider, model: s.model };
  }
  return { state: 'granted' };
}

/** What turning the background switch does: on needs the card unless consent already stands; off also withdraws consent. */
export function backgroundPlan(
  consent: Consent | undefined,
  on: boolean,
): readonly ('openCard' | 'enable' | 'disable' | 'revoke')[] {
  if (!on) return ['disable', 'revoke'];
  const standing = consent?.granted === true && !consent.needsReconsent;
  return standing ? ['enable'] : ['openCard'];
}

/** The sentence beside the switch, naming the Summaries provider live. */
export function backgroundLine(settings: Pick<Settings, 'ai'>): string {
  return `Reads new mail as it arrives and sends it to ${providerName(settings.ai.features.summaries.provider)}.`;
}

/** What the consent card says is sent (DESIGN 7.11). */
export const CONSENT_SENT =
  'The sender, subject and text of each new email, so it can write a one-line summary. Attachments are not sent.';

/** Hosted providers that hold a key may be marked as on a paid plan (Gemini's free tier trains on inputs). */
export function paidSwitch(
  providers: readonly AiProvider[],
): { provider: string; paid: boolean } | null {
  const g = byId(providers, 'gemini');
  if (!g || g.keySource === 'none') return null;
  return { provider: 'gemini', paid: g.paidMarked === true };
}

export const HOW_MAIL_IS_USED: readonly { lead: string; body: string }[] = [
  {
    lead: 'What is sent.',
    body: 'When you use Ask, Summaries, Drafts or Plans, Aplos sends the text of the mail or events involved to the provider you chose for that feature, and nothing else. Voice sends your recording to your speech-to-text provider.',
  },
  {
    lead: 'What stays here.',
    body: 'Ollama and LM Studio run on this Mac, so nothing leaves it. Keys live in your Keychain or your environment, and Aplos never shows them. A provider that may learn from what it is sent never receives your mail.',
  },
  {
    lead: 'Your control.',
    body: 'New accounts allow their mail for AI by default. Turn off “Use this account’s mail for AI” under Accounts to keep a mailbox out of every feature.',
  },
];

/* ───────────────────────── Notifications, tools, help ───────────────────────── */

/** Per-account switches follow the account row. The colour index is the account list's, so a mark matches everywhere. */
export function notifyRows(
  accounts: readonly Account[],
): readonly { id: string; name: string; mark: TagColor; on: boolean }[] {
  return accounts.flatMap((a, i) =>
    a.demo ? [] : [{ id: a.id, name: accountLabel(a), mark: tagColor(a, i), on: a.notifications }],
  );
}

const SCOPE_WORDS: Record<string, string> = {
  read: 'read',
  triage: 'triage',
  draft: 'draft',
  send: 'send',
  ai: 'AI',
  admin: 'settings',
};
export interface ToolRow {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly scopes: string;
  readonly lastSeen: string;
}
const KIND_WORDS: Record<string, string> = {
  cli: 'Command line',
  mcp: 'MCP',
  preview: 'Preview',
  phone: 'Phone',
};

/** The connected tools, newest first; a revoked tool is gone from the list. */
export function toolRows(
  clients: readonly ClientEntry[] | undefined,
  now: number,
): readonly ToolRow[] {
  return [...(clients ?? [])]
    .filter(c => c.revokedAt === undefined)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(c => ({
      id: c.id,
      name: c.name,
      kind: KIND_WORDS[c.kind] ?? c.kind,
      scopes: c.scopes.map(s => SCOPE_WORDS[s] ?? s).join(', '),
      lastSeen:
        c.lastSeenAt === undefined ? 'Not used yet' : `Last used ${agoText(now - c.lastSeenAt)}`,
    }));
}

/** "2 min ago", "3 h ago", "4 days ago". */
export function agoText(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

/** What the listener switch needs: its state, and whether this build has one at all. */
export function listenerLine(listener: ListenerInfo | undefined): string {
  if (!listener)
    return 'Lets scripts and assistants on this Mac read and act on your mail, with the permissions you give them.';
  return listener.enabled
    ? 'On. Tools on this Mac can connect with the permissions you gave them.'
    : 'Off. Nothing on this Mac can connect.';
}

export * from './settings.notices.model';
export * from './settings.queue.model';
export * from './settings.tools.model';

/* ───────────────────────── confirmations ───────────────────────── */

/** The features that use a provider, so a key's removal can say what will stop. */
export function featuresUsing(settings: Pick<Settings, 'ai'>, provider: string): string[] {
  return AI_FEATURES.filter(f => settings.ai.features[f].provider === provider).map(featureLabel);
}

/** "Ask and Summaries" / "Ask, Drafts and Voice". */
export function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** What Remove on a saved key asks (DESIGN 7.10): it names the features that will stop. */
export function removeKeyConfirm(
  settings: Pick<Settings, 'ai'>,
  provider: string,
): { question: string; consequence: string } {
  const name = providerName(provider);
  const using = featuresUsing(settings, provider);
  const stop = using.length
    ? `${joinWords(using)} will stop working until you add a key or pick another provider. `
    : '';
  return {
    question: `Remove the ${name} key?`,
    consequence: `${stop}The key is deleted from your Keychain. You can add one again any time.`,
  };
}

export function discardConfirm(label: string): { question: string; consequence: string } {
  return {
    question: `Discard “${label}”?`,
    consequence:
      'It stops being tried. A message that was waiting to send is not sent. This cannot be undone.',
  };
}
