/**
 * The palette's container (DESIGN §7.9): the registry's entries for the context under the palette, the run, the
 * nested pages, the destructive confirm and the recents. It cannot run until `ui-shell` provides the live registry
 * and command context; it reaches them through `PalettePorts`.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { CommandContext, Registry, RunResult, SettingRoute } from '../../commands';
import type { Announce } from '../../ui/props';
import {
  applyRun,
  choose,
  escape,
  paletteView,
  pushRecent,
  setActive,
  setQuery,
  type Applied,
  type RunTarget,
} from './palette.model';
import { PaletteScreen } from './PaletteScreen';
import { paletteStore, usePaletteState } from './paletteStore';

/** What the palette needs from the shell and the data layer (REQUESTs to ui-shell; see the lane report). */
export interface PalettePorts {
  /** The app's one registry, with every screen's handlers attached. */
  readonly registry: Registry;
  /** The command context under the palette: stack, target, selection, conditions, prefs, focus. */
  readonly context: CommandContext;
  /** `Settings.ui.palette.recents`, newest first. */
  readonly recents: readonly string[];
  /** Writes `Settings.ui.palette.recents`. */
  readonly saveRecents: (recents: readonly string[]) => void;
  /** The shell's `openRoute` for Settings rows. */
  readonly openRoute: (route: SettingRoute) => void;
  /** Opens the Ask dock and asks (the Ask row). */
  readonly ask: (question: string) => void;
  readonly announce?: Announce;
}

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

export function PaletteContainer({ ports }: { ports: PalettePorts }) {
  const state = usePaletteState();
  const { registry, context, recents } = ports;
  const once = useRef(oncePerTask()).current;
  const entries = useMemo(
    () => (state.open ? registry.commandsForPalette(context) : []),
    [registry, context, state.open],
  );
  const view = paletteView(state, { ctx: context, entries, recents });

  // ⌘K toggles from anywhere; the palette's own keys stay with the component while it has focus.
  useEffect(
    () =>
      registry.attach('app.palette', { run: () => once('toggle', () => paletteStore.toggle()) }),
    [registry, once],
  );

  function apply(applied: Applied) {
    paletteStore.set(applied.state);
    if (applied.recent) ports.saveRecents(pushRecent(recents, applied.recent));
  }

  function execute(target: RunTarget, confirmed = false) {
    const current = paletteStore.get();
    if (target.kind === 'ask') {
      apply(applyRun(current, target, { status: 'ask' }));
      ports.ask(target.question);
      return;
    }
    const result: RunResult =
      target.kind === 'command'
        ? registry.run(target.id, context, { confirmed })
        : registry.runChild(target.child, context, { confirmed });
    apply(applyRun(current, target, result));
    if (result.status === 'navigate') ports.openRoute(result.route);
  }

  if (!state.open) return null;
  return (
    <PaletteScreen
      state={state}
      view={view}
      announce={ports.announce}
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
