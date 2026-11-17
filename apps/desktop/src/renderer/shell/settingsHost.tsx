/**
 * Mounts Settings in the shell: the `SettingsHost` the screen asks for, and the route flow that feeds it.
 *
 * Host pieces, all through the shell so one sheet shows at a time with the modal `sheet` key context and focus returning
 * to the opener:
 * - `renderReconnect` opens the shell's `reconnect` sheet (ui-onboard's `ReconnectFlow` runs inside `SheetHost`);
 * - `renderAddAccount` opens the shell's `addAccount` dialog instead of drawing a second one;
 * - `showWelcome` is ui-onboard's `showWelcome`, with a toast when the setup window could not open;
 * - `toast` and `pushUndo` use the shell's toast stack; `pushUndo` also puts the change on the data layer's shared undo
 *   stack, so Z undoes it; an undo for a change that was just toasted rides on that toast, and the toast's Undo and Z
 *   cannot both run it.
 *
 * Route flow: `openRoute('settings/ai#provider')` leaves a pending target; `SettingsMount` keeps it as the container's
 * `route` prop and consumes it once the container has been given it. The route is held here, not read from the pending
 * target, because consuming clears the target and the container reads a cleared route as "no row".
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { parseSettingRoute, type SettingRoute } from '../commands';
import { undoStack, type LocalUndo, type UndoHandle } from '../data';
import { WINDOW_COPY } from '../onboarding/copy';
import { showWelcome, welcomeFailureLine, type WelcomeResult } from '../onboarding/showWelcome';
import { openShortcuts } from './store-shortcuts';
import { SettingsContainer } from '../screens/settings/SettingsContainer';
import type { SettingsHost } from '../screens/settings/ports';
import {
  consumeRoute,
  openAddAccount,
  openSheet,
  dismissToast,
  pushToast,
  setSettingsSection,
  useSettingsTarget,
  type PushedToast,
  type RouteTarget,
} from './index';

/** What the host calls on the shell; the defaults are the shell's own, tests pass recorders. */
export interface SettingsHostDeps {
  pushToast(toast: PushedToast): string;
  dismissToast(id: string): void;
  /** Puts a local change on the data layer's shared undo stack (Z). */
  pushUndoEntry(entry: LocalUndo): UndoHandle;
  openReconnect(accountId: string, mode: 'reconnect' | 'grant' | 'enableEditing'): void;
  openAddAccount(): void;
  showWelcome(): Promise<WelcomeResult>;
}

const SHELL_DEPS: SettingsHostDeps = {
  pushToast,
  dismissToast,
  pushUndoEntry: entry => undoStack.push(entry),
  openReconnect: (accountId, mode) => openSheet('reconnect', { accountId, mode }),
  openAddAccount,
  showWelcome: () => showWelcome(),
};

/**
 * Opens a shell sheet in place of an inline overlay: the effect runs once when Settings draws the overlay, then asks
 * Settings to drop its own flag (`onClose`) because the sheet is the shell's now.
 */
export function runHandOff(open: () => void, onClose: () => void): void {
  open();
  onClose();
}

function HandOff({ open, onClose }: { readonly open: () => void; readonly onClose: () => void }) {
  // Once per mount: Settings unmounts this as soon as `onClose` clears its flag.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => runHandOff(open, onClose), []);
  return null;
}

/** Toast ids are unique for the page's life, so a toast left over from an earlier Settings mount is never taken for a new one. */
let toastSeq = 0;

/** The `SettingsHost` for the shell. One per Settings mount (it remembers the toast an undo may ride on). */
export function createSettingsHost(deps: SettingsHostDeps = SHELL_DEPS): SettingsHost {
  let last: { readonly id: string; readonly message: string } | null = null;
  const toast = (message: string) => {
    toastSeq += 1;
    const id = `settings-${toastSeq}`;
    last = { id, message };
    deps.pushToast({ id, kind: 'info', message, undoable: false });
  };
  return {
    toast,
    pushUndo(entry) {
      if (!last || last.message !== entry.label) toast(entry.label);
      const target = last;
      if (!target) return;
      // Whichever of Z and the toast's Undo comes first runs the change; the other finds nothing left to do.
      let spent = false;
      const run = () => {
        if (spent) return;
        spent = true;
        deps.dismissToast(target.id);
        return entry.undo();
      };
      const handle = deps.pushUndoEntry({ label: entry.label, undo: run });
      // A push with a live id updates that toast in place; one that has closed since comes back.
      deps.pushToast({
        id: target.id,
        kind: 'info',
        message: entry.label,
        undoable: true,
        actions: [{ id: 'undo', label: 'Undo' }],
        onAction: () => {
          handle.forget();
          void run();
        },
      });
    },
    renderReconnect: (accountId, mode, onClose): ReactNode => (
      <HandOff open={() => deps.openReconnect(accountId, mode)} onClose={onClose} />
    ),
    renderAddAccount: (onClose): ReactNode => (
      <HandOff open={() => deps.openAddAccount()} onClose={onClose} />
    ),
    openShortcuts,
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
  /** Bumped when the same route is opened again or another section is opened, so the container starts over and lands on the row. */
  readonly nonce: number;
}

export const NO_ROUTE: MountRoute = { route: undefined, seq: null, nonce: 0 };

/**
 * The mount's route after the shell's pending target changed: a new target replaces it; an old or cleared one changes
 * nothing. The container starts over when the same route is opened again, or when a deep link lands in another section
 * than the one it shows, so a new row is never looked for in the old section's page.
 */
export function routeFor(prev: MountRoute, target: RouteTarget | null): MountRoute {
  if (!target || target.seq === prev.seq) return prev;
  const again = prev.route === target.route;
  const shown = prev.route ? parseSettingRoute(prev.route)?.section : undefined;
  const elsewhere = shown !== undefined && shown !== target.section;
  const restart = again || elsewhere;
  return { route: target.route, seq: target.seq, nonce: restart ? prev.nonce + 1 : prev.nonce };
}

/** The owner picked a section in Settings' own nav: the route follows it (and drops the row). */
export function routeChosen(prev: MountRoute, route: SettingRoute): MountRoute {
  return prev.route === route ? prev : { ...prev, route };
}

/** Marks the pending deep link handled once the container has been given it. */
export function consumePending(
  target: RouteTarget | null,
  consume: (seq: number) => void = consumeRoute,
): void {
  if (target) consume(target.seq);
}

/**
 * Whether arriving at Settings should move focus to its region: only when nothing took it (the previous screen's
 * focused element went away, so focus fell to the page) and no deep-link row will focus its own control.
 */
export function arrivalFocus(input: {
  readonly row: string | undefined;
  readonly activeIsPage: boolean;
}): 'region' | 'keep' {
  return input.row === undefined && input.activeIsPage ? 'region' : 'keep';
}

/** True when focus is on the page itself (nothing focused). */
function focusIsOnPage(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || active === document.documentElement;
}

/** Settings in the shell's screen slot. */
export function SettingsMount() {
  const target = useSettingsTarget();
  const [held, setHeld] = useState<MountRoute>(() => routeFor(NO_ROUTE, target));
  const current = routeFor(held, target);
  if (current !== held) setHeld(current);
  const region = useRef<HTMLDivElement>(null);
  const arrivedRow = useRef(current.route ? parseSettingRoute(current.route)?.row : undefined);
  useEffect(() => consumePending(target), [target]);
  useEffect(() => {
    const row = arrivedRow.current;
    if (arrivalFocus({ row, activeIsPage: focusIsOnPage() }) === 'region')
      region.current?.focus({ preventScroll: true });
  }, []);
  const section = current.route ? parseSettingRoute(current.route)?.section : undefined;
  useEffect(() => {
    setSettingsSection(section ?? null);
    return () => setSettingsSection(null);
  }, [section]);
  const host = useMemo(() => createSettingsHost(), []);
  const onRoute = useCallback(
    (route: SettingRoute) => setHeld(prev => routeChosen(prev, route)),
    [],
  );
  return (
    <div className="aplos-settings-mount" tabIndex={-1} ref={region}>
      <SettingsContainer key={current.nonce} route={current.route} onRoute={onRoute} host={host} />
    </div>
  );
}
