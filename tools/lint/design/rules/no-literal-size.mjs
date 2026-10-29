// DESIGN 4.3, 4.4, 4.5, 4.6 and 12.2: spacing, type size, radius, shadow and
// z-index come from tokens. Allowed literals: 0, 1px hairlines (spacing, gap,
// shadow), 100% (not radius), auto, normal, and unitless multipliers inside
// calc()/min()/max()/clamp().

import { collectDecls } from '../lib/decls.mjs';
import { COLOR_FUNCTIONS } from '../lib/colors.mjs';
import { violation } from '../lib/context.mjs';
import { sizeKind } from '../lib/props.mjs';
import { isDynamic, parseNumber, parseValue } from '../lib/value.mjs';

export const id = 'no-literal-size';
export const description =
  'padding, margin, gap, font-size, line-height, font, letter-spacing, border-radius, box-shadow and z-index take var(--token) values; only 0, 1px hairlines, 100%, auto and normal are literal.';
export const appliesTo = ['css', 'ts'];

const HINTS = {
  spacing: 'var(--space-*)',
  gap: 'var(--space-*)',
  fontSize: 'a type role, font: var(--type-*)',
  lineHeight: 'a type role, font: var(--type-*)',
  font: 'font: var(--type-*)',
  letterSpacing: 'var(--track-*)',
  radius: 'var(--radius-*)',
  shadow: 'var(--elev-*)',
  zIndex: 'a layer token such as var(--z-*)',
};

const GLOBAL_WORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);
const STRICT_WORDS = {
  fontSize: new Set(),
  lineHeight: new Set(['normal']),
  font: new Set(['normal']),
  letterSpacing: new Set(['normal']),
  radius: new Set(),
  zIndex: new Set(['auto']),
};
const HAIRLINE_KINDS = new Set(['spacing', 'gap', 'shadow']);
const IGNORED_FUNCTIONS = new Set(['env', 'url', 'color-mix', ...COLOR_FUNCTIONS]);

function isAllowedTopLevelNumber(number, kind) {
  if (number.value === 0) return true;
  if (HAIRLINE_KINDS.has(kind) && Math.abs(number.value) === 1 && number.unit === 'px') return true;
  return number.unit === '%' && number.value === 100 && kind !== 'radius';
}

function isAllowedMathNumber(number) {
  if (number.value === 0 || number.unit === '') return true;
  if (Math.abs(number.value) === 1 && number.unit === 'px') return true;
  return number.unit === '%' && number.value === 100;
}

function mathProblems(nodes, problems) {
  for (const node of nodes) {
    if (node.type === 'word') {
      const number = parseNumber(node.text);
      if (number && !isAllowedMathNumber(number)) problems.push(node.text);
    } else if (node.type === 'fn') {
      functionProblems(node, null, problems);
    }
  }
}

// calc(), min(), max(), clamp() and any other function: literals must be multipliers.
function functionProblems(fn, kind, problems) {
  const name = fn.name.toLowerCase();
  if (IGNORED_FUNCTIONS.has(name)) return;
  if (name === 'var') {
    for (const arg of fn.args.slice(1)) nodeProblems(arg, kind, problems);
    return;
  }
  for (const arg of fn.args) mathProblems(arg, problems);
}

function nodeProblems(nodes, kind, problems) {
  for (const node of nodes) {
    if (node.type === 'fn') {
      functionProblems(node, kind, problems);
      continue;
    }
    if (node.type !== 'word' || isDynamic(node.text)) continue;
    const word = node.text.toLowerCase();
    if (GLOBAL_WORDS.has(word)) continue;
    const number = parseNumber(node.text);
    if (number) {
      if (!isAllowedTopLevelNumber(number, kind)) problems.push(node.text);
    } else if (STRICT_WORDS[kind] && !STRICT_WORDS[kind].has(word)) {
      problems.push(node.text);
    }
  }
}

function valueProblems(kind, value, numeric) {
  const problems = [];
  if (numeric) {
    const number = parseNumber(value);
    if (number && !isAllowedTopLevelNumber({ value: number.value, unit: 'px' }, kind))
      problems.push(`${value}`);
    return problems;
  }
  nodeProblems(parseValue(value), kind, problems);
  return problems;
}

export function check(ctx) {
  const out = [];
  for (const decl of collectDecls(ctx)) {
    const kind = sizeKind(decl.prop);
    if (!kind) continue;
    if (decl.numeric && !decl.styleContext) continue;
    const problems = valueProblems(kind, decl.value, decl.numeric);
    if (problems.length === 0) continue;
    const literal = decl.numeric ? `${decl.value} (a number is px)` : problems.join(' ');
    out.push(
      violation(
        decl.line,
        decl.column,
        `${decl.prop} uses the literal ${literal}. Use ${HINTS[kind]} (DESIGN 4.3-4.6).`,
        decl.node,
      ),
    );
  }
  return out;
}

export default { id, description, appliesTo, check };
