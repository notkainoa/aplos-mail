import type { Clock } from '../ports';

// A bound on provider work that `Mail/serve` waits for: the caller's abort or the clock's timeout, whichever comes first.
// Racing against it never cancels the work itself; `collectBytes` closes the stream's iterator when it gives up.

const STOPPED: unique symbol = Symbol('stopped');

export interface Deadline {
  /** Settles when the call is cancelled or the time is up. */
  readonly stopped: Promise<typeof STOPPED>;
  /** Cancels the timer and the abort listener; call it once the work is done. */
  end(): void;
}

export function deadline(clock: Clock, ms: number, signal: AbortSignal): Deadline {
  const timer = new AbortController();
  let stop: () => void = () => undefined;
  const stopped = new Promise<typeof STOPPED>(resolve => {
    stop = () => resolve(STOPPED);
  });
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });
  clock.sleep(ms, timer.signal).then(stop, () => undefined);
  return {
    stopped,
    end() {
      timer.abort();
      signal.removeEventListener('abort', stop);
    },
  };
}

/** The work's value, or undefined when the deadline came first. */
export async function within<T>(work: Promise<T>, limit: Deadline): Promise<T | undefined> {
  const result = await Promise.race([work, limit.stopped]);
  return result === STOPPED ? undefined : (result as T);
}
