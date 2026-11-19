// The "Update ready" notice. Main downloads an update quietly and sends one `update` event whenever the state changes
// (main/updater.ts); this turns the ready state into one calm persistent toast with Restart and Later. Nothing installs
// until Restart: Later hides the notice until the next manual check or launch, as in the menu and Settings.

import type { PushedToast } from './index';

/** The part of preload's bridge this needs (the same typed subscribe as `mainNavigate`). */
export interface UpdateBridge {
  subscribe(
    listener: (event: { type: string; payload?: unknown }) => void,
    options?: { only?: readonly string[] },
  ): () => void;
}

/** What the notice reads from main's `UpdateInfo`. */
export interface UpdateState {
  readonly status?: { readonly state?: unknown; readonly version?: unknown };
  readonly dismissed?: unknown;
}

/** The calls the notice makes; `api.update` in the app, fakes in tests. */
export interface UpdateCalls {
  status(): Promise<UpdateState>;
  restart(): Promise<unknown>;
  later(): Promise<unknown>;
}

/** The shell's toast surface. */
export interface UpdateToasts {
  push(toast: PushedToast): unknown;
  dismiss(id: string): unknown;
}

export const UPDATE_TOAST_ID = 'update-ready';
const RESTART_FAILED_ID = 'update-restart-failed';

/** The ready version, or undefined when nothing is ready or the owner put it off with Later. */
export function readyVersion(info: UpdateState | null | undefined): string | undefined {
  const status = info?.status;
  if (!status || status.state !== 'ready' || info?.dismissed === true) return undefined;
  return typeof status.version === 'string' && status.version ? status.version : undefined;
}

/**
 * Shows the notice for the current state and for each `update` event after. Asks `status` once first, because the
 * update may have finished downloading before this window listened. Returns the unsubscribe.
 */
export function listenUpdates(
  bridge: UpdateBridge | undefined,
  calls: UpdateCalls,
  toasts: UpdateToasts,
): () => void {
  let stopped = false;
  const show = (info: UpdateState | null | undefined) => {
    if (stopped) return;
    const version = readyVersion(info);
    if (!version) return void toasts.dismiss(UPDATE_TOAST_ID);
    toasts.push({
      id: UPDATE_TOAST_ID,
      kind: 'info',
      message: `Update ready · Aplos Mail ${version}`,
      undoable: false,
      persistent: true,
      actions: [
        { id: 'restart', label: 'Restart' },
        { id: 'later', label: 'Later' },
      ],
      onAction: actionId => {
        if (actionId === 'later') void calls.later().catch(() => undefined);
        else
          void calls.restart().catch(() =>
            toasts.push({
              id: RESTART_FAILED_ID,
              kind: 'error',
              message: 'Couldn’t restart to update. Try Aplos Mail → Check for Updates.',
              undoable: false,
            }),
          );
      },
    });
  };
  const off =
    bridge && typeof bridge.subscribe === 'function'
      ? bridge.subscribe(
          event => {
            if (event.type === 'update') show(event.payload as UpdateState | null | undefined);
          },
          { only: ['update'] },
        )
      : () => undefined;
  void calls.status().then(show, () => undefined);
  return () => {
    stopped = true;
    off();
  };
}
