import { installKillHook, KILL_POINTS, type KillPoint } from '../../src/outbox/killpoints';
import { driveEngine, KILL_ENV, RUN_ENV, type RunSpec } from './killpoint-harness';

/**
 * The child process of the kill-point harness: one engine life that kills itself at the named point. The point comes
 * from `KILL_ENV` (read here and nowhere under `src/`). `SIGKILL` runs no handlers, no `finally` and no store close,
 * like a crash or a force quit. A child that gets to the end exits 0, which the harness reports as "never reached".
 */

function dieNow(): never {
  process.kill(process.pid, 'SIGKILL');
  // The signal is delivered asynchronously: nothing of the engine may run meanwhile.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
  process.exit(99);
}

function armed(): KillPoint | undefined {
  const name = process.env[KILL_ENV];
  if (name === 'none') return undefined;
  const point = KILL_POINTS.find(p => p === name);
  if (!point) throw new Error(`unknown kill point ${String(name)}`);
  return point;
}

async function main() {
  const point = armed();
  const run = JSON.parse(process.env[RUN_ENV] ?? '') as RunSpec;
  installKillHook(name => {
    if (name === point) dieNow();
  });
  await driveEngine(run);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
