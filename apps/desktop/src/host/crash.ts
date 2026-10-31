/**
 * Slow-main and silent-actor watchdogs (host-2; plan 10 E1 item 4).
 * `createLoopMonitor` samples event-loop delay every 10 s and logs one line when the p99 passes 500 ms.
 * `createHeartbeatSupervisor` restarts an account actor that has sent no heartbeat for 2 minutes, alone and once
 * per silence. Both take their clock, timers and logger as ports, and neither logs anything but numbers and ids.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

export interface Timers {
  every(run: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

/** The part of a `perf_hooks` histogram the monitor reads. Percentiles are in nanoseconds. */
export interface DelayHistogram {
  enable(): unknown;
  disable(): unknown;
  reset(): void;
  percentile(percentile: number): number;
}

export const LOOP_SAMPLE_MS = 10_000;
export const LOOP_P99_LIMIT_MS = 500;

export interface Watchdog {
  start(): void;
  stop(): void;
}

export function createLoopMonitor(ports: {
  histogram: DelayHistogram;
  timers: Timers;
  log(line: string): void;
  sampleMs?: number;
  limitMs?: number;
}): Watchdog {
  const limit = ports.limitMs ?? LOOP_P99_LIMIT_MS;
  let handle: unknown;
  function sample() {
    const p99 = ports.histogram.percentile(99) / 1e6;
    ports.histogram.reset();
    if (p99 > limit) ports.log(`main event loop delay p99 ${Math.round(p99)} ms`);
  }
  return {
    start() {
      if (handle !== undefined) return;
      ports.histogram.enable();
      handle = ports.timers.every(sample, ports.sampleMs ?? LOOP_SAMPLE_MS);
    },
    stop() {
      if (handle !== undefined) ports.timers.cancel(handle);
      handle = undefined;
      ports.histogram.disable();
    },
  };
}

export const nodeDelayHistogram = (): DelayHistogram => monitorEventLoopDelay({ resolution: 20 });

export const SILENT_ACTOR_MS = 120_000;
export const HEARTBEAT_CHECK_MS = 10_000;

export interface HeartbeatPorts {
  now(): number;
  accounts(): string[];
  /** `AccountActorHost.lastHeartbeat`: epoch milliseconds, undefined before the first beat. */
  lastHeartbeat(account: string): number | undefined;
  /** `AccountActorHost` restart of one actor; the others keep running. */
  restart(account: string): void;
  timers: Timers;
  silentMs?: number;
}

export interface HeartbeatSupervisor extends Watchdog {
  check(): void;
}

export function createHeartbeatSupervisor(ports: HeartbeatPorts): HeartbeatSupervisor {
  const silentMs = ports.silentMs ?? SILENT_ACTOR_MS;
  /** When the supervisor first saw an actor that has never beaten, so "never" also counts as silence. */
  const firstSeen = new Map<string, number>();
  /** The silence (its start) each actor was last restarted for; a new beat starts a new silence. */
  const restartedFor = new Map<string, number>();
  let handle: unknown;

  function check() {
    const now = ports.now();
    for (const account of ports.accounts()) {
      if (!firstSeen.has(account)) firstSeen.set(account, now);
      const since = ports.lastHeartbeat(account) ?? firstSeen.get(account)!;
      if (now - since < silentMs) continue;
      if (restartedFor.get(account) === since) continue;
      restartedFor.set(account, since);
      // A restarted actor that stays mute has a new silence, counted from the restart.
      firstSeen.set(account, now);
      ports.restart(account);
    }
  }

  return {
    check,
    start() {
      if (handle === undefined) handle = ports.timers.every(check, HEARTBEAT_CHECK_MS);
    },
    stop() {
      if (handle !== undefined) ports.timers.cancel(handle);
      handle = undefined;
    },
  };
}

/** The part of Electron's `app` the startup naming needs. */
export interface NamedApp {
  setName(name: string): void;
}
/** The part of Electron's `crashReporter` the host starts. */
export interface Reporter {
  start(options: { uploadToServer: boolean }): void;
}

/**
 * Names the app, then starts the crash reporter, in that order and nowhere else. Starting the reporter fixes the default
 * `userData` folder from the app name at that moment, and the package name (`@aplos/desktop`) is not the product name,
 * so starting it first would send a real launch to an empty mailbox folder. Dumps stay on this Mac: no upload.
 */
export function startCrashReporting(app: NamedApp, reporter: Reporter, name: string) {
  app.setName(name);
  reporter.start({ uploadToServer: false });
}
