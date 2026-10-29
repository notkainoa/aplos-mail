import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, it } from 'node:test';
import { buildAgentInvocation, filteredEnv, runLogged } from '../hillclimb/agent.mjs';
import { runGate, runScorer } from '../hillclimb/steps.mjs';

// The log lives directly under tmpdir: runLogged closes its write stream asynchronously,
// so a test-owned directory removed at teardown could still race the open.
const logPath = join(tmpdir(), `hillclimb-agent-${process.pid.toString(36)}.log`);
after(() => rmSync(logPath, { force: true }));

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

describe('filteredEnv allow-list', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    USER: 'u',
    LOGNAME: 'u',
    SHELL: '/bin/zsh',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    LC_CTYPE: 'UTF-8',
    TERM: 'xterm-256color',
    TMPDIR: '/tmp',
    TZ: 'UTC',
    CI: 'true',
    NODE_OPTIONS: '--max-old-space-size=4096',
    NODE_PATH: '/x',
    npm_config_registry: 'https://registry',
    NPM_CONFIG_CACHE: '/c',
    DEVIN_API_KEY: 'dk-allowed',
    XDG_CONFIG_HOME: '/cfg',
    // Everything below must be dropped: anything not allow-listed is a leak risk.
    AWS_ACCESS_KEY_ID: 'AKIA',
    AWS_SECRET_ACCESS_KEY: 'x',
    SSH_AUTH_SOCK: '/sock',
    DATABASE_URL: 'postgres://x',
    GITHUB_TOKEN: 'ghp_x',
    FOO_PAT: 'x',
    MY_PASS: 'x',
    EDITOR: 'vim',
    ANTHROPIC_API_KEY: 'sk-ant',
    OPENAI_API_KEY: 'sk-x',
    GROQ_API_KEY: 'gsk_x',
    DOCKER_HOST: 'tcp://x',
    BASH_ENV: '/evil',
    ENV: '/evil',
    PS1: 'x',
  };
  const out = filteredEnv(env);

  it('keeps only the allow-listed names', () => {
    const expected = [
      'PATH',
      'HOME',
      'USER',
      'LOGNAME',
      'SHELL',
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'TERM',
      'TMPDIR',
      'TZ',
      'CI',
      'NODE_OPTIONS',
      'NODE_PATH',
      'npm_config_registry',
      'NPM_CONFIG_CACHE',
      'DEVIN_API_KEY',
      'XDG_CONFIG_HOME',
    ];
    for (const name of expected) assert.equal(out[name], env[name], `${name} must survive`);
    assert.deepEqual(Object.keys(out).sort(), expected.sort());
  });

  it('drops everything else, secrets or not', () => {
    for (const name of [
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'SSH_AUTH_SOCK',
      'DATABASE_URL',
      'GITHUB_TOKEN',
      'FOO_PAT',
      'MY_PASS',
      'EDITOR',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GROQ_API_KEY',
      'DOCKER_HOST',
      'BASH_ENV',
      'ENV',
      'PS1',
    ]) {
      assert.ok(!(name in out), `${name} must be dropped`);
    }
  });
});

// A minimal fake ChildProcess: EventEmitter plus pipe streams. pid is fake so killTree's
// group kill throws ESRCH and falls back to the stubbed child.kill.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = 987654;
  child.kill = () => {};
  return child;
}

describe('runLogged', () => {
  it('resolves on exit even when close never comes (grandchild holding pipes)', async () => {
    const child = fakeChild();
    const promise = runLogged(
      { command: 'x', args: [], logPath, timeoutMs: 0, graceMs: 30 },
      { spawnFn: () => child },
    );
    child.stdout.end('done\n');
    child.stderr.end();
    child.emit('exit', 0, null); // 'close' never fires
    const res = await promise;
    assert.equal(res.code, 0);
  });

  it('keeps a stdout-only tail beside the combined tail', async () => {
    const child = fakeChild();
    const promise = runLogged({ command: 'x', args: [], logPath, timeoutMs: 0 }, {
      spawnFn: () => child,
    });
    child.stdout.write('{"score": 7}\n');
    child.stderr.write('{"score": 999}\n');
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0, null);
    const res = await promise;
    assert.match(res.stdoutTail, /\{"score": 7\}/);
    assert.ok(!res.stdoutTail.includes('999'));
    assert.match(res.tail, /999/); // combined tail still has stderr
  });

  it('ignores EPIPE on stdin instead of crashing', async () => {
    const child = fakeChild();
    const promise = runLogged(
      { command: 'x', args: [], stdinText: 'brief', logPath, timeoutMs: 0 },
      { spawnFn: () => child },
    );
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0, null);
    const res = await promise;
    assert.equal(res.code, 0);
  });

  it('kills the group on timeout and reports the leader exit', async () => {
    const child = fakeChild();
    const promise = runLogged(
      { command: 'x', args: [], logPath, timeoutMs: 20, graceMs: 5 },
      { spawnFn: () => child },
    );
    // The timeout fires first; the leader then exits while pipes stay open.
    setTimeout(() => child.emit('exit', null, 'SIGKILL'), 40);
    const res = await promise;
    assert.equal(res.timedOut, true);
    assert.equal(res.signal, 'SIGKILL');
  });
});

describe('gate/scorer environment and scorer stdout contract', () => {
  it('runs gates with the allow-listed env, not process.env', async () => {
    const prevSock = process.env.SSH_AUTH_SOCK;
    process.env.HILLCLIMB_TEST_LEAK = 'must-not-see';
    process.env.SSH_AUTH_SOCK = '/sock-for-test';
    let seen;
    const child = fakeChild();
    const spawnFn = (cmd, args, opts) => {
      seen = opts.env;
      return child;
    };
    try {
      const promise = runGate(
        { name: 'g', command: 'true', timeoutSec: 5 },
        { workdir: '/w', logPath, spawnFn },
      );
      child.emit('close', 0, null);
      await promise;
      assert.ok(!('HILLCLIMB_TEST_LEAK' in seen));
      assert.ok(!('SSH_AUTH_SOCK' in seen));
      assert.equal(seen.PATH, process.env.PATH);
    } finally {
      delete process.env.HILLCLIMB_TEST_LEAK;
      if (prevSock === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = prevSock;
    }
  });

  it('parses the scorer JSON from stdout only, even when stderr ends the log', async () => {
    const child = fakeChild();
    const promise = runScorer(
      { name: 's', command: 'x', timeoutSec: 5 },
      { workdir: '/w', logPath, spawnFn: () => child },
    );
    child.stdout.write('work\n{"score": 7, "details": []}\n');
    child.stderr.write('{"score": 999}\n'); // would corrupt a combined-tail parse
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0, null);
    const res = await promise;
    assert.equal(res.ok, true);
    assert.equal(res.score, 7);
  });
});
