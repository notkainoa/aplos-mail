/**
 * ToastStack: up to three toasts, bottom-centre of the main pane, never under the dock (DESIGN 6, 7.13).
 * Newest on top. When more than three are waiting, plain toasts give way first: an Undo toast is never silently
 * replaced, and the undo-send notice always keeps its place. Polite, and it never steals focus.
 *
 * The undo-send notice is drawn here by a plain stand-in until reader/UndoTray lands; it then becomes
 * <UndoTray {...undoSend} placement="toast" /> with no change for callers.
 */
import { useEffect, useRef, type CSSProperties, type ReactElement } from 'react';
import type { ComponentPropsMap, ToastData, ToastStackProps, UndoTrayAction } from '../props';
import { Toast } from './Toast';
import { PartIcon, PartKeys, formatTime, keysFor } from './parts';

const MAX_VISIBLE = 3;

/** The toasts to show, oldest first: the newest that fit, dropping plain toasts before Undo toasts. */
export function visibleToasts(toasts: readonly ToastData[], reserved: number): ToastData[] {
  const room = Math.max(0, MAX_VISIBLE - reserved);
  const list = [...toasts];
  while (list.length > room) {
    const plain = list.findIndex((toast) => !toast.undoable);
    list.splice(plain === -1 ? 0 : plain, 1);
  }
  return list;
}

function UndoSendNotice({ state, reducedMotion, undoCommandId, onAction, announce }: NonNullable<ToastStackProps['undoSend']>) {
  const announced = useRef(false);
  useEffect(() => {
    if (announced.current || !announce || state.kind !== 'sending') return;
    announced.current = true;
    announce(`Sending to ${state.recipients} in ${state.secondsLeft} seconds.`);
  }, [announce, state]);

  const verb = (action: UndoTrayAction, label: string, withKeys = false) => (
    <button key={action} type="button" className="ui-toast__action" onClick={() => onAction(action)}>
      <span>{label}</span>
      {withKeys ? <PartKeys chords={keysFor(undoCommandId)} /> : null}
    </button>
  );

  let message: string;
  let verbs: ReactElement[] = [];
  switch (state.kind) {
    case 'sending':
      message = `Sending to ${state.recipients} in ${state.secondsLeft} s`;
      verbs = [verb('undo', 'Undo', true), verb('sendNow', 'Send now')];
      break;
    case 'uncertain':
      message = 'We could not confirm this was sent.';
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
  const fraction = state.kind === 'sending' && state.totalSeconds > 0 ? Math.max(0, Math.min(1, state.secondsLeft / state.totalSeconds)) : 0;
  return (
    // Not a live region: the countdown ticks every second; the start is spoken once through `announce`.
    <div className="ui-toast" data-kind="undo-send" data-state="shown">
      <span className="ui-toast__icon">
        <PartIcon name="send" />
      </span>
      <span className="ui-toast__message">{message}</span>
      {verbs}
      {state.kind === 'sending' && !reducedMotion ? (
        <span className="ui-toast__drain" aria-hidden="true" style={{ '--drain': String(fraction) } as CSSProperties} />
      ) : null}
    </div>
  );
}

export function ToastStack({ toasts, undoSend, onAction, onDismiss }: ComponentPropsMap['ToastStack']) {
  const shown = visibleToasts(toasts, undoSend ? 1 : 0);
  return (
    <section className="ui-toast-stack" aria-label="Notifications">
      {shown.map((toast) => (
        <Toast key={toast.id} {...toast} onAction={(actionId) => onAction(toast.id, actionId)} onDismiss={() => onDismiss(toast.id)} />
      ))}
      {undoSend ? <UndoSendNotice {...undoSend} /> : null}
    </section>
  );
}
