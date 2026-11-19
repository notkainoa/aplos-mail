import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { log } from './common';
import type { Judge } from './taste-score';

// The `claude -p` judge, kept apart from taste.score.ts so tests can inject spawn. The screenshots
// are attempt-authored and the judge reads on-screen text, so a hostile screenshot must reach nothing
// valuable: the child gets an allow-listed env (env.ts), runs in a fresh directory holding only the
// PNGs of that one call, may only Read inside it, and has no shell, editor or network tools.

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

const DENIED_TOOLS = 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch';
const MAX_OUTPUT_BYTES = 2_000_000;
const KILL_GRACE_MS = 2_000;

/** Signals a whole process group (`-pid`); the child is spawned detached so it leads its own group. */
export type KillGroupFn = (pid: number, signal: NodeJS.Signals) => void;

const killProcessGroup: KillGroupFn = (pid, signal) => process.kill(-pid, signal);

/** The argv for one call, scoped to `dir` (an absolute, symlink-free path). `//` is a filesystem-root path rule. */
export function claudeArgs(model: string, dir: string): string[] {
  return [
    '-p',
    '--model',
    model,
    '--output-format',
    'json',
    '--restricted',
    '--strict-mcp-config',
    '--tools',
    'Read',
    '--allowedTools',
    `Read(/${dir}/**)`,
    '--disallowedTools',
    DENIED_TOOLS,
    '--no-session-persistence',
    '--disable-slash-commands',
    '--max-budget-usd',
    '2',
  ];
}

/**
 * Copies each of `paths` that the prompt mentions into `dir` and points the prompt at the copy, so
 * the judge's whole file scope is that one directory. Returns the rewritten prompt.
 */
export function stageImages(prompt: string, paths: readonly string[], dir: string): string {
  let staged = prompt;
  const longestFirst = [...new Set(paths)].sort((a, b) => b.length - a.length);
  longestFirst.forEach((path, index) => {
    if (!staged.includes(path)) return;
    const copy = join(dir, `${index + 1}-${basename(path)}`);
    copyFileSync(path, copy);
    staged = staged.split(path).join(copy);
  });
  return staged;
}

export interface ClaudeJudgeOptions {
  bin: string;
  model: string;
  /** Every screenshot path a prompt may mention. */
  images: readonly string[];
  /** At most this many calls are ever made in this process. */
  hardCap: number;
  env: Record<string, string>;
  timeoutMs: number;
  spawnFn?: SpawnFn;
  /** Test seam for process.kill(-pid, signal). */
  killGroup?: KillGroupFn;
  /** How long a timed-out call may take to exit after SIGTERM before its group is SIGKILLed. */
  graceMs?: number;
  tmpRoot?: string;
}

export interface ClaudeJudge {
  judge: Judge;
  /** Kills any running call and removes every scratch directory. Safe to call twice. */
  dispose: () => void;
}

interface Run {
  bin: string;
  args: string[];
  prompt: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  spawnFn: SpawnFn;
  running: Set<ChildProcess>;
  reaper: Reaper;
}

/** Stops claude children and every helper they spawned: SIGTERM first, then SIGKILL to the group after a grace. */
interface Reaper {
  /** Sends `signal` to the child's whole group (or to the child alone when it has no pid). ESRCH is ignored. */
  signal: (child: ChildProcess, signal: NodeJS.Signals) => void;
  /** SIGTERM now, SIGKILL after the grace period. */
  terminate: (child: ChildProcess) => void;
  /** SIGKILL every child still waiting out its grace period. */
  flush: () => void;
}

function createReaper(killGroup: KillGroupFn, graceMs: number): Reaper {
  const waiting = new Map<NodeJS.Timeout, () => void>();
  const signal = (child: ChildProcess, name: NodeJS.Signals): void => {
    try {
      if (child.pid === undefined) child.kill(name);
      else killGroup(child.pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const terminate = (child: ChildProcess): void => {
    signal(child, 'SIGTERM');
    const finish = (): void => signal(child, 'SIGKILL');
    const timer = setTimeout(() => {
      waiting.delete(timer);
      finish();
    }, graceMs);
    timer.unref();
    waiting.set(timer, finish);
  };
  const flush = (): void => {
    for (const [timer, finish] of waiting) {
      clearTimeout(timer);
      finish();
    }
    waiting.clear();
  };
  return { signal, terminate, flush };
}

/** One claude process. The promise settles exactly once, on whichever of close, error or timeout comes first. */
function runClaude(run: Run): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = run.spawnFn(run.bin, run.args, {
        cwd: run.cwd,
        env: run.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
    } catch (error) {
      reject(new Error(`cannot run ${run.bin}: ${messageOf(error)}`));
      return;
    }
    run.running.add(child);
    let out = '';
    let err = '';
    let settled = false;
    const settle = (finish: () => void, exited = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.running.delete(child);
      if (exited) run.reaper.signal(child, 'SIGKILL');
      else run.reaper.terminate(child);
      finish();
    };
    const fail = (what: string) => (error: unknown) =>
      settle(() =>
        reject(new Error(`${what}: ${messageOf(error)} ${err.trim().slice(0, 200)}`.trim())),
      );
    const timer = setTimeout(() => fail('claude timed out')('after the limit'), run.timeoutMs);
    const collect = (add: (text: string) => void) => (chunk: Buffer | string) => {
      add(String(chunk));
      if (out.length + err.length > MAX_OUTPUT_BYTES) fail('claude output')('over the size limit');
    };
    child.on('error', fail(`cannot run ${run.bin}`));
    child.stdin?.on('error', fail('claude stdin'));
    child.stdout?.on('error', fail('claude stdout'));
    child.stderr?.on('error', fail('claude stderr'));
    child.stdout?.on(
      'data',
      collect(text => (out += text)),
    );
    child.stderr?.on(
      'data',
      collect(text => (err += text)),
    );
    child.on('close', code =>
      settle(() => {
        try {
          resolve(readClaudeResult(out, code, err));
        } catch (error) {
          reject(error);
        }
      }, true),
    );
    try {
      child.stdin?.end(run.prompt);
    } catch (error) {
      fail('claude stdin')(error);
    }
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function readClaudeResult(out: string, code: number | null, err: string): string {
  let parsed: { is_error?: boolean; result?: unknown; total_cost_usd?: number } | null = null;
  try {
    parsed = JSON.parse(out.trim().split('\n').pop() ?? '');
  } catch {
    parsed = null;
  }
  if (!parsed) throw new Error(`claude exit ${code}: ${(err || out).trim().slice(0, 300)}`);
  if (typeof parsed.total_cost_usd === 'number')
    log(`judge call cost $${parsed.total_cost_usd.toFixed(3)}`);
  if (parsed.is_error || typeof parsed.result !== 'string')
    throw new Error(`claude reported an error: ${String(parsed.result ?? err).slice(0, 300)}`);
  return parsed.result;
}

/** A judge that runs `claude -p` once per call in its own scratch directory, removed afterwards. */
export function createClaudeJudge(options: ClaudeJudgeOptions): ClaudeJudge {
  const running = new Set<ChildProcess>();
  const dirs = new Set<string>();
  const reaper = createReaper(
    options.killGroup ?? killProcessGroup,
    options.graceMs ?? KILL_GRACE_MS,
  );
  let made = 0;
  let disposed = false;
  const dispose = (): void => {
    disposed = true;
    for (const child of running) reaper.signal(child, 'SIGKILL');
    running.clear();
    reaper.flush();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.clear();
  };
  const judge: Judge = async prompt => {
    if (disposed) throw new Error('judge is shut down');
    if (made >= options.hardCap) throw new Error(`judge call limit of ${options.hardCap} reached`);
    made += 1;
    const dir = realpathSync(mkdtempSync(join(options.tmpRoot ?? tmpdir(), 'aplos-taste-')));
    dirs.add(dir);
    try {
      return await runClaude({
        bin: options.bin,
        args: claudeArgs(options.model, dir),
        prompt: stageImages(prompt, options.images, dir),
        cwd: dir,
        env: options.env,
        timeoutMs: options.timeoutMs,
        spawnFn: options.spawnFn ?? spawn,
        running,
        reaper,
      });
    } finally {
      dirs.delete(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return { judge, dispose };
}
