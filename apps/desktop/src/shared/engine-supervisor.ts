// The engine supervisor: keeps one engine process running, restarts it after an unexpected stop until `noteExit` parks,
// restarts it on the owner's ask, and stops it for good on `close`. No Electron import, so node:test runs it. Re-exported by
// `host/transports/port.ts`, where main and the tests have always found it.

import type { EngineLink, Timers } from '../host/transports/port';

/** The error a call gets when the engine is not there (same shape as the port client's `LinkError`: it has a `body`). */
function unavailable(message = 'The mailbox is restarting. Try again in a moment.'): Error {
  return Object.assign(new Error(message), { body: { type: 'unavailable', message } });
}

// ---- the restart policy -------------------------------------------------------------------------------------------

/** `close` asks the engine to quit and waits this long, then kills it (host/lifecycle.ts's `QUIT_DRAIN_MS` is longer). */
export const ENGINE_QUIT_MS = 3000;
/** After the kill, `close` waits this long for the exit event before it reports the engine as stuck. */
export const ENGINE_EXIT_AFTER_KILL_MS = 2000;
/** Restarts the owner asks for closer together than this are one restart. */
export const RESTART_COALESCE_MS = 5000;

/** How `close` ended: the engine exited (asked or after the kill), or it is still running after the kill. */
export type CloseResult = 'exited' | 'stuck';

export interface SupervisorOptions {
  spawn(): EngineLink;
  /**
   * The engine process stopped unexpectedly: true when this stop parks the app. Main passes host/lifecycle.ts's
   * `createProcessState().noteEngineExit` (3 stops within 60 s park), so the legacy and the real path share one policy.
   */
  noteExit(): boolean;
  /** The engine answered `ready`; `restarted` after an unexpected stop. */
  onUp(link: EngineLink, restarted: boolean): void;
  /** The engine stopped unexpectedly; `parked` when no restart follows. */
  onDown(parked: boolean): void;
  timers: Timers;
  /** Default 500 ms, so a crash loop cannot spin. */
  restartDelayMs?: number;
  /** How long `close` waits for the engine to exit before killing it. Default `ENGINE_QUIT_MS`. */
  quitMs?: number;
  /** How long `close` waits for the exit AFTER killing it. Default `ENGINE_EXIT_AFTER_KILL_MS`. */
  exitAfterKillMs?: number;
  /**
   * How long an engine may take to answer `ready` before it is killed; the kill is a stop like any other (it counts
   * toward the park). Default 60 s: a large import or migration may be slow, but never silent forever.
   */
  readyTimeoutMs?: number;
  /** A kill threw (the OS refused): tell someone, since an engine that never becomes ready then leaves `start` waiting. */
  onKillFailed?(error: unknown): void;
  /** The owner asked for a restart ("Try again"): the host forgets earlier stops, so a parked app is not parked any more. */
  onRestart?(): void;
  /** The clock for the restart coalescing (default `Date.now`). */
  now?(): number;
  /** An asked restart within this long of the last accepted one is answered without doing anything. Default 5 s. */
  restartCoalesceMs?: number;
}

/** Kills an engine; a kill that throws is no uncaught error in main: the exit wait that follows still decides. */
function stop(link: EngineLink, onKillFailed?: (error: unknown) => void): void {
  try {
    link.kill();
  } catch (error) {
    // The process may already be gone, or the OS refused; the caller waits for the exit event either way.
    onKillFailed?.(error);
  }
}

/** Keeps one engine process running: restarts it after an unexpected stop until `noteExit` parks, never after `close`. */
export function createEngineSupervisor(options: SupervisorOptions) {
  let current: EngineLink | undefined;
  let closing = false;
  let everUp = false;
  let restart: unknown;
  /** The engine the owner asked to restart: its exit starts the next one at once and does not count toward the park. */
  let asked: EngineLink | undefined;
  let lastAsk = -Infinity;

  function down(link: EngineLink) {
    if (current !== link) return;
    current = undefined;
    // A first start that fails is the caller's error (startup shows it); only a running engine restarts.
    if (closing || !everUp) return;
    if (asked === link) {
      asked = undefined;
      options.onDown(false);
      up(true).catch(() => undefined);
      return;
    }
    const parked = options.noteExit();
    options.onDown(parked);
    if (parked) return;
    restart = options.timers.set(() => {
      restart = undefined;
      up(true).catch(() => undefined);
    }, options.restartDelayMs ?? 500);
  }

  async function up(restarted: boolean): Promise<EngineLink> {
    if (closing) throw unavailable();
    const link = options.spawn();
    current = link;
    link.onExit(() => down(link));
    const timer = options.timers.set(
      () => stop(link, options.onKillFailed),
      options.readyTimeoutMs ?? 60_000,
    );
    try {
      await link.ready;
    } finally {
      options.timers.clear(timer);
    }
    if (closing || current !== link) throw unavailable();
    everUp = true;
    options.onUp(link, restarted);
    return link;
  }

  return {
    start: () => up(false),
    current: () => current,
    /**
     * "Try again": a running engine is asked to quit (killed after `quitMs`) and the next one starts as soon as it is
     * gone; a parked or waiting-to-restart app starts one now. Neither counts toward the park. Resolves once the
     * restart is under way, not when the new engine is ready (`onUp` says that).
     */
    restart(): Promise<void> {
      if (closing) return Promise.reject(unavailable());
      const now = (options.now ?? Date.now)();
      // A loop of asks must not keep the engine in spawn, quit, spawn: one restart per coalescing window.
      if (now - lastAsk < (options.restartCoalesceMs ?? RESTART_COALESCE_MS))
        return Promise.resolve();
      lastAsk = now;
      if (restart !== undefined) {
        options.timers.clear(restart);
        restart = undefined;
      }
      options.onRestart?.();
      const link = current;
      if (link && !link.exited) {
        if (asked) return Promise.resolve();
        asked = link;
        const killer = options.timers.set(() => {
          stop(link, options.onKillFailed);
          // A kill that does not end it (the OS refused, or the process is wedged) must not leave the app unable to retry.
          const giveUp = options.timers.set(() => {
            if (asked === link) asked = undefined;
          }, options.exitAfterKillMs ?? ENGINE_EXIT_AFTER_KILL_MS);
          link.onExit(() => options.timers.clear(giveUp));
        }, options.quitMs ?? ENGINE_QUIT_MS);
        link.onExit(() => options.timers.clear(killer));
        link.quit();
        return Promise.resolve();
      }
      if (!current) up(true).catch(() => undefined);
      return Promise.resolve();
    },
    /**
     * Stops restarting, asks the engine to quit, kills it after `quitMs`, and says how it ended: `'exited'` when the
     * process is gone (a quit that was heard, or one that died after the kill), `'stuck'` when it is still running
     * `exitAfterKillMs` after the kill. Nothing running (never started, or already gone) counts as exited.
     */
    close(): Promise<CloseResult> {
      closing = true;
      if (restart !== undefined) options.timers.clear(restart);
      const link = current;
      if (!link || link.exited) return Promise.resolve('exited');
      return new Promise<CloseResult>(resolve => {
        let timer: unknown;
        link.onExit(() => {
          options.timers.clear(timer);
          resolve('exited');
        });
        timer = options.timers.set(() => {
          stop(link, options.onKillFailed);
          timer = options.timers.set(
            () => resolve('stuck'),
            options.exitAfterKillMs ?? ENGINE_EXIT_AFTER_KILL_MS,
          );
        }, options.quitMs ?? ENGINE_QUIT_MS);
        link.quit();
      });
    },
  };
}
