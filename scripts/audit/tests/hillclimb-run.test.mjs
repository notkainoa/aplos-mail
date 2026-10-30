// CLI surface tests for run.mjs: --run-id lands in branch names and tmpdir names, so it is
// validated as a safe slug before anything is created; and the harness's own process.env
// is scrubbed to the eval/agent allow-lists before anything can spawn.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseArgs, scrubProcessEnv } from '../hillclimb/run.mjs';

describe('parseArgs --run-id', () => {
  it('accepts a valid slug', () => {
    const options = parseArgs(['config.json', '--run-id', 'r7-2026-02']);
    assert.equal(options.runId, 'r7-2026-02');
  });

  it('rejects ids that are not safe slugs', () => {
    const bad = ['-x', 'A', 'a_b', 'a/b', 'a b', 'a'.repeat(42), 'Ω', ''];
    for (const value of bad) {
      assert.throws(
        () => parseArgs(['config.json', '--run-id', value]),
        /--run-id/,
        JSON.stringify(value),
      );
    }
  });
});

describe('scrubProcessEnv', () => {
  it('deletes every variable not on the eval or agent allow-lists', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/h',
      NODE_OPTIONS: '--max-old-space-size=4096',
      npm_config_cache: '/c',
      XDG_CONFIG_HOME: '/cfg', // agent-only name, kept so agents can be spawned
      DEVIN_CONFIG_DIR: '/dc',
      NODE_AUTH_TOKEN: 'nt',
      NODE_PATH: '/x',
      DEVIN_API_KEY: 'dk',
      GITHUB_TOKEN: 'ghp_x',
      SSH_AUTH_SOCK: '/sock',
      AWS_SECRET_ACCESS_KEY: 'x',
      npm_config_registry: 'https://registry',
      'npm_config_//registry.npmjs.org/:_authToken': 'tok',
      LC_TIME: 'en_US.UTF-8',
    };
    scrubProcessEnv(env);
    assert.deepEqual(
      Object.keys(env).sort(),
      [
        'PATH',
        'HOME',
        'NODE_OPTIONS',
        'npm_config_cache',
        'XDG_CONFIG_HOME',
        'DEVIN_CONFIG_DIR',
      ].sort(),
    );
  });

  it('also scrubs NODE_OPTIONS carrying injection flags', () => {
    const env = { PATH: '/usr/bin', NODE_OPTIONS: '--require ./evil.js' };
    scrubProcessEnv(env);
    assert.deepEqual(env, { PATH: '/usr/bin' });
  });
});
