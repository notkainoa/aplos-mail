/**
 * A screen's key listener: one window-level keydown that asks the CommandRegistry which command the key is in the
 * screen's context stack and runs it. The registry owns every binding; this binds none of its own. A key already
 * handled (by a date picker, a dialog, the shell) arrives with `defaultPrevented` and is left alone, so a shell-level
 * listener can replace this one later without double-running a command.
 */
import { useEffect, useRef } from 'react';
import {
  DEFAULT_KEY_PREFS,
  focusKindOf,
  type CommandContext,
  type ConditionState,
  type ContextName,
  type KeyPrefs,
  type Registry,
  type TargetSummary,
} from '../../commands';

/** What the listener needs to build a `CommandContext` at the moment of a key. */
export interface ScreenKeyState {
  readonly registry: Registry;
  readonly prefs?: KeyPrefs;
  /** The screen's own contexts under `global`, outer to inner (`['list']`, `['list', 'done']`). */
  readonly contexts: readonly ContextName[];
  /** A transient on top: 'datePicker' while the Later picker is open, 'dialog' under a Confirm. */
  readonly modal?: ContextName | null;
  readonly selection?: readonly string[];
  readonly target: TargetSummary | null;
  readonly conditions?: ConditionState;
}

/** The stack this screen reports. */
export function stackOf(state: Pick<ScreenKeyState, 'contexts' | 'modal'>): readonly ContextName[] {
  const base: ContextName[] = ['global', ...state.contexts];
  return state.modal ? [...base, state.modal] : base;
}

/** The context a key runs in. */
export function contextOf(state: ScreenKeyState, focusTarget: unknown): CommandContext {
  return {
    stack: stackOf(state),
    target: state.target,
    selection: state.selection ?? [],
    conditions: state.conditions ?? {},
    prefs: state.prefs ?? DEFAULT_KEY_PREFS,
    focus: focusKindOf(focusTarget),
  };
}

/** Resolves and runs one keydown. Returns true when a command ran, so the caller can stop the browser's default. */
export function dispatchKey(state: ScreenKeyState, event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  const context = contextOf(state, event.target);
  const resolution = state.registry.resolve(event, context);
  if (!resolution || resolution.phase !== 'tap') return false;
  return state.registry.run(resolution.commandId, context).status === 'ran';
}

/** Listens for keys while the screen is mounted; reads the latest state through a ref, so the listener binds once. */
export function useScreenKeys(state: ScreenKeyState): void {
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (dispatchKey(latest.current, event)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
