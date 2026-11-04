import type { StoreReader } from '../store/port';

// The one place a `Mail/frame` image policy is decided (html-4, reviewer recommendation d). The contract asks for
// `block` or `load`; the sanitizer takes `block` or `allow`. `load` is the owner's explicit "Load images"; `block` turns
// into `allow` only for a sender on `Settings.mail.imageAllowList`. Anything else is `block`. The render cache is keyed
// on the result, never on the request, so an allow-listed render can never be served for a blocked one or back.

export type ResolvedPolicy = 'block' | 'allow';
export type RequestedPolicy = 'block' | 'load';

/** The contract's request, closed: anything but `load` is `block`. */
export function requestedOf(value: unknown): RequestedPolicy {
  return value === 'load' ? 'load' : 'block';
}

/** The contract's `SenderMatch` shapes (`common.ts`), restated without zod: an address, or `@domain`. */
const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const DOMAIN = /^@[^\s@<>]+\.[^\s@<>]+$/;
const MAX_MATCH = 320;

/** An allow-list entry as stored and compared: trimmed, lower case, and a valid address or `@domain`. */
export function normaliseMatch(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.trim().toLowerCase();
  if (match.length > MAX_MATCH) return undefined;
  return ADDRESS.test(match) || DOMAIN.test(match) ? match : undefined;
}

/** True when the sender's whole address, or its whole domain as `@domain`, is on the list. Never a suffix match. */
export function senderAllowed(sender: unknown, allowList: readonly unknown[]): boolean {
  const address = normaliseMatch(sender);
  if (address === undefined || address.startsWith('@')) return false;
  const domain = address.slice(address.lastIndexOf('@'));
  return allowList.some(entry => {
    const match = normaliseMatch(entry);
    return match === address || match === domain;
  });
}

export function resolveImagePolicy(
  requested: unknown,
  sender: unknown,
  allowList: readonly unknown[],
  global: 'block' | 'allow' = 'block',
): ResolvedPolicy {
  if (requested === 'load') return 'allow';
  if (requested !== 'block') return 'block';
  if (global === 'allow') return 'allow';
  return senderAllowed(sender, allowList) ? 'allow' : 'block';
}

/** `Settings.mail.remoteImages`: the owner's global always-load choice; 'block' when unset or unreadable. */
export function readRemoteImages(q: StoreReader): 'block' | 'allow' {
  try {
    const row = q.get<{ value: string | null }>(
      "SELECT json_extract(data, '$.mail.remoteImages') AS value FROM settings WHERE id = 1",
    );
    return row && row.value === 'allow' ? 'allow' : 'block';
  } catch {
    return 'block';
  }
}

/** `Settings.mail.imageAllowList` from the settings document; empty when there is none or it is unreadable. */
export function readAllowList(q: StoreReader): unknown[] {
  try {
    const row = q.get<{ list: string | null }>(
      "SELECT json_extract(data, '$.mail.imageAllowList') AS list FROM settings WHERE id = 1",
    );
    if (!row || typeof row.list !== 'string') return [];
    const list: unknown = JSON.parse(row.list);
    return Array.isArray(list) ? list : [];
  } catch {
    // A settings document that is not JSON allows nobody: the safe answer is "block".
    return [];
  }
}
