import type { Frame, LogRecord } from '@aplos/contract';
import { createLogger } from '../src/diag/log';
import { createEngine, type Engine, type EngineOptions } from '../src/index';
import type { Clock, DeadlineRegistry, Timer } from '../src/ports';
import { openStore, type StorePort } from '../src/store';
import { T0, tempDb } from './store/helpers';

/**
 * A deadline registry that never fires on its own: `changed` marks are recorded in `told`, sources register and
 * unregister, but no fire runs until a test calls `runJobs` itself. Keeps AI-queue tests deterministic — a queued
 * job cannot race a scripted provider answer.
 */
export function silentDeadlines(told: string[] = []): DeadlineRegistry & { told: string[] } {
  return {
    told,
    register: () => () => {},
    changed: id => void told.push(id),
  };
}

/** A manual clock until `eng-time`'s fake clock lands: timers fire only when a test advances it. */
export function manualClock(start = T0) {
  let now = start;
  let timers: { at: number; fire: () => void; live: boolean }[] = [];
  const clock: Clock & { advance(ms: number): void; pending(): number } = {
    now: () => now,
    // Like the real clocks, an aborted sleep cancels its timer: the loop's and outbox's grace and timeout sleeps abort
    // once their work settles, and must not read as pending timers afterwards.
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const timer = clock.timer(now + ms, () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        });
        function onAbort() {
          timer.cancel();
          reject(signal!.reason);
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      }),
    timer(at, fire): Timer {
      const entry = { at, fire, live: true };
      timers.push(entry);
      return { cancel: () => void (entry.live = false) };
    },
    pending: () => timers.filter(t => t.live).length,
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = timers.filter(t => t.live && t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = Math.max(now, next.at);
        next.live = false;
        next.fire();
      }
      timers = timers.filter(t => t.live);
      now = until;
    },
  };
  return clock;
}

/** An engine over a fresh temp `mail.db`, a manual clock and an in-memory log. */
export async function testEngine(options: Partial<EngineOptions> = {}) {
  const file = tempDb();
  const store: StorePort = openStore(file.open(), { now: () => T0 });
  const clock = manualClock();
  const records: LogRecord[] = [];
  const log = createLogger({ sink: { write: r => records.push(r) }, salt: 'runtime-test', clock });
  const engine: Engine = await createEngine({ store, clock, log, ...options });
  return {
    engine,
    store,
    clock,
    records,
    logText: () => records.map(r => JSON.stringify(r)).join('\n'),
    async cleanup() {
      await engine.close();
      store.close();
      file.cleanup();
    },
  };
}

/** Collects a session's frames. */
export function framesOf(session: { subscribe(l: (f: Frame) => void): () => void }) {
  const frames: Frame[] = [];
  session.subscribe(f => frames.push(f));
  return frames;
}
