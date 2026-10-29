import type { Clock, Timer } from '../ports/time';

/** Node and browsers clamp longer timeouts to 1 ms; the timer re-arms instead. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
/**
 * The longest single `setTimeout` the system clock arms. libuv timers run on the monotonic clock, which stops while the
 * Mac sleeps: an 8 h wait with 7 h of sleep would fire 7 h late. Re-checking `Date.now()` every minute bounds that
 * lateness to about a minute without any help from the host (`Engine.wake` makes it immediate).
 */
export const MAX_SYSTEM_WAIT_MS = 60_000;

/**
 * The real clock over `Date.now` and `setTimeout` (F3 `Clock`). A timer re-checks `now()` when its timeout fires and
 * re-arms when early, so a long wait or drift never fires before `at`. Each wait is capped at `MAX_SYSTEM_WAIT_MS`, so a
 * wall-clock jump or a Mac sleep costs at most about that much lateness; the host's `wake()` makes it immediate.
 */
export function systemClock(): Clock {
  return {
    now: () => Date.now(),
    sleep: (ms, signal) => sleep(ms, signal),
    timer: (at, fire) => systemTimer(at, fire),
  };
}

function systemTimer(at: number, fire: () => void): Timer {
  let handle: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const later = (ms: number) => {
    handle = setTimeout(arm, ms);
    // A deadline wait must never hold the process open.
    (handle as { unref?: () => void }).unref?.();
  };
  const arm = () => {
    const wait = at - Date.now();
    // `!(wait > 0)` covers NaN: an unorderable target is already due, never re-armed at ~0 ms.
    if (!(wait > 0)) {
      done = true;
      fire();
      return;
    }
    later(Math.min(wait, MAX_TIMEOUT_MS, MAX_SYSTEM_WAIT_MS));
  };
  // Never fire synchronously inside `timer()`: the caller may still be setting up.
  later(Math.max(0, Math.min(at - Date.now(), MAX_TIMEOUT_MS, MAX_SYSTEM_WAIT_MS)));
  return {
    cancel() {
      if (done) return;
      done = true;
      clearTimeout(handle);
    },
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = systemTimer(Date.now() + ms, () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    });
    function onAbort() {
      timer.cancel();
      reject(signal!.reason);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
