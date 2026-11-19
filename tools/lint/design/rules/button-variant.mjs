// DESIGN 4.6 "Three button idioms only": filled, text and icon. Pills, glass,
// ghost, primary and secondary buttons are gone.

import ts from 'typescript';
import {
  jsxTagName,
  lastSegment,
  nameOfProperty,
  positionOf,
  resolveIdentifier,
  unwrap,
  valueLeaves,
  visit,
} from '../lib/ast.mjs';
import { violation } from '../lib/context.mjs';

export const id = 'button-variant';
export const description =
  '<Button variant="..."> must be filled, text or icon, including every string branch of a conditional expression, inline spreads and aliased imports of Button.';
export const appliesTo = ['ts'];

export const ALLOWED_VARIANTS = new Set(['filled', 'text', 'icon']);

// Local names that stand for Button: Button itself and any `import { Button as Btn }`.
function buttonNames(sf) {
  const names = new Set(['Button']);
  visit(sf, node => {
    if (!ts.isImportSpecifier(node)) return;
    if ((node.propertyName || node.name).text === 'Button') names.add(node.name.text);
  });
  return names;
}

function variantLeaves(sf, attribute) {
  const initializer = attribute.initializer;
  if (!initializer) return [];
  if (ts.isStringLiteral(initializer)) return [{ text: initializer.text, node: initializer }];
  if (!ts.isJsxExpression(initializer) || !initializer.expression) return [];
  return valueLeaves(initializer.expression, sf).map(leaf => ({ ...leaf, node: attribute }));
}

// {...{ variant: 'ghost' }} and {...props} where props is a same-file object.
function spreadLeaves(sf, spread) {
  const object = resolveIdentifier(sf, spread.expression);
  const target = object && unwrap(object);
  if (!target || !ts.isObjectLiteralExpression(target)) return [];
  return target.properties
    .filter(
      property => ts.isPropertyAssignment(property) && nameOfProperty(property.name) === 'variant',
    )
    .flatMap(property =>
      valueLeaves(property.initializer, sf).map(leaf => ({ ...leaf, node: spread })),
    );
}

export function check(ctx) {
  const out = [];
  const { sf } = ctx;
  const names = buttonNames(sf);
  visit(sf, node => {
    if (!ts.isJsxSelfClosingElement(node) && !ts.isJsxOpeningElement(node)) return;
    if (!names.has(lastSegment(jsxTagName(node)))) return;
    for (const attribute of node.attributes.properties) {
      let leaves = [];
      if (ts.isJsxAttribute(attribute) && attribute.name.getText() === 'variant')
        leaves = variantLeaves(sf, attribute);
      else if (ts.isJsxSpreadAttribute(attribute)) leaves = spreadLeaves(sf, attribute);
      for (const leaf of leaves) {
        if (ALLOWED_VARIANTS.has(leaf.text)) continue;
        const at = positionOf(sf, leaf.node);
        out.push(
          violation(
            at.line,
            at.column,
            `Button variant "${leaf.text}" does not exist. Use filled, text or icon (DESIGN 4.6).`,
          ),
        );
      }
    }
  });
  return out;
}

export default { id, description, appliesTo, check };
