/**
 * The status slot's host (DESIGN 7.1, 7.15): reads the most urgent account state from the data layer and hands it to
 * `StatusSlot`, the only place sync status is drawn in the main window. Reconnect opens the reconnect sheet; the other
 * verbs call the engine. Nothing here writes a sentence.
 */
import { api, useAccounts, useStatus, type StatusSlotState } from '../data';
import type { StatusAction, SyncAccount } from '../ui/props';
import { StatusSlot } from '../ui/status';
import { navigate, openSheet, pushToast } from './index';
import { reconnectMode, syncAccount, toSyncStatus } from './status-map';

const DIAGNOSTICS_TOAST_ID = 'diagnostics-copied';

function ignore(): void {
  return undefined;
}

function copyDiagnostics(): void {
  api.diagnostics.copy().then(() => {
    pushToast({
      id: DIAGNOSTICS_TOAST_ID,
      kind: 'info',
      message: 'Diagnostics copied. They hold no mail.',
      undoable: false,
    });
  }, ignore);
}

function retryNow(state: StatusSlotState): void {
  api.sync.request({ accountId: state.account?.id, force: true }).then(ignore, ignore);
}

/** Runs one slot verb for the account the slot is about. */
export function runStatusAction(action: StatusAction, state: StatusSlotState): void {
  if (action === 'reconnect' && state.account)
    openSheet('reconnect', { accountId: state.account.id, mode: reconnectMode(state) });
  else if (action === 'retry') retryNow(state);
  else if (action === 'copyDiagnostics') copyDiagnostics();
  else if (action === 'viewDetails') navigate('settings');
}

/** Props for `StatusView`. */
export interface StatusViewProps {
  readonly state: StatusSlotState;
  readonly accountCount: number;
  readonly onAction: (action: StatusAction, account?: SyncAccount) => void;
}

/** The slot for one resolved state; kept apart from the hooks so tests can drive it with any state. */
export function StatusView({ state, accountCount, onAction }: StatusViewProps) {
  return (
    <StatusSlot
      status={toSyncStatus(state)}
      account={state.account ? syncAccount(state.account) : undefined}
      multipleAccounts={accountCount > 1}
      onAction={onAction}
    />
  );
}

/** The sidebar footer's status slot, live. Renders nothing before any account exists. */
export function StatusHost() {
  const state = useStatus();
  const accounts = useAccounts();
  if (!state) return null;
  return (
    <StatusView
      state={state}
      accountCount={accounts.length}
      onAction={action => runStatusAction(action, state)}
    />
  );
}
