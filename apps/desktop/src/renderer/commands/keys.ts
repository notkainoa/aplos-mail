// Chords: parse spec strings, normalize KeyboardEvents, format for Kbd, tooltips,
// the sheet and toasts. Pure; reads event.key, never keyCode (DESIGN §5 rule 16).
import type { FocusKind, KeyChord, KeyInput, Phase } from './types';

const MODIFIER_WORDS: Readonly<Record<string, 'meta' | 'ctrl' | 'alt' | 'shift'>> = {
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
};

const NAMED_KEYS: Readonly<Record<string, string>> = {
  ' ': 'Space',
  space: 'Space',
  spacebar: 'Space',
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  home: 'Home',
  end: 'End',
};

/** Keys that never form a chord on their own. 'Process' is an IME keydown. */
const IGNORED_KEYS = new Set([
  'Shift',
  'Control',
  'Alt',
  'AltGraph',
  'Meta',
  'OS',
  'Super',
  'Hyper',
  'Fn',
  'FnLock',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Process',
  'Compose',
  'Unidentified',
]);

/** The order of modifiers in chord ids ("alt+meta+l"). Internal only; never shown. */
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift', 'meta'] as const;

/**
 * The order keycaps are drawn in. DESIGN §8 and the mockups write ⌘ first
 * (⌘⌥L, ⌘⇧Return, ⌘⇧C); macOS menus put ⌘ last. DESIGN wins until the owner
 * changes it there.
 */
const DISPLAY_ORDER = ['meta', 'ctrl', 'alt', 'shift'] as const;

const MODIFIER_GLYPHS: Readonly<Record<(typeof MODIFIER_ORDER)[number], string>> = {
  ctrl: '⌃',
  alt: '⌥',
  shift: '⇧',
  meta: '⌘',
};

const KEY_GLYPHS: Readonly<Record<string, string>> = {
  Space: 'Space',
  Enter: 'Return',
  Escape: 'Esc',
  Tab: 'Tab',
  Backspace: '⌫',
  Delete: '⌦',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Home: 'Home',
  End: 'End',
};

/** Chords that edit text; inside a field they belong to the field unless a binding owns them. */
const TEXT_EDITING_CHORDS = new Set([
  'meta+a',
  'meta+c',
  'meta+v',
  'meta+x',
  'meta+z',
  'shift+meta+z',
  'meta+ArrowLeft',
  'meta+ArrowRight',
  'meta+ArrowUp',
  'meta+ArrowDown',
  'shift+meta+ArrowLeft',
  'shift+meta+ArrowRight',
  'shift+meta+ArrowUp',
  'shift+meta+ArrowDown',
  'meta+Backspace',
  'meta+Delete',
  'ctrl+a',
  'ctrl+b',
  'ctrl+d',
  'ctrl+e',
  'ctrl+f',
  'ctrl+h',
  'ctrl+k',
  'ctrl+l',
  'ctrl+n',
  'ctrl+o',
  'ctrl+p',
  'ctrl+t',
  'ctrl+v',
  'ctrl+y',
]);

/** Chords macOS or the app menu own (quit, close, hide, minimise, settings, app and window switching, screenshots, full screen). */
const SYSTEM_CHORDS = new Set([
  'meta+q',
  'meta+w',
  'meta+h',
  'alt+meta+h',
  'meta+m',
  'meta+,',
  'meta+Tab',
  'shift+meta+Tab',
  'meta+`',
  'meta+Space',
  'ctrl+meta+Space',
  'ctrl+meta+q',
  'ctrl+meta+f',
  'alt+meta+d',
  'alt+meta+Escape',
  'shift+meta+3',
  'shift+meta+4',
  'shift+meta+5',
]);

/** Chords the window's region navigation owns (shell/regions.ts): the registry never sees them. */
const REGION_CHORDS = new Set(['Tab', 'shift+Tab']);

/**
 * Chords no remap may take, as canonical spec strings ("meta+c"): text editing
 * (⌘C, ⌘V, ⌘X, ⌘A, ⌘Z, ⌘⇧Z, the ⌃ Emacs keys…), the system's (⌘Q, ⌘W, ⌘H, ⌘M,
 * ⌘,, ⌘Tab…) and the region cycle's (Tab, ⇧Tab). A command may keep one that is
 * its own default (⌘A Select all, ⌘, Settings, Tab Keep suggestion).
 */
export const RESERVED_CHORDS: readonly string[] = [
  ...TEXT_EDITING_CHORDS,
  ...SYSTEM_CHORDS,
  ...REGION_CHORDS,
];

/**
 * Why a chord is reserved, or null: 'text' edits text in a field, 'system' belongs to macOS or the
 * app menu, 'navigation' is the shell's region Tab.
 */
export function reservedReason(chord: KeyChord): 'text' | 'system' | 'navigation' | null {
  const id = chordId(chord);
  if (TEXT_EDITING_CHORDS.has(id)) return 'text';
  if (REGION_CHORDS.has(id)) return 'navigation';
  return SYSTEM_CHORDS.has(id) ? 'system' : null;
}

function isSingleChar(key: string): boolean {
  return [...key].length === 1;
}

function isLetter(key: string): boolean {
  return /^\p{L}$/u.test(key);
}

function isDigit(key: string): boolean {
  return /^[0-9]$/.test(key);
}

/**
 * Shift is part of the chord for letters and named keys, and for digits under
 * ⌘ or ⌃ (⌃⇧1 is not ⌃1). A symbol carries shift in the character itself.
 */
function shiftMatters(key: string, meta: boolean, ctrl: boolean): boolean {
  return !isSingleChar(key) || isLetter(key) || (isDigit(key) && (meta || ctrl));
}

/** The canonical key name, or null for keys that cannot be bound. */
export function canonicalKey(key: string): string | null {
  const named = NAMED_KEYS[key.toLowerCase()];
  if (named) return named;
  if (isSingleChar(key)) return key.toLowerCase();
  if (/^F([1-9]|1[0-9]|20)$/.test(key)) return key;
  return null;
}

/** Applies the shift rule (see shiftMatters). */
export function normalizeChord(chord: KeyChord): KeyChord {
  const key = canonicalKey(chord.key) ?? chord.key;
  return {
    key,
    meta: chord.meta,
    ctrl: chord.ctrl,
    alt: chord.alt,
    shift: shiftMatters(key, chord.meta, chord.ctrl) && chord.shift,
  };
}

function splitChord(text: string): string[] {
  if (text === '+') return ['+'];
  if (text.endsWith('++')) return [...text.slice(0, -2).split('+'), '+'];
  return text.split('+');
}

/** Parses "meta+k", "shift+r", "alt+ArrowDown", "?", "Space". Throws on anything ambiguous. */
export function parseChord(text: string): KeyChord {
  const trimmed = text.trim();
  if (trimmed === '') throw new Error('Empty chord');
  const parts = splitChord(trimmed);
  const rawKey = parts.pop() ?? '';
  const chord = { key: '', meta: false, ctrl: false, alt: false, shift: false };
  for (const part of parts) {
    const modifier = MODIFIER_WORDS[part.toLowerCase()];
    if (!modifier)
      throw new Error(`Unknown modifier "${part}" in "${text}" (use meta, ctrl, alt or shift)`);
    chord[modifier] = true;
  }
  const key = canonicalKey(rawKey);
  if (key === null) throw new Error(`Unknown key "${rawKey}" in "${text}"`);
  if (chord.shift && !shiftMatters(key, chord.meta, chord.ctrl)) {
    throw new Error(`Write the shifted symbol itself, not shift+"${key}", in "${text}"`);
  }
  return normalizeChord({ ...chord, key });
}

/** 'KeyL' → 'l', 'Digit5' → '5'. */
function codeCharacter(code: string | undefined): string | null {
  if (!code) return null;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  const digit = /^Digit([0-9])$/.exec(code);
  return digit ? digit[1] : null;
}

function isPrintableAscii(key: string): boolean {
  return /^[\x20-\x7e]$/.test(key);
}

/**
 * Normalizes a keydown. Caps Lock is ignored (letters are lower-cased and shift
 * comes from shiftKey). On a letter key, Option-composed characters ("¬" for ⌥L),
 * dead keys and non-Latin layouts fall back to the physical letter, so ⌘⌥L works
 * everywhere. The digit row falls back to the physical digit only under ⌘ or ⌃
 * (⌃1 on AZERTY), keeping shift; without them a digit-row key is whatever it
 * types, so German ⇧3 ("§") and AZERTY "é" are not 3 and 2.
 * Returns null during IME composition and for lone modifiers.
 */
export function chordFromEvent(event: KeyInput): KeyChord | null {
  if (event.isComposing || event.key === 'Process') return null;
  let key = event.key;
  const physical = codeCharacter(event.code);
  if (physical && isLetter(physical)) {
    const composed = key === 'Dead' || (isSingleChar(key) && !isPrintableAscii(key));
    if (composed) key = physical;
  }
  if (physical && isDigit(physical) && (event.metaKey || event.ctrlKey)) key = physical;
  if (key === 'Dead' || IGNORED_KEYS.has(key)) return null;
  const canonical = canonicalKey(key);
  if (canonical === null) return null;
  return normalizeChord({
    key: canonical,
    meta: event.metaKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
  });
}

/** A stable id for lookups: "ctrl+alt+shift+meta+key" with absent modifiers left out. */
export function chordId(chord: KeyChord): string {
  const prefix = MODIFIER_ORDER.filter(m => chord[m])
    .map(m => `${m}+`)
    .join('');
  return `${prefix}${chord.key}`;
}

export function sameChord(a: KeyChord, b: KeyChord): boolean {
  return chordId(a) === chordId(b);
}

/** An unmodified character key (letter, digit, symbol; shift allowed). WCAG 2.1.4 calls these single-key shortcuts. */
export function isCharacterChord(chord: KeyChord): boolean {
  return isSingleChar(chord.key) && !chord.meta && !chord.ctrl && !chord.alt;
}

export function isTextEditingChord(chord: KeyChord): boolean {
  return TEXT_EDITING_CHORDS.has(chordId(chord));
}

/**
 * The physical key a hold is tracked by, with modifiers left out: 'r' for R, ⇧R
 * and ⌘R alike, 'Space' for the space bar. Pressing or releasing ⇧ mid-hold
 * cannot strand a running dictation.
 */
export function holdKeyOf(event: KeyInput): string {
  const physical = codeCharacter(event.code);
  if (physical) return physical;
  return canonicalKey(event.key) ?? event.key;
}

/** "⌘K", "⌃1", "⇧A", "⌥↓", "⌘⌥L", "⌘⇧Return", "Space", "Return", "Esc". */
export function formatChord(chord: KeyChord): string {
  const modifiers = DISPLAY_ORDER.filter(m => chord[m])
    .map(m => MODIFIER_GLYPHS[m])
    .join('');
  const glyph =
    KEY_GLYPHS[chord.key] ?? (isLetter(chord.key) ? chord.key.toUpperCase() : chord.key);
  return `${modifiers}${glyph}`;
}

export interface Bindable {
  readonly chord: KeyChord;
  readonly phase: Phase;
}

/** "⌘K", or "Hold R" for a hold binding. */
export function formatBinding(binding: Bindable): string {
  const text = formatChord(binding.chord);
  return binding.phase === 'hold' ? `Hold ${text}` : text;
}

function digitRange(bindings: readonly Bindable[]): string | null {
  if (bindings.length < 3) return null;
  const first = bindings[0];
  const digits: number[] = [];
  for (const b of bindings) {
    if (b.phase !== 'tap' || !isDigit(b.chord.key)) return null;
    if (chordId({ ...b.chord, key: '0' }) !== chordId({ ...first.chord, key: '0' })) return null;
    digits.push(Number(b.chord.key));
  }
  const consecutive = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  if (!consecutive) return null;
  const prefix = formatChord({ ...first.chord, key: '' });
  return `${prefix}${digits[0]}–${digits[digits.length - 1]}`;
}

const ARROW_KEY = /^[←→↑↓]$/u;

/** One notation for a key pair everywhere (menus, palette, Settings, the sheet, tooltips): the arrow first, then the letter. */
export function arrowsFirst(texts: readonly string[]): string[] {
  return [...texts.filter(t => ARROW_KEY.test(t)), ...texts.filter(t => !ARROW_KEY.test(t))];
}

/** Alternatives joined with "or", the arrow first ("↓ or J", "→ or E"); a run of digits reads "1–9". */
export function formatAlternatives(bindings: readonly Bindable[]): string {
  const range = digitRange(bindings);
  if (range) return range;
  const seen: string[] = [];
  for (const b of bindings) {
    const text = formatBinding(b);
    if (!seen.includes(text)) seen.push(text);
  }
  return arrowsFirst(seen).join(' or ');
}

interface FocusLike {
  readonly tagName?: string;
  readonly isContentEditable?: boolean;
  readonly type?: string;
  getAttribute?(name: string): string | null;
}

const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'radio',
  'submit',
  'reset',
  'range',
  'color',
  'file',
  'image',
]);

const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox']);
const CONTROL_ROLES = new Set(['button', 'checkbox', 'switch', 'radio', 'tab', 'link', 'menuitem']);

/** Classifies event.target or document.activeElement without touching the DOM API beyond reading. */
export function focusKindOf(target: unknown): FocusKind {
  if (!target || typeof target !== 'object') return 'none';
  const el = target as FocusLike;
  if (el.isContentEditable) return 'text';
  const tag = (el.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA') return 'text';
  if (tag === 'INPUT')
    return NON_TEXT_INPUTS.has((el.type ?? 'text').toLowerCase()) ? 'control' : 'text';
  if (tag === 'SELECT' || tag === 'BUTTON' || tag === 'A') return 'control';
  const role = el.getAttribute?.('role') ?? '';
  if (TEXT_ROLES.has(role)) return 'text';
  if (CONTROL_ROLES.has(role)) return 'control';
  return 'none';
}

export interface KeySnapshot extends KeyInput {
  /** Milliseconds, from event.timeStamp or performance.now(). */
  readonly at: number;
  readonly focus: FocusKind;
}

/** A plain copy of a keydown, safe to queue and replay after the event has gone. */
export function snapshotKey(event: KeyInput, at: number, focus: FocusKind): KeySnapshot {
  return {
    key: event.key,
    code: event.code,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    isComposing: event.isComposing ?? false,
    repeat: event.repeat ?? false,
    at,
    focus,
  };
}
