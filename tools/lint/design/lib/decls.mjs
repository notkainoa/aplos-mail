// A unified list of CSS declarations for either kind of file, so the
// value-based rules are written once.
//
// A declaration is {prop, value, numeric, line, column, origin, fromCss,
// styleContext, inKeyframes, selector, node}. Origins:
//   css           a declaration in a stylesheet
//   css-embedded  a declaration in a stylesheet written inside a TS string
//   object        a key in a TS object literal (style={{...}} and friends)
//   assign        el.style.x = ..., style.setProperty(...)
//   inline        "prop: value" text inside a TS string
//   attribute     an SVG colour attribute such as fill="red"

import postcss from 'postcss';
import ts from 'typescript';
import {
  foldExpression,
  isStringLike,
  nameOfProperty,
  positionOf,
  textOf,
  unwrap,
  valueLeaves,
  visit,
} from './ast.mjs';
import { isKnownProp, toKebab } from './props.mjs';
import { DYNAMIC } from './value.mjs';

const STYLE_SIGNAL_KEYS = new Set([
  'color',
  'background',
  'backgroundColor',
  'fontSize',
  'fontWeight',
  'padding',
  'margin',
  'display',
  'position',
  'transform',
  'opacity',
  'transition',
  'cursor',
  'pointerEvents',
  'flexDirection',
  'alignItems',
  'justifyContent',
  'overflow',
  'zIndex',
  'lineHeight',
  'letterSpacing',
  'borderRadius',
  'boxShadow',
  'border',
  'borderColor',
  'outline',
  'gap',
  'whiteSpace',
  'textAlign',
  'willChange',
  'animation',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'paddingBottom',
  'marginLeft',
  'marginRight',
  'marginTop',
  'marginBottom',
]);

function typeTextHasCssProperties(typeNode) {
  return Boolean(typeNode) && /CSSProperties/.test(typeNode.getText());
}

function identifiersOf(expression) {
  const node = unwrap(expression);
  if (!node) return [];
  if (ts.isIdentifier(node)) return [node.text];
  if (ts.isConditionalExpression(node))
    return [...identifiersOf(node.whenTrue), ...identifiersOf(node.whenFalse)];
  if (ts.isBinaryExpression(node))
    return [...identifiersOf(node.left), ...identifiersOf(node.right)];
  if (ts.isArrayLiteralExpression(node))
    return node.elements.flatMap(element => identifiersOf(element));
  return [];
}

const styleNameCache = new WeakMap();

// Names of same-file objects handed to style={x}, Object.assign(el.style, x)
// or spread into a style object, so `const theme = { color: 'red' }` counts as
// a style object however few keys it has.
function styleReferencedNames(sf) {
  if (styleNameCache.has(sf)) return styleNameCache.get(sf);
  const names = new Set();
  styleNameCache.set(sf, names);
  const spreads = [];
  visit(sf, node => {
    if (
      ts.isJsxAttribute(node) &&
      /style$/i.test(node.name.getText()) &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression
    ) {
      for (const name of identifiersOf(node.initializer.expression)) names.add(name);
    } else if (ts.isCallExpression(node) && /Object\.assign$/.test(node.expression.getText())) {
      const first = node.arguments[0];
      if (first && /style$/.test(first.getText()))
        node.arguments.slice(1).forEach(arg => identifiersOf(arg).forEach(name => names.add(name)));
    } else if (ts.isSpreadAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
      spreads.push(node);
    }
  });
  for (const spread of spreads) {
    if (isStyleObject(spread.parent, false))
      identifiersOf(spread.expression).forEach(name => names.add(name));
  }
  return names;
}

const STYLE_PASS_THROUGH = [
  ts.isParenthesizedExpression,
  ts.isConditionalExpression,
  ts.isObjectLiteralExpression,
  ts.isArrayLiteralExpression,
  ts.isSpreadAssignment,
  ts.isBinaryExpression,
];

// Climbs out of the object literal through wrappers that do not change what it
// is. Returns {style: true} when a wrapper already proves a style object, else
// {current} with the first ancestor that is not a wrapper.
function climbStyleWrappers(node) {
  let current = node.parent;
  while (current) {
    const isCast = ts.isAsExpression(current) || ts.isSatisfiesExpression(current);
    if (isCast && typeTextHasCssProperties(current.type)) return { style: true };
    if (ts.isPropertyAssignment(current)) {
      const name = nameOfProperty(current.name);
      if (name && /style/i.test(name)) return { style: true };
    } else if (!isCast && !STYLE_PASS_THROUGH.some(test => test(current))) {
      break;
    }
    current = current.parent;
  }
  return { current };
}

// True or false when the destination settles the question; null when it does not.
function styleDestination(node, current, followReferences) {
  if (!current) return null;
  if (ts.isJsxExpression(current) && current.parent && ts.isJsxAttribute(current.parent))
    return /style$/i.test(current.parent.name.getText());
  if (ts.isVariableDeclaration(current)) {
    const name = current.name.getText();
    if (typeTextHasCssProperties(current.type) || /style/i.test(name)) return true;
    if (
      followReferences &&
      ts.isIdentifier(current.name) &&
      styleReferencedNames(node.getSourceFile()).has(name)
    )
      return true;
  }
  if (ts.isCallExpression(current) && /Object\.assign$/.test(current.expression.getText())) {
    const first = current.arguments[0];
    if (first && /style$/.test(first.getText())) return true;
  }
  return null;
}

function isStyleObject(node, followReferences = true) {
  const climbed = climbStyleWrappers(node);
  if (climbed.style) return true;
  const destination = styleDestination(node, climbed.current, followReferences);
  if (destination !== null) return destination;
  const signals = node.properties.filter(p => {
    const name = nameOfProperty(p.name);
    return name && STYLE_SIGNAL_KEYS.has(name);
  });
  return signals.length >= 2;
}

function cssDecls(ctx) {
  const decls = [];
  ctx.root.walkDecls(decl => {
    const start = decl.source && decl.source.start;
    if (!start) return;
    decls.push(makeCssDecl(decl, start.line, start.column, 'css'));
  });
  return decls;
}

function selectorOf(decl) {
  const parts = [];
  let current = decl.parent;
  while (current) {
    if (current.type === 'rule') parts.unshift(current.selector);
    current = current.parent;
  }
  return parts.join(' ');
}

function inKeyframesOf(decl) {
  let current = decl.parent;
  while (current) {
    if (current.type === 'atrule' && /keyframes$/i.test(current.name)) return true;
    current = current.parent;
  }
  return false;
}

function makeCssDecl(decl, line, column, origin) {
  return {
    prop: decl.prop.startsWith('--') ? decl.prop : decl.prop.toLowerCase(),
    value: decl.value,
    numeric: false,
    line,
    column,
    origin,
    fromCss: true,
    styleContext: true,
    inKeyframes: inKeyframesOf(decl),
    selector: selectorOf(decl),
    node: decl,
  };
}

function tryEmbeddedStylesheet(text, node, sf, decls) {
  if (!text.includes('{') || !text.includes('}') || !text.includes(':')) return false;
  let root;
  try {
    root = postcss.parse(text.split(DYNAMIC).join('__expr__'));
  } catch {
    return false;
  }
  const at = positionOf(sf, node);
  root.walkDecls(decl => {
    const start = decl.source.start;
    const line = at.line + start.line - 1;
    const column = start.line === 1 ? at.column + start.column : start.column;
    decls.push(makeCssDecl(decl, line, column, 'css-embedded'));
  });
  return true;
}

const INLINE_DECL = /(?<![\w-])(--[\w-]+|[a-z][a-z-]*)\s*:\s*([^;{}]+?)\s*(?:;|$)/g;

function inlineDecls(text, node, sf, decls, styleContext) {
  if (!text.includes(':')) return;
  const at = positionOf(sf, node);
  for (const match of text.matchAll(INLINE_DECL)) {
    const prop = match[1];
    if (!isKnownProp(prop)) continue;
    decls.push({
      prop,
      value: match[2],
      numeric: false,
      line: at.line,
      column: at.column,
      origin: 'inline',
      fromCss: false,
      styleContext,
      inKeyframes: false,
      selector: '',
      node,
    });
  }
}

function pushLeaves(decls, prop, expression, anchor, sf, origin, styleContext) {
  const at = positionOf(sf, anchor);
  for (const leaf of valueLeaves(expression, sf)) {
    decls.push({
      prop,
      value: leaf.text,
      numeric: leaf.numeric,
      line: at.line,
      column: at.column,
      origin,
      fromCss: false,
      styleContext,
      inKeyframes: false,
      selector: '',
      node: anchor,
    });
  }
}

function objectDecls(node, sf, decls) {
  let style;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const key = nameOfProperty(property.name);
    if (!key) continue;
    const prop = toKebab(key);
    if (!isKnownProp(prop)) continue;
    if (style === undefined) style = isStyleObject(node);
    pushLeaves(decls, prop, property.initializer, property, sf, 'object', style);
  }
}

// SVG presentation attributes carry colour too: <path fill="red" />.
const COLOR_ATTRIBUTES = new Map([
  ['fill', 'fill'],
  ['stroke', 'stroke'],
  ['color', 'color'],
  ['stopColor', 'stop-color'],
  ['stop-color', 'stop-color'],
  ['floodColor', 'flood-color'],
  ['flood-color', 'flood-color'],
  ['lightingColor', 'lighting-color'],
  ['lighting-color', 'lighting-color'],
]);

function attributeDecl(node, sf, decls) {
  const prop = COLOR_ATTRIBUTES.get(node.name.getText());
  const initializer = node.initializer;
  if (!prop || !initializer) return;
  const expression = ts.isJsxExpression(initializer) ? initializer.expression : initializer;
  if (expression) pushLeaves(decls, prop, expression, node, sf, 'attribute', true);
}

function isStyleAccess(expression) {
  const inner = unwrap(expression);
  if (ts.isPropertyAccessExpression(inner)) return inner.name.text === 'style';
  if (ts.isIdentifier(inner)) return inner.text === 'style';
  return false;
}

function assignDecl(node, sf, decls) {
  const left = node.left;
  if (ts.isPropertyAccessExpression(left) && isStyleAccess(left.expression)) {
    const prop = toKebab(left.name.text);
    if (isKnownProp(prop)) pushLeaves(decls, prop, node.right, node, sf, 'assign', true);
  } else if (ts.isElementAccessExpression(left) && isStyleAccess(left.expression)) {
    const key = unwrap(left.argumentExpression);
    if (ts.isStringLiteral(key)) {
      const prop = toKebab(key.text);
      if (isKnownProp(prop)) pushLeaves(decls, prop, node.right, node, sf, 'assign', true);
    }
  }
}

function setPropertyDecl(node, sf, decls) {
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'setProperty') return;
  if (!isStyleAccess(callee.expression) || node.arguments.length < 2) return;
  const key = unwrap(node.arguments[0]);
  if (!ts.isStringLiteral(key)) return;
  const prop = toKebab(key.text);
  if (isKnownProp(prop)) pushLeaves(decls, prop, node.arguments[1], node, sf, 'assign', true);
}

function isIgnoredString(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return true;
  return ts.isLiteralTypeNode(parent);
}

function tsDecls(ctx) {
  const { sf } = ctx;
  const decls = [];
  const embedded = new Set();
  visit(sf, node => {
    if (ts.isObjectLiteralExpression(node)) objectDecls(node, sf, decls);
    else if (ts.isJsxAttribute(node)) attributeDecl(node, sf, decls);
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      assignDecl(node, sf, decls);
    else if (ts.isCallExpression(node)) setPropertyDecl(node, sf, decls);
    if (!isStringLike(node) || isIgnoredString(node)) return;
    const text = textOf(node, sf);
    if (tryEmbeddedStylesheet(text, node, sf, decls)) embedded.add(node);
    else inlineDecls(text, node, sf, decls, true);
  });
  ctx.embeddedStrings = embedded;
  return decls;
}

export function collectDecls(ctx) {
  if (!ctx.decls) ctx.decls = ctx.kind === 'css' ? cssDecls(ctx) : tsDecls(ctx);
  return ctx.decls;
}

// Every string in a TS file except import specifiers and type literals.
// Strings that were parsed as embedded stylesheets are skipped when asked,
// because their declarations already go through collectDecls.
//
// A `+` chain of strings that folds to one constant ('#0b' + '5394') is
// reported once more, as the joined text, so a split literal cannot hide.
export function forEachString(ctx, callback, { skipEmbedded = false } = {}) {
  collectDecls(ctx);
  const { sf } = ctx;
  visit(sf, node => {
    if (isTopConcatenation(node)) {
      const folded = foldExpression(sf, node);
      if (folded && folded.complete && !isIgnoredString(node)) {
        const at = positionOf(sf, node);
        callback({ text: folded.text, node, line: at.line, column: at.column, folded: true });
      }
      return;
    }
    if (!isStringLike(node) || isIgnoredString(node)) return;
    if (skipEmbedded && ctx.embeddedStrings.has(node)) return;
    const at = positionOf(sf, node);
    callback({ text: textOf(node, sf), node, line: at.line, column: at.column });
  });
}

function isTopConcatenation(node) {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.PlusToken)
    return false;
  let parent = node.parent;
  while (parent && ts.isParenthesizedExpression(parent)) parent = parent.parent;
  return !(
    parent &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.PlusToken
  );
}
