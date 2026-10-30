import { log, markShuttingDown } from './common';

// Shutdown for every scorer: one set of cleanups (close the browser, stop the Vite server, remove
// temp dirs, kill the judge) that runs on a normal end, on an error and on SIGINT, SIGTERM or
// SIGHUP, so a harness timeout never leaves a detached vite or chromium behind.

export type Cleanup = () => void | Promise<void>;

/** Exit codes after a signal: 128 + the signal number. */
export const SIGNAL_EXIT: Readonly<Record<string, number>> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};
const CLEANUP_TIMEOUT_MS = 8_000;

const cleanups = new Set<Cleanup>();
let installed = false;
/** The exit code of a signal that arrived, which wins over whatever main() was about to exit with. */
let signalCode: number | undefined;

/** Registers a cleanup (installing the signal handlers once). Returns a function that removes it. */
export function onShutdown(cleanup: Cleanup): () => void {
  installSignalHandlers();
  cleanups.add(cleanup);
  return () => {
    cleanups.delete(cleanup);
  };
}

/** Runs every registered cleanup, newest first, once each. A failing cleanup never blocks the rest. */
export async function runCleanups(): Promise<void> {
  const pending = [...cleanups].reverse();
  cleanups.clear();
  await Promise.allSettled(pending.map(async cleanup => cleanup()));
}

async function exitAfterCleanup(code: number): Promise<never> {
  const timeout = new Promise<void>(resolve => setTimeout(resolve, CLEANUP_TIMEOUT_MS).unref());
  await Promise.race([runCleanups(), timeout]);
  process.exit(signalCode ?? code);
}

/** Once per process. A second signal falls through to the default and ends the process at once. */
export function installSignalHandlers(): void {
  if (installed) return;
  installed = true;
  for (const [signal, code] of Object.entries(SIGNAL_EXIT))
    process.once(signal, () => {
      log(`scorer: ${signal}, cleaning up`);
      signalCode ??= code;
      markShuttingDown();
      void exitAfterCleanup(code);
    });
}

/** Sends `signal` to a detached child's whole process group; false when the group is already gone. */
export function killGroup(pid: number | undefined, signal: NodeJS.Signals = 'SIGTERM'): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Entry point of a scorer: handlers installed, any error logged and exit 1 (cleanups ran in finally). */
export function runScorer(main: () => Promise<void>): void {
  installSignalHandlers();
  main().catch(async error => {
    log(error instanceof Error ? (error.stack ?? error.message) : String(error));
    await exitAfterCleanup(1);
  });
}

/** Closes everything and exits; for the end of main. */
export async function finish(code: number): Promise<never> {
  return exitAfterCleanup(code);
}
