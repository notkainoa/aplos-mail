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

/** The slice of an element the overlay scan reads (a real `Element` satisfies it). */
interface ElementLike {
  readonly parentElement?: ElementLike | null;
  getAttribute?(name: string): string | null;
}

function hasClass(el: ElementLike, name: string): boolean {
  return (el.getAttribute?.('class') ?? '').split(/\s+/).includes(name);
}

/** The key contexts one element declares: `data-keyctx` (comma separated) first, else the overlay its role and class show. */
function contextsOfElement(el: ElementLike): ContextName[] {
  const declared = el.getAttribute?.('data-keyctx');
  if (declared) return declared.split(',').map(c => c.trim()) as ContextName[];
  if (hasClass(el, 'ui-date-presets')) return ['datePicker'];
  const role = el.getAttribute?.('role');
  if (role === 'menu')
    return el.parentElement && hasClass(el.parentElement, 'ui-date-presets') ? [] : ['menu'];
  if (role === 'dialog') return [hasClass(el, 'ui-palette__panel') ? 'palette' : 'dialog'];
  return [];
}

/**
 * The modal contexts open around an element: its ancestors that are a menu, a date picker, a dialog or the palette (or
 * that declare `data-keyctx`), outer to inner. The renderer's overlays carry a role and a class rather than a key
 * context, so this reads those; a keydown inside an open overlay then reaches the overlay's keys and nothing behind it.
 */
export function overlayContexts(target: unknown): ContextName[] {
  if (typeof target !== 'object' || target === null) return [];
  const found: ContextName[] = [];
  for (let el: ElementLike | null | undefined = target; el; el = el.parentElement) {
    found.unshift(...contextsOfElement(el));
  }
  return found;
}

/** The overlay contexts around the event target and around the focused element (they differ when focus sits in a portal). */
function domContexts(focusTarget: unknown): ContextName[] {
  const active = typeof document === 'undefined' ? null : document.activeElement;
  return [...overlayContexts(active), ...overlayContexts(focusTarget)];
}

/** The context a key runs in; `focusTarget` is the event's target. The overlays open around it join the stack. */
export function shellKeyContext(state: ShellKeyState, focusTarget: unknown): CommandContext {
  return {
    stack: buildStack([...state.stack, ...domContexts(focusTarget)]),
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
