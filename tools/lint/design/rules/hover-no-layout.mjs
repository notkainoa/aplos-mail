// DESIGN 3 principle 11 and 5 rule 17: hover never moves anything. It may
// change colour and fill, nothing else, and it never reveals an inline keycap.

import ts from 'typescript';
import { jsxTagName, lastSegment, positionOf, valueLeaves, visit } from '../lib/ast.mjs';
import { collectDecls } from '../lib/decls.mjs';
import { violation } from '../lib/context.mjs';
import { stripVendor } from '../lib/props.mjs';

export const id = 'hover-no-layout';
export const description =
  'A :hover rule may set only colour and fill properties (plus opacity, visibility, cursor, --hover-* and --press-*); a <Kbd> is never rendered on hover state.';
export const appliesTo = ['css', 'ts'];

const HOVER_ALLOWED = new Set([
  'color',
  'background',
  'background-color',
  'border-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'fill',
  'stroke',
  'text-decoration-color',
  'box-shadow',
  'opacity',
  'visibility',
  'cursor',
]);

function hoverAllowed(prop) {
  if (/^--(hover|press)/.test(prop)) return true;
  return HOVER_ALLOWED.has(stripVendor(prop));
}

function cssChecks(ctx, out) {
  for (const decl of collectDecls(ctx)) {
    if (!decl.selector || !/:hover/i.test(decl.selector)) continue;
    if (hoverAllowed(decl.prop)) continue;
    out.push(
      violation(
        decl.line,
        decl.column,
        `${decl.prop} inside a :hover rule can move or reshape things. Hover may change colour and fill only (DESIGN 5 rule 17).`,
        decl.node,
      ),
    );
  }
}

const HOVER_NAME = /hover|mouse-?over|pointer-?over/i;
const HOVER_HANDLERS =
  /^on(MouseEnter|MouseOver|PointerEnter|PointerOver|MouseLeave|PointerLeave)$/;
const KBD_TAG = /^(kbd|keycap|keyhint)$/i;
const KBD_CLASS = /(^|[\s_-])(kbd|keycap|key-?hint)([\s_-]|$)/i;

function isKeycap(sf, node) {
  if (KBD_TAG.test(lastSegment(jsxTagName(node)))) return true;
  return node.attributes.properties.some(attribute => {
    if (!ts.isJsxAttribute(attribute) || !/^class(Name)?$/.test(attribute.name.getText()))
      return false;
    const initializer = attribute.initializer;
    if (!initializer) return false;
    const leaves = ts.isStringLiteral(initializer)
      ? [{ text: initializer.text }]
      : initializer.expression
        ? valueLeaves(initializer.expression, sf)
        : [];
    return leaves.some(leaf => KBD_CLASS.test(leaf.text));
  });
}

// Names of state variables set from a hover handler, found by looking for
// setX(...) calls inside onMouseEnter-style attributes.
function hoverStateNames(sf) {
  const names = new Set();
  visit(sf, node => {
    if (!ts.isJsxAttribute(node) || !HOVER_HANDLERS.test(node.name.getText())) return;
    visit(node, inner => {
      if (
        ts.isCallExpression(inner) &&
        ts.isIdentifier(inner.expression) &&
        /^set[A-Z]/.test(inner.expression.text)
      ) {
        const base = inner.expression.text.slice(3);
        names.add(base.charAt(0).toLowerCase() + base.slice(1));
      }
    });
  });
  return names;
}

function mentionsHover(expression, stateNames) {
  let mentioned = false;
  visit(expression, node => {
    if (ts.isIdentifier(node) && (HOVER_NAME.test(node.text) || stateNames.has(node.text)))
      mentioned = true;
  });
  return mentioned;
}

function conditionalAncestorMentionsHover(node, stateNames) {
  let child = node;
  let current = node.parent;
  while (current && !ts.isStatement(current)) {
    if (
      ts.isBinaryExpression(current) &&
      current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      current.right === child
    ) {
      if (mentionsHover(current.left, stateNames)) return true;
    }
    if (ts.isConditionalExpression(current) && current.condition !== child) {
      if (mentionsHover(current.condition, stateNames)) return true;
    }
    child = current;
    current = current.parent;
  }
  return false;
}

function kbdChecks(ctx, out) {
  const { sf } = ctx;
  const stateNames = hoverStateNames(sf);
  visit(sf, node => {
    if (!ts.isJsxSelfClosingElement(node) && !ts.isJsxOpeningElement(node)) return;
    if (!isKeycap(sf, node)) return;
    if (!conditionalAncestorMentionsHover(node, stateNames)) return;
    const at = positionOf(sf, node);
    out.push(
      violation(
        at.line,
        at.column,
        'A keycap rendered on hover moves the row. Key hints live in tooltips, in the held-command badges and in the "Show all key hints" mode (DESIGN 5 rule 17).',
      ),
    );
  });
}

export function check(ctx) {
  const out = [];
  cssChecks(ctx, out);
  if (ctx.kind === 'ts') kbdChecks(ctx, out);
  return out;
}

export default { id, description, appliesTo, check };
