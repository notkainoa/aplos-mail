/**
 * ToastStack: up to three toasts, bottom-centre of the main pane, never under the dock (DESIGN 6, 7.13).
 * Newest on top. When more than three are waiting, the oldest plain toasts give way and are dismissed for good
 * (onDismiss), never hidden and brought back later. The newest toast, an Undo toast, an error toast and a persistent
 * toast are never silently replaced: when those alone outnumber the room, the stack grows past three rather
 * than drop one (past six the oldest of them are hidden, still queued). The undo-send notice always keeps
 * its place. The stack itself is the persistent polite live region, so each new toast is read once; it never
 * steals focus.
 *
 * The undo-send notice is drawn here by a plain stand-in until reader/UndoTray lands; it then becomes
 * <UndoTray {...undoSend} placement="toast" /> with no change for callers.
 */
import { useEffect, useRef, type CSSProperties, type ReactElement } from 'react';
import type { ComponentPropsMap, ToastData, ToastStackProps, UndoTrayAction } from '../props';
import { Toast } from './Toast';
import { PartIcon, PartKeys, formatTime, useKeysFor } from './parts';

const MAX_VISIBLE = 3;

/** Most toasts (undo-send notice included) kept in the DOM; older Undo and failure toasts beyond it wait, hidden. */
const MAX_MOUNTED = 6;

export interface ToastPlan {
  /** Toasts to render, oldest first. */
  shown: ToastData[];
  /** Plain toasts that gave way: dismissed for good (onDismiss). */
  dropped: ToastData[];
}

/**
 * Which toasts to show. While more than fit, the oldest plain toast (not undoable, error or persistent) that is not
 * the newest gives way; the newest toast, Undo toasts, error toasts and persistent toasts are never dropped, so a burst of them
 * may exceed three. Past six mounted, the oldest of those are hidden (kept queued, not dismissed) until newer close.
 */
export function planToasts(toasts: readonly ToastData[], reserved: number): ToastPlan {
  const room = Math.max(0, MAX_VISIBLE - reserved);
  const list = [...toasts];
  const dropped: ToastData[] = [];
  while (list.length > room) {
    const plain = list.findIndex(
      (toast, i) =>
        i < list.length - 1 && !toast.undoable && !toast.persistent && toast.kind !== 'error',
    );
    if (plain === -1) break;
    dropped.push(...list.splice(plain, 1));
  }
  const mounted = Math.max(1, MAX_MOUNTED - reserved);
  return { shown: list.length > mounted ? list.slice(-mounted) : list, dropped };
}

/** The toasts to show, oldest first (see planToasts). */
export function visibleToasts(toasts: readonly ToastData[], reserved: number): ToastData[] {
  return planToasts(toasts, reserved).shown;
}

/** The countdown reads in whole seconds, rounded up, never "9.806 s". */
export function wholeSeconds(secondsLeft: number): number {
  return Math.max(0, Math.ceil(secondsLeft));
}

function UndoSendNotice({
  state,
  reducedMotion,
  undoCommandId,
  onAction,
  announce,
}: NonNullable<ToastStackProps['undoSend']>) {
  const keysOf = useKeysFor();
  const announced = useRef(false);
  useEffect(() => {
    if (announced.current || !announce || state.kind !== 'sending') return;
    announced.current = true;
    announce(`Sending to ${state.recipients} in ${wholeSeconds(state.secondsLeft)} seconds.`);
  }, [announce, state]);

  const verb = (action: UndoTrayAction, label: string, withKeys = false) => (
    <button
      key={action}
      type="button"
      className="ui-toast__action"
      onClick={() => onAction(action)}
    >
      <span>{label}</span>
      {withKeys ? <PartKeys chords={keysOf(undoCommandId)} /> : null}
    </button>
  );

  let message: string;
  let verbs: ReactElement[] = [];
  switch (state.kind) {
    case 'sending':
      message = `Sending to ${state.recipients} in ${wholeSeconds(state.secondsLeft)} s`;
      verbs = [verb('undo', 'Undo', true), verb('sendNow', 'Send now')];
      break;
    case 'uncertain':
      message = 'Couldn’t confirm this was sent.';
      verbs = [verb('checkSent', 'Check Sent'), verb('sendAnyway', 'Send anyway')];
      break;
    case 'suspended':
      message = 'Missed its time while your Mac was off.';
      verbs = [verb('sendNow', 'Send now'), verb('reschedule', 'Reschedule')];
      break;
    case 'deferred':
      message = `Couldn’t send until ${formatTime(state.until)}. Your draft is saved.`;
      break;
  }
  const fraction =
    state.kind === 'sending' && state.totalSeconds > 0
      ? Math.max(0, Math.min(1, state.secondsLeft / state.totalSeconds))
      : 0;
  return (
    // Opted out of the stack's live region: the countdown ticks every second; the start is spoken once through `announce`.
    <div className="ui-toast" data-kind="undo-send" data-state="shown" aria-live="off">
      <span className="ui-toast__icon">
        <PartIcon name="send" />
      </span>
      <span className="ui-toast__message">{message}</span>
      {verbs}
      {state.kind === 'sending' && !reducedMotion ? (
        <span
          className="ui-toast__drain"
          aria-hidden="true"
          style={{ '--drain': String(fraction) } as CSSProperties}
        />
      ) : null}
    </div>
  );
}

export function ToastStack({
  toasts,
  undoSend,
  onAction,
  onDismiss,
}: ComponentPropsMap['ToastStack']) {
  const { shown, dropped: gaveWay } = planToasts(toasts, undoSend ? 1 : 0);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  // Plain toasts that gave way are removed for real, so they never come back later with a fresh timer.
  // Older Undo and failure toasts hidden past the cap are not: they stay queued and reappear.
  const dropped = gaveWay.map(toast => toast.id);
  const droppedKey = dropped.join('\u0000');
  useEffect(() => {
    if (droppedKey) for (const id of droppedKey.split('\u0000')) dismiss.current(id);
  }, [droppedKey]);
  return (
    // A plain container, not a landmark: always mounted so it is a live region before any toast arrives.
    <div className="ui-toast-stack" aria-live="polite">
      {shown.map(toast => (
        <Toast
          key={toast.id}
          {...toast}
          onAction={actionId => onAction(toast.id, actionId)}
          onDismiss={() => onDismiss(toast.id)}
        />
      ))}
      {undoSend ? <UndoSendNotice {...undoSend} /> : null}
    </div>
  );
}
