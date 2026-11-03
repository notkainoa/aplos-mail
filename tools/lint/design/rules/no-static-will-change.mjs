// DESIGN 5 rule 14: will-change only while animating, removed on finish.
// A stylesheet or a static style object can never express that.

import { collectDecls } from '../lib/decls.mjs';
import { violation } from '../lib/context.mjs';
import { stripVendor } from '../lib/props.mjs';

export const id = 'no-static-will-change';
export const description =
  'will-change in a stylesheet or a static style object. Only motion.ts sets it, while an animation runs.';
export const appliesTo = ['css', 'ts'];

export function check(ctx) {
  const out = [];
  for (const decl of collectDecls(ctx)) {
    if (stripVendor(decl.prop) !== 'will-change') continue;
    if (decl.origin === 'assign') continue;
    if (decl.value.trim().toLowerCase() === 'auto') continue;
    out.push(
      violation(
        decl.line,
        decl.column,
        'will-change is static here. Set it from motion.ts only while an animation runs and remove it on finish (DESIGN 5 rule 14).',
        decl.node,
      ),
    );
  }
  return out;
}

export default { id, description, appliesTo, check };
