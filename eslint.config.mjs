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
// The contract's own files: its source and the allowlists and client generated from its registry.
const CONTRACT = ['packages/contract/src/**', 'packages/contract/generated/**'];
const RENDERER = 'apps/desktop/src/renderer/**';
const MAILFRAME = 'apps/desktop/src/renderer/mailframe/**';
// Legacy code lives only in these two roots (restructure step 1). A folder that merely happens
// to be called legacy elsewhere gets no exemption.
const ENGINE_LEGACY = 'packages/engine/src/legacy/**';
const CONTRACT_LEGACY = 'packages/contract/src/legacy/**';
const LEGACY_ROOTS = [ENGINE_LEGACY, CONTRACT_LEGACY];

export const boundaryZones = [
  {
    name: 'engine-core',
    from: [ENGINE_CORE],
    except: [ENGINE_LEGACY],
    flagDynamic: true,
    deny: [
      {
        // electron, electron/main, electron-updater, electron-log, @electron/remote, ...
        specifier: '^(@electron/|electron(-[\\w.-]+)?(/|$))',
        message: 'engine core must run outside Electron (ARCHITECTURE 2.6).',
      },
      {
        builtin: true,
        message:
          'engine core takes no node: or Node builtin imports; go through a port (ARCHITECTURE 2.6).',
      },
    ],
  },
  {
    name: 'contract',
    from: CONTRACT,
    except: [CONTRACT_LEGACY],
    flagDynamic: true,
    allow: {
      packages: ['zod'],
      relativeWithin: CONTRACT,
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
    except: LEGACY_ROOTS,
    deny: [
      { segment: 'legacy', message: 'legacy/ code may be imported only by other legacy code.' },
    ],
  },
];

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
      // A plugin rule, not no-restricted-syntax: flat config replaces a rule's options wholesale,
      // so UI-core's design rules (which use no-restricted-syntax) could otherwise erase this ban.
      'aplos/no-dangerous-html': 'error',
      'aplos/boundaries': ['error', { zones: boundaryZones }],
      // A leading underscore marks a binding that is unused on purpose.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
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
    rules: {
      'no-eval': ['error', { allowIndirect: false }],
      'no-new-func': 'error',
      'no-implied-eval': 'error',
    },
  },
  { files: [MAILFRAME], rules: { 'aplos/no-dangerous-html': 'off' } },
  {
    // Engine core and the contract must not reach Node modules without an import either.
    // process and Buffer stay allowed: the engine may run in plain Node (ARCHITECTURE 2.6).
    // Do not set these two rules for these paths elsewhere: a later config replaces the whole list.
    files: [ENGINE_CORE, ...CONTRACT],
    ignores: [ENGINE_LEGACY, CONTRACT_LEGACY],
    rules: {
      'no-restricted-properties': [
        'error',
        ...['getBuiltinModule', 'binding', 'dlopen', 'mainModule'].map(property => ({
          object: 'process',
          property,
          message: 'no Node module loading in engine core; go through a port (ARCHITECTURE 2.6).',
        })),
        ...['globalThis', 'global'].map(object => ({
          object,
          property: 'require',
          message: 'no CommonJS require in engine core.',
        })),
        { object: 'module', property: 'require', message: 'no CommonJS require in engine core.' },
      ],
      'no-restricted-globals': [
        'error',
        ...['require', 'module', '__dirname', '__filename'].map(name => ({
          name,
          message: 'CommonJS globals are not available in engine core (ARCHITECTURE 2.6).',
        })),
      ],
    },
  },
  ...designConfig,
];
