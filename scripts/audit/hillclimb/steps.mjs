// Gate and scorer runners. Both are shell commands executed in a worktree; their full output
// goes to per-step log files and is never printed raw. A scorer's contract: its LAST
// non-empty stdout line is JSON {"score": <finite number, higher is better>, "details": []}.
// A gate must exit 0. Any deviation (non-zero exit, timeout, missing/invalid JSON, non-finite
// score) makes the attempt invalid with the reason reported. Gates and scorers run the
// tightest environment — evalEnv, the runtime allow-list without even the agent CLIs'
// login-discovery variables — because they execute code the attempt agent modified.
import { evalEnv, runLogged } from './agent.mjs';

const lastNonEmpty = text =>
  text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .at(-1);

/**
 * Parses scorer output's last line into { score, details } or { invalid: reason }. Exported
 * for tests; `tail` is the bounded end of the combined output the runner captured.
 */
export function parseScorerOutput(output) {
  const line = lastNonEmpty(output ?? '');
  if (!line) return { invalid: 'scorer printed no output' };
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { invalid: `last line is not JSON: ${line.slice(0, 120)}` };
  }
  if (typeof parsed !== 'object' || parsed === null || !Number.isFinite(parsed.score)) {
    return { invalid: 'score is missing or not a finite number' };
  }
  const details = Array.isArray(parsed.details) ? parsed.details : [];
  return { score: parsed.score, details };
}

/**
 * The line most worth showing when a gate fails: the first line that looks like a failure,
 * else the last line, truncated to 160 chars. Output text itself is never printed otherwise.
 */
export function firstFailLine(output) {
  const lines = (output ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const hit = lines.find(line => /error|fail|✖|✗|✘|warning:.*error/i.test(line)) ?? lines.at(-1);
  return (hit ?? 'no output').slice(0, 160);
}

/** Runs a gate via `sh -c` in `workdir`; resolves { ok, failLine?, timedOut }. */
export async function runGate(gate, { workdir, logPath, env, spawnFn, onSpawn }) {
  const out = await runLogged(
    {
      command: 'sh',
      args: ['-c', gate.command],
      cwd: workdir,
      env: env ?? evalEnv(),
      timeoutMs: gate.timeoutSec * 1000,
      logPath,
      onSpawn,
    },
    { spawnFn },
  );
  if (out.code === 0) return { ok: true };
  const why = out.timedOut
    ? `timed out after ${gate.timeoutSec}s`
    : `exit ${out.code ?? out.signal}`;
  return { ok: false, reason: why, failLine: firstFailLine(out.tail) };
}

/** Runs a scorer via `sh -c`; resolves { ok, score, details } or { ok: false, reason }. */
export async function runScorer(scorer, { workdir, logPath, env, spawnFn, onSpawn }) {
  const out = await runLogged(
    {
      command: 'sh',
      args: ['-c', scorer.command],
      cwd: workdir,
      env: env ?? evalEnv(),
      timeoutMs: scorer.timeoutSec * 1000,
      logPath,
      onSpawn,
    },
    { spawnFn },
  );
  if (out.code !== 0) {
    const why = out.timedOut
      ? `timed out after ${scorer.timeoutSec}s`
      : `exit ${out.code ?? out.signal}`;
    return { ok: false, reason: why };
  }
  // The JSON contract lives on stdout only; a stderr warning must not corrupt the parse.
  const parsed = parseScorerOutput(out.stdoutTail ?? '');
  if (parsed.invalid) return { ok: false, reason: parsed.invalid };
  return { ok: true, score: parsed.score, details: parsed.details };
}
