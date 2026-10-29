// Attempt-agent invocation: argv per agent kind, the filtered environment, and the spawn
// loop with timeout. The brief always travels through a file or stdin, never through shell
// interpolation, so a brief containing quotes or `$()` cannot become shell syntax.
//
// Environment filtering exists because agents are untrusted code: they must NOT inherit
// credentials. A deny-list can never keep up with every name a secret might hide behind
// (AWS_SESSION_TOKEN, SSH_AUTH_SOCK, DATABASE_URL, FOO_PAT, ...), so the filter is an
// ALLOW-list of boring runtime variables — anything not listed is dropped. Agents that need
// auth (claude, devin) use their own login from disk, not our env.
import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';

const ENV_ALLOW_EXACT = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  'TZ',
  'CI',
]);
const ENV_ALLOW_PREFIX = ['LC_', 'NODE_', 'npm_config_', 'NPM_CONFIG_', 'DEVIN_', 'XDG_'];

export function filteredEnv(env = process.env) {
  const out = {};
  for (const [name, value] of Object.entries(env)) {
    if (ENV_ALLOW_EXACT.has(name) || ENV_ALLOW_PREFIX.some(prefix => name.startsWith(prefix))) {
      out[name] = value;
    }
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
 * { code, signal, timedOut, tail, stdoutTail }: `tail` is the bounded end of COMBINED output
 * (for gate failure lines) and `stdoutTail` stdout alone (the scorer's JSON contract lives
 * on stdout only — a warning on stderr must never corrupt it).
 *
 * Waits for 'close', but a leader that exits while a grandchild still holds the pipes open
 * would never close: on 'exit' a `graceMs` timer starts, after which the whole process
 * group is killed and the leader's own exit result is returned.
 */
export function runLogged(
  {
    command,
    args,
    cwd,
    env,
    stdinText,
    timeoutMs,
    logPath,
    tailBytes = 256 * 1024,
    graceMs = 2000,
    onSpawn,
  },
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
    let stdoutTail = '';
    const capture = chunk => {
      tail = (tail + chunk.toString('utf8')).slice(-tailBytes);
      log.write(chunk);
    };
    child.stdout.on('data', chunk => {
      stdoutTail = (stdoutTail + chunk.toString('utf8')).slice(-tailBytes);
      capture(chunk);
    });
    child.stderr.on('data', capture);
    child.on('error', error => {
      log.end();
      rejectPromise(error);
    });
    let timedOut = false;
    let done = false;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killTree(child);
          }, timeoutMs)
        : null;
    let graceTimer = null;
    const finish = (code, signal) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      log.end();
      resolvePromise({ code, signal, timedOut, tail, stdoutTail });
    };
    child.on('exit', (code, signal) => {
      // Leader exited but 'close' may never come (a grandchild keeping the pipes open).
      // Give stragglers a short grace, then reap the whole group.
      graceTimer = setTimeout(() => {
        killTree(child);
        finish(code, signal);
      }, graceMs);
    });
    child.on('close', (code, signal) => finish(code, signal));
    // Writing to a child that already died raises EPIPE on stdin — the 'close'/'error'
    // handlers own the outcome, so stdin errors are informational only.
    child.stdin.on('error', () => {});
    if (stdinText !== undefined) {
      try {
        child.stdin.write(stdinText);
      } catch {
        // stdin already gone; the exit path reports the child's real status.
      }
    }
    try {
      child.stdin.end();
    } catch {
      // Same: never let a dead pipe mask the exit result.
    }
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
