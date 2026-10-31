import type { Frame, NotificationItem } from '@aplos/contract';

/** The part of an engine session this module needs; no electron or engine import, so tests drive it with a fake. */
export interface NotificationLoopSession {
  call(method: string, args: unknown): Promise<unknown>;
  subscribe(listener: (frame: Frame) => void): () => void;
}

/** The host's banner function; `dropped` means notifications are off or Focus is on, so the item is finished too. */
export type PostNotification = (item: NotificationItem) => Promise<PostResult> | PostResult;
export type PostResult = 'posted' | 'dropped';

export interface NotificationLoopOptions {
  /** Where failures go. It gets a short fixed message and an error name, never notification text. */
  log?: (message: string, errorName?: string) => void;
  /** Timer functions for the claim retry; tests pass fakes. Default: `setTimeout` (unref'd) and `clearTimeout`. */
  timers?: RetryTimers;
}

export interface RetryTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const systemTimers: RetryTimers = {
  set: (run, ms) => {
    const handle = setTimeout(run, ms);
    handle.unref?.();
    return handle;
  },
  clear: handle => clearTimeout(handle as NodeJS.Timeout),
};

/** A failed claim is retried after this long, doubling per consecutive failure up to the cap. */
const RETRY_MIN_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
export const retryDelay = (failures: number) =>
  Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.max(0, failures - 1));

/** The contract's limit for `Notification/claim` `max` and for the ids of one `Notification/ack`. */
const BATCH = 50;
/** A run never claims more than this many batches, so a misbehaving engine cannot keep it busy for ever. */
const MAX_BATCHES_PER_RUN = 100;
/** Settled ids kept in memory to avoid a repost; the engine's own lease and ack are the real guard. */
const REMEMBER = 500;

type Settled = Map<string, PostResult>;

const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

function itemsOf(output: unknown): NotificationItem[] {
  const items = (output as { items?: unknown } | null | undefined)?.items;
  if (!Array.isArray(items)) return [];
  return items.filter((i): i is NotificationItem => typeof i?.id === 'string');
}

const isNotify = (frame: Frame) => frame.frame === 'host' && frame.event.type === 'notify';

function chunks<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += BATCH) out.push(list.slice(i, i + BATCH));
  return out;
}

/**
 * Keeps the notification outbox drained: claims, posts, acknowledges.
 *
 * It subscribes first, then claims once at once, because `notify` is not replayed on attach and rows that arrived
 * before the host connected are already pending. After that it claims whenever a `notify` host event arrives.
 *
 * One run drains in batches of 50 (`Notification/claim { max: 50 }` until a batch is short or empty), posts each item,
 * then acks the posted ids and the dropped ids, one call per state and at most 50 ids per call. Runs never overlap:
 * notifies that arrive during a run schedule exactly one more run after it. A failing claim is swallowed and retried
 * by one unref'd timer (5 s, doubling per consecutive failure, capped at 5 min); a claim that works resets the delay
 * and a new run cancels the pending timer. The returned stop function clears it.
 *
 * Delivery is at least once with stable ids. A post that throws leaves its item unacked, so the engine offers it
 * again once its lease ends. An id this loop has posted is never posted again in this session, and an id whose ack
 * failed is acked again at the start of the next run without being reposted.
 *
 * Not wired into `src/main` yet: main still runs the legacy engine. The new engine's host calls this once, right after
 * `engine.connect()`, with the host session and its banner function, and calls the returned function on quit.
 * After that function runs nothing more is claimed or posted; an ack for an item already posted is still sent.
 */
export function runNotificationLoop(
  session: NotificationLoopSession,
  post: PostNotification,
  options: NotificationLoopOptions = {},
): () => void {
  const log = options.log ?? (() => undefined);
  const timers = options.timers ?? systemTimers;
  let active = true;
  let failures = 0;
  let retry: unknown;
  let running = false;
  let again = false;
  /** Acked, so never posted again. Insertion order is age; the oldest go first. */
  const settled: Settled = new Map();
  /** Posted (or dropped) but not acked yet, waiting for a later run. */
  const unacked: Settled = new Map();

  const remember = (ids: string[], state: PostResult) => {
    for (const id of ids) {
      unacked.delete(id);
      settled.set(id, state);
    }
    while (settled.size > REMEMBER) settled.delete(settled.keys().next().value as string);
  };

  const ack = async (outcomes: Settled) => {
    for (const state of ['posted', 'dropped'] as const) {
      const ids = [...outcomes].filter(([, s]) => s === state).map(([id]) => id);
      for (const part of chunks(ids)) {
        try {
          await session.call('Notification/ack', { ids: part, state });
          remember(part, state);
        } catch (error) {
          log('Notification/ack failed; it is retried at the next run', errorName(error));
          for (const id of part) unacked.set(id, state);
        }
      }
    }
  };

  const postOne = async (i: NotificationItem, outcomes: Settled) => {
    const known = settled.get(i.id) ?? unacked.get(i.id);
    if (known) return void outcomes.set(i.id, known);
    try {
      const result = await post(i);
      if (result === 'posted' || result === 'dropped') outcomes.set(i.id, result);
    } catch (error) {
      log('posting a notification failed; it stays unacked', errorName(error));
    }
  };

  const cancelRetry = () => {
    if (retry === undefined) return;
    timers.clear(retry);
    retry = undefined;
  };

  /** One pending timer at most; it runs a whole new run, which may fail and arm the next, longer one. */
  const armRetry = () => {
    cancelRetry();
    if (!active) return;
    failures += 1;
    retry = timers.set(() => {
      retry = undefined;
      if (active) void schedule();
    }, retryDelay(failures));
  };

  const batch = async (): Promise<number | undefined> => {
    let items: NotificationItem[];
    try {
      items = itemsOf(await session.call('Notification/claim', { max: BATCH }));
    } catch (error) {
      log('Notification/claim failed; it is retried on a timer', errorName(error));
      armRetry();
      return undefined;
    }
    failures = 0;
    const outcomes: Settled = new Map();
    for (const i of items) if (active) await postOne(i, outcomes);
    for (const [id, state] of outcomes) unacked.set(id, state);
    await ack(outcomes);
    return items.length;
  };

  const run = async () => {
    await ack(new Map(unacked));
    for (let n = 0; n < MAX_BATCHES_PER_RUN && active; n++) {
      const count = await batch();
      if (count === undefined || count < BATCH) return;
    }
  };

  const schedule = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    cancelRetry();
    try {
      do {
        again = false;
        await run();
      } while (again && active);
    } finally {
      running = false;
    }
  };

  const unsubscribe = session.subscribe(frame => {
    if (active && isNotify(frame)) void schedule();
  });
  void schedule();
  return () => {
    active = false;
    cancelRetry();
    unsubscribe();
  };
}
