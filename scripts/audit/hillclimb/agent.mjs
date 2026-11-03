// Attempt-agent invocation: argv per agent kind, the filtered environment, and the spawn
// loop with timeout. The brief always travels through a file or stdin, never through shell
// interpolation, so a brief containing quotes or `$()` cannot become shell syntax.
//
// Environment filtering exists because agents and the attempt-modified code gates/scorers
// run are untrusted: they must NOT inherit credentials. A deny-list can never keep up with
// every name a secret might hide behind (AWS_SESSION_TOKEN, SSH_AUTH_SOCK, DATABASE_URL,
// FOO_PAT, NODE_AUTH_TOKEN, npm_config_//registry/:_authToken, ...), so the filter is an
// ALLOW-list of named boring runtime variables — anything not listed is dropped. Gates and
// scorers get the bare evalEnv; only agents additionally get the variables the devin/claude
// CLIs need to find their own login on disk (never any *_API_KEY or *_TOKEN).
import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';

// Named variables every spawned process may see. NODE_OPTIONS is handled separately: its
// value gets vetted for injection flags before it is let through.
const RUNTIME_ENV_NAMES = [
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
  'npm_config_cache',
  'npm_config_loglevel',
  'npm_config_progress',
  'npm_config_update_notifier',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
];
// Agents only — where the CLIs keep their login. Never forwarded to gates or scorers.
const AGENT_ONLY_ENV_NAMES = [
  'XDG_CONFIG_HOME',
  'DEVIN_CONFIG_DIR',
  'DEVIN_HOME',
  'CLAUDE_CONFIG_DIR',
];
const SECRET_NAME = /_(API_KEY|TOKEN)$/;
// NODE_OPTIONS with any of these turns a plain `node` call into code injection. `-r`
// takes a joined value too (`-r./evil`), so the short flag is banned by prefix.
const NODE_OPTIONS_BANNED = /^(--(require|import|loader|experimental-loader)(=|$)|-r)/;

const nodeOptionsSafe = value =>
  typeof value === 'string' && !value.split(/\s+/).some(token => NODE_OPTIONS_BANNED.test(token));

function pickEnv(env, extraNames) {
  const out = {};
  for (const name of [...RUNTIME_ENV_NAMES, ...extraNames]) {
    if (name in env && !SECRET_NAME.test(name)) out[name] = env[name];
  }
  if ('NODE_OPTIONS' in env && nodeOptionsSafe(env.NODE_OPTIONS)) {
    out.NODE_OPTIONS = env.NODE_OPTIONS;
  }
  return out;
}

/** Environment for gates and scorers running attempt-modified code: runtime names only. */
export function evalEnv(env = process.env) {
  // SCORER_ISOLATED=1 is SET by the harness, never inherited: UI scorers (tests/visual) then ignore
  // APLOS_VISUAL_PORT and start their own server, instead of trusting whatever answers on a port
  // that may belong to another worktree's dev server. (APLOS_VISUAL_PORT itself is not on the
  // allow-list, so it never reaches a gate or scorer anyway.)
  return { ...pickEnv(env, []), SCORER_ISOLATED: '1' };
}

/** Environment for attempt agents: the runtime names plus the CLI login-discovery variables (no SCORER_ISOLATED: agents do not run scorers). */
export function agentEnv(env = process.env) {
  return pickEnv(env, AGENT_ONLY_ENV_NAMES);
}

// Backwards-compatible name for the agent-side filter (agents, never gates/scorers).
export const filteredEnv = agentEnv;

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
    maxLogBytes = Infinity,
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
    let logBytes = 0;
    let logOverflow = false;
    const capture = chunk => {
      tail = (tail + chunk.toString('utf8')).slice(-tailBytes);
      if (logOverflow) return;
      logBytes += chunk.length;
      if (logBytes > maxLogBytes) {
        // A child filling its log is a runaway or a disk-fill attack: kill the whole
        // group and stop appending. The caller turns logOverflow into a rejection.
        logOverflow = true;
        killTree(child);
        return;
      }
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
      resolvePromise({ code, signal, timedOut, logOverflow, tail, stdoutTail });
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
  { briefFile, briefText, workdir, env, logPath, maxLogBytes, spawnFn, onSpawn },
) {
  const invocation = buildAgentInvocation(attempt, { briefFile, briefText });
  return runLogged(
    {
      ...invocation,
      cwd: workdir,
      env: env ?? agentEnv(),
      timeoutMs: attempt.timeoutSec * 1000,
      logPath,
      maxLogBytes,
      onSpawn,
    },
    { spawnFn },
  );
}

/** Convenience for the CLI path: brief text read back only when the agent needs it on stdin. */
export function briefFor(attempt, briefFile) {
  return attempt.agent === 'claude' ? readFileSync(briefFile, 'utf8') : undefined;
}
