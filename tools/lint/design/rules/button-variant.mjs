// DESIGN 4.6 "Three button idioms only": filled, text and icon. Pills, glass,
// ghost, primary and secondary buttons are gone.

import ts from 'typescript';
import {
  jsxTagName, lastSegment, positionOf, valueLeaves, visit,
} from '../lib/ast.mjs';
import { violation } from '../lib/context.mjs';

export const id = 'button-variant';
export const description = '<Button variant="..."> must be filled, text or icon, including every string branch of a conditional expression.';
export const appliesTo = ['ts'];

export const ALLOWED_VARIANTS = new Set(['filled', 'text', 'icon']);

function variantLeaves(sf, attribute) {
  const initializer = attribute.initializer;
  if (!initializer) return [];
  if (ts.isStringLiteral(initializer)) return [{ text: initializer.text, node: initializer }];
  if (!ts.isJsxExpression(initializer) || !initializer.expression) return [];
  return valueLeaves(initializer.expression, sf).map((leaf) => ({ ...leaf, node: attribute }));
}

export function check(ctx) {
  const out = [];
  const { sf } = ctx;
  visit(sf, (node) => {
    if (!ts.isJsxSelfClosingElement(node) && !ts.isJsxOpeningElement(node)) return;
    if (lastSegment(jsxTagName(node)) !== 'Button') return;
    for (const attribute of node.attributes.properties) {
      if (!ts.isJsxAttribute(attribute) || attribute.name.getText() !== 'variant') continue;
      for (const leaf of variantLeaves(sf, attribute)) {
        if (ALLOWED_VARIANTS.has(leaf.text)) continue;
        const at = positionOf(sf, leaf.node);
        out.push(violation(at.line, at.column, `Button variant "${leaf.text}" does not exist. Use filled, text or icon (DESIGN 4.6).`));
      }
    }
  });
  return out;
}

export default { id, description, appliesTo, check };
