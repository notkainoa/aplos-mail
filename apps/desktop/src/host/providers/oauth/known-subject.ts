// The `knownSubject` dep of the Google connect (connect.ts) over a store lookup, with a bounded wait. The connect revokes a
// refused grant only when this answers exactly `false`, so a slow, failing, throwing or cancelled lookup answers `true`
// (known): the unused grant stays at Google rather than risk ending one an Aplos account relies on.

import type { Clock } from '@aplos/engine/ports';

export const knownSubjectTimeoutMs = 2_000;

export interface KnownSubjectOptions {
  /** The wait runs on this clock, so a test never waits the real timeout. */
  clock: Pick<Clock, 'sleep'>;
  timeoutMs?: number;
}

/** Answers `true` (known) once the timeout passes or `signal` aborts, whichever comes first. */
export type KnownSubject = (subject: string, signal?: AbortSignal) => Promise<boolean>;

/** Resolves `true` after `timeoutMs`, or at once when `stop` aborts. */
function knownAfter(clock: Pick<Clock, 'sleep'>, timeoutMs: number, stop: AbortSignal) {
  return clock.sleep(timeoutMs, stop).then(
    () => true as const,
    () => true as const,
  );
}

export function boundedKnownSubject(
  lookup: (subject: string) => boolean | Promise<boolean>,
  options: KnownSubjectOptions,
): KnownSubject {
  const timeoutMs = options.timeoutMs ?? knownSubjectTimeoutMs;
  return async (subject, signal) => {
    if (signal?.aborted) return true;
    const timer = new AbortController();
    const stop = signal ? AbortSignal.any([signal, timer.signal]) : timer.signal;
    try {
      const asked = Promise.resolve().then(() => lookup(subject));
      const answer = await Promise.race([asked, knownAfter(options.clock, timeoutMs, stop)]);
      return answer !== false;
    } catch {
      return true;
    } finally {
      timer.abort();
    }
  };
}
