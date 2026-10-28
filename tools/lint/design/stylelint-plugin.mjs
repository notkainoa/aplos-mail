// Stylelint adapter. Each plugin object runs a core CSS check on the PostCSS
// root stylelint hands over. stylelint is imported lazily inside the rule, so
// this module loads without stylelint installed. Not executed in Phase 0;
// see README.md.
//
//   // stylelint.config.mjs
//   export default { plugins: ['./tools/lint/design/stylelint-plugin.mjs'],
//     rules: { 'aplos-design/no-raw-color': true, ... } };

import path from 'node:path';
import { exclude, include, repoRoot } from './config.mjs';
import { createCssContext } from './lib/context.mjs';
import { matchesAny } from './lib/glob.mjs';
import { rules as coreRules } from './rules/index.mjs';

/** stylelint runs over every CSS file in the repo; the design rules cover only the new renderer tree. */
function inScope(file) {
  if (!file) return false;
  const relative = path.relative(repoRoot, file).split(path.sep).join('/');
  return matchesAny(relative, include) && !matchesAny(relative, exclude);
}

const NAMESPACE = 'aplos-design';

function toStylelintPlugin(core) {
  const ruleName = `${NAMESPACE}/${core.id}`;
  const rule = primary => async (root, result) => {
    if (!primary || !inScope(root.source && root.source.input.file)) return;
    const { default: stylelint } = await import('stylelint');
    const ctx = createCssContext({
      path: root.source && root.source.input.file,
      text: root.toString(),
      root,
    });
    for (const item of core.check(ctx)) {
      stylelint.utils.report({
        ruleName,
        result,
        message: item.message,
        node: item.node || root,
        start: { line: item.line, column: item.column },
      });
    }
  };
  rule.ruleName = ruleName;
  rule.messages = {};
  rule.meta = { url: 'tools/lint/design/README.md' };
  return { ruleName, rule };
}

export const plugins = coreRules
  .filter(core => core.appliesTo.includes('css'))
  .map(toStylelintPlugin);

export default plugins;
