// Shared by the real-process hillclimb tests. A failing test must never leave a child
// running: a leaked `node -e` holds node:test's stdio pipes open and turns a test failure
// into a hung `npm run test:audit` (seen once for 23 minutes). Two layers, either of which
// is enough on its own:
//   1. every child self-exits after hardExitMs (HARD_EXIT_PRELUDE is prepended to its
//      script; the timer is unref'd, so a healthy child is not kept alive by it);
//   2. the test file registers `afterEach(killTrackedChildren)`, which SIGKILLs whatever the
//      test spawned and did not already reap, pass or fail.
import { spawn } from 'node:child_process';

export const hardExitMs = 120_000;

export const HARD_EXIT_PRELUDE = `setTimeout(() => process.exit(97), ${hardExitMs}).unref();\n`;

const tracked = new Set();

/** Registers a spawned child so killTrackedChildren() can reap it; returns the child. */
export function trackChild(child) {
  tracked.add(child);
  child.once('close', () => tracked.delete(child));
  return child;
}

/** SIGKILLs every tracked child that is still running and forgets all of them. */
export function killTrackedChildren() {
  for (const child of tracked) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
  tracked.clear();
}

/** How many children are still tracked (for the helper's own test). */
export const trackedCount = () => tracked.size;

/**
 * Runs `script` as an ES-module `node -e` child with the hard self-exit timer prepended and
 * the child tracked. Resolves when it exits 0, rejects with its stderr otherwise.
 */
export function spawnNodeScript(script, name = 'child') {
  return new Promise((resolve, reject) => {
    const child = trackChild(
      spawn('node', ['--input-type=module', '-e', HARD_EXIT_PRELUDE + script], {
        stdio: ['ignore', 'ignore', 'pipe'],
      }),
    );
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('close', code => (code === 0 ? resolve() : reject(new Error(`${name}: ${stderr}`))));
    child.on('error', reject);
  });
}
