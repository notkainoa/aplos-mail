import { IMAGE_PROXY_LIMITS } from '@aplos/engine/ports';

/**
 * The image proxy's caps (plan 10 E4 item 6). `IMAGE_PROXY_LIMITS` is the frozen upper bound: callers (tests) may
 * tighten any number, never loosen it, and the ports are not configurable at all.
 */

/** Tokens whose budgets are remembered at once; html-4 keeps at most 64 live, so this is a generous ceiling. */
export const TRACKED_TOKENS = 256;

/** Fetches in flight at once, across every token: bounds buffered bytes to this times `maxBytes` (60 MB). */
export const MAX_IN_FLIGHT = 6;

/** How long one fetch may wait for in-flight slots in all, before it is refused as `timeout`. */
export const WAIT_MS = 30_000;

/** Body bytes one token may pull in total, redirect hops included (five full-size images). */
export const PER_TOKEN_BYTES = 50_000_000;

export interface ProxyLimits {
  maxRedirects: number;
  maxBytes: number;
  maxPixels: number;
  /** A fetch's own working time (lookups, connect, body, redirects); the clock stops while it waits for a slot. */
  timeoutMs: number;
  /** Total time a fetch may spend waiting for in-flight slots, across its hops. */
  waitMs: number;
  perToken: number;
  /** Body bytes per token across all its fetches. */
  perTokenBytes: number;
  /** Fetches in flight at once; the rest wait for a slot. */
  maxInFlight: number;
  /** How many tokens' budgets are tracked before the oldest is forgotten. */
  maxTokens: number;
  ports: readonly number[];
}

export type LimitOverrides = Partial<Omit<ProxyLimits, 'ports'>>;

const CEILINGS: Omit<ProxyLimits, 'ports'> = {
  maxRedirects: IMAGE_PROXY_LIMITS.maxRedirects,
  maxBytes: IMAGE_PROXY_LIMITS.maxBytes,
  maxPixels: IMAGE_PROXY_LIMITS.maxPixels,
  timeoutMs: IMAGE_PROXY_LIMITS.timeoutMs,
  waitMs: WAIT_MS,
  perToken: IMAGE_PROXY_LIMITS.perToken,
  perTokenBytes: PER_TOKEN_BYTES,
  maxInFlight: MAX_IN_FLIGHT,
  maxTokens: TRACKED_TOKENS,
};

function checked(name: keyof typeof CEILINGS, value: number): number {
  const ceiling = CEILINGS[name];
  if (!Number.isSafeInteger(value) || value < 0 || value > ceiling)
    throw new RangeError(`image proxy limit ${name} must be an integer from 0 to ${ceiling}`);
  return value;
}

/** The frozen limits, with any override checked to be a tightening. Throws on an attempt to loosen. */
export function proxyLimits(overrides: LimitOverrides = {}): ProxyLimits {
  const limits = { ...CEILINGS, ports: IMAGE_PROXY_LIMITS.ports };
  for (const name of Object.keys(CEILINGS) as (keyof typeof CEILINGS)[]) {
    const value = overrides[name];
    if (value !== undefined) limits[name] = checked(name, value);
  }
  return Object.freeze(limits);
}

export interface TokenBudget {
  /** Spends one request from the token's budget; false once it is spent. */
  take(token: string): boolean;
  /** Charges body bytes to the token; false once its byte budget is exceeded. */
  spendBytes(token: string, bytes: number): boolean;
  /** Forgets the token, e.g. when its render is released. */
  release(token: string): void;
  /** Tokens currently tracked. */
  size(): number;
}

interface Spent {
  requests: number;
  bytes: number;
}

/**
 * Per-token request and byte counts. At most `maxTokens` are kept; a new token past that evicts the oldest one, which
 * only resets a token the engine has long since retired (it keeps far fewer live).
 */
export function tokenBudget(
  limits: Pick<ProxyLimits, 'perToken' | 'perTokenBytes' | 'maxTokens'>,
): TokenBudget {
  const used = new Map<string, Spent>();

  function evictOldest() {
    const oldest = used.keys().next();
    if (!oldest.done) used.delete(oldest.value);
  }

  function take(token: string): boolean {
    const spent = used.get(token);
    if (spent === undefined && used.size >= limits.maxTokens) evictOldest();
    const requests = (spent?.requests ?? 0) + 1;
    if (requests > limits.perToken) return false;
    used.set(token, { requests, bytes: spent?.bytes ?? 0 });
    return true;
  }

  function spendBytes(token: string, bytes: number): boolean {
    const spent = used.get(token);
    // A released or forgotten token has no render left to protect.
    if (spent === undefined) return true;
    spent.bytes += bytes;
    return spent.bytes <= limits.perTokenBytes;
  }

  return { take, spendBytes, release: token => void used.delete(token), size: () => used.size };
}

export type Release = () => void;

export interface Semaphore {
  /**
   * Resolves with a release function once a slot is free; rejects with the signal's reason if it aborts first. Waiters
   * of one `group` (an image token) queue together; a freed slot goes to the waiting group holding the fewest slots,
   * so a group with many waiters cannot keep another out.
   */
  acquire(signal?: AbortSignal, group?: string): Promise<Release>;
}

interface Waiter {
  grant(release: Release): void;
}

/**
 * A counting semaphore: at most `max` holders. Waiters queue per group, first in, first out inside a group; across
 * groups a freed slot goes to the waiting group with the fewest holders (the one waiting longest on a tie). Aborted
 * waiters leave their queue.
 */
export function createSemaphore(max: number): Semaphore {
  let active = 0;
  const holding = new Map<string, number>();
  // Insertion order is the tie-break: a group that was just served moves to the back.
  const queues = new Map<string, Waiter[]>();

  function hold(group: string, by: number) {
    const count = (holding.get(group) ?? 0) + by;
    if (count > 0) holding.set(group, count);
    else holding.delete(group);
  }

  function neediest(): string | undefined {
    let best: string | undefined;
    for (const group of queues.keys())
      if (best === undefined || (holding.get(group) ?? 0) < (holding.get(best) ?? 0)) best = group;
    return best;
  }

  function releaseOnce(group: string): Release {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      hold(group, -1);
      const next = neediest();
      // The slot passes straight to the next waiter, so `active` only drops when nobody waits.
      if (next === undefined) active -= 1;
      else dequeue(next).grant(releaseOnce(next));
    };
  }

  function dequeue(group: string): Waiter {
    const queue = queues.get(group) as Waiter[];
    const waiter = queue.shift() as Waiter;
    queues.delete(group);
    if (queue.length > 0) queues.set(group, queue);
    hold(group, 1);
    return waiter;
  }

  function leave(group: string, waiter: Waiter) {
    const queue = queues.get(group);
    const at = queue?.indexOf(waiter) ?? -1;
    // Already granted or removed: splice(-1) would drop an unrelated waiter.
    if (!queue || at === -1) return false;
    queue.splice(at, 1);
    if (queue.length === 0) queues.delete(group);
    return true;
  }

  function acquire(signal?: AbortSignal, group = ''): Promise<Release> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (active < max) {
      active += 1;
      hold(group, 1);
      return Promise.resolve(releaseOnce(group));
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        grant: release => {
          signal?.removeEventListener('abort', onAbort);
          resolve(release);
        },
      };
      function onAbort() {
        if (leave(group, waiter)) reject(signal?.reason);
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      const queue = queues.get(group);
      if (queue) queue.push(waiter);
      else queues.set(group, [waiter]);
    });
  }

  return { acquire };
}
