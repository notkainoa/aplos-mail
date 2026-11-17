/**
 * The one ToastStack (DESIGN 7.13). Screens push `ToastData` with `pushToast`; this mounts the stack from the shell's
 * list, so every toast is opaque `--paper` with `--elev-float` through the component. It sits inside the main pane,
 * bottom-centre, never under the dock.
 */
import { useEffect, useReducer } from 'react';
import type { Registry } from '../commands';
import type { ToastData, ToastStackProps } from '../ui/props';
import { ToastStack } from '../ui/surfaces';
import { useUndoSendNotice } from '../screens/compose';
import { dismissToast, runToastAction, useAppRoute, useToasts } from './index';
import { useShellRegistry } from './ShellRegistry';

/**
 * A toast action's keycap only shows while the screen under it binds that key: "Remind me if no reply R" and
 * "Set a date D" belong to Home, so in the reader (where R replies) the button stays and the keycap goes.
 */
export function withLiveKeys(
  toasts: readonly ToastData[],
  owns: (commandId: string) => boolean,
): readonly ToastData[] {
  return toasts.map(toast => {
    const actions = toast.actions?.map(action =>
      action.keysFrom && !action.commandId && !owns(action.keysFrom)
        ? { ...action, keysFrom: undefined }
        : action,
    );
    return actions ? { ...toast, actions } : toast;
  });
}

function ownedBy(registry: Registry): (commandId: string) => boolean {
  return commandId => registry.get(commandId)?.handlers !== undefined;
}

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
  const { registry } = useShellRegistry();
  // The screen's handlers attach in its effects, one pass after the route changes: render again once they have.
  const route = useAppRoute();
  const [, settle] = useReducer((n: number) => n + 1, 0);
  useEffect(() => settle(), [route]);
  const undoSend = useUndoSendNotice();
  return (
    <ToastHostView
      toasts={withLiveKeys(toasts, ownedBy(registry))}
      onAction={runToastAction}
      onDismiss={dismissToast}
      undoSend={undoSend}
    />
  );
}
