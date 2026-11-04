/**
 * The ⌘K palette's host (DESIGN §7.9): props-in (`{open, onClose}`) because mounting it in an overlay slot is the
 * shell's job (REQUESTS.md). It reads the one registry through `useShellRegistry`, rebuilds the `CommandContext` the
 * shell would hand a key on the screen under the palette (same stack, target, conditions and prefs), and feeds
 * `paletteView` to the `Palette` component. Recents persist in `Settings.ui.palette.recents`; Settings rows open
 * through `openRoute`; the Ask row asks through `askRequests` (ui-ask's Ask dock picks it up).
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
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
  useShellRegistry,
  useSheetContextActive,
} from '../../shell';
import { screenContext } from '../../shell/KeysProviders';
import {
  getKeyLayers,
  layerConditions,
  shellStack,
  subscribeKeyLayers,
} from '../../shell/store-keys';
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

  const entries = useMemo(
    () => (open ? registry.commandsForPalette(ctx) : []),
    [registry, ctx, open],
  );
  const view = paletteView(state, { ctx, entries, recents });

  function apply(applied: Applied) {
    paletteStore.set(applied.state);
    if (applied.closed) onClose();
    if (applied.recent) {
      const next = pushRecent(recents, applied.recent);
      api.settings.set({ patch: { ui: { palette: { recents: next } } } }).catch(() => undefined);
    }
  }

  function execute(target: RunTarget, confirmed = false) {
    const current = paletteStore.get();
    if (target.kind === 'ask') {
      apply(applyRun(current, target, { status: 'ask' }));
      requestAsk(target.question);
      return;
    }
    const result: RunResult =
      target.kind === 'command'
        ? registry.run(target.id, ctx, { confirmed })
        : registry.runChild(target.child, ctx, { confirmed });
    apply(applyRun(current, target, result));
    if (result.status === 'navigate') openRoute(result.route);
  }

  return (
    <PaletteScreen
      state={{ ...state, open }}
      view={view}
      handlers={{
        onQueryChange: query => paletteStore.set(setQuery(paletteStore.get(), query)),
        onActiveChange: id => paletteStore.set(setActive(paletteStore.get(), id)),
        onRun: id =>
          once('run', () => {
            const target = choose(view, id);
            if (target) execute(target);
          }),
        onBack: () => once('esc', () => paletteStore.set(escape(paletteStore.get()).state)),
        onClose: () =>
          once('close', () =>
            paletteStore.set(
              escape({ ...paletteStore.get(), pages: [], confirm: undefined }).state,
            ),
          ),
        onConfirm: () =>
          once('confirm', () => {
            const confirm = paletteStore.get().confirm;
            if (confirm) execute(confirm.target, true);
          }),
        onCancelConfirm: () =>
          once('esc', () => paletteStore.set(escape(paletteStore.get()).state)),
      }}
    />
  );
}
