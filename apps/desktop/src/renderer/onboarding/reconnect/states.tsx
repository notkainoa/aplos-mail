/**
 * Preview fixtures for the weekly reconnect sheet and the zero-accounts state (DESIGN 7.1, 7.14, 7.15; plan 30 §4.5
 * rows 8 and 11). Every state is the machine's own output (`reconnect.model.ts`) or the presentational view with
 * no-op callbacks, drawn over a plain backdrop the size of the main pane. Original demo data only: an invented
 * address on an example domain.
 *
 * The gallery (`../preview/main.tsx`) imports `reconnectStates` with the same shape as `stepStates`.
 */
import type { JSX } from 'react';
import { Pane } from '../../ui/surfaces';
import { ReconnectSheet } from '../../ui/status/ReconnectSheet';
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
function sheetAfter(call: ReconnectCall, events: readonly ReconnectEvent[]): ReconnectState {
  let state = initialReconnect({ accountId: 'acc-jordan', address: ADDRESS, call });
  for (const event of [{ type: 'open' } as const, { type: 'started', attempt: 1, connectId: 'c1' } as const, ...events]) {
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
  'reconnect-waiting': {
    title: 'Reconnect sheet: waiting for Google in the browser (Cancel)',
    render: () => sheet(sheetAfter('reconnect', [])),
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
  'zero-accounts': {
    title: 'Main pane, no accounts: Add an account · Try demo mail',
    render: () => (
      <Backdrop>
        <ZeroAccountsView onAddAccount={noop} onTryDemo={noop} />
      </Backdrop>
    ),
  },
  'zero-accounts-first-sync': {
    title: 'Main pane while a first sync runs: the first-mail line instead (never the zero-accounts line)',
    render: () => (
      <Backdrop>
        <ZeroAccountsView firstSyncRunning detail="Reading your newest mail" onAddAccount={noop} onTryDemo={noop} />
      </Backdrop>
    ),
  },
};
