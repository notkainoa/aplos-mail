/**
 * The weekly reconnect flow (DESIGN 7.1 "The reconnect sheet", 7.10, 7.15; roadmap N3; plan 30 U8 acceptance 3 and 9).
 * ui-shell's status slot ("Reconnect now", "Reconnect"), ui-settings' account row and the account switcher's row all
 * mount this one component, so every entry point opens the same sheet and runs the same calls.
 *
 * What it does, once mounted: it starts `Account/reconnect` (or `Account/grantPermissions` for a missing permission)
 * at once, shows `ReconnectSheet` "Waiting for Google in your browser…", and follows the flow's `connect` frames.
 * - Connected: the sheet closes, a "Reconnected" toast goes through the shell's `pushToast`, and `onClose('reconnected')`.
 *   The 'enableEditing' sheet raises no toast: the account row flipping to "Editing on" is the confirmation, and
 *   a consent that left the events scope unticked must not announce a reconnect that never happened.
 * - Failed: the sheet says why in a plain sentence with Try again (`copy.ts`); the wrong Google account names the
 *   address to choose.
 * - Cancel, Esc or the scrim: `Account/cancelConnect`, then `onClose('cancelled')`. A frame that arrives after that,
 *   or after the sheet closed, is ignored.
 * - It never asks for a sync: nothing resyncs, and the changes queued on this Mac stay queued (N3).
 * - Focus returns to what had it before the sheet opened. If that control is gone (the status line vanishes once the
 *   account is reconnected), the parent decides where focus goes in `onClose`.
 *
 * The state machine and its effects are `reconnect.model.ts`; this file only wires them to `renderer/data`.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, getNow, useAccounts, useAccountsLoaded, useFrames } from '../../data';
import { pushToast, useRegisterCommands } from '../../shell';
import { ReconnectSheet } from '../../ui/status/ReconnectSheet';
import {
  callFor,
  initialReconnect,
  MISSING_ACCOUNT_WAIT_MS,
  missingAccountClose,
  reconnectedToast,
  reduceReconnect,
  runReconnectEffect,
  sheetView,
  type ReconnectCall,
  type ReconnectEvent,
  type ReconnectOutcome,
  type ReconnectPorts,
  type ReconnectState,
} from './reconnect.model';

export const defaultReconnectPorts: ReconnectPorts = {
  reconnect: async input => api.account.reconnect(input),
  grantPermissions: async input => api.account.grantPermissions(input),
  cancelConnect: async input => api.account.cancelConnect(input),
};

export interface ReconnectFlowProps {
  /** The account to reconnect. */
  readonly accountId: string;
  /** The sheet is gone; the parent unmounts the flow. */
  readonly onClose: (outcome: ReconnectOutcome) => void;
  /** The calls; the defaults come from `renderer/data`. The preview and tests pass their own. */
  readonly ports?: Partial<ReconnectPorts>;
  /**
   * The caller's pick (`Account/reconnect` or `Account/grantPermissions`), when it named one — the shell's sheet
   * args carry the mode the entry point asked for, and that wins over what the account's health would re-derive.
   */
  readonly call?: ReconnectCall;
  /** 'enableEditing' only: `grantPermissions` asks for the events scope on top of the read scopes. */
  readonly enable?: 'calendarWrite';
}

/** What the flow knows about the account when it opens; later health changes never restart it. */
interface Facts {
  readonly address: string;
  readonly call: ReconnectCall;
  readonly enable?: 'calendarWrite';
}

/** Puts focus back where it was, unless something else already holds it. */
export function restoreFocus(opener: Element | null): boolean {
  if (!(opener instanceof HTMLElement) || !opener.isConnected) return false;
  const active = document.activeElement;
  if (active && active !== document.body && active !== opener && !active.closest('[role="dialog"]'))
    return false;
  opener.focus({ preventScroll: true });
  return document.activeElement === opener;
}

const noop = () => {};

export function ReconnectFlow({
  accountId,
  onClose,
  ports: given,
  call,
  enable,
}: ReconnectFlowProps) {
  const accounts = useAccounts();
  const loaded = useAccountsLoaded();
  const factsRef = useRef<Facts | null>(null);
  if (!factsRef.current) {
    const account = accounts.find(a => a.id === accountId);
    if (account)
      factsRef.current = {
        address: account.address,
        call: call ?? callFor(account, getNow()),
        ...(enable ? { enable } : {}),
      };
  }
  const facts = factsRef.current;
  // The account is not here (removed, or the list has not arrived): nothing to reconnect.
  if (!facts) return <Missing onClose={onClose} loaded={loaded} accounts={accounts.length} />;
  return <Run accountId={accountId} facts={facts} onClose={onClose} ports={given} />;
}

/** The account is gone: report it once, draw nothing. While `Account/get` is still out, an empty list means "not arrived yet", so the flow waits instead of closing on a slow boot. */
function Missing({
  onClose,
  loaded,
  accounts,
}: {
  onClose: ReconnectFlowProps['onClose'];
  loaded: boolean;
  accounts: number;
}) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const when = missingAccountClose(loaded, accounts);
    if (when === 'now') {
      close.current('failed');
      return;
    }
    // The list may simply not have arrived: wait a moment for it, but never leave the flow waiting for good.
    if (when === 'wait') return;
    const timer = setTimeout(() => close.current('failed'), MISSING_ACCOUNT_WAIT_MS);
    return () => clearTimeout(timer);
  }, [loaded, accounts]);
  return null;
}

function Run({
  accountId,
  facts,
  onClose,
  ports: given,
}: {
  accountId: string;
  facts: Facts;
  onClose: ReconnectFlowProps['onClose'];
  ports: Partial<ReconnectPorts> | undefined;
}) {
  const ports = useRef({ ...defaultReconnectPorts, ...given }).current;
  // Read before any effect runs: this is the control that had focus when the sheet opened. A render with no DOM
  // (a static render under test) has no opener to return to.
  const [opener] = useState<Element | null>(() =>
    typeof document === 'undefined' ? null : document.activeElement,
  );

  const [state, setState] = useState<ReconnectState>(() =>
    initialReconnect({
      accountId,
      address: facts.address,
      call: facts.call,
      ...(facts.enable ? { enable: facts.enable } : {}),
    }),
  );
  const stateRef = useRef(state);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const mounted = useRef(true);

  const finish = useCallback(
    (outcome: ReconnectOutcome) => {
      // Unmounted from outside (the window went away): nobody is left to tell.
      if (!mounted.current) return;
      const message = outcome === 'reconnected' ? reconnectedToast(stateRef.current) : null;
      if (message) {
        try {
          pushToast({
            id: `reconnect-${accountId}`,
            kind: 'info',
            message,
            undoable: false,
          });
        } catch {
          // The shell's toast stack may not be there yet; onClose('reconnected') still tells the parent.
        }
      }
      onCloseRef.current(outcome);
      // The parent may have removed the control that opened the sheet; otherwise put focus back on it.
      queueMicrotask(() => restoreFocus(opener));
    },
    [accountId, opener],
  );

  const dispatchRef = useRef<(event: ReconnectEvent) => void>(noop);
  const dispatch = useCallback(
    (event: ReconnectEvent) => {
      const out = reduceReconnect(stateRef.current, event);
      stateRef.current = out.state;
      setState(out.state);
      for (const effect of out.effects) {
        if (effect.type === 'close') finish(effect.outcome);
        else void runReconnectEffect(effect, ports, answer => dispatchRef.current(answer));
      }
    },
    [finish, ports],
  );
  dispatchRef.current = dispatch;

  // Return in the sheet is Try again on a failed reconnect (shell/README.md `sheet.default`); the machine
  // ignores `retry` in every other phase, so the handler can stay registered for the sheet's whole life.
  const sheetDefault = useMemo(
    () => ({ 'sheet.default': { run: () => dispatchRef.current({ type: 'retry' }) } }),
    [],
  );
  useRegisterCommands(sheetDefault);

  // One click starts the flow. `open` only acts on an idle sheet, so a StrictMode remount cannot start a second one.
  useEffect(() => {
    mounted.current = true;
    dispatch({ type: 'open' });
    return () => {
      mounted.current = false;
      // Unmounted while waiting (the window went away): cancel the flow so a late answer finds nothing to settle.
      queueMicrotask(() => {
        if (!mounted.current && stateRef.current.phase === 'waiting') dispatch({ type: 'cancel' });
      });
    };
  }, [dispatch]);

  // The connect frames of this account: each is handed to the machine once.
  const { frames } = useFrames('connect', { accountId });
  const seen = useRef(new Set<string>());
  useLayoutEffect(() => {
    for (const frame of frames) {
      const key = `${frame.connectId}:${frame.state}:${frame.seq}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      dispatch({
        type: 'frame',
        connectId: frame.connectId,
        mode: frame.mode,
        state: frame.state,
        ...(frame.accountId ? { accountId: frame.accountId } : {}),
        ...(frame.reasonCode ? { reasonCode: frame.reasonCode } : {}),
      });
    }
  }, [frames, dispatch]);

  const view = sheetView(state);
  return (
    <ReconnectSheet
      open={view.open}
      address={view.address}
      state={view.state}
      mode={view.mode}
      {...(view.reason ? { reason: view.reason } : {})}
      onCancel={() => dispatch({ type: 'cancel' })}
      onRetry={() => dispatch({ type: 'retry' })}
    />
  );
}
