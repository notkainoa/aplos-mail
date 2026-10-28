import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { parseWorkflowLog, type WorkflowLog } from '@aplos/engine/legacy/workflow';

/**
 * Sync codes are 26 random Crockford base32 symbols (130 bits) plus 2 check symbols, shown as seven groups
 * of four. Crockford's alphabet has no I, L, O or U; typed O, I and L are read as 0, 1 and 1.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM = 26,
  CHECK = 2;
const PREFIX = 'APLOS-WF1';
/** Hosts store the blob as one small message; Outlook caps app data near 3 MB once base64-encoded. */
export const MAX_SEALED = 2_000_000;
export const MAX_PLAIN = 32_000_000;
// 32 MiB of memory and well under a second; the code itself carries 130 bits, so this only slows guessing further.
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export class WorkflowCryptoError extends Error {
  constructor(
    message: string,
    readonly reason: 'code' | 'damaged' | 'format' | 'size',
  ) {
    super(message);
  }
}

function checksum(symbols: string): string {
  const digest = createHash('sha256').update(`aplos-sync-code:${symbols}`).digest();
  return Array.from({ length: CHECK }, (_, i) => ALPHABET[digest[i] % 32]).join('');
}
const group = (symbols: string) => symbols.match(/.{1,4}/g)!.join('-');

export function generateSyncCode(): string {
  const bytes = randomBytes(RANDOM),
    symbols = Array.from(bytes, b => ALPHABET[b % 32]).join('');
  return group(symbols + checksum(symbols));
}

/** Canonical grouped form of a typed code: any case, spaces or dashes. Throws when it cannot be a sync code. */
export function normalizeSyncCode(input: string): string {
  const symbols = input
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (symbols.length !== RANDOM + CHECK || [...symbols].some(c => !ALPHABET.includes(c)))
    throw new WorkflowCryptoError(
      `A sync code has ${RANDOM + CHECK} letters and digits. Check that you copied all of it.`,
      'format',
    );
  if (checksum(symbols.slice(0, RANDOM)) !== symbols.slice(RANDOM))
    throw new WorkflowCryptoError(
      'This sync code has a typo. Check it against the code on your other device.',
      'format',
    );
  return group(symbols);
}

/** 32 bytes of AES key and 16 bytes that let a wrong code be told apart from damaged data. */
function derive(code: string, salt: Buffer) {
  const material = scryptSync(normalizeSyncCode(code).replace(/-/g, ''), salt, 48, SCRYPT);
  return { key: material.subarray(0, 32), check: material.subarray(32) };
}
const b64 = (value: Buffer) => value.toString('base64url');

/** Encrypt a workflow log for storage at the mail host: `APLOS-WF1.<salt>.<check>.<iv>.<ciphertext+tag>`. */
export function sealWorkflow(log: WorkflowLog, code: string, maxPlain = MAX_PLAIN): string {
  const salt = randomBytes(16),
    iv = randomBytes(12),
    { key, check } = derive(code, salt);
  const header = `${PREFIX}.${b64(salt)}.${b64(check)}.${b64(iv)}`;
  const tooLarge = () =>
    new WorkflowCryptoError(
      'Workflow data is too large to sync. Older entries are dropped automatically; try again after the next sync.',
      'size',
    );
  // Checked here as well as on open, or a log that compresses well would be written and then refused by every reader.
  const plain = Buffer.from(JSON.stringify(log));
  if (plain.length > maxPlain) throw tooLarge();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(header));
  const body = Buffer.concat([
    cipher.update(deflateRawSync(plain)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const sealed = `${header}.${b64(body)}`;
  if (sealed.length > MAX_SEALED) throw tooLarge();
  return sealed;
}

export function openWorkflow(blob: string, code: string, maxPlain = MAX_PLAIN): WorkflowLog {
  const damaged = () =>
    new WorkflowCryptoError(
      'The synced workflow data in this account is damaged. Syncing from this device will replace it.',
      'damaged',
    );
  if (blob.length > MAX_SEALED)
    throw new WorkflowCryptoError(
      'The synced workflow data in this account is too large to read.',
      'size',
    );
  const parts = blob.trim().split('.');
  if (parts[0] !== PREFIX)
    throw new WorkflowCryptoError(
      parts[0]?.startsWith('APLOS-WF')
        ? 'This workflow data was written by a newer version of Aplos. Update Aplos on this device.'
        : 'The data in this account’s Aplos folder is not Aplos workflow data.',
      'format',
    );
  if (parts.length !== 5 || parts.slice(1).some(p => !/^[\w-]+$/.test(p))) throw damaged();
  const [salt, check, iv, body] = parts.slice(1).map(p => Buffer.from(p, 'base64url'));
  if (salt.length !== 16 || check.length !== 16 || iv.length !== 12 || body.length < 17)
    throw damaged();
  const derived = derive(code, salt);
  if (!timingSafeEqual(derived.check, check))
    throw new WorkflowCryptoError(
      'This sync code does not match the one used on your other devices. Enter the code shown on a device that already syncs.',
      'code',
    );
  let deflated: Buffer, plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', derived.key, iv);
    decipher.setAAD(Buffer.from(parts.slice(0, 4).join('.')));
    decipher.setAuthTag(body.subarray(-16));
    deflated = Buffer.concat([decipher.update(body.subarray(0, -16)), decipher.final()]);
  } catch {
    throw damaged();
  }
  try {
    plain = inflateRawSync(deflated, { maxOutputLength: maxPlain });
  } catch (error) {
    // Authenticated data over the limit came from a device with the code (perhaps a newer version), so it is kept, not replaced.
    if ((error as NodeJS.ErrnoException)?.code === 'ERR_BUFFER_TOO_LARGE')
      throw new WorkflowCryptoError(
        'The synced workflow data in this account is too large to read.',
        'size',
      );
    throw damaged();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(plain.toString('utf8'));
  } catch {
    throw damaged();
  }
  return parseWorkflowLog(parsed);
}
