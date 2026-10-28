// DESIGN 2.3 (checks 5 and 6), 2.4 and 4.6: no gradients, no glass, no old
// decorative class names, no 3D toss.

import ts from 'typescript';
import { nameOfProperty, positionOf, visit } from '../lib/ast.mjs';
import { collectDecls, forEachString } from '../lib/decls.mjs';
import { violation } from '../lib/context.mjs';
import { stripVendor } from '../lib/props.mjs';

export const id = 'no-decoration';
export const description =
  'No gradients, no backdrop-filter, no old decorative classes (post-edge, airmail, skyscene, dock-pill, deck, has-next, low-line, reader-dock), no 3D transforms (rotateY(), rotateX(), rotate3d(), matrix3d(), translateZ(), scale3d(), perspective(), preserve-3d, backface-visibility).';
export const appliesTo = ['css', 'ts'];

const GRADIENT = /(?<![\w-])(?:repeating-)?(?:linear|radial|conic)-gradient\(/gi;
const TOSS =
  /(?<![\w-])(?:rotateX|rotateY|rotate3d|matrix3d|translateZ|scale3d|scaleZ|perspective)\(/gi;
const TRANSLATE3D = /(?<![\w-])translate3d\(([^)]*)\)/gi;
const STRING_3D_PROPS = /(?<![\w-])(?:transform-style\s*:\s*preserve-3d|backface-visibility\s*:)/gi;
const ROTATE_AXIS = /^\s*(?:[xyz]\b|[+-]?[\d.]+\s+[+-]?[\d.]+\s+[+-]?[\d.]+\s)/i;

// Every 3D form in a value: the functions of the old toss plus translate3d()
// with a non-zero z.
export function threeDMatches(text) {
  const found = [...text.matchAll(TOSS)].map(match => `${match[0]}...)`);
  for (const match of text.matchAll(TRANSLATE3D)) {
    const z = (match[1].split(',')[2] || '').trim();
    if (z && !/^[+-]?0*\.?0*(?:[a-z%]*)$/i.test(z)) found.push('translate3d(...) with a z offset');
  }
  return found;
}

// Declarations that are 3D by themselves: the individual rotate property with
// an axis or vector, preserve-3d, backface-visibility, perspective-origin.
export function threeDDeclaration(prop, value) {
  if (prop === 'rotate' && ROTATE_AXIS.test(value)) return 'rotate with an axis';
  if (prop === 'transform-style' && /preserve-3d/i.test(value))
    return 'transform-style: preserve-3d';
  if (prop === 'backface-visibility') return 'backface-visibility';
  if (prop === 'perspective-origin') return 'perspective-origin';
  return null;
}
const BANNED_CLASS_PARTS = [
  'post-edge',
  'airmail',
  'skyscene',
  'sky-scene',
  'dock-pill',
  'has-next',
  'low-line',
  'reader-dock',
];
const BANNED_CLASS_EXACT = ['deck'];

function kebabOf(token) {
  return token.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

// Matches the kebab-case name and its camelCase CSS-module spelling
// (readerDock, dockPill, lowLine, hasNext, postEdge, skyScene).
export function bannedClassIn(token) {
  const lower = kebabOf(token);
  const part = BANNED_CLASS_PARTS.find(name => lower.includes(name));
  if (part) return part;
  return BANNED_CLASS_EXACT.find(name => lower === name) || null;
}

function selectorClasses(selector) {
  return [...selector.matchAll(/[.#]([\w-]+)/g)].map(m => m[1]);
}

function selectorAttributeValues(selector) {
  return [...selector.matchAll(/\[([^\]]*)\]/g)].flatMap(m =>
    m[1].split(/[^\w-]+/).filter(Boolean),
  );
}

function cssChecks(ctx, out) {
  ctx.root.walkRules(rule => {
    const tokens = [...selectorClasses(rule.selector), ...selectorAttributeValues(rule.selector)];
    for (const token of tokens) {
      const banned = bannedClassIn(token);
      if (banned) {
        const at = rule.source.start;
        out.push(
          violation(
            at.line,
            at.column,
            `Selector uses the banned decorative class "${banned}" (DESIGN 2.4).`,
            rule,
          ),
        );
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
      if (
        /classList\.(add|remove|toggle|replace|contains)$|(^|\.)(clsx|cx|classNames|cn)$/.test(
          callee,
        )
      )
        return true;
    }
    if (
      ts.isBinaryExpression(current) &&
      ts.isPropertyAccessExpression(current.left) &&
      /^class(Name)?$/.test(current.left.name.text)
    )
      return true;
    if (ts.isPropertyAssignment(current)) {
      const name = nameOfProperty(current.name);
      if (name && /^class(Name)?$/.test(name)) return true;
    }
    if (ts.isStatement(current)) return false;
    current = current.parent;
  }
  return false;
}

const STYLE_MODULE_NAME = /^(styles?|css|classes|classNames|cls|module)$/i;

// styles.readerDock and styles['reader-dock'] on a CSS-module object.
function moduleClassChecks(sf, out) {
  const modules = new Set();
  visit(sf, node => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const clause = node.importClause;
    if (clause && /\.module\.[a-z]+$/.test(node.moduleSpecifier.text)) {
      if (clause.name) modules.add(clause.name.text);
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
        modules.add(clause.namedBindings.name.text);
    }
  });
  visit(sf, node => {
    if (!ts.isPropertyAccessExpression(node) || !ts.isIdentifier(node.expression)) return;
    const owner = node.expression.text;
    if (!modules.has(owner) && !STYLE_MODULE_NAME.test(owner)) return;
    const banned = bannedClassIn(node.name.text);
    if (!banned) return;
    const at = positionOf(sf, node);
    out.push(violation(at.line, at.column, `Class "${banned}" is banned (DESIGN 2.4 and 13).`));
  });
}

function tsChecks(ctx, out) {
  moduleClassChecks(ctx.sf, out);
  forEachString(ctx, ({ text, node, line, column }) => {
    const embedded = ctx.embeddedStrings.has(node);
    if (!embedded) {
      for (const match of text.matchAll(GRADIENT)) {
        out.push(violation(line, column, `${match[0]}...) is decoration (DESIGN 2.4).`));
      }
      for (const match of threeDMatches(text)) {
        out.push(
          violation(
            line,
            column,
            `${match} is 3D, the old toss. Use flight with a 2 degree tilt (DESIGN 4.9).`,
          ),
        );
      }
      for (const match of text.matchAll(STRING_3D_PROPS)) {
        out.push(violation(line, column, `${match[0].trim()} is 3D, the old toss (DESIGN 4.9).`));
      }
    }
    const tokens = isClassContext(node)
      ? classTokensOf(text)
      : [...text.matchAll(/(?<![\w-])[.#]([\w-]+)/g)].map(m => m[1]);
    for (const token of tokens) {
      const banned = bannedClassIn(token);
      if (banned)
        out.push(violation(line, column, `Class "${banned}" is banned (DESIGN 2.4 and 13).`));
    }
  });
}

export function check(ctx) {
  const out = [];
  for (const decl of collectDecls(ctx)) {
    const prop = stripVendor(decl.prop);
    if (prop === 'backdrop-filter') {
      out.push(
        violation(
          decl.line,
          decl.column,
          'backdrop-filter is glass. Floating surfaces are opaque --paper (DESIGN 4.6).',
          decl.node,
        ),
      );
    }
    if (prop === 'perspective') {
      out.push(
        violation(
          decl.line,
          decl.column,
          'perspective is the old 3D toss (DESIGN 4.9).',
          decl.node,
        ),
      );
    }
    const standalone = threeDDeclaration(prop, decl.value);
    if (standalone)
      out.push(
        violation(
          decl.line,
          decl.column,
          `${standalone} is 3D, the old toss (DESIGN 4.9).`,
          decl.node,
        ),
      );
    if (decl.fromCss) {
      for (const match of decl.value.matchAll(GRADIENT)) {
        out.push(
          violation(
            decl.line,
            decl.column,
            `${match[0]}...) is decoration (DESIGN 2.4).`,
            decl.node,
          ),
        );
      }
      for (const match of threeDMatches(decl.value)) {
        out.push(
          violation(
            decl.line,
            decl.column,
            `${match} is 3D, the old toss (DESIGN 4.9).`,
            decl.node,
          ),
        );
      }
    }
  }
  if (ctx.kind === 'css') cssChecks(ctx, out);
  else tsChecks(ctx, out);
  return out;
}

export default { id, description, appliesTo, check };
