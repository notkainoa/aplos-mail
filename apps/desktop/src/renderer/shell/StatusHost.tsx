/**
 * The status slot's host (DESIGN 7.1, 7.15): reads the most urgent account state from the data layer and hands it to
 * `StatusSlot`, the only place sync status is drawn in the main window. Reconnect opens the reconnect sheet; the other
 * verbs call the engine. Nothing here writes a sentence.
 */
import {
  api,
  toIsoDateTime,
  useAccounts,
  useConnection,
  useNow,
  useStatus,
  type StatusSlotState,
} from '../data';
import type { StatusAction, SyncAccount } from '../ui/props';
import { StatusSlot } from '../ui/status';
import { DIAGNOSTICS_FAILED_COPY, RECONNECT_FAILED_COPY } from './failure-copy';
import { navigate, openRoute, openSheet, pushToast } from './index';
import { reconnectMode, syncAccount, toSyncStatus } from './status-map';

const DIAGNOSTICS_TOAST_ID = 'diagnostics-copied';
const RETRY_FAILED_TOAST_ID = 'retry-failed';

function ignore(): void {
  return undefined;
}

function notify(id: string, message: string, failed = false): void {
  pushToast({ id, kind: failed ? 'error' : 'info', message, undoable: false });
}

/** A verb that throws before it returns a promise fails the same way as one that rejects. */
function attempt(call: () => Promise<unknown>): Promise<unknown> {
  return Promise.resolve().then(call);
}

function copyDiagnostics(): void {
  attempt(() => api.diagnostics.copy()).then(
    () => notify(DIAGNOSTICS_TOAST_ID, 'Diagnostics copied. They hold no mail.'),
    () => notify(DIAGNOSTICS_TOAST_ID, DIAGNOSTICS_FAILED_COPY, true),
  );
}

function retryNow(state: StatusSlotState): void {
  attempt(() => api.sync.request({ accountId: state.account?.id, force: true })).then(ignore, () =>
    notify(RETRY_FAILED_TOAST_ID, RECONNECT_FAILED_COPY, true),
  );
}

/** Runs one slot verb for the account the slot is about. */
export function runStatusAction(action: StatusAction, state: StatusSlotState): void {
  if (action === 'reconnect' && state.account)
    openSheet('reconnect', { accountId: state.account.id, mode: reconnectMode(state) });
  else if (action === 'retry') retryNow(state);
  else if (action === 'copyDiagnostics') copyDiagnostics();
  else if (action === 'viewDetails') navigate('settings');
  else if (action === 'openAccounts') openRoute('settings/accounts');
}

/** Props for `StatusView`. */
export interface StatusViewProps {
  readonly state: StatusSlotState;
  readonly accountCount: number;
  /** The data clock as an ISO string; the slot compares reconnectBy and lastSyncedAt with it. */
  readonly now?: string;
  readonly onAction: (action: StatusAction, account?: SyncAccount) => void;
}

/** The slot for one resolved state; kept apart from the hooks so tests can drive it with any state. */
export function StatusView({ state, accountCount, now, onAction }: StatusViewProps) {
  return (
    <StatusSlot
      status={toSyncStatus(state)}
      account={state.account ? syncAccount(state.account) : undefined}
      multipleAccounts={accountCount > 1}
      now={now}
      onAction={onAction}
    />
  );
}

/** main's reason on the `connecting` frame while the engine backs up and migrates (`host/damaged.ts UPGRADING_REASON`). */
export const UPGRADING_REASON = 'store.upgrading';

/** The sidebar footer's status slot, live. Renders nothing before any account exists. */
export function StatusHost() {
  const state = useStatus();
  const accounts = useAccounts();
  const connection = useConnection();
  const now = useNow({ granularity: 'minute' });
  // The engine is updating the database: that, not an account's last state, is what is going on.
  if (connection.state === 'connecting' && connection.reasonCode === UPGRADING_REASON)
    return <StatusSlot status={{ kind: 'updating' }} onAction={ignore} />;
  if (!state) return null;
  return (
    <StatusView
      state={state}
      accountCount={accounts.length}
      now={toIsoDateTime(now)}
      onAction={action => runStatusAction(action, state)}
    />
  );
}
