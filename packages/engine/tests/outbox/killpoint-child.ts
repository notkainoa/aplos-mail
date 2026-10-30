import { KILL_POINTS, type KillPoint } from '../../src/outbox/killpoints';
import { driveEngine, KILL_ENV, RUN_ENV, type RunSpec } from './killpoint-harness';

/**
 * The child process of the kill-point harness: one engine life that kills itself at the named point. The point comes
 * from `KILL_ENV` (read here and nowhere under `src/`). `SIGKILL` runs no handlers, no `finally` and no store close,
 * like a crash or a force quit (`dieNow` in the harness). A child that gets to the end exits 0, which the harness reports as "never reached".
 */

function armed(): KillPoint | undefined {
  const name = process.env[KILL_ENV];
  if (name === 'none' || name === 'quit') return undefined;
  const point = KILL_POINTS.find(p => p === name);
  if (!point) throw new Error(`unknown kill point ${String(name)}`);
  return point;
}

async function main() {
  const point = armed();
  const run = JSON.parse(process.env[RUN_ENV] ?? '') as RunSpec;
  const list = await driveEngine(run, point);
  // The last life's answer; a killed life never gets here.
  process.stdout.write(JSON.stringify(list));
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
