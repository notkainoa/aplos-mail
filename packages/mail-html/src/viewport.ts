import { asciiLower } from './parse';

// Viewport length units that follow the frame's height become fixed lengths. The host sizes the frame to the letter,
// and the letter lays out in that frame, so `height:100vh` would grow the frame, which grows the letter, without end.
// Only lengths: writing modes and media or container queries can still follow the frame (css.ts, the host's fence).
// Every height-axis unit is read against a fixed 800 px viewport height; `vw` and `vi` follow the width and stay.
// The min and max units become `calc(N*min(1vw,8px))` (or `max`), which is exact for negative N too. Container
// units count: with no size container in the mail they fall back to the small viewport's units.

/** The fixed viewport height the rewritten units are read against, in px per unit (800 px / 100). */
export const FIXED_PX_PER_UNIT = 8;

/** Units of the viewport's (or a container's) height or block axis. */
const HEIGHT_UNITS: ReadonlySet<string> = new Set([
  'vh',
  'dvh',
  'svh',
  'lvh',
  'vb',
  'dvb',
  'svb',
  'lvb',
  'cqh',
  'cqb',
]);

/** The smaller or larger of width and height: the unit, the comparison and the width unit it keeps. */
const MIN_MAX_UNITS: ReadonlyMap<string, { pick: 'min' | 'max'; width: string }> = new Map([
  ['vmin', { pick: 'min', width: 'vw' }],
  ['dvmin', { pick: 'min', width: 'dvw' }],
  ['svmin', { pick: 'min', width: 'svw' }],
  ['lvmin', { pick: 'min', width: 'lvw' }],
  ['cqmin', { pick: 'min', width: 'cqi' }],
  ['vmax', { pick: 'max', width: 'vw' }],
  ['dvmax', { pick: 'max', width: 'dvw' }],
  ['svmax', { pick: 'max', width: 'svw' }],
  ['lvmax', { pick: 'max', width: 'lvw' }],
  ['cqmax', { pick: 'max', width: 'cqi' }],
]);

/** A CSS number as text: at most 12 significant digits, exponent form when the browser would read one. */
function cssNumber(value: number): string {
  return String(Number(value.toPrecision(12)));
}

/**
 * What a dimension token is written as: a fixed length for a height-axis unit, a `calc()` for the min and max
 * units, `undefined` for any other unit (the token stays as written), and `null` (drop it) when the rewritten
 * number would not be finite.
 */
export function fixedViewportLength(value: number, unit: string): string | null | undefined {
  const lower = asciiLower(unit);
  const pair = MIN_MAX_UNITS.get(lower);
  if (!HEIGHT_UNITS.has(lower) && !pair) return undefined;
  if (!Number.isFinite(value * FIXED_PX_PER_UNIT)) return null;
  if (!pair) return `${cssNumber(value * FIXED_PX_PER_UNIT)}px`;
  return `calc(${cssNumber(value)}*${pair.pick}(1${pair.width},${FIXED_PX_PER_UNIT}px))`;
}
