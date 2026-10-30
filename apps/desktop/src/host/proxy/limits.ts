import { IMAGE_PROXY_LIMITS } from '@aplos/engine/ports';

/**
 * The image proxy's caps (plan 10 E4 item 6). `IMAGE_PROXY_LIMITS` is the frozen upper bound: callers (tests) may
 * tighten any number, never loosen it, and the ports are not configurable at all.
 */

/** Tokens whose budgets are remembered at once; html-4 keeps at most 64 live, so this is a generous ceiling. */
export const TRACKED_TOKENS = 256;

/** Fetches in flight at once, across every token: bounds buffered bytes to this times `maxBytes` (60 MB). */
export const MAX_IN_FLIGHT = 6;

/** Body bytes one token may pull in total, redirect hops included (five full-size images). */
export const PER_TOKEN_BYTES = 50_000_000;

export interface ProxyLimits {
  maxRedirects: number;
  maxBytes: number;
  maxPixels: number;
  timeoutMs: number;
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
  /** Resolves with a release function once a slot is free; rejects with the signal's reason if it aborts first. */
  acquire(signal?: AbortSignal): Promise<Release>;
}

interface Waiter {
  grant(release: Release): void;
}

/** A counting semaphore: at most `max` holders, the rest queued first in, first out. Aborted waiters leave the queue. */
export function createSemaphore(max: number): Semaphore {
  let active = 0;
  const queue: Waiter[] = [];

  function releaseOnce(): Release {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = queue.shift();
      // The slot passes straight to the next waiter, so `active` only drops when nobody waits.
      if (next) next.grant(releaseOnce());
      else active -= 1;
    };
  }

  function acquire(signal?: AbortSignal): Promise<Release> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (active < max) {
      active += 1;
      return Promise.resolve(releaseOnce());
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        grant: release => {
          signal?.removeEventListener('abort', onAbort);
          resolve(release);
        },
      };
      function onAbort() {
        queue.splice(queue.indexOf(waiter), 1);
        reject(signal?.reason);
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      queue.push(waiter);
    });
  }

  return { acquire };
}
