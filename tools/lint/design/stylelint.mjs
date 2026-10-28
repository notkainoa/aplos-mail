// The DESIGN section 12.2 CSS rules for stylelint.config.mjs, which merges { plugins, rules }.
// stylelint's hook has no per-file scope, so each rule checks config.mjs's include and exclude
// itself (stylelint-plugin.mjs) and skips files outside the new renderer tree.
import { fileURLToPath } from 'node:url';
import { plugins } from './stylelint-plugin.mjs';

export default {
  plugins: [fileURLToPath(new URL('./stylelint-plugin.mjs', import.meta.url))],
  rules: {
    // Off by owner decision (owner-thread DECIDED 2026-10-28): BEM state selectors legitimately follow the base rule.
    'no-descending-specificity': null,
    ...Object.fromEntries(plugins.map(({ ruleName }) => [ruleName, true])),
    // Component classes are kebab-case blocks with BEM elements and modifiers:
    // ui-list-row, ui-list-row__date, ui-button--filled.
    'selector-class-pattern': [
      '^[a-z][a-z0-9]*(-[a-z0-9]+)*(__[a-z0-9]+(-[a-z0-9]+)*)?(--[a-z0-9]+(-[a-z0-9]+)*)?$',
      { message: 'Use kebab-case blocks with __element and --modifier (ui-list-row__date)' },
    ],
  },
};
