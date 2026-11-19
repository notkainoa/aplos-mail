// DESIGN 4.1 rule "No raw colour in components" and 12.2 "No raw colour".

import ts from 'typescript';
import { nameOfProperty, unwrap } from '../lib/ast.mjs';
import { collectDecls, forEachString } from '../lib/decls.mjs';
import { COLOR_FUNCTIONS, NAMED_COLORS } from '../lib/colors.mjs';
import { violation } from '../lib/context.mjs';
import { isColorProp } from '../lib/props.mjs';
import { parseValue, walkNodes } from '../lib/value.mjs';

export const id = 'no-raw-color';
export const description =
  'Colours come from var(--token) only: no hex, rgb(), hsl(), oklch() and friends, no named colours, no literal colour in color-mix().';
export const appliesTo = ['css', 'ts'];

const HEX_WORD = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const STRING_HEX =
  /(?<![\w&#])(?<!url\()#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})(?![\w-])/gi;
// A '#' followed by hex-looking text is a colour unless the string is plainly
// an anchor, an id lookup or an issue reference.
const ISSUE_PREFIX =
  /(?:\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?|see|issue|issues|pr|ref|refs|via)\s*|[-/?=&])$/i;
const NON_COLOR_ATTRIBUTES = /^(href|to|src|id|htmlFor|for|name|key|target|data-.*)$/;
const NON_COLOR_KEYS = /^(href|to|url|hash|id|anchor|selector|target|key)$/i;
const SELECTOR_CALLS =
  /^(querySelector|querySelectorAll|closest|matches|getElementById|scrollIntoView)$/;

function isAnchorContext(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isBinaryExpression(parent) && /^(===|!==|==|!=)$/.test(parent.operatorToken.getText())) {
    const other = unwrap(parent.left === node ? parent.right : parent.left);
    return /hash|href|anchor/i.test(other.getText());
  }
  if (ts.isJsxAttribute(parent)) return NON_COLOR_ATTRIBUTES.test(parent.name.getText());
  if (ts.isJsxExpression(parent) && parent.parent && ts.isJsxAttribute(parent.parent))
    return NON_COLOR_ATTRIBUTES.test(parent.parent.name.getText());
  if (ts.isPropertyAssignment(parent))
    return NON_COLOR_KEYS.test(nameOfProperty(parent.name) || '');
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression;
    const name = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ts.isIdentifier(callee)
        ? callee.text
        : '';
    return SELECTOR_CALLS.test(name);
  }
  return false;
}

function hexMatches(text) {
  return [...text.matchAll(STRING_HEX)].filter(
    match => !ISSUE_PREFIX.test(text.slice(0, match.index)),
  );
}

const STRING_COLOR_FN =
  /(?<![\w-])(?:rgba?|hsla?|hwb|oklab|oklch|lab|lch)\(\s*(?:[\d.+-]|from\b|var\(|none\b|calc\(|)|(?<![\w-])(?:rgba?|hsla?)\($|(?<![\w-])color\(\s*(?:srgb|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|from\b|var\()/gi;

function colorMixLiterals(text) {
  const found = [];
  const pattern = /color-mix\(/gi;
  let match = pattern.exec(text);
  while (match) {
    const nodes = parseValue(text.slice(match.index));
    walkNodes(nodes.slice(0, 1), node => {
      if (node.type === 'fn' && node.name.toLowerCase() === 'var') return false;
      if (node.type === 'word' && NAMED_COLORS.has(node.text.toLowerCase())) found.push(node.text);
      return true;
    });
    match = pattern.exec(text);
  }
  return found;
}

function cssValueProblems(prop, value) {
  const problems = [];
  const colorProp = isColorProp(prop);
  const walk = (nodes, inMix) => {
    walkNodes(nodes, node => {
      if (node.type === 'word') {
        if (HEX_WORD.test(node.text)) problems.push(`hex colour ${node.text}`);
        else if ((colorProp || inMix) && NAMED_COLORS.has(node.text.toLowerCase()))
          problems.push(`named colour ${node.text}`);
        return true;
      }
      if (node.type !== 'fn') return true;
      const name = node.name.toLowerCase();
      if (name === 'url') return false;
      if (name === 'var') {
        walk(node.args.slice(1).flat(), inMix);
        return false;
      }
      if (COLOR_FUNCTIONS.has(name)) {
        problems.push(`${name}() colour`);
        return false;
      }
      if (name === 'color-mix') {
        walk(node.args.flat(), true);
        return false;
      }
      return true;
    });
  };
  walk(parseValue(value), false);
  return problems;
}

export function check(ctx) {
  const out = [];
  const advice = 'Use a colour token such as var(--accent) (DESIGN 4.1).';
  const decls = collectDecls(ctx);
  for (const decl of decls) {
    if (decl.fromCss) {
      for (const problem of cssValueProblems(decl.prop, decl.value)) {
        out.push(
          violation(decl.line, decl.column, `Raw ${problem} in ${decl.prop}. ${advice}`, decl.node),
        );
      }
    } else if (decl.styleContext && isColorProp(decl.prop)) {
      for (const problem of cssValueProblems(decl.prop, decl.value).filter(p =>
        p.startsWith('named'),
      )) {
        out.push(violation(decl.line, decl.column, `Raw ${problem} in ${decl.prop}. ${advice}`));
      }
    }
  }
  if (ctx.kind !== 'ts') return out;
  forEachString(
    ctx,
    ({ text, node, line, column }) => {
      const anchor = isAnchorContext(node);
      for (const match of anchor ? [] : hexMatches(text)) {
        out.push(violation(line, column, `Raw hex colour ${match[0]} in a string. ${advice}`));
      }
      for (const match of text.matchAll(STRING_COLOR_FN)) {
        out.push(
          violation(
            line,
            column,
            `Raw colour function ${match[0].trim()}...) in a string. ${advice}`,
          ),
        );
      }
      for (const name of colorMixLiterals(text)) {
        out.push(
          violation(
            line,
            column,
            `color-mix() with the literal colour ${name}. Mix only var(--token) and transparent.`,
          ),
        );
      }
    },
    { skipEmbedded: true },
  );
  return out;
}

export default { id, description, appliesTo, check };
