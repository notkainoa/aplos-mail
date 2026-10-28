// Which files the design lint covers by default, and what it never covers.
// Exempt: the token sources and generated files only (DESIGN 12.2), plus
// test files and this tool's own fixtures, which plant violations on purpose.
// There are no inline disable comments.
//
// Contract with the token generator: it writes
// apps/desktop/src/renderer/ui/generated/tokens.css, motion.ts and
// contrast-pairs.json, and nothing else is exempt. A generator that wrote
// ui/tokens.css or ui/motion.ts instead would be linted like any other file.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(here, '../../..');

export const include = ['apps/desktop/src/renderer/**/*.{css,ts,tsx}'];

export const alwaysExclude = [
  'apps/desktop/src/renderer/legacy/**',
  'apps/desktop/src/renderer/ui/tokens.json',
  'apps/desktop/src/renderer/ui/generated/**',
  'tools/lint/design/fixtures/**',
  '**/*.test.{ts,tsx,mjs}',
  '**/*.d.ts',
];

// Today's renderer lives in renderer/legacy/ (restructure step 1) and is never linted;
// Phase 2 deletes it.
export const exclude = alwaysExclude;
