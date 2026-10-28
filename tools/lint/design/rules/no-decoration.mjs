// DESIGN 2.3 (checks 5 and 6), 2.4 and 4.6: no gradients, no glass, no old
// decorative class names, no 3D toss.

import ts from 'typescript';
import { nameOfProperty } from '../lib/ast.mjs';
import { collectDecls, forEachString } from '../lib/decls.mjs';
import { violation } from '../lib/context.mjs';
import { stripVendor } from '../lib/props.mjs';

export const id = 'no-decoration';
export const description = 'No gradients, no backdrop-filter, no old decorative classes (post-edge, airmail, skyscene, dock-pill, deck, has-next, low-line, reader-dock), no rotateY() or perspective().';
export const appliesTo = ['css', 'ts'];

const GRADIENT = /(?<![\w-])(?:repeating-)?(?:linear|radial|conic)-gradient\(/gi;
const TOSS = /(?<![\w-])(?:rotateY|perspective)\(/gi;
const BANNED_CLASS_PARTS = ['post-edge', 'airmail', 'skyscene', 'sky-scene', 'dock-pill', 'has-next', 'low-line', 'reader-dock'];
const BANNED_CLASS_EXACT = ['deck'];

export function bannedClassIn(token) {
  const lower = token.toLowerCase();
  const part = BANNED_CLASS_PARTS.find((name) => lower.includes(name));
  if (part) return part;
  return BANNED_CLASS_EXACT.find((name) => lower === name) || null;
}

function selectorClasses(selector) {
  return [...selector.matchAll(/[.#]([\w-]+)/g)].map((m) => m[1]);
}

function selectorAttributeValues(selector) {
  return [...selector.matchAll(/\[([^\]]*)\]/g)].flatMap((m) => m[1].split(/[^\w-]+/).filter(Boolean));
}

function cssChecks(ctx, out) {
  ctx.root.walkRules((rule) => {
    const tokens = [...selectorClasses(rule.selector), ...selectorAttributeValues(rule.selector)];
    for (const token of tokens) {
      const banned = bannedClassIn(token);
      if (banned) {
        const at = rule.source.start;
        out.push(violation(at.line, at.column, `Selector uses the banned decorative class "${banned}" (DESIGN 2.4).`, rule));
      }
    }
  });
}

function classTokensOf(text) {
  return text.split(/[\s]+/).filter(Boolean);
}

function isClassContext(node) {
  const parent = node.parent;
  let current = parent;
  while (current) {
    if (ts.isJsxAttribute(current)) return /^class(Name)?$/.test(current.name.getText());
    if (ts.isCallExpression(current)) {
      const callee = current.expression.getText();
      if (/classList\.(add|remove|toggle|replace|contains)$|(^|\.)(clsx|cx|classNames|cn)$/.test(callee)) return true;
    }
    if (ts.isBinaryExpression(current) && ts.isPropertyAccessExpression(current.left) && /^class(Name)?$/.test(current.left.name.text)) return true;
    if (ts.isPropertyAssignment(current)) {
      const name = nameOfProperty(current.name);
      if (name && /^class(Name)?$/.test(name)) return true;
    }
    if (ts.isStatement(current)) return false;
    current = current.parent;
  }
  return false;
}

function tsChecks(ctx, out) {
  forEachString(ctx, ({ text, node, line, column }) => {
    const embedded = ctx.embeddedStrings.has(node);
    if (!embedded) {
      for (const match of text.matchAll(GRADIENT)) {
        out.push(violation(line, column, `${match[0]}...) is decoration (DESIGN 2.4).`));
      }
      for (const match of text.matchAll(TOSS)) {
        out.push(violation(line, column, `${match[0]}...) is the old 3D toss. Use flight with a 2 degree tilt (DESIGN 4.9).`));
      }
    }
    const tokens = isClassContext(node) ? classTokensOf(text) : [...text.matchAll(/(?<![\w-])[.#]([\w-]+)/g)].map((m) => m[1]);
    for (const token of tokens) {
      const banned = bannedClassIn(token);
      if (banned) out.push(violation(line, column, `Class "${banned}" is banned (DESIGN 2.4 and 13).`));
    }
  });
}

export function check(ctx) {
  const out = [];
  for (const decl of collectDecls(ctx)) {
    const prop = stripVendor(decl.prop);
    if (prop === 'backdrop-filter') {
      out.push(violation(decl.line, decl.column, 'backdrop-filter is glass. Floating surfaces are opaque --paper (DESIGN 4.6).', decl.node));
    }
    if (prop === 'perspective') {
      out.push(violation(decl.line, decl.column, 'perspective is the old 3D toss (DESIGN 4.9).', decl.node));
    }
    if (decl.fromCss) {
      for (const match of decl.value.matchAll(GRADIENT)) {
        out.push(violation(decl.line, decl.column, `${match[0]}...) is decoration (DESIGN 2.4).`, decl.node));
      }
      for (const match of decl.value.matchAll(TOSS)) {
        out.push(violation(decl.line, decl.column, `${match[0]}...) is the old 3D toss (DESIGN 4.9).`, decl.node));
      }
    }
  }
  if (ctx.kind === 'css') cssChecks(ctx, out);
  else tsChecks(ctx, out);
  return out;
}

export default { id, description, appliesTo, check };
