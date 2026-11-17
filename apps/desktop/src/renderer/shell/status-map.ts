/**
 * The data layer's status line as the StatusSlot's props (DESIGN 7.1, 7.15).
 *
 * Copy is the component's: this file passes facts (a state, a time, a count) and never a sentence. A provider's own
 * `reason` string is never read, so it cannot reach the screen.
 */
import { toIsoDateTime, type Account, type StatusSlotState } from '../data';
import type { SyncAccount, SyncStatus, TagColor } from '../ui/props';

const TAG_COLORS: readonly TagColor[] = ['sky', 'hill', 'stamp', 'dusk', 'sand', 'ember'];

/**
 * The account mark: the stored colour tag when it is one of DESIGN 4.2's six; else the colour Settings → Accounts gives
 * the account at that position (so the menu and Settings agree), or sky when the position is not known.
 */
export function accountColor(account: Pick<Account, 'colorTag'>, index?: number): TagColor {
  const tag = account.colorTag as TagColor | undefined;
  if (tag && TAG_COLORS.includes(tag)) return tag;
  return index === undefined ? 'sky' : (TAG_COLORS[index % TAG_COLORS.length] ?? 'sky');
}

/** An account as the status slot names it. */
export function syncAccount(account: Account): SyncAccount {
  return { address: account.address, color: accountColor(account) };
}

/** Reason codes that mean the day's quota, not a passing throttle. */
const DAILY_LIMIT_CODES: readonly string[] = ['quota.daily', 'quota.project'];

/** States that a nearby reconnect deadline outranks (the data layer ranks it above backfilling). */
const QUIET_STATES: readonly string[] = ['ok', 'syncing', 'starting', 'backfilling'];

/** The slot's state for the most urgent account. */
export function toSyncStatus(state: StatusSlotState): SyncStatus {
  const { account, status } = state;
  if (state.reconnectSoon && account?.health.reconnectBy !== undefined && isQuiet(status.state))
    return { kind: 'ok', reconnectBy: toIsoDateTime(account.health.reconnectBy) };
  if (state.demo) return { kind: 'demo' };
  switch (status.state) {
    case 'starting':
      return { kind: 'starting' };
    case 'syncing':
      return { kind: 'syncing' };
    case 'ok':
      return okStatus(account);
    case 'backfilling':
      return status.of === undefined
        ? { kind: 'syncing' }
        : { kind: 'backfilling', done: status.done, of: status.of };
    case 'paused':
      return {
        kind: 'paused',
        reason: DAILY_LIMIT_CODES.includes(state.reasonCode ?? '') ? 'dailyLimit' : 'throttle',
        ...(isTime(status.until) ? { resumeAt: toIsoDateTime(status.until) } : {}),
      };
    case 'offline':
      return { kind: 'offline', changesWaiting: account?.pendingChanges ?? 0 };
    case 'needsReauth':
    case 'needsPermission':
    case 'needsAdmin':
    case 'misconfigured':
    case 'error':
      return { kind: status.state };
  }
}

/** True for a usable epoch-ms time (a missing or NaN `until` would print "Invalid Date"). */
function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isQuiet(state: string): boolean {
  return QUIET_STATES.includes(state);
}

function okStatus(account: Account | null): SyncStatus {
  const last = account?.health.lastSyncAt;
  return last === undefined ? { kind: 'ok' } : { kind: 'ok', lastSyncedAt: toIsoDateTime(last) };
}

/** Which sheet flow a Reconnect press starts: a missing permission is `grant`, anything else `reconnect`. */
export function reconnectMode(state: StatusSlotState): 'reconnect' | 'grant' {
  return state.status.state === 'needsPermission' ? 'grant' : 'reconnect';
}

/** Whether an account needs the reconnect sheet (the account menu's inline Reconnect). */
export function needsReconnect(account: Account): boolean {
  const state = account.health.status.state;
  return state === 'needsReauth' || state === 'needsPermission';
}

/** The sheet mode for an account's own state. */
export function accountReconnectMode(account: Account): 'reconnect' | 'grant' {
  return account.health.status.state === 'needsPermission' ? 'grant' : 'reconnect';
}
