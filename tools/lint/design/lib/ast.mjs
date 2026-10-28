// Helpers over the TypeScript compiler API AST.

import ts from 'typescript';
import { DYNAMIC } from './value.mjs';

const { SyntaxKind } = ts;

export function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

export function positionOf(sf, node) {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { line: line + 1, column: character + 1 };
}

export function unwrap(node) {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current))
  ) {
    current = current.expression;
  }
  return current;
}

export function isStringLike(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node);
}

// Cooked text of a string or template. Substitutions become the DYNAMIC marker.
export function textOf(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => DYNAMIC + span.literal.text).join('');
  }
  return '';
}

export function nameOfProperty(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const inner = unwrap(name.expression);
    if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return inner.text;
  }
  return null;
}

export function isNumericLiteralLike(node) {
  const inner = unwrap(node);
  if (ts.isNumericLiteral(inner)) return true;
  if (ts.isPrefixUnaryExpression(inner) && ts.isNumericLiteral(inner.operand)) return true;
  return false;
}

export function numericValue(node) {
  const inner = unwrap(node);
  if (ts.isNumericLiteral(inner)) return Number(inner.text);
  if (ts.isPrefixUnaryExpression(inner) && ts.isNumericLiteral(inner.operand)) {
    return inner.operator === SyntaxKind.MinusToken ? -Number(inner.operand.text) : Number(inner.operand.text);
  }
  return null;
}

// True for a literal, or arithmetic made only of literals.
export function isLiteralExpression(node) {
  const inner = unwrap(node);
  if (!inner) return false;
  if (isNumericLiteralLike(inner) || ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return true;
  if (ts.isTemplateExpression(inner)) return inner.templateSpans.every((span) => isLiteralExpression(span.expression));
  if (ts.isBinaryExpression(inner)) return isLiteralExpression(inner.left) && isLiteralExpression(inner.right);
  return false;
}

// Every string or number a copy or value expression can evaluate to, through
// conditionals and logical operators. Calls are opaque. When a source file is
// given, an identifier is followed to its same-file const initializer.
export function valueLeaves(expression, sf = null, depth = 0) {
  const node = unwrap(expression);
  if (!node || depth > 3) return [];
  if (sf && ts.isIdentifier(node)) {
    const resolved = resolveIdentifier(sf, node);
    return resolved === node ? [] : valueLeaves(resolved, sf, depth + 1);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) {
    return [{ text: textOf(node), node, numeric: false }];
  }
  if (isNumericLiteralLike(node)) return [{ text: String(numericValue(node)), node, numeric: true }];
  if (ts.isConditionalExpression(node)) return [...valueLeaves(node.whenTrue, sf, depth), ...valueLeaves(node.whenFalse, sf, depth)];
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === SyntaxKind.BarBarToken || op === SyntaxKind.QuestionQuestionToken) {
      return [...valueLeaves(node.left, sf, depth), ...valueLeaves(node.right, sf, depth)];
    }
    if (op === SyntaxKind.AmpersandAmpersandToken) return valueLeaves(node.right, sf, depth);
  }
  return [];
}

export function jsxTagName(node) {
  const tag = node.tagName || (node.openingElement && node.openingElement.tagName);
  return tag ? tag.getText() : '';
}

export function lastSegment(name) {
  return name.split('.').pop();
}

// Finds `const name = <init>` in the same file so simple indirections resolve.
export function resolveIdentifier(sf, expression) {
  const node = unwrap(expression);
  if (!node || !ts.isIdentifier(node)) return node;
  let found = null;
  visit(sf, (child) => {
    if (found) return;
    if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.name.text === node.text && child.initializer) {
      found = child.initializer;
    }
    if (ts.isFunctionDeclaration(child) && child.name && child.name.text === node.text && child.body) {
      found = child;
    }
  });
  return found ? unwrap(found) : node;
}

export function isFunctionLike(node) {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node);
}
