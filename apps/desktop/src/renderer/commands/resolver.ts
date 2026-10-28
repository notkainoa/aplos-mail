// The pure key resolver (plan 30 §4.2; DESIGN §5 rules 1 and 16, §8).
// It decides which command a keydown means. It never touches the DOM and never
// runs anything; the shell's capture listener calls it (through the registry)
// and acts on the answer.
import { chordFromEvent, chordId, isCharacterChord, isTextEditingChord } from './keys';
import { isModal } from './stacks';
import {
  CONDITION_PRIORITY,
  type Binding,
  type CommandId,
  type ContextStack,
  type FocusKind,
  type KeyChord,
  type KeyInput,
  type KeyPrefs,
  type Resolution,
} from './types';

export interface ResolveOptions {
  /** What has focus. Defaults to 'none'. */
  readonly focus?: FocusKind;
  /**
   * The command's runtime gate (`onlyWhen`, `when`, context disables). Disabled
   * commands let outer contexts answer. Without it, guarded bindings count as unmet.
   */
  readonly isEnabled?: (commandId: CommandId) => boolean;
}

/**
 * The text-field rule. `inTextField` lets a binding own its key inside the
 * focused field (⌘Return Send, hold A in Ask's field); it never touches the
 * WCAG single-key switch, which `usable` applies separately.
 */
function usableInFocus(binding: Binding, chord: KeyChord, focus: FocusKind): boolean {
  if (binding.inTextField) return true;
  if (focus === 'text') {
    if (chord.key === 'Escape') return true;
    if (!chord.meta && !chord.ctrl) return false;
    return !isTextEditingChord(chord);
  }
  if (focus === 'control') {
    // Plain Space and Return press the focused button; any modifier makes it a shortcut (⇧Return confirms).
    const activates =
      (chord.key === 'Space' || chord.key === 'Enter') &&
      !chord.meta &&
      !chord.ctrl &&
      !chord.alt &&
      !chord.shift;
    return !activates;
  }
  return true;
}

function usable(
  binding: Binding,
  chord: KeyChord,
  event: KeyInput,
  prefs: KeyPrefs,
  options: ResolveOptions,
): boolean {
  if (!usableInFocus(binding, chord, options.focus ?? 'none')) return false;
  // WCAG 2.1.4: with the switch off, every character chord is off unless its widget has focus.
  if (!prefs.singleKeyShortcuts && isCharacterChord(chord) && !isModal(binding.context))
    return false;
  if (event.repeat && !binding.repeat) return false;
  if (!options.isEnabled) return binding.onlyWhen === undefined;
  return options.isEnabled(binding.commandId);
}

function rank(binding: Binding): number {
  return binding.onlyWhen === undefined
    ? CONDITION_PRIORITY.length
    : CONDITION_PRIORITY.indexOf(binding.onlyWhen);
}

/** The guarded binding with the highest-priority condition, else the unguarded one. */
export function pickBinding(candidates: readonly Binding[]): Binding | undefined {
  let best: Binding | undefined;
  for (const b of candidates) {
    if (!best || rank(b) < rank(best)) best = b;
  }
  return best;
}

/**
 * Walks the stack from the innermost context outward. The first context with a
 * usable binding for the chord decides; a modal context (palette, menu, date
 * picker, dialog, Low-importance sheet) ends the walk even when it has none.
 * Within one context the highest-priority live guard wins (CONDITION_PRIORITY).
 * A hold rides along with a tap only when it is that tap's partner (`holdFor`).
 * Returns null to let the key through untouched.
 *
 * Rules: nothing while composing (IME); single-key shortcuts are off in text
 * fields unless the binding owns the field, and off everywhere but focused
 * widgets when prefs.singleKeyShortcuts is false; Space and Return on a focused
 * button belong to the button; auto-repeat only runs movement.
 * Pass a normalized stack (buildStack); the registry does this for you.
 */
export function resolve(
  event: KeyInput,
  stack: ContextStack,
  bindings: readonly Binding[],
  prefs: KeyPrefs,
  options: ResolveOptions = {},
): Resolution | null {
  const chord = chordFromEvent(event);
  if (!chord) return null;
  const id = chordId(chord);
  const matching = bindings.filter(b => chordId(b.chord) === id);
  for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
    const context = stack[depth];
    const live = matching.filter(
      b => b.context === context && usable(b, chord, event, prefs, options),
    );
    const tap = pickBinding(live.filter(b => b.phase === 'tap'));
    const hold = pickBinding(live.filter(b => b.phase === 'hold'));
    if (tap) {
      return hold && hold.holdFor === tap.commandId
        ? { commandId: tap.commandId, phase: 'tap', holdCommandId: hold.commandId, context, chord }
        : { commandId: tap.commandId, phase: 'tap', context, chord };
    }
    if (hold) return { commandId: hold.commandId, phase: 'hold', context, chord };
    if (isModal(context)) return null;
  }
  return null;
}
