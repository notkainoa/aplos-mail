// ESLint 9 flat-config adapter. Every rule runs the matching core check on the
// whole file text at Program and reports at the returned locations. Not
// executed in Phase 0 (ESLint is not installed); see README.md.
//
//   import aplosDesign from './tools/lint/design/eslint-plugin.mjs';
//   export default [{ plugins: { 'aplos-design': aplosDesign }, rules: { ...aplosDesign.configs.all.rules } }];

import { createTsContext } from './lib/context.mjs';
import { rules as coreRules } from './rules/index.mjs';

function toEslintRule(core) {
  return {
    meta: {
      type: 'problem',
      docs: { description: core.description },
      schema: [],
      messages: { violation: '{{ message }}' },
    },
    create(context) {
      return {
        Program() {
          const ctx = createTsContext({ path: context.filename, text: context.sourceCode.text });
          for (const item of core.check(ctx)) {
            context.report({
              loc: { line: item.line, column: item.column - 1 },
              messageId: 'violation',
              data: { message: item.message },
            });
          }
        },
      };
    },
  };
}

const tsRules = coreRules.filter(rule => rule.appliesTo.includes('ts'));

export const rules = Object.fromEntries(tsRules.map(rule => [rule.id, toEslintRule(rule)]));

const plugin = {
  meta: { name: 'eslint-plugin-aplos-design' },
  rules,
  configs: {},
};

plugin.configs.all = {
  plugins: { 'aplos-design': plugin },
  rules: Object.fromEntries(tsRules.map(rule => [`aplos-design/${rule.id}`, 'error'])),
};

export default plugin;
