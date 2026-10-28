// Flat ESLint config. Rules that need explaining live next to their setting.
// Existing violations are recorded in eslint-suppressions.json (npm run lint:baseline).
import { existsSync } from 'node:fs';
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import aplos from './tools/lint/eslint-plugin-aplos.mjs';

// UI-core's DESIGN section 12.2 rules plug in here (tools/lint/design/index.mjs).
const designConfig = existsSync(new URL('./tools/lint/design/index.mjs', import.meta.url))
  ? (await import('./tools/lint/design/index.mjs')).default
  : [];

const ENGINE_CORE = 'packages/engine/src/**';
const CONTRACT = 'packages/contract/src/**';
const RENDERER = 'apps/desktop/src/renderer/**';
const MAILFRAME = 'apps/desktop/src/renderer/mailframe/**';
const LEGACY = '**/legacy/**';

export const boundaryZones = [
  {
    name: 'engine-core',
    from: [ENGINE_CORE],
    except: [LEGACY],
    flagDynamic: true,
    deny: [
      {
        specifier: '^electron(/|$)',
        message: 'engine core must run outside Electron (ARCHITECTURE 2.6).',
      },
      {
        builtin: true,
        message: 'engine core takes no node: or Node builtin imports; go through a port (ARCHITECTURE 2.6).',
      },
    ],
  },
  {
    name: 'contract',
    from: [CONTRACT],
    except: [LEGACY],
    allow: {
      packages: ['zod'],
      relativeWithin: [CONTRACT],
      message: 'the contract imports only zod and its own files.',
    },
  },
  {
    name: 'renderer',
    from: [RENDERER],
    deny: [
      {
        path: [
          'apps/desktop/src/main/**',
          'apps/desktop/src/host/**',
          'apps/desktop/src/engine/**', // today's engine location, before the move to packages/engine
          'packages/engine/**',
        ],
        message: 'the renderer talks to the engine through the contract, not by importing it.',
      },
      {
        specifier: '^@aplos/engine(/|$)',
        message: 'the renderer talks to the engine through the contract, not by importing it.',
      },
      {
        specifier: '^(node:)?child_process$',
        message: 'the renderer must not spawn processes.',
      },
    ],
  },
  {
    name: 'legacy',
    from: ['**'],
    except: [LEGACY],
    deny: [{ segment: 'legacy', message: 'legacy/ code may be imported only by other legacy code.' }],
  },
];

const dangerouslySetInnerHTML = {
  selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
  message: 'dangerouslySetInnerHTML is allowed only in apps/desktop/src/renderer/mailframe (ARCHITECTURE 10).',
};

const SOURCE = ['**/*.{js,mjs,cjs,ts,mts,cts,tsx,jsx}'];

export default [
  {
    ignores: [
      '**/dist/**',
      '**/release/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/generated/**',
      'research/**',
      'plans/**',
      'mockups/**',
    ],
  },
  { linterOptions: { reportUnusedDisableDirectives: 'warn' } },
  { files: SOURCE, ...js.configs.recommended },
  ...tseslint.configs.recommended.map(config => ({ ...config, files: SOURCE })),
  {
    files: SOURCE,
    languageOptions: { globals: globals.node },
    plugins: { aplos },
    rules: {
      'max-lines': ['error', { max: 800, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 25],
      'no-restricted-syntax': ['error', dangerouslySetInnerHTML],
      'aplos/boundaries': ['error', { zones: boundaryZones }],
    },
  },
  {
    files: ['**/*.{tsx,jsx}'],
    plugins: { 'react-hooks': reactHooks },
    // Only the two classic rules. The React Compiler rules in v7's "recommended" preset cost
    // about 28 s of a 30 s run and mostly flag working code; revisit when the renderer is rewritten.
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error' },
  },
  {
    files: ['apps/desktop/src/renderer/**', 'apps/web/**'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: [RENDERER],
    rules: { 'no-eval': ['error', { allowIndirect: false }], 'no-new-func': 'error', 'no-implied-eval': 'error' },
  },
  { files: [MAILFRAME], rules: { 'no-restricted-syntax': 'off' } },
  ...designConfig,
];
