import type { Clock, Timer } from '../ports/time';

/** Node and browsers clamp longer timeouts to 1 ms; the timer re-arms instead. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * The real clock over `Date.now` and `setTimeout` (F3 `Clock`). A timer re-checks `now()` when its timeout fires and
 * re-arms when early, so a long wait or drift never fires before `at`. A wall-clock jump is the host's `wake()`.
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
  const arm = () => {
    const wait = at - Date.now();
    if (wait <= 0) {
      done = true;
      fire();
      return;
    }
    handle = setTimeout(arm, Math.min(wait, MAX_TIMEOUT_MS));
  };
  // Never fire synchronously inside `timer()`: the caller may still be setting up.
  handle = setTimeout(arm, Math.max(0, Math.min(at - Date.now(), MAX_TIMEOUT_MS)));
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
