/**
 * The key-hint providers the shell mounts once (ui README "Keys"): `KeyHintsProvider` (tooltips, ⌘ held, or all) and
 * `CommandKeysProvider` (the registry's `describeKeys`, closed over the current context stack). They only describe keys.
 * Binding keys is the registry's resolver and the key listener, which are not mounted here. It also hands the toast
 * store a command runner over the same registry and stack, so a toast's Undo runs `app.undo` unless it can undo its own operation.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {
  createAppRegistry,
  DEFAULT_KEY_PREFS,
  keyPrefsFromUi,
  type CommandId,
  type ContextName,
} from '../commands';
import { api, useSettings } from '../data';
import { CommandKeysProvider, KeyHintsProvider, resolveShowKeys } from '../ui/buttons-keys';
import { setToastCommandRunner, setToastUndoRunner, toastUndoRefused, type Screen } from './index';
import { useShellKeys } from './keys-dispatch';
import { ShellRegistryProvider, shellRegistryFor } from './ShellRegistry';
import { getKeyLayers, layerConditions, shellStack, subscribeKeyLayers } from './store-keys';
import { getTarget } from './store-target';
import { toastCommandRunner, toastContext } from './toast-runner';

const META_KEY = 'Meta';

const RunCommandContext = createContext<((commandId: CommandId) => void) | null>(null);

/** Runs a command id through the shared registry in the shell's current context stack (a pane header tool uses it). A no-op outside the providers. */
export function useRunCommand(): (commandId: CommandId) => void {
  return useContext(RunCommandContext) ?? noRun;
}

function noRun(): void {
  return undefined;
}

/** A toast's Undo: undoes that toast's own operation (its id), not the newest change. True once the data layer took the request. */
export function undoToastOperation(opId: string): boolean {
  try {
    api.operation.undo({ opId }).receipt.catch(error => toastUndoRefused(opId, error));
    return true;
  } catch {
    return false;
  }
}

/** Whether ⌘ is down, for the held-key badges. Cleared when the window loses focus so it cannot stick. */
function useCommandHeld(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === META_KEY) setHeld(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === META_KEY) setHeld(false);
    };
    const clear = () => setHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
    };
  }, []);
  return held;
}

/** The key context a screen puts on the stack, so tooltips list only keys that work there. */
export function screenContext(screen: Screen): ContextName | null {
  if (typeof screen !== 'string') return null;
  switch (screen) {
    case 'home':
    case 'done':
    case 'calendar':
    case 'settings':
      return screen;
    default:
      return 'list';
  }
}

/** Props for `KeysProviders`. */
export interface KeysProvidersProps {
  readonly screen: Screen;
  /** A sheet is open, so the modal `sheet` context is on top. */
  readonly sheetOpen: boolean;
  readonly children: ReactNode;
}

export function KeysProviders({ screen, sheetOpen, children }: KeysProvidersProps) {
  const ui = useSettings()?.ui;
  const held = useCommandHeld();
  const prefs = useMemo(() => (ui ? keyPrefsFromUi(ui) : undefined), [ui]);
  // One registry for the app's life: screens attach handlers to it, so a settings change reconfigures it, never replaces it.
  const [shell] = useState(() => shellRegistryFor(createAppRegistry(prefs)));
  const { registry } = shell;
  // Configured while rendering, not in an effect: the key caps below are described from this render's registry, so an
  // effect would leave them one render behind a settings change. `configure` is idempotent for the same prefs.
  useMemo(() => registry.configure(prefs ?? DEFAULT_KEY_PREFS), [registry, prefs]);
  const layers = useSyncExternalStore(subscribeKeyLayers, getKeyLayers, getKeyLayers);
  const context = screenContext(screen);
  const stack = useMemo(() => shellStack(context, sheetOpen, layers), [context, sheetOpen, layers]);
  const latest = useRef({ stack, prefs, layers });
  latest.current = { stack, prefs, layers };
  const keyState = () => ({
    stack: latest.current.stack,
    prefs: latest.current.prefs,
    conditions: layerConditions(latest.current.layers),
    target: getTarget(),
  });
  useShellKeys(registry, keyState);
  useEffect(() => {
    setToastCommandRunner(
      toastCommandRunner(registry, () => toastContext(stack, getTarget(), prefs)),
    );
    return () => setToastCommandRunner(null);
  }, [registry, stack, prefs]);
  useEffect(() => {
    setToastUndoRunner(undoToastOperation);
    return () => setToastUndoRunner(null);
  }, []);
  const runCommand = useCallback(
    (commandId: CommandId) => {
      const { stack: now, prefs: nowPrefs, layers: nowLayers } = latest.current;
      const base = toastContext(now, getTarget(), nowPrefs);
      registry.run(commandId, { ...base, conditions: layerConditions(nowLayers) });
    },
    [registry],
  );
  const showKeys = resolveShowKeys({ all: ui?.keyHints === 'always', held });
  return (
    <ShellRegistryProvider value={shell}>
      <RunCommandContext.Provider value={runCommand}>
        <KeyHintsProvider value={{ showKeys }}>
          <CommandKeysProvider
            describe={(id, from) => registry.describeKeys(id, from)}
            stack={stack}
          >
            {children}
          </CommandKeysProvider>
        </KeyHintsProvider>
      </RunCommandContext.Provider>
    </ShellRegistryProvider>
  );
}
