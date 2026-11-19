// The DESIGN section 12.2 rules as flat ESLint config objects, spread by eslint.config.mjs.
// Scope comes from config.mjs: the new renderer tree, minus legacy/, the token sources,
// generated files, tests and this tool's fixtures. CSS rules run through stylelint.mjs.
import plugin from './eslint-plugin.mjs';
import { exclude } from './config.mjs';

export default [
  // The fixtures plant violations on purpose so the rules' tests can see them fail.
  { ignores: ['tools/lint/design/fixtures/**'] },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    ignores: exclude,
    plugins: { 'aplos-design': plugin },
    rules: plugin.configs.all.rules,
  },
];
