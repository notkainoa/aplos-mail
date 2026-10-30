import { IMAGE_PROXY_LIMITS } from '@aplos/engine/ports';

/**
 * The image proxy's caps (plan 10 E4 item 6). `IMAGE_PROXY_LIMITS` is the frozen upper bound: callers (tests) may
 * tighten any number, never loosen it, and the ports are not configurable at all.
 */

/** Tokens whose budgets are remembered at once; html-4 keeps at most 64 live, so this is a generous ceiling. */
export const TRACKED_TOKENS = 256;

export interface ProxyLimits {
  maxRedirects: number;
  maxBytes: number;
  maxPixels: number;
  timeoutMs: number;
  perToken: number;
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
  /** Forgets the token, e.g. when its render is released. */
  release(token: string): void;
  /** Tokens currently tracked. */
  size(): number;
}

/**
 * Per-token request counts. At most `maxTokens` are kept; a new token past that evicts the oldest one, which only
 * resets a token the engine has long since retired (it keeps far fewer live).
 */
export function tokenBudget(limits: Pick<ProxyLimits, 'perToken' | 'maxTokens'>): TokenBudget {
  const used = new Map<string, number>();

  function evictOldest() {
    const oldest = used.keys().next();
    if (!oldest.done) used.delete(oldest.value);
  }

  function take(token: string): boolean {
    const count = used.get(token);
    if (count === undefined && used.size >= limits.maxTokens) evictOldest();
    const next = (count ?? 0) + 1;
    if (next > limits.perToken) return false;
    used.set(token, next);
    return true;
  }

  return { take, release: token => void used.delete(token), size: () => used.size };
}
