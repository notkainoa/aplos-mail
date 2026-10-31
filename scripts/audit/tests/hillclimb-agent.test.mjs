import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, it } from 'node:test';
import {
  agentEnv,
  buildAgentInvocation,
  evalEnv,
  filteredEnv,
  runAgent,
  runLogged,
} from '../hillclimb/agent.mjs';
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

describe('agentEnv/evalEnv allow-lists', () => {
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    USER: 'u',
    LOGNAME: 'u',
    SHELL: '/bin/zsh',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    LC_CTYPE: 'UTF-8',
    LC_MESSAGES: 'en_US.UTF-8',
    TERM: 'xterm-256color',
    TMPDIR: '/tmp',
    TZ: 'UTC',
    CI: 'true',
    NODE_ENV: 'test',
    NODE_OPTIONS: '--max-old-space-size=4096',
    npm_config_cache: '/c',
    npm_config_loglevel: 'warn',
    npm_config_progress: 'false',
    npm_config_update_notifier: 'false',
    XDG_CACHE_HOME: '/xc',
    XDG_DATA_HOME: '/xd',
    // Agents only — the CLIs' login-discovery names.
    XDG_CONFIG_HOME: '/cfg',
    DEVIN_CONFIG_DIR: '/dc',
    DEVIN_HOME: '/dh',
    CLAUDE_CONFIG_DIR: '/cc',
    // Everything below must be dropped in BOTH: prefix-shaped secrets and injection
    // vectors are exactly what the named-only list exists to stop.
    NODE_PATH: '/x',
    NODE_AUTH_TOKEN: 'nt',
    npm_config_registry: 'https://registry',
    'npm_config_//registry.npmjs.org/:_authToken': 'tok',
    NPM_CONFIG_CACHE: '/C',
    LC_TIME: 'en_US.UTF-8',
    DEVIN_API_KEY: 'dk',
    ANTHROPIC_API_KEY: 'sk-ant',
    OPENAI_API_KEY: 'sk-x',
    GROQ_API_KEY: 'gsk_x',
    AWS_ACCESS_KEY_ID: 'AKIA',
    AWS_SECRET_ACCESS_KEY: 'x',
    AWS_SESSION_TOKEN: 't',
    SSH_AUTH_SOCK: '/sock',
    DATABASE_URL: 'postgres://x',
    GITHUB_TOKEN: 'ghp_x',
    FOO_PAT: 'x',
    MY_PASS: 'x',
    EDITOR: 'vim',
    DOCKER_HOST: 'tcp://x',
    BASH_ENV: '/evil',
    ENV: '/evil',
    PS1: 'x',
  };
  const COMMON = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'LC_MESSAGES',
    'TERM',
    'TMPDIR',
    'TZ',
    'CI',
    'NODE_ENV',
    'NODE_OPTIONS',
    'npm_config_cache',
    'npm_config_loglevel',
    'npm_config_progress',
    'npm_config_update_notifier',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
  ];
  const AGENT_ONLY = ['XDG_CONFIG_HOME', 'DEVIN_CONFIG_DIR', 'DEVIN_HOME', 'CLAUDE_CONFIG_DIR'];
  const agent = agentEnv(env);
  const evald = evalEnv(env);

  it('agentEnv keeps the common names plus the CLI login-discovery names', () => {
    const expected = [...COMMON, ...AGENT_ONLY];
    for (const name of expected) assert.equal(agent[name], env[name], `${name} must survive`);
    assert.deepEqual(Object.keys(agent).sort(), expected.sort());
  });

  it('evalEnv keeps the common names and nothing agent-only, plus the harness-set SCORER_ISOLATED=1', () => {
    assert.deepEqual(Object.keys(evald).sort(), [...COMMON, 'SCORER_ISOLATED'].sort());
    assert.equal(evald.SCORER_ISOLATED, '1');
    for (const name of AGENT_ONLY) assert.ok(!(name in evald), `${name} must be dropped`);
  });

  it('SCORER_ISOLATED is set by the harness, never inherited, and UI scorers get no APLOS_VISUAL_PORT', () => {
    const hostile = { ...env, SCORER_ISOLATED: '0', APLOS_VISUAL_PORT: '5173' };
    assert.equal(
      evalEnv(hostile).SCORER_ISOLATED,
      '1',
      'an inherited value cannot switch isolation off',
    );
    assert.ok(
      !('APLOS_VISUAL_PORT' in evalEnv(hostile)),
      'the visual port must not reach a scorer',
    );
    assert.ok(
      !('SCORER_ISOLATED' in agentEnv(hostile)),
      'agents do not run scorers and get neither value',
    );
  });

  it('drops prefix-shaped secrets and injection vectors in both', () => {
    for (const name of [
      'NODE_PATH',
      'NODE_AUTH_TOKEN',
      'npm_config_registry',
      'npm_config_//registry.npmjs.org/:_authToken',
      'NPM_CONFIG_CACHE',
      'LC_TIME',
      'DEVIN_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GROQ_API_KEY',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'SSH_AUTH_SOCK',
      'DATABASE_URL',
      'GITHUB_TOKEN',
      'FOO_PAT',
      'MY_PASS',
      'EDITOR',
      'DOCKER_HOST',
      'BASH_ENV',
      'ENV',
      'PS1',
    ]) {
      assert.ok(!(name in agent), `agentEnv must drop ${name}`);
      assert.ok(!(name in evald), `evalEnv must drop ${name}`);
    }
  });

  it('drops NODE_OPTIONS carrying injection flags, keeps benign options', () => {
    for (const bad of [
      '--require /x',
      '-r /x',
      '-r./x',
      '-rx',
      '--require=/x',
      '--import=x',
      '--loader /x',
      '--experimental-loader /x',
      '--max-old-space-size=4096 -r ./preload.js',
    ]) {
      for (const filter of [agentEnv, evalEnv]) {
        assert.ok(!('NODE_OPTIONS' in filter({ NODE_OPTIONS: bad })), bad);
      }
    }
    assert.equal(
      agentEnv({ NODE_OPTIONS: '--max-old-space-size=4096' }).NODE_OPTIONS,
      '--max-old-space-size=4096',
    );
  });

  it('keeps filteredEnv as the agent-side alias', () => {
    assert.equal(filteredEnv, agentEnv);
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
    const promise = runLogged(
      { command: 'x', args: [], logPath, timeoutMs: 0 },
      {
        spawnFn: () => child,
      },
    );
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

  it('kills the group and stops writing when the log passes maxLogBytes', async () => {
    const child = fakeChild();
    let killed = false;
    child.kill = () => {
      killed = true;
    };
    const capLog = join(tmpdir(), `hillclimb-cap-${process.pid.toString(36)}.log`);
    const promise = runLogged(
      { command: 'x', args: [], logPath: capLog, timeoutMs: 0, maxLogBytes: 16 },
      { spawnFn: () => child },
    );
    child.stdout.write('a'.repeat(10));
    assert.equal(killed, false);
    child.stdout.write('b'.repeat(10)); // 20 bytes > 16: overflow
    assert.equal(killed, true);
    child.stdout.write('c'.repeat(100)); // past the cap: never reaches the file
    child.stdout.end();
    child.stderr.end();
    child.emit('close', null, 'SIGKILL');
    const res = await promise;
    assert.equal(res.logOverflow, true);
    rmSync(capLog, { force: true });
  });

  it('reaps a real process group that floods its log', async () => {
    const capLog = join(tmpdir(), `hillclimb-cap-real-${process.pid.toString(36)}.log`);
    const res = await runLogged(
      {
        command: process.execPath,
        args: ['-e', 'process.stdout.write("x".repeat(1 << 20)); setInterval(() => {}, 1000)'],
        logPath: capLog,
        timeoutMs: 30_000,
        maxLogBytes: 64 * 1024,
      },
      { spawnFn: spawn },
    );
    assert.equal(res.logOverflow, true);
    assert.equal(res.signal, 'SIGKILL');
    assert.ok(statSync(capLog).size <= 64 * 1024);
    rmSync(capLog, { force: true });
  });

  it('leaves maxLogBytes unset (uncapped) by default', async () => {
    const child = fakeChild();
    const promise = runLogged(
      { command: 'x', args: [], logPath, timeoutMs: 0 },
      { spawnFn: () => child },
    );
    child.stdout.end('small\n');
    child.stderr.end();
    child.emit('close', 0, null);
    const res = await promise;
    assert.equal(res.logOverflow, false);
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
  it('runs gates with the eval env: runtime names only, no agent-only names', async () => {
    const prev = {};
    for (const name of ['SSH_AUTH_SOCK', 'HILLCLIMB_TEST_LEAK', 'DEVIN_CONFIG_DIR']) {
      prev[name] = process.env[name];
    }
    process.env.HILLCLIMB_TEST_LEAK = 'must-not-see';
    process.env.SSH_AUTH_SOCK = '/sock-for-test';
    process.env.DEVIN_CONFIG_DIR = '/dc-for-test';
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
      assert.ok(!('DEVIN_CONFIG_DIR' in seen), 'gates must not see agent login dirs');
      assert.equal(seen.PATH, process.env.PATH);
    } finally {
      for (const [name, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('runs agents with the agent env: CLI login names survive, secrets never do', async () => {
    const prev = {};
    for (const name of ['DEVIN_CONFIG_DIR', 'DEVIN_API_KEY', 'NODE_AUTH_TOKEN']) {
      prev[name] = process.env[name];
    }
    process.env.DEVIN_CONFIG_DIR = '/dc-for-test';
    process.env.DEVIN_API_KEY = 'dk-secret';
    process.env.NODE_AUTH_TOKEN = 'nt-secret';
    let seen;
    const child = fakeChild();
    const spawnFn = (cmd, args, opts) => {
      seen = opts.env;
      return child;
    };
    try {
      const promise = runAgent(
        { agent: 'command', command: 'true', timeoutSec: 5 },
        { workdir: '/w', logPath, spawnFn },
      );
      child.emit('close', 0, null);
      await promise;
      assert.equal(seen.DEVIN_CONFIG_DIR, '/dc-for-test');
      assert.ok(!('DEVIN_API_KEY' in seen));
      assert.ok(!('NODE_AUTH_TOKEN' in seen));
      assert.equal(seen.PATH, process.env.PATH);
    } finally {
      for (const [name, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
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
