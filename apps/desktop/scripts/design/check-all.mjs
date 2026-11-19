#!/usr/bin/env node
// Every design gate in one command, for CI and the `test` script:
//   1. build-tokens.mjs --check  generated files match tokens.json, nothing stray
//   2. check-contrast.mjs        contrast, coverage and identity (DESIGN 12.4)
//   3. check-skill-tokens.mjs    the aplos-design skill names the current tokens (DESIGN 12.3)
//   4. node --test               the scripts/design unit tests
// Not wired into any package.json yet (that file belongs to another lane); until
// it is, CI does not enforce these gates. Exits 1 if any step fails.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function testFiles() {
  return readdirSync(here)
    .filter(name => name.endsWith('.test.mjs'))
    .sort()
    .map(name => join(here, name));
}

export function steps() {
  return [
    { name: 'generated files', args: [join(here, 'build-tokens.mjs'), '--check'] },
    { name: 'contrast and identity', args: [join(here, 'check-contrast.mjs')] },
    { name: 'skill tokens', args: [join(here, 'check-skill-tokens.mjs')] },
    { name: 'unit tests', args: ['--test', ...testFiles()] },
  ];
}

function main() {
  const failed = [];
  for (const step of steps()) {
    console.log(`\n== ${step.name} ==`);
    const result = spawnSync(process.execPath, step.args, { stdio: 'inherit' });
    if (result.status !== 0) {
      failed.push(step.name);
    }
  }
  console.log(
    failed.length === 0
      ? '\nAll design gates passed.'
      : `\nDesign gates failed: ${failed.join(', ')}.`,
  );
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
