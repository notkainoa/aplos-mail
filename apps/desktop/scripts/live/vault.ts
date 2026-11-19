import { execFile, spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { RunnerError } from './errors';
import type { LiveProvider } from './types';

/**
 * The test-account vault: a folder outside the repository that holds account metadata only. Tokens
 * live in the macOS keychain and are read through an injected reader, so nothing here ever holds a
 * token longer than one call and no function prints one.
 */
const DAY_MS = 86_400_000;
/** Google expires refresh tokens of projects in Testing mode 7 days after consent. */
export const TESTING_MODE_DAYS = 7;
/** Account labels are short names like "agent", never addresses. */
export const LABEL = /^[a-z][a-z0-9-]{0,31}$/;

export interface AccountMeta {
  provider: LiveProvider;
  /** ISO time of the consent that produced the stored refresh token. */
  grantedAt: string;
  /** ISO time Google said the token stops working, when it said so. */
  refreshExpiresAt?: string;
  /** Keychain service that holds the refresh token. */
  keychainService: string;
  /**
   * The signed-in account's address, salted and hashed (never the address itself), so the
   * mutating tiers can check they run on the account that signed in. The salt is random per
   * sign-in and stored beside the hash.
   */
  addressSalt?: string;
  addressHash?: string;
}

export type AccountsFile = Record<string, AccountMeta>;
export type SecretReader = (service: string) => Promise<string>;
export type SecretWriter = (service: string, secret: string) => Promise<void>;

/** A folder under ~/Library/Application Support, outside the repository. */
export function applicationSupportDir(...parts: string[]): string {
  return join(homedir(), 'Library', 'Application Support', ...parts);
}

export function vaultDir(env: Record<string, string | undefined> = process.env): string {
  return env.APLOS_LIVE_VAULT || applicationSupportDir('Aplos Mail Live');
}

const isoTime = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

/** Strict on purpose: an unexpected field (say, a pasted token) makes the whole file invalid. */
function validate(label: string, value: unknown): AccountMeta {
  if (!LABEL.test(label))
    throw new RunnerError('Account labels are lowercase names such as "agent"');
  const meta = value as Partial<AccountMeta> | null;
  if (!meta || typeof meta !== 'object') throw new RunnerError(`Account ${label} is malformed`);
  const extra = Object.keys(meta).filter(
    key =>
      ![
        'provider',
        'grantedAt',
        'refreshExpiresAt',
        'keychainService',
        'addressSalt',
        'addressHash',
      ].includes(key),
  );
  if (extra.length)
    throw new RunnerError(
      `Account ${label} has unexpected fields; the vault file holds metadata only`,
    );
  if (meta.provider !== 'gmail' && meta.provider !== 'gcal')
    throw new RunnerError(`Account ${label} has an unknown provider`);
  if (!isoTime(meta.grantedAt)) throw new RunnerError(`Account ${label} has no valid grantedAt`);
  if (meta.refreshExpiresAt !== undefined && !isoTime(meta.refreshExpiresAt))
    throw new RunnerError(`Account ${label} has an invalid refreshExpiresAt`);
  if (
    typeof meta.keychainService !== 'string' ||
    !/^[A-Za-z0-9._-]{1,80}$/.test(meta.keychainService)
  )
    throw new RunnerError(`Account ${label} has an invalid keychainService`);
  const hashed = meta.addressSalt !== undefined || meta.addressHash !== undefined;
  if (
    hashed &&
    !(
      typeof meta.addressSalt === 'string' &&
      SALT.test(meta.addressSalt) &&
      typeof meta.addressHash === 'string' &&
      HASH.test(meta.addressHash)
    )
  )
    throw new RunnerError(`Account ${label} has an invalid address hash`);
  return {
    provider: meta.provider,
    grantedAt: meta.grantedAt,
    ...(meta.refreshExpiresAt ? { refreshExpiresAt: meta.refreshExpiresAt } : {}),
    keychainService: meta.keychainService,
    ...(hashed ? { addressSalt: meta.addressSalt, addressHash: meta.addressHash } : {}),
  };
}

export async function loadAccounts(dir: string): Promise<AccountsFile> {
  let text: string;
  try {
    text = await readFile(join(dir, 'accounts.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSON.parse quotes the text around the error, and a mis-pasted token would be in it.
    throw new RunnerError('accounts.json is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new RunnerError('accounts.json must be an object of labels');
  return Object.fromEntries(
    Object.entries(parsed).map(([label, value]) => [label, validate(label, value)]),
  );
}

export async function saveAccount(dir: string, label: string, meta: AccountMeta): Promise<void> {
  const accounts = await loadAccounts(dir);
  accounts[label] = validate(label, meta);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Write then rename so a crash cannot leave half a file that hides the other accounts.
  const temp = join(dir, `accounts.json.${process.pid}.tmp`);
  await writeFile(temp, `${JSON.stringify(accounts, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, join(dir, 'accounts.json'));
}

// ---------- the account check ----------

const SALT = /^[A-Za-z0-9_-]{22,64}$/;
const HASH = /^[0-9a-f]{64}$/;

export function newAddressSalt(): string {
  return randomBytes(16).toString('base64url');
}

/** A slow salted hash of an address, compared case-blind like Gmail compares addresses. */
export function addressHash(address: string, salt: string): string {
  return scryptSync(address.trim().toLowerCase(), salt, 32).toString('hex');
}

/** True only when the account has a stored hash and `address` hashes to it. */
export function addressMatches(account: AccountMeta, address: string): boolean {
  if (account.addressSalt === undefined || account.addressHash === undefined) return false;
  const expected = Buffer.from(account.addressHash, 'hex');
  const actual = Buffer.from(addressHash(address, account.addressSalt), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function defaultKeychainService(label: string): string {
  return `aplos-mail-live-${label}`;
}

// ---------- keychain (macOS) ----------

const execFileAsync = promisify(execFile);

/** Reads a generic password. Errors carry no output, so a failure cannot echo a secret. */
export const keychainReader: SecretReader = async service => {
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      service,
      '-w',
    ]);
    const secret = stdout.replace(/\r?\n$/, '');
    if (!secret) throw new RunnerError('empty');
    return secret;
  } catch {
    throw new RunnerError(`The keychain item "${service}" could not be read`);
  }
};

/**
 * Stores a generic password with `security -i`, which takes the command on stdin, so the token
 * never appears in the process list the way a `-w <token>` argument would.
 */
export const keychainWriter: SecretWriter = (service, secret) => {
  // Tokens are URL-safe text; refusing anything else keeps the quoting below trivial.
  if (!/^[A-Za-z0-9._~/+=-]+$/.test(secret) || !/^[A-Za-z0-9._-]+$/.test(service))
    return Promise.reject(new RunnerError('Secret or service name has unsupported characters'));
  return new Promise((resolve, reject) => {
    const child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => reject(new RunnerError('The keychain could not be written')));
    child.on('close', code =>
      code === 0 ? resolve() : reject(new RunnerError('The keychain could not be written')),
    );
    child.stdin.end(`add-generic-password -U -a aplos-live -s ${service} -w "${secret}"\n`);
  });
};

// ---------- expiry ----------

/** The last moment the stored token is expected to work: grant plus 7 days, or Google's own date if earlier. */
export function reconnectBy(account: AccountMeta): number {
  const byGrant = Date.parse(account.grantedAt) + TESTING_MODE_DAYS * DAY_MS;
  return account.refreshExpiresAt
    ? Math.min(byGrant, Date.parse(account.refreshExpiresAt))
    : byGrant;
}

export type Preflight =
  { ok: true; daysLeft: number } | { ok: false; daysLeft: number; message: string };

/** A token closer than this to its reconnect date is not used (plans/LIVE-RUNS.md, check 5). */
export const RECONNECT_MARGIN_MS = DAY_MS;

/**
 * Checks an account before a run. A token that has expired, will expire while the run is going, or
 * must be reconnected within a day is a skip with a plain message: it is not a failure of the code
 * under test.
 */
export function preflight(
  account: AccountMeta,
  label: string,
  expectedRunMs: number,
  now: number,
): Preflight {
  const by = reconnectBy(account);
  const daysLeft = Math.floor((by - now) / DAY_MS);
  if (by > now + Math.max(expectedRunMs, RECONNECT_MARGIN_MS)) return { ok: true, daysLeft };
  const date = new Date(by).toISOString().slice(0, 10);
  return {
    ok: false,
    daysLeft,
    message: `test account ${label} expires ${date}, reconnect it first`,
  };
}
