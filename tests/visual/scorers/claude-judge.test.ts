import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import {
  claudeArgs,
  createClaudeJudge,
  stageImages,
  type KillGroupFn,
  type SpawnFn,
} from './claude-judge';
import { scorerEnv } from './env';

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-judge-test-')));
  roots.push(dir);
  return dir;
}

interface Call {
  command: string;
  args: string[];
  options: SpawnOptions;
  stdin: string;
  filesInCwd: string[];
}

class FakeChild extends EventEmitter {
  stdin = Object.assign(new EventEmitter(), { end: (_text: string) => undefined });
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number | undefined;
  kills: string[] = [];
  kill(signal: string): boolean {
    this.kills.push(signal);
    return true;
  }
}

/** A killGroup stand-in that records `signal` per pid; ESRCH-throws when `gone` holds the pid. */
function recorder(gone = new Set<number>()): { killGroup: KillGroupFn; sent: string[] } {
  const sent: string[] = [];
  const killGroup: KillGroupFn = (pid, signal) => {
    sent.push(`${signal}:${pid}`);
    if (gone.has(pid)) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
  };
  return { killGroup, sent };
}

/** `pid` is only set for tests that inject killGroup, so a fake child can never signal a real group. */
function fake(
  behave: (child: FakeChild, call: Call) => void,
  pid?: number,
): { spawnFn: SpawnFn; calls: Call[] } {
  const calls: Call[] = [];
  const spawnFn: SpawnFn = (command, args, options) => {
    const child = new FakeChild();
    child.pid = pid;
    assert.equal(options.detached, true, 'the child leads its own process group');
    const call: Call = {
      command,
      args,
      options,
      stdin: '',
      filesInCwd: readdirSync(String(options.cwd)).sort(),
    };
    calls.push(call);
    child.stdin.end = (text: string) => {
      call.stdin = text;
      setImmediate(() => behave(child, call));
    };
    return child as unknown as ChildProcess;
  };
  return { spawnFn, calls };
}

const OK = JSON.stringify({ result: '{"criteria": {}}', total_cost_usd: 0.01 });

function makeShots(tmp: string): { a: string; b: string; scratch: string } {
  const scratch = join(tmp, 'scratch');
  const a = join(tmp, 'a-light.png');
  const b = join(tmp, 'b-dark.png');
  writeFileSync(a, 'AAA');
  writeFileSync(b, 'BBB');
  rmSync(scratch, { recursive: true, force: true });
  return { a, b, scratch };
}

test('the argv scopes Read to one directory and denies shell, editor and network tools', () => {
  const args = claudeArgs('claude-sonnet-5-5', '/tmp/aplos-taste-abc');
  const at = (flag: string): string => args[args.indexOf(flag) + 1] as string;
  assert.equal(at('--tools'), 'Read');
  assert.equal(at('--allowedTools'), 'Read(//tmp/aplos-taste-abc/**)');
  assert.equal(at('--disallowedTools'), 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch');
  assert.ok(args.includes('--restricted'));
  assert.ok(!args.includes('--add-dir'));
  assert.ok(!args.includes('--dangerously-skip-permissions'));
});

test('a call runs in a fresh dir holding only its PNGs, with an allow-listed env, and the dir is removed', async () => {
  const tmp = root();
  const { a, b } = makeShots(tmp);
  writeFileSync(join(tmp, 'unrelated.png'), 'X');
  const { spawnFn, calls } = fake(child => {
    child.stdout.emit('data', OK);
    child.emit('close', 0);
  });
  const env = scorerEnv({
    PATH: '/bin',
    HOME: '/h',
    GROQ_API_KEY: 'g',
    OPENAI_API_KEY: 'o',
    ANTHROPIC_API_KEY: 'a',
    CLAUDE_CONFIG_DIR: '/c',
    GITHUB_TOKEN: 't',
  });
  const { judge } = createClaudeJudge({
    bin: 'claude',
    model: 'm',
    images: [a, b, join(tmp, 'unrelated.png')],
    hardCap: 4,
    env,
    timeoutMs: 5_000,
    spawnFn,
    tmpRoot: tmp,
  });
  const answer = await judge(`1. SHOT light: ${a}\n2. REFERENCE: ${b}\nread them`);
  assert.equal(answer, '{"criteria": {}}');
  const call = calls[0] as Call;
  const cwd = String(call.options.cwd);
  assert.ok(cwd.startsWith(join(tmp, 'aplos-taste-')));
  assert.equal(call.filesInCwd.length, 2);
  assert.ok(call.filesInCwd.every(name => name.endsWith('.png')));
  assert.ok(!call.stdin.includes(a) && !call.stdin.includes(b), 'prompt points at the copies');
  assert.ok(call.stdin.includes(cwd));
  assert.deepEqual(call.options.env, env);
  assert.ok(call.args.includes(`Read(/${cwd}/**)`));
  assert.equal(
    readdirSync(tmp).filter(name => name.startsWith('aplos-taste-')).length,
    0,
    'scratch dir removed',
  );
});

test('ENOENT: error on the child and EPIPE on stdin settle once and leave no scratch dir', async () => {
  const tmp = root();
  const { a } = makeShots(tmp);
  const { spawnFn, calls } = fake(child => {
    child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    child.emit('close', -2);
  });
  const { judge } = createClaudeJudge({
    bin: 'claude',
    model: 'm',
    images: [a],
    hardCap: 4,
    env: {},
    timeoutMs: 5_000,
    spawnFn,
    tmpRoot: tmp,
  });
  await assert.rejects(judge(`image ${a}`), /cannot run claude: spawn claude ENOENT/);
  assert.equal(calls.length, 1);
  assert.equal(readdirSync(tmp).filter(name => name.startsWith('aplos-taste-')).length, 0);
});

test('EPIPE on stdin alone rejects, kills the child and cleans up; a late close changes nothing', async () => {
  const tmp = root();
  const { a } = makeShots(tmp);
  const { killGroup, sent } = recorder();
  const { spawnFn } = fake(child => {
    child.stderr.emit('data', 'not logged in');
    child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    child.stdout.emit('error', new Error('read error'));
    child.emit('close', 1);
  }, 4242);
  const { judge } = createClaudeJudge({
    bin: 'claude',
    model: 'm',
    images: [a],
    hardCap: 4,
    env: {},
    timeoutMs: 5_000,
    spawnFn,
    killGroup,
    graceMs: 60_000,
    tmpRoot: tmp,
  });
  await assert.rejects(judge(`image ${a}`), /claude stdin: write EPIPE not logged in/);
  assert.deepEqual(sent, ['SIGTERM:4242'], 'the group gets SIGTERM, SIGKILL waits out the grace');
  assert.equal(readdirSync(tmp).filter(name => name.startsWith('aplos-taste-')).length, 0);
});

test('a spawn that throws, a timeout and the call cap all reject cleanly', async () => {
  const tmp = root();
  const { a } = makeShots(tmp);
  const base = { bin: 'claude', model: 'm', images: [a], env: {}, tmpRoot: tmp };
  const thrower: SpawnFn = () => {
    throw new Error('EACCES');
  };
  const one = createClaudeJudge({ ...base, hardCap: 1, timeoutMs: 5_000, spawnFn: thrower });
  await assert.rejects(one.judge(`image ${a}`), /cannot run claude: EACCES/);
  await assert.rejects(one.judge(`image ${a}`), /call limit of 1 reached/);
  const silent = fake(() => undefined);
  const slow = createClaudeJudge({ ...base, hardCap: 2, timeoutMs: 20, spawnFn: silent.spawnFn });
  await assert.rejects(slow.judge(`image ${a}`), /timed out/);
  assert.equal(readdirSync(tmp).filter(name => name.startsWith('aplos-taste-')).length, 0);
  slow.dispose();
  slow.dispose();
  await assert.rejects(slow.judge('x'), /shut down/);
});

test('dispose kills a running call and removes its scratch dir', async () => {
  const tmp = root();
  const { a } = makeShots(tmp);
  let seen: FakeChild | undefined;
  const { killGroup, sent } = recorder();
  const { spawnFn } = fake(child => {
    seen = child;
  }, 4242);
  const { judge, dispose } = createClaudeJudge({
    bin: 'claude',
    model: 'm',
    images: [a],
    hardCap: 2,
    env: {},
    timeoutMs: 60_000,
    spawnFn,
    killGroup,
    tmpRoot: tmp,
  });
  const pending = judge(`image ${a}`).catch(error => error as Error);
  while (!seen) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(readdirSync(tmp).filter(name => name.startsWith('aplos-taste-')).length, 1);
  dispose();
  assert.deepEqual(sent, ['SIGKILL:4242']);
  assert.deepEqual(seen.kills, [], 'a child with a pid is killed through its group');
  assert.equal(readdirSync(tmp).filter(name => name.startsWith('aplos-taste-')).length, 0);
  seen.emit('close', 137);
  assert.ok((await pending) instanceof Error);
});

test('stageImages copies only the images the prompt names', () => {
  const tmp = root();
  const { a, b } = makeShots(tmp);
  const dir = mkdtempSync(join(tmp, 'stage-'));
  const out = stageImages(`only ${a}`, [a, b], dir);
  assert.ok(!out.includes(a));
  assert.equal(readdirSync(dir).length, 1);
  assert.equal(readFileSync(out.replace('only ', ''), 'utf8'), 'AAA');
});

test('a timeout SIGTERMs the group, then SIGKILLs it after the grace; ESRCH is ignored', async () => {
  const tmp = root();
  const { a } = makeShots(tmp);
  const { killGroup, sent } = recorder(new Set([4242]));
  const silent = fake(() => undefined, 4242);
  const { judge } = createClaudeJudge({
    bin: 'claude',
    model: 'm',
    images: [a],
    hardCap: 1,
    env: {},
    timeoutMs: 10,
    graceMs: 40,
    spawnFn: silent.spawnFn,
    killGroup,
    tmpRoot: tmp,
  });
  await assert.rejects(judge(`image ${a}`), /timed out/);
  assert.deepEqual(sent, ['SIGTERM:4242']);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.deepEqual(sent, ['SIGTERM:4242', 'SIGKILL:4242']);
});

test('dispose kills a group that is still inside its grace period right away', async () => {
  const tmp = root();
  const { a } = makeShots(tmp);
  const { killGroup, sent } = recorder();
  const silent = fake(() => undefined, 4242);
  const { judge, dispose } = createClaudeJudge({
    bin: 'claude',
    model: 'm',
    images: [a],
    hardCap: 1,
    env: {},
    timeoutMs: 10,
    graceMs: 60_000,
    spawnFn: silent.spawnFn,
    killGroup,
    tmpRoot: tmp,
  });
  await assert.rejects(judge(`image ${a}`), /timed out/);
  dispose();
  assert.deepEqual(sent, ['SIGTERM:4242', 'SIGKILL:4242']);
});

test('a finished call SIGKILLs its group so stray helpers do not outlive it', async () => {
  const tmp = root();
  const { a } = makeShots(tmp);
  const { killGroup, sent } = recorder(new Set([4242]));
  const { spawnFn } = fake(child => {
    child.stdout.emit('data', OK);
    child.emit('close', 0);
  }, 4242);
  const { judge } = createClaudeJudge({
    bin: 'claude',
    model: 'm',
    images: [a],
    hardCap: 1,
    env: {},
    timeoutMs: 5_000,
    spawnFn,
    killGroup,
    tmpRoot: tmp,
  });
  assert.equal(await judge(`image ${a}`), '{"criteria": {}}');
  assert.deepEqual(sent, ['SIGKILL:4242']);
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('a real timed-out call takes its TERM-ignoring grandchild down with it', async () => {
  const tmp = root();
  const { a } = makeShots(tmp);
  const pidFile = join(tmp, 'grandchild.pid');
  const bin = join(tmp, 'fake-claude.sh');
  writeFileSync(bin, '#!/bin/sh\ntrap "" TERM\nsleep 300 &\necho $! > "$PIDFILE"\nwait\n', {
    mode: 0o755,
  });
  const { judge } = createClaudeJudge({
    bin,
    model: 'm',
    images: [a],
    hardCap: 1,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', PIDFILE: pidFile },
    timeoutMs: 600,
    graceMs: 150,
    tmpRoot: tmp,
  });
  await assert.rejects(judge(`image ${a}`), /timed out/);
  const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
  assert.ok(grandchild > 1);
  assert.ok(alive(grandchild), 'still running right after SIGTERM, which it ignores');
  for (let waited = 0; alive(grandchild) && waited < 3_000; waited += 50)
    await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(alive(grandchild), false, 'SIGKILL to the group reached the grandchild');
});
