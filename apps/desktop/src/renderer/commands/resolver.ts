// The pure key resolver (plan 30 §4.2; DESIGN §5 rules 1 and 16, §8).
// It decides which command a keydown means. It never touches the DOM and never
// runs anything; the shell's capture listener calls it and acts on the answer.
import { chordFromEvent, chordId, isCharacterChord, isTextEditingChord } from './keys';
import type {
  Binding,
  CommandId,
  ContextName,
  ContextStack,
  FocusKind,
  KeyChord,
  KeyInput,
  KeyPrefs,
  Resolution,
} from './types';

/**
 * Contexts whose keys are active only while that widget has focus. WCAG 2.1.4
 * exempts such shortcuts, so the single-key switch leaves them on (a menu's 1–9).
 */
export const FOCUS_SCOPED_CONTEXTS: readonly ContextName[] = ['palette', 'menu', 'datePicker', 'dialog'];

export interface ResolveOptions {
  /** What has focus. Defaults to 'none'. */
  readonly focus?: FocusKind;
  /**
   * The command's runtime gate (`onlyWhen` plus `when`). Disabled commands let
   * outer contexts answer. Without it, guarded bindings count as unmet.
   */
  readonly isEnabled?: (commandId: CommandId) => boolean;
}

function usableInFocus(binding: Binding, chord: KeyChord, focus: FocusKind): boolean {
  if (binding.inTextField) return true;
  if (focus === 'text') {
    if (chord.key === 'Escape') return true;
    if (!chord.meta && !chord.ctrl) return false;
    return !isTextEditingChord(chord);
  }
  if (focus === 'control') {
    // Plain Space and Return press the focused button; any modifier makes it a shortcut (⇧Return confirms).
    const activates = (chord.key === 'Space' || chord.key === 'Enter') && !chord.meta && !chord.ctrl && !chord.alt && !chord.shift;
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
  const singleKeyOff = !prefs.singleKeyShortcuts && isCharacterChord(chord);
  if (singleKeyOff && !binding.inTextField && !FOCUS_SCOPED_CONTEXTS.includes(binding.context)) return false;
  if (event.repeat && !binding.repeat) return false;
  if (binding.commandId === null) return true;
  if (!options.isEnabled) return !binding.guarded;
  return options.isEnabled(binding.commandId);
}

function preferGuarded(candidates: readonly Binding[]): Binding | undefined {
  return candidates.find((b) => b.guarded) ?? candidates[0];
}

/**
 * Walks the stack from the innermost context outward. The first context that
 * either blocks the chord or has a usable binding for it decides. Within one
 * context a guarded binding (an `onlyWhen` command that is enabled) beats an
 * unguarded one. Returns null to let the key through untouched.
 *
 * Rules: nothing while composing (IME); single-key shortcuts are off in text
 * fields and when prefs.singleKeyShortcuts is false; Space and Return on a
 * focused button belong to the button; auto-repeat only runs movement.
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
  const matching = bindings.filter((b) => chordId(b.chord) === id);
  if (matching.length === 0) return null;
  for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
    const context = stack[depth];
    const here = matching.filter((b) => b.context === context);
    if (here.some((b) => b.commandId === null)) return null;
    const live = here.filter((b) => usable(b, chord, event, prefs, options));
    const tap = preferGuarded(live.filter((b) => b.phase === 'tap'));
    const hold = preferGuarded(live.filter((b) => b.phase === 'hold'));
    if (tap?.commandId) {
      const holdCommandId = hold?.commandId ?? undefined;
      return holdCommandId
        ? { commandId: tap.commandId, phase: 'tap', holdCommandId, context, chord }
        : { commandId: tap.commandId, phase: 'tap', context, chord };
    }
    if (hold?.commandId) return { commandId: hold.commandId, phase: 'hold', context, chord };
  }
  return null;
}
