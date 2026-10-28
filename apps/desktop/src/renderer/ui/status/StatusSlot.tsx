/**
 * StatusSlot: the sidebar footer's sync state, the only place sync status lives in the main window
 * (DESIGN 6, 7.1, 7.15). Copy is DESIGN 7.1's table, written for two short lines of about 28 characters, with
 * one inline text button. It never becomes a banner. "Starting…" and "Syncing…" wait 150 ms before they show.
 * The slot is a polite live region; ticking counts inside it are marked aria-live="off" so only state changes speak.
 */
import { useEffect, useState } from 'react';
import { timing } from '../generated/motion';
import type { ComponentPropsMap, IconName, StatusAction, SyncStatus } from '../props';
import { PartButton, PartIcon, dayWord, formatCount, formatTime } from '../surfaces/parts';
import { ProgressSegments } from './ProgressSegments';

const DAY_MS = 86_400_000;

/** What the slot says for a state: DESIGN 7.1's copy, its icon, its one action and whether it needs attention. */
export interface StatusCopy {
  text: string;
  icon: IconName;
  action?: { kind: StatusAction; label: string; tone: 'default' | 'danger' };
  attention: boolean;
}

/** DESIGN 7.1's status table. Returns null when the slot shows nothing (ok, no reconnect due). */
export function statusCopy(status: SyncStatus, now: Date = new Date()): StatusCopy | null {
  switch (status.kind) {
    case 'starting':
      return { text: 'Starting…', icon: 'refresh', attention: false };
    case 'syncing':
      return status.firstWindow
        ? { text: `Reading your newest mail · ${formatCount(status.firstWindow.read)} of ${formatCount(status.firstWindow.of)}`, icon: 'refresh', attention: false }
        : { text: 'Syncing…', icon: 'refresh', attention: false };
    case 'ok': {
      if (!status.reconnectBy) return null;
      const left = new Date(status.reconnectBy).getTime() - now.getTime();
      if (left > DAY_MS) return null;
      return {
        text: `Gmail will ask you to reconnect ${dayWord(status.reconnectBy, now)} at ${formatTime(status.reconnectBy)}.`,
        icon: 'clock',
        action: { kind: 'reconnect', label: 'Reconnect now', tone: 'default' },
        attention: false,
      };
    }
    case 'backfilling':
      return { text: `Importing ${formatCount(status.done)} of ${formatCount(status.of)}`, icon: 'refresh', attention: false };
    case 'paused':
      return status.reason === 'dailyLimit'
        ? { text: 'Google’s daily limit is reached. Resuming tomorrow.', icon: 'pause', attention: false }
        : {
            text: status.resumeAt ? `Google asked us to slow down. Resuming at ${formatTime(status.resumeAt)}.` : 'Google asked us to slow down.',
            icon: 'pause',
            action: { kind: 'retry', label: 'Retry now', tone: 'default' },
            attention: false,
          };
    case 'needsReauth':
      return { text: 'Google needs you to sign in again.', icon: 'alert', action: { kind: 'reconnect', label: 'Reconnect', tone: 'danger' }, attention: true };
    case 'needsPermission':
      return { text: 'Aplos needs permission to read your Gmail.', icon: 'alert', action: { kind: 'reconnect', label: 'Reconnect', tone: 'danger' }, attention: true };
    case 'needsAdmin':
      return { text: 'Your organisation has blocked Aplos. Ask your administrator.', icon: 'alert', attention: true };
    case 'misconfigured':
      return { text: 'Google sign-in isn’t set up in this build.', icon: 'alert', action: { kind: 'copyDiagnostics', label: 'Copy diagnostics', tone: 'default' }, attention: true };
    case 'offline':
      return {
        text: status.changesWaiting > 0 ? `Offline · ${formatCount(status.changesWaiting)} ${status.changesWaiting === 1 ? 'change' : 'changes'} waiting` : 'Offline',
        icon: 'cloud-off',
        attention: false,
      };
    case 'error':
      return { text: 'Sync hit a problem.', icon: 'alert', action: { kind: 'viewDetails', label: 'View details', tone: 'default' }, attention: true };
    case 'demo':
      return { text: 'Demo mail. Remove it in Settings.', icon: 'mail', attention: false };
  }
}

/** The hover line for a healthy account ("Synced 2 min ago"), for the shell to show on hover. */
export function syncedLine(lastSyncedAt: string, now: Date = new Date()): string {
  const minutes = Math.floor((now.getTime() - new Date(lastSyncedAt).getTime()) / 60_000);
  if (minutes < 1) return 'Synced just now';
  if (minutes < 60) return `Synced ${minutes} min ago`;
  return `Synced at ${formatTime(lastSyncedAt)}`;
}

export function StatusSlot({ status, account, multipleAccounts, onAction }: ComponentPropsMap['StatusSlot']) {
  const delayed = status.kind === 'starting' || (status.kind === 'syncing' && !status.firstWindow);
  const [revealed, setRevealed] = useState(!delayed);
  useEffect(() => {
    if (!delayed) {
      setRevealed(true);
      return;
    }
    setRevealed(false);
    const t = setTimeout(() => setRevealed(true), timing.spinnerDelay);
    return () => clearTimeout(t);
  }, [delayed, status.kind]);

  const copy = statusCopy(status);
  const action = copy?.action;
  const ticking = status.kind === 'backfilling' || (status.kind === 'syncing' && status.firstWindow !== undefined);
  return (
    <div
      className="ui-status-slot"
      role="status"
      data-status={status.kind}
      data-tone={copy?.attention ? 'attention' : undefined}
      data-state={copy === null ? 'empty' : revealed ? 'shown' : 'waiting'}
    >
      {copy ? (
        <>
          <PartIcon name={copy.icon} size="sm" />
          <div className="ui-status-slot__body">
            {multipleAccounts && account ? <span className="ui-status-slot__account">{account.address}</span> : null}
            {status.kind === 'backfilling' && account ? (
              <div aria-live="off">
                <ProgressSegments variant="importing" account={account} done={status.done} of={status.of} />
              </div>
            ) : (
              <p className="ui-status-slot__text" aria-live={ticking ? 'off' : undefined}>
                {copy.text}
              </p>
            )}
            {status.kind === 'syncing' && status.firstWindow && account ? (
              <div aria-live="off">
                <ProgressSegments variant="waiting" label={`${account.address} sync`} />
              </div>
            ) : null}
            {action ? (
              <span className="ui-status-slot__action">
                <PartButton variant="text" size="sm" label={action.label} tone={action.tone} onPress={() => onAction(action.kind, account)} />
              </span>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
