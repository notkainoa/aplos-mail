import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAgentInvocation, filteredEnv } from '../hillclimb/agent.mjs';

describe('buildAgentInvocation', () => {
  it('builds the devin argv with the brief file, never the brief text', () => {
    const out = buildAgentInvocation(
      { agent: 'swe-2', model: 'swe-2-high', timeoutSec: 10 },
      { briefFile: '/tmp/brief.md', briefText: '$(rm -rf /)' },
    );
    assert.equal(out.command, 'devin');
    assert.deepEqual(out.args, [
      '--model',
      'swe-2-high',
      '--permission-mode',
      'dangerous',
      '--respect-workspace-trust',
      'false',
      '-p',
      '--prompt-file',
      '/tmp/brief.md',
    ]);
    assert.equal(out.stdinText, undefined);
  });

  it('defaults the swe-2 model', () => {
    const out = buildAgentInvocation({ agent: 'swe-2' }, { briefFile: '/b' });
    assert.ok(out.args.includes('swe-2-high'));
  });

  it('builds the claude argv and passes the brief on stdin', () => {
    const out = buildAgentInvocation(
      { agent: 'claude', model: 'claude-opus-5-5' },
      { briefFile: '/b', briefText: 'the brief' },
    );
    assert.equal(out.command, 'claude');
    assert.deepEqual(out.args, [
      '-p',
      '--model',
      'claude-opus-5-5',
      '--permission-mode',
      'bypassPermissions',
    ]);
    assert.equal(out.stdinText, 'the brief');
  });

  it('omits --model for claude when unset', () => {
    const out = buildAgentInvocation({ agent: 'claude' }, { briefFile: '/b', briefText: 'x' });
    assert.ok(!out.args.includes('--model'));
  });

  it('builds the command agent as sh -c', () => {
    const out = buildAgentInvocation(
      { agent: 'command', command: 'echo hi > a.txt' },
      { briefFile: '/b' },
    );
    assert.equal(out.command, 'sh');
    assert.deepEqual(out.args, ['-c', 'echo hi > a.txt']);
  });
});

describe('filteredEnv', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    LANG: 'en_US',
    TMPDIR: '/tmp',
    NODE_OPTIONS: '--max-old-space-size=4096',
    npm_config_registry: 'https://registry',
    GROQ_API_KEY: 'gsk_x',
    OPENAI_API_KEY: 'sk-x',
    GITHUB_TOKEN: 'ghp_x',
    AWS_SECRET_ACCESS_KEY: 'x',
    DB_PASSWORD: 'x',
    CLIENT_CREDENTIAL: 'x',
    SSH_PRIVATE_KEY: 'x',
    SOME_KEY: 'x',
    api_key_lowercase: 'x',
    MY_TOKEN_VALUE: 'x',
    USER: 'u',
    EDITOR: 'vim',
  };
  const out = filteredEnv(env);

  it('drops anything secret-shaped', () => {
    for (const name of [
      'GROQ_API_KEY',
      'OPENAI_API_KEY',
      'GITHUB_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'DB_PASSWORD',
      'CLIENT_CREDENTIAL',
      'SSH_PRIVATE_KEY',
      'SOME_KEY',
      'api_key_lowercase',
      'MY_TOKEN_VALUE',
    ]) {
      assert.ok(!(name in out), `${name} must be dropped`);
    }
  });

  it('keeps the ordinary environment', () => {
    for (const name of [
      'PATH',
      'HOME',
      'LANG',
      'TMPDIR',
      'NODE_OPTIONS',
      'npm_config_registry',
      'USER',
      'EDITOR',
    ]) {
      assert.equal(out[name], env[name], `${name} must survive`);
    }
  });
});
