/**
 * The ⌘K palette's host (DESIGN §7.9): props-in (`{open, onClose}`) because mounting it in an overlay slot is the
 * shell's job (REQUESTS.md). It reads the one registry through `useShellRegistry`, rebuilds the `CommandContext` the
 * shell would hand a key on the screen under the palette (same stack, target, conditions and prefs), and feeds
 * `paletteView` to the `Palette` component. Recents persist in `Settings.ui.palette.recents`; Settings rows open
 * through `openRoute`; the Ask row asks through `askRequests` (ui-ask's Ask dock picks it up).
 *
 * The host also owns the window the `palette.*` controls run against (registered here, like `SheetHost` registers
 * `sheet.*`), the hidden `role="status"` the confirm speaks through, and the focus return to whoever opened it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  buildStack,
  DEFAULT_KEY_PREFS,
  keyPrefsFromUi,
  type CommandContext,
  type RunResult,
} from '../../commands';
import { api, useSettings } from '../../data';
import {
  openRoute,
  useAppRoute,
  useCurrentTarget,
  useRegisterCommands,
  useShellKeyLayer,
  useShellRegistry,
  useSheetContextActive,
  type CommandHandlerTable,
} from '../../shell';
import { screenContext } from '../../shell/KeysProviders';
import {
  getKeyLayers,
  layerConditions,
  shellStack,
  subscribeKeyLayers,
} from '../../shell/store-keys';
import { nextActiveId } from '../../ui/ask/palette-nav';
import { askStore } from '../ask/askStore';
import { requestAsk } from './askRequests';
import {
  applyRun,
  choose,
  escape,
  openPalette,
  paletteView,
  pushRecent,
  setActive,
  setQuery,
  type Applied,
  type RunTarget,
} from './palette.model';
import { consumePaletteQuery, paletteStore, usePaletteState } from './paletteStore';
import { PaletteScreen } from './PaletteScreen';

/** Props for `PaletteHost`: the shell's overlay slot owns `open` (⌘K toggles it) and `onClose`. */
export interface PaletteHostProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export const PALETTE_LISTBOX_ID = 'palette-results';

/** A keydown can reach a handler twice (the shell's resolver and the component's own key handling); once is enough. */
function oncePerTask() {
  const seen = new Set<string>();
  return (key: string, run: () => void) => {
    if (seen.has(key)) return;
    seen.add(key);
    queueMicrotask(() => seen.delete(key));
    run();
  };
}

/** The element to refocus on close (store-sheet.ts's pattern, kept local: that one is the sheet's own). */
type Opener = { focus(): void; isConnected?: boolean } | null;

function focusedElement(): Opener {
  if (typeof document === 'undefined') return null;
  const active: unknown = document.activeElement;
  if (typeof active !== 'object' || active === null) return null;
  if (active === document.body) return null;
  return typeof (active as { focus?: unknown }).focus === 'function'
    ? (active as NonNullable<Opener>)
    : null;
}

/** Where focus goes when the opener has unmounted: the account switcher's trigger, else the main pane. */
function fallbackFocus(): Opener {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return null;
  const switcher = document.querySelector<HTMLElement>('.ui-account-switcher');
  if (switcher) return switcher;
  const pane = document.querySelector<HTMLElement>('.ui-pane[data-kind="main"]');
  if (pane && !pane.hasAttribute('tabindex')) pane.setAttribute('tabindex', '-1');
  return pane;
}

/** The context the commands run with: what the shell's key listener would build for a key on the screen below. */
function useCommandContext(): CommandContext {
  const screen = useAppRoute();
  const sheetOpen = useSheetContextActive();
  const layers = useSyncExternalStore(subscribeKeyLayers, getKeyLayers, getKeyLayers);
  const target = useCurrentTarget();
  const ui = useSettings()?.ui;
  const prefs = useMemo(() => (ui ? keyPrefsFromUi(ui) : DEFAULT_KEY_PREFS), [ui]);
  const stack = useMemo(
    () => buildStack(shellStack(screenContext(screen), sheetOpen, layers)),
    [screen, sheetOpen, layers],
  );
  return useMemo(
    () => ({
      stack,
      target,
      selection: [],
      conditions: layerConditions(layers),
      prefs,
      focus: 'control' as const,
    }),
    [stack, target, layers, prefs],
  );
}

export function PaletteHost({ open, onClose }: PaletteHostProps) {
  const state = usePaletteState();
  const { registry } = useShellRegistry();
  const ctx = useCommandContext();
  const once = useRef(oncePerTask()).current;
  const recents = useSettings()?.ui.palette.recents ?? [];
  const openerRef = useRef<Opener>(null);
  const wasOpen = useRef(false);

  // The confirm's sentence lives in a hidden polite region (DESIGN §11.3); a repeat gets an invisible suffix so it speaks again.
  const [announcement, setAnnouncement] = useState('');
  const announce = useCallback(
    (message: string) => setAnnouncement(now => (now === message ? `${message}\u00a0` : message)),
    [],
  );

  // Sync the host's `open` prop into the store, seeding the field from a pending `>` request.
  useEffect(() => {
    const current = paletteStore.get();
    if (open && !current.open) {
      const seeded = consumePaletteQuery();
      paletteStore.set(seeded === null ? openPalette() : openPalette(seeded));
    } else if (!open && current.open) {
      paletteStore.set(escape({ ...current, pages: [], confirm: undefined }).state);
    }
  }, [open]);

  // The panel's input autoFocuses before any open-time read of document.activeElement, so the opener is
  // tracked by listening: the last element focused outside `.ui-palette` is the one focus returns to.
  useEffect(() => {
    if (typeof document === 'undefined' || !document.addEventListener) return undefined;
    const onFocusIn = (event: FocusEvent) => {
      const el = event.target;
      if (el instanceof HTMLElement && !el.closest('.ui-palette')) openerRef.current = el;
    };
    document.addEventListener('focusin', onFocusIn, true);
    return () => document.removeEventListener('focusin', onFocusIn, true);
  }, []);

  // On close, return focus to the opener; when it is gone, the account switcher or the main pane (as the sheet does).
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      // Focused before the listener ever heard a focusin (or the panel never took focus): seed from the DOM.
      const active = focusedElement();
      const inside =
        typeof Element !== 'undefined' &&
        active instanceof Element &&
        active.closest('.ui-palette');
      if (active && !inside) openerRef.current = active;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    const target = openerRef.current;
    openerRef.current = null;
    if (target && target.isConnected !== false) target.focus();
    else fallbackFocus()?.focus();
  }, [open]);

  const entries = useMemo(
    () => (open ? registry.commandsForPalette(ctx) : []),
    [registry, ctx, open],
  );
  const view = paletteView(state, { ctx, entries, recents });

  // `palette.pickNumber` stays unregistered: the shell never sets `ctx.trigger`, so a handler cannot learn the
  // digit (REQUESTS.md). The rest run the same helpers the panel's own key handling calls, so a key handled
  // there (it preventDefaults) never reaches the dispatcher twice.
  useShellKeyLayer({ conditions: { emptyField: open && state.query === '' } });

  function apply(applied: Applied) {
    paletteStore.set(applied.state);
    if (applied.closed) onClose();
    if (applied.recent) {
      const id = applied.recent;
      // Read the latest settings inside the write: a recents list captured at render would lose a later row.
      void api.settings
        .get({})
        .then(settings =>
          api.settings.set({
            patch: {
              ui: { palette: { recents: pushRecent(settings.ui.palette.recents, id) } },
            },
          }),
        )
        .catch(() => undefined);
    }
  }

  function execute(target: RunTarget, confirmed = false) {
    const current = paletteStore.get();
    if (target.kind === 'ask') {
      apply(applyRun(current, target, { status: 'ask' }));
      // No subscriber yet (the dock's onAskRequest is still the shell's to mount): ask through the store
      // directly, which also bumps the open tick.
      if (!requestAsk(target.question)) askStore.ask(target.question);
      return;
    }
    const result: RunResult =
      target.kind === 'command'
        ? registry.run(target.id, ctx, { confirmed })
        : registry.runChild(target.child, ctx, { confirmed });
    apply(applyRun(current, target, result));
    if (result.status === 'navigate') openRoute(result.route);
  }

  /** Esc's own step: up a level, then out. The close lands through `onClose`, or the prop's `open` never moves. */
  function goBack(): void {
    once('esc', () => {
      const out = escape(paletteStore.get());
      paletteStore.set(out.state);
      if (out.closed) onClose();
    });
  }

  /** Esc at the top, ⌘K again, or the scrim: flatten whatever is open and close. */
  function close(): void {
    once('close', () => {
      const out = escape({ ...paletteStore.get(), pages: [], confirm: undefined });
      paletteStore.set(out.state);
      if (out.closed) onClose();
    });
  }

  function confirmPending(): void {
    once('confirm', () => {
      const pending = paletteStore.get().confirm;
      if (pending) execute(pending.target, true);
    });
  }

  function runRow(id: string | undefined): void {
    once('run', () => {
      const target = id ? choose(view, id) : null;
      if (target) execute(target);
    });
  }

  function moveActive(step: 1 | -1): void {
    const next = nextActiveId(view.order, view.activeId, step);
    if (next !== undefined) paletteStore.set(setActive(paletteStore.get(), next));
  }

  // The controls table is stable; it reaches the fresh closures and view through these refs on every run.
  const fns = { moveActive, runRow, confirmPending, goBack };
  const fnsRef = useRef(fns);
  fnsRef.current = fns;
  const viewRef = useRef(view);
  viewRef.current = view;
  const paletteControls = useMemo<CommandHandlerTable>(
    () => ({
      'palette.next': { run: () => fnsRef.current.moveActive(1) },
      'palette.previous': { run: () => fnsRef.current.moveActive(-1) },
      'palette.choose': { run: () => fnsRef.current.runRow(viewRef.current.activeId) },
      'palette.confirmDestructive': { run: () => fnsRef.current.confirmPending() },
      'palette.back': { run: () => fnsRef.current.goBack() },
    }),
    [],
  );
  useRegisterCommands(paletteControls);

  return (
    <>
      <span className="ui-sr-only" role="status">
        {announcement}
      </span>
      <PaletteScreen
        state={{ ...state, open }}
        view={view}
        announce={announce}
        handlers={{
          onQueryChange: query => paletteStore.set(setQuery(paletteStore.get(), query)),
          onActiveChange: id => paletteStore.set(setActive(paletteStore.get(), id)),
          onRun: id => runRow(id),
          onBack: () => goBack(),
          onClose: () => close(),
          onConfirm: () => confirmPending(),
          onCancelConfirm: () => goBack(),
        }}
      />
    </>
  );
}
