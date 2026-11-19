/**
 * Preview fixtures for the weekly reconnect sheet and the zero-accounts state (DESIGN 7.1, 7.14, 7.15; plan 30 §4.5
 * rows 8 and 11). Every state is the machine's own output (`reconnect.model.ts`) or the presentational view with
 * no-op callbacks, drawn over a plain backdrop the size of the main pane. Original demo data only: an invented
 * address on an example domain.
 *
 * The gallery (`../preview/main.tsx`) imports `reconnectStates` with the same shape as `stepStates`.
 */
import type { JSX } from 'react';
import { Pane, ToastStack } from '../../ui/surfaces';
import { ReconnectSheet } from '../../ui/status/ReconnectSheet';
import { StatusSlot } from '../../ui/status/StatusSlot';
import type { SyncStatus } from '../../ui/props';
import { WINDOW_COPY } from '../copy';
import { ZeroAccountsView } from '../ZeroAccounts';
import {
  initialReconnect,
  reduceReconnect,
  sheetView,
  type ReconnectCall,
  type ReconnectEvent,
  type ReconnectState,
} from './reconnect.model';

const noop = () => undefined;

type StateEntry = { title: string; render: () => JSX.Element; height?: number };

const ADDRESS = 'jordan.lee@example.com';

/** A sheet's state after real events, so the pictures cannot drift from the machine. */
function sheetAfter(
  call: ReconnectCall,
  events: readonly ReconnectEvent[],
  enable?: 'calendarWrite',
): ReconnectState {
  let state = initialReconnect({
    accountId: 'acc-jordan',
    address: ADDRESS,
    call,
    ...(enable ? { enable } : {}),
  });
  for (const event of [
    { type: 'open' } as const,
    { type: 'started', attempt: 1, connectId: 'c1' } as const,
    ...events,
  ]) {
    state = reduceReconnect(state, event).state;
  }
  return state;
}

const frame = (reasonCode: string | undefined, mode = 'reconnect'): ReconnectEvent => ({
  type: 'frame',
  connectId: 'c1',
  mode,
  state: 'failed',
  accountId: 'acc-jordan',
  ...(reasonCode ? { reasonCode } : {}),
});

/** The main pane behind the sheet: the gray shell and the white pane with nothing drawn on it. */
function Backdrop({ children }: { children?: JSX.Element }): JSX.Element {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', background: 'var(--shell)' }}>
      <div style={{ flex: 1, minWidth: 0, display: 'flex' }}>
        <Pane kind="main" label="Home">
          {children ?? <></>}
        </Pane>
      </div>
    </div>
  );
}

/**
 * The mail window's shell with the sidebar's footer slot beside the plain pane: where the status slot lives (DESIGN
 * 7.1). The slot is the real `StatusSlot`; the rest of the sidebar belongs to the shell lane and is left out.
 */
export function SlotBackdrop({
  slot,
  children,
}: {
  slot: JSX.Element;
  children?: JSX.Element;
}): JSX.Element {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', background: 'var(--shell)' }}>
      <aside
        style={{
          flex: 'none',
          width: 'var(--sidebar-w)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          padding: 'var(--space-2)',
        }}
      >
        {slot}
      </aside>
      <div style={{ flex: 1, minWidth: 0, display: 'flex' }}>
        <Pane kind="main" label="Home">
          {children ?? <></>}
        </Pane>
      </div>
    </div>
  );
}

/**
 * When Gmail will ask: tomorrow at 9:00 AM if that is within the 24 hours the slot waits for, otherwise tomorrow a
 * little earlier in the day than now (so the copy still says "tomorrow" at any hour the capture runs).
 */
export function reconnectDueBy(now: Date = new Date()): string {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const nineAm = tomorrow.getTime() + 9 * 3_600_000;
  if (nineAm - now.getTime() <= 24 * 3_600_000 - 60_000) return new Date(nineAm).toISOString();
  const sinceMidnight =
    now.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return new Date(tomorrow.getTime() + Math.max(60_000, sinceMidnight - 30 * 60_000)).toISOString();
}

/** The status slot with one status, as the shell draws it for a single account. */
function slotState(status: SyncStatus): JSX.Element {
  return (
    <SlotBackdrop
      slot={
        <StatusSlot status={status} account={{ address: ADDRESS, color: 'sky' }} onAction={noop} />
      }
    />
  );
}

function sheet(state: ReconnectState): JSX.Element {
  const view = sheetView(state);
  return (
    <Backdrop>
      <ReconnectSheet
        open
        address={view.address}
        state={view.state}
        mode={view.mode}
        {...(view.reason ? { reason: view.reason } : {})}
        onCancel={noop}
        onRetry={noop}
      />
    </Backdrop>
  );
}

export const reconnectStates: Record<string, StateEntry> = {
  'reconnect-due': {
    title:
      'Status slot a day before reconnectBy: "Gmail will ask you to reconnect tomorrow…" (Reconnect now)',
    render: () =>
      slotState({
        kind: 'ok',
        lastSyncedAt: new Date().toISOString(),
        reconnectBy: reconnectDueBy(),
      }),
  },
  reconnecting: {
    title: 'Reconnect sheet while waiting for Google (the same sheet as reconnect-waiting)',
    render: () => sheet(sheetAfter('reconnect', [])),
  },
  'reconnect-waiting': {
    title: 'Reconnect sheet: waiting for Google in the browser (Cancel)',
    render: () => sheet(sheetAfter('reconnect', [])),
  },
  reconnected: {
    title: 'After a successful reconnect: the "Reconnected" toast over the main pane',
    render: () => (
      <Backdrop>
        <ToastStack
          toasts={[
            {
              id: 'reconnected',
              kind: 'info',
              message: 'Reconnected',
              undoable: false,
              persistent: true,
            },
          ]}
          onAction={noop}
          onDismiss={noop}
        />
      </Backdrop>
    ),
  },
  'reconnect-failed-denied': {
    title: 'Reconnect sheet: Google sign-in declined (Try again)',
    render: () => sheet(sheetAfter('reconnect', [frame('auth.denied')])),
  },
  'reconnect-wrong-account': {
    title: 'Reconnect sheet: a different Google account (names the address)',
    render: () => sheet(sheetAfter('reconnect', [frame('auth.wrongAccount')])),
  },
  'reconnect-timeout': {
    title: 'Reconnect sheet: sign-in took too long (Try again)',
    render: () => sheet(sheetAfter('reconnect', [frame('auth.timeout')])),
  },
  'reconnect-grant-permissions': {
    title: 'Reconnect sheet: a missing permission (grant mode, waiting)',
    render: () => sheet(sheetAfter('grantPermissions', [])),
  },
  'reconnect-enable-editing': {
    title: 'Reconnect sheet: turning on calendar editing (enableEditing mode, waiting)',
    render: () => sheet(sheetAfter('grantPermissions', [], 'calendarWrite')),
  },
  /* The block in the mail window's proportions (hill-climb winners: the sidebar aside the pane where the status
     slot lives, and the centred 'settle' placement for the block itself; the sidebar's contents belong to ui-shell). */
  'zero-accounts': {
    title: 'Main pane, no accounts: the block with Add an account · Try demo mail',
    render: () => (
      <SlotBackdrop slot={<></>}>
        <ZeroAccountsView onAddAccount={noop} onTryDemo={noop} />
      </SlotBackdrop>
    ),
  },
  'zero-accounts-open-failed': {
    title: 'Main pane, no accounts: Add an account could not open the setup window (review1)',
    render: () => (
      <SlotBackdrop slot={<></>}>
        <ZeroAccountsView
          notice={WINDOW_COPY.setupWindowFailed}
          onAddAccount={noop}
          onTryDemo={noop}
        />
      </SlotBackdrop>
    ),
  },
  'zero-accounts-first-sync': {
    title:
      'Main pane while a first sync runs: the first-mail line, the status slot carrying the same words',
    render: () => (
      <SlotBackdrop
        slot={
          <StatusSlot
            status={{ kind: 'syncing', firstWindow: { read: 24, of: 50 } }}
            account={{ address: 'jordan.lee@example.com', color: 'sky' }}
            onAction={noop}
          />
        }
      >
        <div className="onb-list-column">
          <ZeroAccountsView
            firstSyncRunning
            detail="Reading your newest mail · 24 of 50"
            onAddAccount={noop}
            onTryDemo={noop}
          />
        </div>
      </SlotBackdrop>
    ),
  },
};
