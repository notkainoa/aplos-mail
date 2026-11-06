/**
 * The shell's one key listener, split into pure parts. A keydown is resolved against the current context stack and the
 * command runs; the registry owns every binding. A key typed in a field, composing text, or already handled by another
 * listener is left alone (the resolver decides, from the focus kind, which bindings own a field). With a `ShellHold`,
 * the listener also follows the hold protocol on `Resolution`: armed repeats are swallowed, a held key upgrades to its
 * hold command at the threshold, and every hold ends with `registry.release` (keyup, another key, Esc, blur or hide).
 */
import { useEffect, useRef } from 'react';
import {
  DEFAULT_KEY_PREFS,
  buildStack,
  createHoldTracker,
  focusKindOf,
  isModal,
  type CommandContext,
  type CommandId,
  type ConditionState,
  type ContextName,
  type HoldRelease,
  type HoldTracker,
  type KeyPrefs,
  type Registry,
  type TargetSummary,
} from '../commands';
import { handleRegionTab, trackRegionFocus } from './regions';

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

/**
 * One element's own overlay markers, for `openOverlays`: the overlay roles, the date picker, an
 * aria-modal surface or a popover, or a `data-keyctx` that names a modal context. A screen's
 * `data-keyctx` ('reader', 'search,list', 'ask') is a key context, not an overlay, so it is left
 * out — region Tab keeps working on those screens.
 */
function overlayMarks(el: ElementLike): ContextName[] {
  const out: ContextName[] = [];
  const declared = el.getAttribute?.('data-keyctx');
  if (declared)
    for (const name of declared.split(',')) {
      const context = name.trim() as ContextName;
      if (isModal(context)) out.push(context);
    }
  if (hasClass(el, 'ui-date-presets')) out.push('datePicker');
  const role = el.getAttribute?.('role');
  if (role === 'menu') out.push('menu');
  else if (role === 'dialog' || role === 'alertdialog')
    out.push(hasClass(el, 'ui-palette__panel') ? 'palette' : 'dialog');
  else if (el.getAttribute?.('aria-modal') === 'true' || hasClass(el, 'ui-popover'))
    out.push('dialog');
  return out;
}

/**
 * The real overlays open around an element, outer to inner — the same ancestor walk as
 * `overlayContexts` but only modal surfaces count (the shell's overlay stack: menus, dialogs, the
 * palette, the date picker, sheets). `handleRegionTab` reads it so region Tab yields to an open
 * overlay but stays alive on screens that carry a `data-keyctx`.
 */
export function openOverlays(target: unknown): ContextName[] {
  if (typeof target !== 'object' || target === null) return [];
  const found: ContextName[] = [];
  for (let el: ElementLike | null | undefined = target; el; el = el.parentElement)
    found.unshift(...overlayMarks(el));
  return found;
}

/** The overlays around an element plus the modal contexts the key stack reports (the open sheet). */
function regionTabOverlays(state: ShellKeyState, target: unknown): readonly ContextName[] {
  const modals = state.stack.filter(isModal);
  const dom = openOverlays(target);
  return modals.length === 0 ? dom : [...modals, ...dom];
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

/** The registry calls a hold needs: the tap and the hold command run, and every hold ends with a release. */
export type HoldRegistry = Pick<Registry, 'resolve' | 'run' | 'release'>;

/** What the listener needs to follow holds: the tracker, a clock, a timer, the latest state and the typed-key undo. */
export interface ShellHold {
  readonly tracker: HoldTracker;
  /** Milliseconds; the same clock for keydown, keyup and the tick. */
  now(): number;
  /** Calls `callback` after `ms`; returns the cancel. */
  schedule(ms: number, callback: () => void): () => void;
  /** The state at the tick: a tap (R) has changed it by then (the reply is open, so the stack holds `compose`). */
  readState(): ShellKeyState;
  /** The element that has focus now (`document.activeElement`). */
  focused(): unknown;
  /** Deletes the one character a phase 'hold' keydown typed into the focused field. */
  removeTyped(): void;
}

interface PendingTick {
  readonly cancel: () => void;
  /** The conditions at a typing keydown (hold Space in an empty body): the typed character is about to go again. */
  readonly typedConditions: ConditionState | null;
}

const pendingTicks = new WeakMap<ShellHold, PendingTick>();
/** The field a typing hold's keydown typed into: the typed character is removed only there, and leaving it ends the hold. */
const typedTargets = new WeakMap<ShellHold, unknown>();

/** The one field a held Space dictates into: the reply or compose body (`BodyEditor`'s `data-dictation="body"`). */
export const DICTATION_FIELD_ATTRIBUTE = 'data-dictation';

/** True for the reply or compose body; To, Subject and every other field type a held Space as spaces. */
export function isDictationField(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const el = target as ElementLike;
  return el.getAttribute?.(DICTATION_FIELD_ATTRIBUTE) === 'body';
}

/** Modifiers pressed or released mid-hold leave it armed: holds are tracked by physical key. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta']);

function activeElement(): unknown {
  return typeof document === 'undefined' ? null : document.activeElement;
}

function clearTick(hold: ShellHold): PendingTick | undefined {
  const pending = pendingTicks.get(hold);
  pending?.cancel();
  pendingTicks.delete(hold);
  return pending;
}

/** Hands an ended hold to its command's `release` handler; a disarmed tracker has no tick left to wait for. */
function finishHold(
  registry: HoldRegistry,
  context: CommandContext,
  hold: ShellHold,
  release: HoldRelease | null,
): void {
  if (!hold.tracker.armed) {
    clearTick(hold);
    typedTargets.delete(hold);
  }
  if (release) registry.release(release, context);
}

/** The context the hold command runs in: the current state, with the typing keydown's conditions restored. */
function upgradeContext(hold: ShellHold, typedConditions: ConditionState | null): CommandContext {
  const context = shellKeyContext(hold.readState(), activeElement());
  if (!typedConditions) return context;
  return { ...context, conditions: { ...context.conditions, ...typedConditions } };
}

function tickHold(registry: HoldRegistry, hold: ShellHold): void {
  const pending = clearTick(hold);
  const typedConditions = pending?.typedConditions ?? null;
  const upgrade = hold.tracker.tick(hold.now());
  if (!upgrade) {
    scheduleTick(registry, hold, typedConditions);
    return;
  }
  // Only from the field the key typed into, and only while it still has focus: never from whatever is focused now.
  const target = typedTargets.get(hold);
  if (upgrade.removeTyped && target !== undefined && hold.focused() === target) hold.removeTyped();
  registry.run(upgrade.commandId, upgradeContext(hold, typedConditions));
}

function scheduleTick(
  registry: HoldRegistry,
  hold: ShellHold,
  typedConditions: ConditionState | null,
): void {
  clearTick(hold);
  const deadline = hold.tracker.deadline;
  if (deadline === null) return;
  const wait = Math.max(0, deadline - hold.now());
  const cancel = hold.schedule(wait, () => tickHold(registry, hold));
  pendingTicks.set(hold, { cancel, typedConditions });
}

function armHold(
  registry: HoldRegistry,
  context: CommandContext,
  event: KeyboardEvent,
  hold: ShellHold,
  holdCommandId: CommandId,
  typed: boolean,
): void {
  const previous = hold.tracker.down(event, holdCommandId, hold.now(), { typed });
  finishHold(registry, context, hold, previous);
  if (typed) typedTargets.set(hold, event.target);
  else typedTargets.delete(hold);
  scheduleTick(registry, hold, typed ? context.conditions : null);
}

/**
 * Another keydown ends an armed hold: Esc cancels it, a modifier leaves it, anything else interrupts it. Returns true
 * when the key is spent: Esc during a running hold command only cancels it (the reply stays open, the words go).
 */
function endArmedHold(
  registry: HoldRegistry,
  context: CommandContext,
  event: KeyboardEvent,
  hold: ShellHold,
): boolean {
  if (!hold.tracker.armed || MODIFIER_KEYS.has(event.key)) return false;
  const escape = event.key === 'Escape';
  const at = hold.now();
  const release = escape ? hold.tracker.cancel(at) : hold.tracker.interrupt(at);
  finishHold(registry, context, hold, release);
  return escape && release?.upgraded === true;
}

function dispatchTap(
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

function dispatchWithHold(
  registry: HoldRegistry,
  state: ShellKeyState,
  event: KeyboardEvent,
  hold: ShellHold,
): boolean {
  if (hold.tracker.swallows(event)) return true;
  const context = shellKeyContext(state, event.target);
  if (endArmedHold(registry, context, event, hold)) return true;
  if (event.defaultPrevented || event.isComposing) return false;
  const resolution = registry.resolve(event, context);
  if (!resolution) return false;
  if (resolution.phase === 'hold') {
    const typed = context.focus === 'text';
    // A held key in a text field dictates only in the body; anywhere else it just types.
    if (typed && !isDictationField(event.target)) return false;
    armHold(registry, context, event, hold, resolution.commandId, typed);
    return false;
  }
  const ran = registry.run(resolution.commandId, context).status === 'ran';
  if (ran && resolution.holdCommandId)
    armHold(registry, context, event, hold, resolution.holdCommandId, false);
  return ran;
}

/**
 * Resolves and runs one keydown. Returns true when a command ran (or an armed key's repeat was swallowed), so the
 * caller can stop the browser's default. Without `hold`, only taps run and nothing is armed.
 */
export function dispatchShellKey(
  registry: Pick<Registry, 'resolve' | 'run'>,
  state: ShellKeyState,
  event: KeyboardEvent,
): boolean;
export function dispatchShellKey(
  registry: HoldRegistry,
  state: ShellKeyState,
  event: KeyboardEvent,
  hold: ShellHold,
): boolean;
export function dispatchShellKey(
  registry: Pick<Registry, 'resolve' | 'run'> | HoldRegistry,
  state: ShellKeyState,
  event: KeyboardEvent,
  hold?: ShellHold,
): boolean {
  if (!hold) return dispatchTap(registry, state, event);
  return dispatchWithHold(registry as HoldRegistry, state, event, hold);
}

/** The keyup: when it is the armed key, the hold ends ('up') and its command hears the release. */
export function releaseShellKey(
  registry: HoldRegistry,
  state: ShellKeyState,
  event: KeyboardEvent,
  hold: ShellHold,
): void {
  const release = hold.tracker.up(event, hold.now());
  finishHold(registry, shellKeyContext(state, event.target), hold, release);
}

/** Blur or the window hiding: an armed hold ends ('cancel') and what it heard is dropped. */
export function cancelShellHold(
  registry: HoldRegistry,
  state: ShellKeyState,
  hold: ShellHold,
): void {
  const release = hold.tracker.cancel(hold.now());
  finishHold(registry, shellKeyContext(state, activeElement()), hold, release);
}

/**
 * Focus left the field a typing hold typed into (the keyup will land elsewhere, or never): the hold ends ('cancel'), as
 * on blur. A hold that typed nothing (R in the reader, which moves focus into the reply) is left alone.
 */
export function focusLeftShellHold(
  registry: HoldRegistry,
  state: ShellKeyState,
  hold: ShellHold,
  left: unknown,
): void {
  if (!hold.tracker.armed || !typedTargets.has(hold) || typedTargets.get(hold) !== left) return;
  cancelShellHold(registry, state, hold);
}

/** Deletes the character before the caret in the focused field, as Backspace would, so a controlled field hears it. */
export function removeTypedCharacter(): void {
  if (typeof document === 'undefined') return;
  document.execCommand('delete');
}

function thresholdOf(state: ShellKeyState): number {
  return state.prefs?.holdThresholdMs ?? DEFAULT_KEY_PREFS.holdThresholdMs;
}

function domHold(thresholdMs: number, readState: () => ShellKeyState): ShellHold {
  return {
    tracker: createHoldTracker(thresholdMs),
    now: () => performance.now(),
    schedule(ms, callback) {
      const id = window.setTimeout(callback, ms);
      return () => window.clearTimeout(id);
    },
    readState,
    focused: activeElement,
    removeTyped: removeTypedCharacter,
  };
}

/** The DOM hold, rebuilt when the threshold setting changes while nothing is armed. */
function holdSource(readState: () => ShellKeyState): () => ShellHold {
  let threshold = thresholdOf(readState());
  let hold = domHold(threshold, readState);
  return () => {
    const wanted = thresholdOf(readState());
    if (wanted === threshold || hold.tracker.armed) return hold;
    threshold = wanted;
    hold = domHold(wanted, readState);
    return hold;
  };
}

/** Binds keydown, keyup, blur and hide on the window; returns the unbind. Repeats are swallowed in the capture phase. */
function listenShellKeys(registry: HoldRegistry, readState: () => ShellKeyState): () => void {
  const holds = holdSource(readState);
  const onRepeat = (event: KeyboardEvent) => {
    if (!holds().tracker.swallows(event)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // Tab/Shift+Tab are the region cycle (regions.ts): they move between the window's regions
    // before the registry sees them, except inside fields, overlays and the sealed frame.
    if (handleRegionTab(event, { overlays: target => regionTabOverlays(readState(), target) })) {
      event.preventDefault();
      return;
    }
    if (dispatchShellKey(registry, readState(), event, holds())) event.preventDefault();
  };
  const onKeyUp = (event: KeyboardEvent) => releaseShellKey(registry, readState(), event, holds());
  const onBlur = () => cancelShellHold(registry, readState(), holds());
  const onFocusOut = (event: FocusEvent) =>
    focusLeftShellHold(registry, readState(), holds(), event.target);
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') onBlur();
  };
  const untrackRegions = trackRegionFocus(document);
  window.addEventListener('keydown', onRepeat, true);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('focusout', onFocusOut, true);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    untrackRegions();
    window.removeEventListener('keydown', onRepeat, true);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('focusout', onFocusOut, true);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibility);
    onBlur();
  };
}

/**
 * Listens on the window for the shell's lifetime; reads the latest state through a ref, so the listener binds once.
 * One hold tracker follows held keys (threshold from the key prefs). Inert without a DOM.
 */
export function useShellKeys(registry: HoldRegistry, readState: () => ShellKeyState): void {
  const latest = useRef(readState);
  useEffect(() => {
    latest.current = readState;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    return listenShellKeys(registry, () => latest.current());
  }, [registry]);
}
