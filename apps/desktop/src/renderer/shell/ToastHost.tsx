/**
 * The one ToastStack (DESIGN 7.13). Screens push `ToastData` with `pushToast`; this mounts the stack from the shell's
 * list, so every toast is opaque `--paper` with `--elev-float` through the component. It sits inside the main pane,
 * bottom-centre, never under the dock.
 */
import type { ToastData, ToastStackProps } from '../ui/props';
import { ToastStack } from '../ui/surfaces';
import { useUndoSendNotice } from '../screens/compose';
import { dismissToast, runToastAction, useToasts } from './index';

/** Props for `ToastHostView`. */
export interface ToastHostViewProps {
  readonly toasts: readonly ToastData[];
  readonly onAction: (toastId: string, actionId: string) => void;
  readonly onDismiss: (toastId: string) => void;
  /** The undo-send notice, when a send was handed off with no thread showing it. */
  readonly undoSend?: ToastStackProps['undoSend'];
}

/** The stack for a given list; kept apart from the store so tests can render any list. */
export function ToastHostView({ toasts, onAction, onDismiss, undoSend }: ToastHostViewProps) {
  return (
    <ToastStack toasts={toasts} onAction={onAction} onDismiss={onDismiss} undoSend={undoSend} />
  );
}

/** The shell's toast stack, live. */
export function ToastHost() {
  const toasts = useToasts();
  const undoSend = useUndoSendNotice();
  return (
    <ToastHostView
      toasts={toasts}
      onAction={runToastAction}
      onDismiss={dismissToast}
      undoSend={undoSend}
    />
  );
}
