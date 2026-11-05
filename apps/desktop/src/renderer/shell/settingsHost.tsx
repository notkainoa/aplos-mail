/**
 * Mounts Settings in the shell: the `SettingsHost` the screen asks for, and the route flow that feeds it.
 *
 * Host pieces, all through the shell so one sheet shows at a time with the modal `sheet` key context and focus returning
 * to the opener:
 * - `renderReconnect` opens the shell's `reconnect` sheet (ui-onboard's `ReconnectFlow` runs inside `SheetHost`);
 * - `renderAddAccount` opens the shell's `addAccount` dialog instead of drawing a second one;
 * - `showWelcome` is ui-onboard's `showWelcome`, with a toast when the setup window could not open;
 * - `toast` and `pushUndo` use the shell's toast stack; an undo for a change that was just toasted rides on that toast.
 *
 * Route flow: `openRoute('settings/ai#provider')` leaves a pending target; `SettingsMount` keeps it as the container's
 * `route` prop and consumes it once the container has been given it. The route is held here, not read from the pending
 * target, because consuming clears the target and the container reads a cleared route as "no row".
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SettingRoute } from '../commands';
import { WINDOW_COPY } from '../onboarding/copy';
import { showWelcome, welcomeFailureLine, type WelcomeResult } from '../onboarding/showWelcome';
import { SettingsContainer } from '../screens/settings/SettingsContainer';
import type { SettingsHost } from '../screens/settings/ports';
import {
  consumeRoute,
  openAddAccount,
  openSheet,
  pushToast,
  updateToast,
  useSettingsTarget,
  type PushedToast,
  type RouteTarget,
} from './index';

/** What the host calls on the shell; the defaults are the shell's own, tests pass recorders. */
export interface SettingsHostDeps {
  pushToast(toast: PushedToast): string;
  updateToast(id: string, patch: Partial<Omit<PushedToast, 'id'>>): void;
  openReconnect(accountId: string, mode: 'reconnect' | 'grant'): void;
  openAddAccount(): void;
  showWelcome(): Promise<WelcomeResult>;
}

const SHELL_DEPS: SettingsHostDeps = {
  pushToast,
  updateToast,
  openReconnect: (accountId, mode) => openSheet('reconnect', { accountId, mode }),
  openAddAccount,
  showWelcome: () => showWelcome(),
};

/**
 * Opens a shell sheet in place of an inline overlay: the effect runs once when Settings draws the overlay, then asks
 * Settings to drop its own flag (`onClose`) because the sheet is the shell's now.
 */
function HandOff({ open, onClose }: { readonly open: () => void; readonly onClose: () => void }) {
  useEffect(() => {
    open();
    onClose();
    // Once per mount: Settings unmounts this as soon as `onClose` clears its flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

/** The `SettingsHost` for the shell. One per Settings mount (it remembers the toast an undo may ride on). */
export function createSettingsHost(deps: SettingsHostDeps = SHELL_DEPS): SettingsHost {
  let count = 0;
  let last: { readonly id: string; readonly message: string } | null = null;
  const toast = (message: string) => {
    count += 1;
    const id = `settings-${count}`;
    last = { id, message };
    deps.pushToast({ id, kind: 'info', message, undoable: false });
  };
  return {
    toast,
    pushUndo(entry) {
      if (!last || last.message !== entry.label) toast(entry.label);
      const target = last;
      if (!target) return;
      deps.updateToast(target.id, {
        undoable: true,
        actions: [{ id: 'undo', label: 'Undo' }],
        onAction: () => void entry.undo(),
      });
    },
    renderReconnect: (accountId, mode, onClose): ReactNode => (
      <HandOff open={() => deps.openReconnect(accountId, mode)} onClose={onClose} />
    ),
    renderAddAccount: (onClose): ReactNode => (
      <HandOff open={() => deps.openAddAccount()} onClose={onClose} />
    ),
    showWelcome() {
      void deps.showWelcome().then(result => {
        if (welcomeFailureLine(result)) toast(WINDOW_COPY.setupWindowFailed);
      });
    },
  };
}

/** The route the container is given, and which pending target it came from. */
export interface MountRoute {
  readonly route: SettingRoute | undefined;
  readonly seq: number | null;
  /** Bumped when the same route is opened again, so the container starts over and lands on the row once more. */
  readonly nonce: number;
}

export const NO_ROUTE: MountRoute = { route: undefined, seq: null, nonce: 0 };

/** The mount's route after the shell's pending target changed: a new target replaces it; an old or cleared one changes nothing. */
export function routeFor(prev: MountRoute, target: RouteTarget | null): MountRoute {
  if (!target || target.seq === prev.seq) return prev;
  const again = prev.route === target.route;
  return { route: target.route, seq: target.seq, nonce: again ? prev.nonce + 1 : prev.nonce };
}

/** The owner picked a section in Settings' own nav: the route follows it (and drops the row). */
export function routeChosen(prev: MountRoute, route: SettingRoute): MountRoute {
  return prev.route === route ? prev : { ...prev, route };
}

/** Settings in the shell's screen slot. */
export function SettingsMount() {
  const target = useSettingsTarget();
  const [held, setHeld] = useState<MountRoute>(() => routeFor(NO_ROUTE, target));
  const current = routeFor(held, target);
  if (current !== held) setHeld(current);
  useEffect(() => {
    if (target) consumeRoute(target.seq);
  }, [target]);
  const host = useMemo(() => createSettingsHost(), []);
  const onRoute = useCallback(
    (route: SettingRoute) => setHeld(prev => routeChosen(prev, route)),
    [],
  );
  return (
    <SettingsContainer key={current.nonce} route={current.route} onRoute={onRoute} host={host} />
  );
}
