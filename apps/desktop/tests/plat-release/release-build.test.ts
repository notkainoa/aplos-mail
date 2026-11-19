import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Only the refusals that end before electron-builder or any upload runs: an ad-hoc build is never uploaded.
const script = fileURLToPath(new URL('../../scripts/release-build.mjs', import.meta.url));
function run(args: string[]) {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && !/^(CSC_|APPLE_|GH_TOKEN$|GITHUB_TOKEN$)/.test(name))
      env[name] = value;
  return spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 30_000 });
}

test('--publish always without a Developer ID certificate refuses before packaging', () => {
  const result = run(['--publish', 'always']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--publish always needs a Developer ID certificate/);
  assert.doesNotMatch(result.stdout, /building ad-hoc|uploading/);
});

test('--publish always cannot take --expect adhoc', () => {
  const result = run(['--publish', 'always', '--expect', 'adhoc']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cannot take --expect adhoc/);
});
