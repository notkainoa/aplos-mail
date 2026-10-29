import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * Sealing for the workflow channel (DECISIONS M29, ARCH 13.1), ported from `src/main/workflow-crypto.ts` without its sync
 * code and vault: the key is the engine's data key (`KeyProvider`, injected by the caller), stretched once with HKDF to
 * a channel key that seals nothing else. Format `APLOS-WF2.<kid>.<iv>.<ciphertext+tag>`, AES-256-GCM over the raw-
 * deflated JSON payload. The account's address is in the key derivation and in the AAD (with the header), so a copy
 * lifted from another account (or a header with a swapped kid or iv) fails authentication. `kid` is an HMAC of the channel key, so a copy sealed under a
 * different key is told apart from a damaged one without revealing anything about either key.
 */

export const SEAL_PREFIX = 'APLOS-WF2';
/** One small message per copy; Gmail's insert limit is far above this, every reader refuses more. */
export const MAX_SEALED = 2_000_000;
export const MAX_PLAIN = 32_000_000;
const KID_BYTES = 9;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type OpenFailure = 'format' | 'wrongKey' | 'damaged' | 'size';
export type OpenResult = { ok: true; plain: unknown } | { ok: false; reason: OpenFailure };

export interface ChannelKey {
  key: Buffer;
  kid: string;
}

const b64 = (value: Buffer) => value.toString('base64url');

const normal = (address: string) => address.trim().toLowerCase();

/**
 * The channel key for one account, derived from the 32-byte data key with the account's address in the HKDF info, so
 * each account has its own key and `kid` and two accounts' copies cannot be linked by it; never logged, never stored.
 */
export function channelKey(dataKey: Uint8Array, address: string): ChannelKey {
  if (dataKey.byteLength < 32)
    throw new Error('The data key is too short for the workflow channel');
  const info = `workflow-channel/v2|${normal(address)}`;
  const key = Buffer.from(hkdfSync('sha256', dataKey, 'aplos-mail/workflow', info, 32));
  const kid = b64(
    createHmac('sha256', key).update('aplos-wf2-kid').digest().subarray(0, KID_BYTES),
  );
  return { key, kid };
}

const aad = (header: string, binding: string) => Buffer.from(`${header}|${normal(binding)}`);

/** Seals `payload` for the account `binding` (its address). Throws when the result would be refused by readers. */
export function seal(payload: unknown, key: ChannelKey, binding: string): string {
  const plain = Buffer.from(JSON.stringify(payload));
  if (plain.length > MAX_PLAIN) throw new Error('Workflow data is too large to seal');
  const iv = randomBytes(IV_BYTES);
  const header = `${SEAL_PREFIX}.${key.kid}.${b64(iv)}`;
  const cipher = createCipheriv('aes-256-gcm', key.key, iv);
  cipher.setAAD(aad(header, binding));
  const body = Buffer.concat([
    cipher.update(deflateRawSync(plain)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const sealed = `${header}.${b64(body)}`;
  if (sealed.length > MAX_SEALED) throw new Error('Workflow data is too large to seal');
  return sealed;
}

interface Parts {
  header: string;
  kid: string;
  iv: Buffer;
  body: Buffer;
}

function split(blob: string): Parts | OpenFailure {
  const parts = blob.trim().split('.');
  if (parts[0] !== SEAL_PREFIX) return 'format';
  if (parts.length !== 4 || parts.slice(1).some(p => !/^[\w-]+$/.test(p))) return 'damaged';
  const iv = Buffer.from(parts[2], 'base64url');
  const body = Buffer.from(parts[3], 'base64url');
  if (iv.length !== IV_BYTES || body.length <= TAG_BYTES) return 'damaged';
  return { header: parts.slice(0, 3).join('.'), kid: parts[1], iv, body };
}

function sameKid(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function decrypt(parts: Parts, key: ChannelKey, binding: string): Buffer | undefined {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.key, parts.iv);
    decipher.setAAD(aad(parts.header, binding));
    decipher.setAuthTag(parts.body.subarray(-TAG_BYTES));
    return Buffer.concat([decipher.update(parts.body.subarray(0, -TAG_BYTES)), decipher.final()]);
  } catch {
    return undefined;
  }
}

function inflate(deflated: Buffer): Buffer | OpenFailure {
  try {
    return inflateRawSync(deflated, { maxOutputLength: MAX_PLAIN });
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE' ? 'size' : 'damaged';
  }
}

/**
 * Opens a sealed copy. Nothing is returned unless GCM authenticated every byte under this key and binding, so a wrong
 * key, a foreign account or a flipped bit never yields plaintext, not even a prefix.
 */
export function open(blob: string, key: ChannelKey, binding: string): OpenResult {
  if (blob.length > MAX_SEALED) return { ok: false, reason: 'size' };
  const parts = split(blob);
  if (typeof parts === 'string') return { ok: false, reason: parts };
  if (!sameKid(parts.kid, key.kid)) return { ok: false, reason: 'wrongKey' };
  const deflated = decrypt(parts, key, binding);
  if (!deflated) return { ok: false, reason: 'damaged' };
  const plain = inflate(deflated);
  if (typeof plain === 'string') return { ok: false, reason: plain };
  try {
    return { ok: true, plain: JSON.parse(plain.toString('utf8')) };
  } catch {
    return { ok: false, reason: 'damaged' };
  }
}
