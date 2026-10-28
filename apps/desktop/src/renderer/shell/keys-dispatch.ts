/**
 * The shell's one key listener, split into pure parts. A keydown is resolved against the current context stack and the
 * command runs; the registry owns every binding. A key typed in a field, composing text, or already handled by another
 * listener is left alone (the resolver decides, from the focus kind, which bindings own a field).
 */
import { useEffect, useRef } from 'react';
import {
  DEFAULT_KEY_PREFS,
  buildStack,
  focusKindOf,
  type CommandContext,
  type ConditionState,
  type ContextName,
  type KeyPrefs,
  type Registry,
  type TargetSummary,
} from '../commands';

/** What a keydown needs to build its `CommandContext`, read at the moment of the key. */
export interface ShellKeyState {
  readonly stack: readonly ContextName[];
  readonly target: TargetSummary | null;
  readonly conditions: ConditionState;
  readonly prefs?: KeyPrefs;
}

/** The context a key runs in; `focusTarget` is the event's target. */
export function shellKeyContext(state: ShellKeyState, focusTarget: unknown): CommandContext {
  return {
    stack: buildStack(state.stack),
    target: state.target,
    selection: [],
    conditions: state.conditions,
    prefs: state.prefs ?? DEFAULT_KEY_PREFS,
    focus: focusKindOf(focusTarget),
  };
}

/** Resolves and runs one keydown. Returns true when a command ran, so the caller can stop the browser's default. */
export function dispatchShellKey(
  registry: Pick<Registry, 'resolve' | 'run'>,
  state: ShellKeyState,
  event: KeyboardEvent,
): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  const context = shellKeyContext(state, event.target);
  const resolution = registry.resolve(event, context);
  if (!resolution || resolution.phase !== 'tap') return false;
  return registry.run(resolution.commandId, context).status === 'ran';
}

/** Listens on the window for the shell's lifetime; reads the latest state through a ref, so the listener binds once. Inert without a DOM. */
export function useShellKeys(
  registry: Pick<Registry, 'resolve' | 'run'>,
  readState: () => ShellKeyState,
): void {
  const latest = useRef(readState);
  useEffect(() => {
    latest.current = readState;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (dispatchShellKey(registry, latest.current(), event)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [registry]);
}
