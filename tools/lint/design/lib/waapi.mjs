// Finders for Web Animations API calls and timer-driven motion.

import ts from 'typescript';
import {
  isFunctionLike,
  nameOfProperty,
  positionOf,
  resolveIdentifier,
  unwrap,
  visit,
} from './ast.mjs';

export function findAnimateCalls(sf) {
  const calls = [];
  visit(sf, node => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      callee.name.text === 'animate' &&
      node.arguments.length >= 1
    ) {
      calls.push(node);
    }
  });
  return calls;
}

// Returns [{key, node}] for every property name used in the keyframes argument.
export function keyframeKeys(sf, argument) {
  const resolved = resolveIdentifier(sf, argument);
  const keys = [];
  const addObject = object => {
    for (const property of object.properties) {
      const key = nameOfProperty(property.name);
      if (key) keys.push({ key, node: property });
    }
  };
  if (ts.isArrayLiteralExpression(resolved)) {
    for (const element of resolved.elements) {
      const item = resolveIdentifier(sf, element);
      if (ts.isObjectLiteralExpression(item)) addObject(item);
    }
  } else if (ts.isObjectLiteralExpression(resolved)) {
    addObject(resolved);
  }
  return keys;
}

export function optionsObject(sf, call) {
  const option = call.arguments[1];
  if (!option) return null;
  const resolved = resolveIdentifier(sf, option);
  return resolved && ts.isObjectLiteralExpression(resolved) ? resolved : null;
}

const TIMER_NAMES = new Set(['setTimeout', 'setInterval']);
const MOTION_STYLE =
  /^(transform|opacity|transition|translate|scale|rotate|animation|filter|left|top|right|bottom|inset|width|height|margin\w*|padding\w*)$/i;
const MOTION_CLASS = /enter|leave|exit|animat|fade|slide|appear|flight|carry|flip/i;

export function findTimerCalls(sf) {
  const calls = [];
  visit(sf, node => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : '';
    if (TIMER_NAMES.has(name) && node.arguments.length >= 1) calls.push(node);
  });
  return calls;
}

// Does the callback write motion: a style transform/opacity/transition or an
// enter/leave/animate class toggle?
export function callbackWritesMotion(sf, callArgument) {
  const callback = resolveIdentifier(sf, callArgument);
  if (!callback || !isFunctionLike(callback)) return false;
  let writes = false;
  visit(callback, node => {
    if (writes) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left;
      if (
        ts.isPropertyAccessExpression(left) &&
        /style$/.test(left.expression.getText()) &&
        MOTION_STYLE.test(left.name.text)
      ) {
        writes = true;
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const owner = node.expression.expression.getText();
      if (method === 'setProperty' && /style$/.test(owner)) {
        const first = unwrap(node.arguments[0] || node);
        if (ts.isStringLiteral(first) && MOTION_STYLE.test(first.text)) writes = true;
      }
      if (/^(add|remove|toggle|replace)$/.test(method) && /classList$/.test(owner)) {
        const named = node.arguments.some(arg => {
          const inner = unwrap(arg);
          return ts.isStringLiteral(inner) && MOTION_CLASS.test(inner.text);
        });
        if (named) writes = true;
      }
    }
  });
  return writes;
}

export { positionOf };
