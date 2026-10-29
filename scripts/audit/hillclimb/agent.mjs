// Attempt-agent invocation: argv per agent kind, the filtered environment, and the spawn
// loop with timeout. The brief always travels through a file or stdin, never through shell
// interpolation, so a brief containing quotes or `$()` cannot become shell syntax.
//
// Environment filtering exists because agents are untrusted code running with inherited
// credentials otherwise: drop anything matching API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL and
// every *_KEY, keep the boring rest (PATH, HOME, LANG, TMPDIR, NODE*, npm_config_* survive).
import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';

const SECRET_NAME = /(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
const KEY_SUFFIX = /_KEY$/i;
// Names that must survive even if a filter pattern grows broad later.
const ALWAYS_KEEP = new Set(['PATH', 'HOME', 'LANG', 'TMPDIR']);

export function filteredEnv(env = process.env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (ALWAYS_KEEP.has(name)) {
      out[name] = value;
      continue;
    }
    if (SECRET_NAME.test(name) || KEY_SUFFIX.test(name)) continue;
    out[name] = value;
  }
  return out;
}

/**
 * Builds { command, args, stdinText } for an attempt. `stdinText` is fed to the child's
 * stdin (claude reads its prompt there); the other agents read the brief file from argv.
 */
export function buildAgentInvocation(attempt, { briefFile, briefText }) {
  switch (attempt.agent) {
    case 'swe-2':
      return {
        command: 'devin',
        args: [
          '--model',
          attempt.model ?? 'swe-2-high',
          '--permission-mode',
          'dangerous',
          '--respect-workspace-trust',
          'false',
          '-p',
          '--prompt-file',
          briefFile,
        ],
      };
    case 'claude': {
      const args = ['-p'];
      if (attempt.model) args.push('--model', attempt.model);
      args.push('--permission-mode', 'bypassPermissions');
      return { command: 'claude', args, stdinText: briefText };
    }
    case 'command':
      return { command: 'sh', args: ['-c', attempt.command] };
    default:
      throw new Error(`unknown attempt.agent "${attempt.agent}"`);
  }
}

/**
 * Runs one child with stdout+stderr appended to a single log stream. Kills the whole process
 * group on timeout (children of sh -c and agent CLIs die with their leader). Resolves with
 * { code, signal, timedOut, tail } where tail is the last `tailBytes` of combined output —
 * enough to pull a scorer's last line or a gate's first failure without holding whole logs.
 */
export function runLogged(
  { command, args, cwd, env, stdinText, timeoutMs, logPath, tailBytes = 256 * 1024, onSpawn },
  { spawnFn = spawn } = {},
) {
  return new Promise((resolvePromise, rejectPromise) => {
    const log = createWriteStream(logPath, { flags: 'a' });
    const child = spawnFn(command, args, {
      cwd,
      env,
      detached: true, // own process group so the timeout can kill the whole tree
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    onSpawn?.(child);
    let tail = '';
    const capture = chunk => {
      tail = (tail + chunk.toString('utf8')).slice(-tailBytes);
      log.write(chunk);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.on('error', error => {
      log.end();
      rejectPromise(error);
    });
    let timedOut = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree(child);
          }, timeoutMs)
        : null;
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      log.end();
      resolvePromise({ code, signal, timedOut, tail });
    });
    if (stdinText !== undefined) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

function killTree(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL'); // group already gone; at least take the leader
  }
}

/**
 * Runs the configured attempt agent in a worktree. The brief text is written by the caller
 * to briefFile; here it is only forwarded to stdin for agents that read it there.
 */
export async function runAgent(
  attempt,
  { briefFile, briefText, workdir, env, logPath, spawnFn, onSpawn },
) {
  const invocation = buildAgentInvocation(attempt, { briefFile, briefText });
  return runLogged(
    {
      ...invocation,
      cwd: workdir,
      env: env ?? filteredEnv(),
      timeoutMs: attempt.timeoutSec * 1000,
      logPath,
      onSpawn,
    },
    { spawnFn },
  );
}

/** Convenience for the CLI path: brief text read back only when the agent needs it on stdin. */
export function briefFor(attempt, briefFile) {
  return attempt.agent === 'claude' ? readFileSync(briefFile, 'utf8') : undefined;
}
