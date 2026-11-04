// The frame deadline (html-4 host prerequisite, PROTOCOL.md "Deadline"). A frame that never reports its size, the
// sealed `aplos-mail://` frame whose reporter never runs or the srcdoc frame whose document never loads, must not
// leave the loading line up forever: after the timeout the host shows "Couldn't load this email." with Try again, and
// a report that arrives after that is refused. Pure, with an injectable clock, so the timing is unit-tested.

/** How long a frame may take to report its size before the host shows the failed state. */
export const FRAME_TIMEOUT_MS = 10_000;

/** The timer calls the deadline needs; `globalThis` by default, a fake clock in tests. */
export interface DeadlineClock {
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** One host's wait for its pending letter (one key at a time). */
export interface FrameDeadline {
  /** Start waiting for `key` afresh (a new letter, or Try again), dropping any earlier wait. */
  watch(key: string): void;
  /** A first report for `key`: true when accepted (stops the clock), false when `key` has already expired. */
  settle(key: string): boolean;
  /** Stop waiting (unmount, or the letter left); nothing expires afterwards. */
  cancel(): void;
  /** True once `key` has expired and not been watched again since. */
  expired(key: string): boolean;
}

const SYSTEM_CLOCK: DeadlineClock = {
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A deadline that calls `onExpire(key)` when the watched letter has not reported within `timeoutMs`. */
export function createFrameDeadline(
  onExpire: (key: string) => void,
  timeoutMs = FRAME_TIMEOUT_MS,
  clock: DeadlineClock = SYSTEM_CLOCK,
): FrameDeadline {
  const expired = new Set<string>();
  let current: { key: string; handle: unknown } | null = null;

  const cancel = () => {
    if (current) clock.clearTimeout(current.handle);
    current = null;
  };
  const expire = (key: string) => {
    current = null;
    expired.add(key);
    onExpire(key);
  };
  const watch = (key: string) => {
    cancel();
    expired.delete(key);
    current = { key, handle: clock.setTimeout(() => expire(key), timeoutMs) };
  };
  const settle = (key: string) => {
    if (expired.has(key)) return false;
    if (current?.key === key) cancel();
    return true;
  };
  return { watch, settle, cancel, expired: key => expired.has(key) };
}
