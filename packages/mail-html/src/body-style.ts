import { TokenType, type CSSToken } from '@csstools/css-tokenizer';
import { asciiLower } from './parse';

// What the frame body's own `style` attribute may set. An element's style attribute outranks every
// cascade layer, so the body's carries only its look: colours, margins, padding and type, by explicit
// name (an unknown property under a known prefix, today's or tomorrow's, is left out). The font size
// and the line height are bounded too, so a huge type size set here stays reasonable. That is a bound on
// this attribute only: a `<style>` rule can still set `body{font-size:900px}` (the reading layer does not
// guard the font size, which changes every em and rem in the letter). It is a tall letter, not a runaway.

const SIDES = ['top', 'right', 'bottom', 'left', 'block', 'block-start', 'block-end'];
const INLINE = ['inline', 'inline-start', 'inline-end'];

export const BODY_STYLE_PROPERTIES: ReadonlySet<string> = new Set([
  'background',
  'background-color',
  'background-image',
  'background-repeat',
  'background-position',
  'background-size',
  'background-attachment',
  'background-origin',
  'background-clip',
  'color',
  'margin',
  'padding',
  ...[...SIDES, ...INLINE].flatMap(side => [`margin-${side}`, `padding-${side}`]),
  'font',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'font-variant',
  'line-height',
  'text-align',
]);

/** The largest font size or line height the body may set, in px (a 16 px em), and the largest unitless line height. */
const MAX_TYPE_PX = 200;
const MAX_LINE_HEIGHT_NUMBER = 10;
const PX_PER_UNIT: Record<string, number> = {
  px: 1,
  pt: 4 / 3,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  q: 96 / 101.6,
  em: 16,
  rem: 16,
  ex: 16,
  ch: 16,
  lh: 16,
  rlh: 16,
};

/** Whether the body's style may carry this declaration: the name is listed and a bounded value is small. */
export function keepsBodyDeclaration(name: string, value: readonly CSSToken[]): boolean {
  if (!BODY_STYLE_PROPERTIES.has(name)) return false;
  if (name === 'font-size' || name === 'line-height' || name === 'font')
    return typeIsBounded(name, value);
  return true;
}

function typeIsBounded(name: string, value: readonly CSSToken[]): boolean {
  let previous: CSSToken | undefined;
  for (const token of value) {
    const type = token[0];
    if (type === TokenType.Function) return false;
    if (type === TokenType.Dimension && !lengthFits(token[4].value, token[4].unit)) return false;
    // A percentage of the font size (or of the parent's) is a multiple of 16 px.
    if (type === TokenType.Percentage && (token[4].value * 16) / 100 > MAX_TYPE_PX) return false;
    if (
      type === TokenType.Number &&
      token[4].value > MAX_LINE_HEIGHT_NUMBER &&
      numberIsLineHeight(name, previous)
    )
      return false;
    if (type !== TokenType.Whitespace && type !== TokenType.Comment) previous = token;
  }
  return true;
}

/** `line-height: 40` is a multiple; in the `font` shorthand only the number after the `/` is. */
function numberIsLineHeight(name: string, previous: CSSToken | undefined): boolean {
  if (name === 'line-height') return true;
  return name === 'font' && previous?.[0] === TokenType.Delim && previous[4].value === '/';
}

function lengthFits(value: number, unit: string): boolean {
  const perUnit = PX_PER_UNIT[asciiLower(unit)];
  return perUnit !== undefined && Math.abs(value) * perUnit <= MAX_TYPE_PX;
}
