// DESIGN 5 rule 7 "Never animate layout" and 4.8: transitions and keyframes
// may touch only transform, opacity and colour/fill properties.

import ts from 'typescript';
import { positionOf, unwrap } from '../lib/ast.mjs';
import { collectDecls } from '../lib/decls.mjs';
import { violation } from '../lib/context.mjs';
import { isKeyframeProp, isLayoutProp, isTransitionProp, stripVendor } from '../lib/props.mjs';
import { parseValue, walkNodes } from '../lib/value.mjs';
import { findAnimateCalls, keyframeKeys } from '../lib/waapi.mjs';

export const id = 'no-layout-motion';
export const description =
  'transition and @keyframes (CSS, style objects, WAAPI keyframes) may animate only transform, opacity and colour/fill properties; never all, width, height, padding, margin, inset, flex, grid-template, font-size, border-width or gap.';
export const appliesTo = ['css', 'ts'];

function transitionedLayoutProps(value) {
  const found = [];
  walkNodes(parseValue(value), node => {
    if (node.type === 'fn') return node.name.toLowerCase() !== 'var';
    if (node.type === 'word' && isLayoutProp(node.text)) found.push(node.text);
    return true;
  });
  return found;
}

export function check(ctx) {
  const out = [];
  for (const decl of collectDecls(ctx)) {
    if (decl.numeric) continue;
    if (decl.inKeyframes) {
      const prop = stripVendor(decl.prop);
      if (isKeyframeProp(prop)) continue;
      const kind = isLayoutProp(prop)
        ? 'layout property'
        : 'property that is not compositor or colour';
      out.push(
        violation(
          decl.line,
          decl.column,
          `@keyframes animates ${decl.prop}, a ${kind}. Keyframes may animate only transform, opacity and colour (DESIGN 5 rule 7).`,
          decl.node,
        ),
      );
    } else if (
      isTransitionProp(decl.prop) &&
      /^(transition|transition-property)$/.test(stripVendor(decl.prop))
    ) {
      for (const name of transitionedLayoutProps(decl.value)) {
        out.push(
          violation(
            decl.line,
            decl.column,
            `${decl.prop} transitions ${name}. Never animate layout (DESIGN 5 rule 7).`,
            decl.node,
          ),
        );
      }
    }
  }
  if (ctx.kind !== 'ts') return out;
  for (const call of findAnimateCalls(ctx.sf)) {
    const direct =
      ts.isArrayLiteralExpression(unwrap(call.arguments[0])) ||
      ts.isObjectLiteralExpression(unwrap(call.arguments[0]));
    for (const { key, node } of keyframeKeys(ctx.sf, call.arguments[0])) {
      const prop = stripVendor(key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`));
      if (isKeyframeProp(prop)) continue;
      const at = positionOf(ctx.sf, direct ? node : call);
      const kind = isLayoutProp(prop)
        ? 'layout property'
        : 'property that is not compositor or colour';
      out.push(
        violation(
          at.line,
          at.column,
          `WAAPI keyframes animate ${key}, a ${kind}. Animate only transform, opacity and colour (DESIGN 5 rule 7).`,
        ),
      );
    }
  }
  return out;
}

export default { id, description, appliesTo, check };
