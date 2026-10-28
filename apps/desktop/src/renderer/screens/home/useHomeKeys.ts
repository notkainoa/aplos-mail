/**
 * Home's key listener: one window-level keydown that asks the CommandRegistry which command the key is in the current
 * context stack and runs it. The registry owns every binding; this binds none of its own. A key the shell (or any
 * other listener) already handled arrives with `defaultPrevented` and is left alone, so a shell-level listener can
 * replace this one later without double-running a command.
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
export interface HomeKeyState {
  readonly registry: Registry;
  readonly prefs?: KeyPrefs;
  /** The Low importance sheet is open: its modal context goes on top. */
  readonly lowSheetOpen: boolean;
  /** A "Remind me if no reply" toast is showing, so R means that. */
  readonly remindOffer: boolean;
  readonly target: TargetSummary | null;
}

/** The stack Home reports: the window, the list, Home itself, and the sheet when it is open. */
export function homeStack(lowSheetOpen: boolean): readonly ContextName[] {
  const base: ContextName[] = ['global', 'list', 'home'];
  return lowSheetOpen ? [...base, 'lowImportance'] : base;
}

/** The context a key runs in. */
export function homeContext(state: HomeKeyState, focusTarget: unknown): CommandContext {
  const conditions: ConditionState = { remindOffer: state.remindOffer };
  return {
    stack: homeStack(state.lowSheetOpen),
    target: state.target,
    selection: [],
    conditions,
    prefs: state.prefs ?? DEFAULT_KEY_PREFS,
    focus: focusKindOf(focusTarget),
  };
}

/** Resolves and runs one keydown. Returns true when a command ran, so the caller can stop the browser's default. */
export function dispatchKey(state: HomeKeyState, event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  const context = homeContext(state, event.target);
  const resolution = state.registry.resolve(event, context);
  if (!resolution || resolution.phase !== 'tap') return false;
  const result = state.registry.run(resolution.commandId, context);
  return result.status === 'ran';
}

/** Listens for keys while Home is mounted; reads the latest state through a ref, so the listener binds once. */
export function useHomeKeys(state: HomeKeyState): void {
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
