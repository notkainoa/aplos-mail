// The `aplos://oauth-return` deep link and its nonce registry. After Google sign-in the loopback page
// redirects the browser to the app's own scheme so the window that started the sign-in comes forward
// instead of leaving the owner on a dead tab.
//
// The link carries one parameter only: `n`, a 128-bit one-time nonce the sign-in flow minted itself
// (never the OAuth `state` or `code`). The page is built in the engine's utility process while macOS
// delivers `aplos:` links to the main process, and the contract's IPC seams may not grow a field here,
// so the registry is the one channel both processes already share: one 0600 file per nonce under
// `<dataDir>/oauth-returns/` (directory 0700, inside the same private data folder as the credential
// vault). An entry is `{purpose, exp}`: which window to raise and when the nonce stops counting.
//
// A web page or another app can fire `aplos://` links at will, so main trusts a link only when its
// nonce names a live registry entry: unknown, expired, replayed or malformed links are silent no-ops
// that never focus, navigate or create a window. A process that can already write inside the private
// data directory can mint entries, but it is inside the app's own trust domain (it could equally read
// the mailbox).

import {
  lstatSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** The window a completed sign-in returns to: the welcome window or the mail window. */
export type OauthReturnPurpose = 'onboarding' | 'mail';

export const oauthReturnScheme = 'aplos';
export const oauthReturnHost = 'oauth-return';
/** Outstanding nonces never exceed this; a burst of sign-ins past it gets a link-free page. */
export const oauthReturnMaxEntries = 16;
/** The deep link is a fixed URL plus the nonce, never longer than this. */
export const oauthReturnLinkMaxLength = 300;

const noncePattern = /^[0-9a-f]{32}$/;
const fileSuffix = '.json';
/** An entry is a two-field object well under this; a bigger file is never read at all. */
const entryFileMaxBytes = 256;

function parse(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/**
 * Whether `raw` claims to be the oauth-return deep link. A claimed link is handled by the
 * oauth-return path alone: it never falls through to the generic deep-link handling, so a malformed
 * or overlong one is a silent no-op rather than a window focus and a nonce never reaches the
 * renderer. The claim is therefore broader than the strict accept in `oauthReturnNonce`: any
 * `aplos:` link whose host or path starts with `oauth-return`, where `aplos:/x`, `aplos:///x` and
 * `aplos:x` spellings put the claim in the path and `aplos://x` puts it in the host (its port and
 * trailing dots normalised away, so `oauth-return:443` and `oauth-return.` count while
 * `oauth-return.evil` does not). `aplos:` links under any other host are not claimed.
 */
export function isOauthReturnLink(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  const url = parse(raw);
  if (!url || url.protocol !== `${oauthReturnScheme}:`) return false;
  if (url.hostname.toLowerCase().replace(/\.+$/, '') === oauthReturnHost) return true;
  return (
    url.host === '' && url.pathname.toLowerCase().replace(/^\/+/, '').startsWith(oauthReturnHost)
  );
}

/**
 * The nonce out of a strictly-shaped `aplos://oauth-return?n=<32 lowercase hex>`: exact scheme and
 * host, no userinfo, port, path beyond `/`, fragment or other parameters, and a whole-link length
 * cap. Anything else is undefined; callers treat it as a silent no-op.
 */
export function oauthReturnNonce(raw: string): string | undefined {
  if (typeof raw !== 'string' || raw.length > oauthReturnLinkMaxLength) return undefined;
  const url = parse(raw);
  if (!url || url.protocol !== `${oauthReturnScheme}:`) return undefined;
  if (
    url.host.toLowerCase() !== oauthReturnHost ||
    url.username !== '' ||
    url.password !== '' ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.hash !== ''
  )
    return undefined;
  const params = [...url.searchParams.entries()];
  if (params.length !== 1 || params[0]![0] !== 'n') return undefined;
  const nonce = params[0]![1];
  return noncePattern.test(nonce) ? nonce : undefined;
}

/** The link the loopback page redirects to and its visible anchor points at. Fixed host, one param. */
export function oauthReturnLink(nonce: string): string {
  if (!noncePattern.test(nonce))
    throw new Error('An oauth-return nonce is 32 lowercase hex digits.');
  return `${oauthReturnScheme}://${oauthReturnHost}?n=${nonce}`;
}

export interface OauthReturnEntry {
  purpose: OauthReturnPurpose;
  /** Epoch milliseconds after which the nonce no longer counts. */
  exp: number;
}

/** The writer side (the utility process's sign-in flow): register before the page is served. */
export interface OauthReturns {
  /**
   * Writes one entry living `ttlMs`; false when the registry is at its bound or the write failed
   * (the page then carries no link).
   */
  register(entry: { nonce: string; purpose: OauthReturnPurpose; ttlMs: number }): boolean;
  /** Drops an entry (a flow that aborted before serving a page). Missing is fine. */
  revoke(nonce: string): void;
}

interface EntryFile {
  purpose?: unknown;
  exp?: unknown;
}

function readEntry(file: string): OauthReturnEntry | undefined {
  try {
    const stat = lstatSync(file);
    // A planted oversized file is treated as absent without being read or parsed.
    if (!stat.isFile() || stat.size > entryFileMaxBytes) return undefined;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as EntryFile;
    const purpose =
      parsed?.purpose === 'onboarding' || parsed?.purpose === 'mail' ? parsed.purpose : undefined;
    const exp = typeof parsed?.exp === 'number' && Number.isFinite(parsed.exp) ? parsed.exp : 0;
    return purpose ? { purpose, exp } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Best-effort removal of a spent or revoked entry: the file is unlinked, or — when the directory
 * refuses the unlink — truncated to an empty tombstone a reader still treats as spent and the next
 * sweep deletes. Never throws; a file that stays live anyway is still bounded by its `exp`.
 */
function removeEntryFile(file: string): void {
  try {
    unlinkSync(file);
    return;
  } catch {
    /* the directory refused: leave the file dead rather than live */
  }
  try {
    truncateSync(file, 0);
  } catch {
    /* still on disk: `exp` and any in-memory consumed set bound it */
  }
}

/**
 * The file-backed registry. `register` sweeps expired or malformed files (a truncated tombstone
 * reads as malformed) first, then refuses past `maxEntries`; the write is a tmp file renamed into
 * place so a reader never sees a partial entry. Every filesystem error is swallowed: the deep link
 * is a convenience, never a reason a sign-in fails.
 */
export function createOauthReturns(options: {
  dir: string;
  now?: () => number;
  maxEntries?: number;
}): OauthReturns {
  const now = options.now ?? Date.now;
  const max = options.maxEntries ?? oauthReturnMaxEntries;
  const { dir } = options;
  const sweep = () => {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(fileSuffix)) continue;
      const file = join(dir, name);
      const entry = readEntry(file);
      if (!entry || entry.exp <= now()) {
        try {
          rmSync(file);
        } catch {
          /* gone or unreadable either way */
        }
      }
    }
  };
  return {
    register({ nonce, purpose, ttlMs }) {
      let tmp: string | undefined;
      try {
        if (!noncePattern.test(nonce) || !(ttlMs > 0)) return false;
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        // mkdir never tightens a folder that already exists: the registry folder is private to this user.
        chmodSync(dir, 0o700);
        sweep();
        const live = readdirSync(dir).filter(name => name.endsWith(fileSuffix));
        if (live.length >= max) return false;
        const file = join(dir, `${nonce}${fileSuffix}`);
        tmp = join(dir, `.${nonce}.tmp`);
        const entry: OauthReturnEntry = { purpose, exp: now() + ttlMs };
        writeFileSync(tmp, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
        renameSync(tmp, file);
        return true;
      } catch {
        // A failed write or rename must not leave its temp file behind (the sweep only reads `.json` entries).
        if (tmp) {
          try {
            rmSync(tmp, { force: true });
          } catch {
            /* nothing more to do */
          }
        }
        return false;
      }
    },
    revoke(nonce) {
      try {
        if (noncePattern.test(nonce)) removeEntryFile(join(dir, `${nonce}${fileSuffix}`));
      } catch {
        /* nothing registered, or already consumed */
      }
    },
  };
}

/**
 * The main-process side: a link's nonce counts only while its file is a live, unexpired regular
 * file. Consuming deletes the file (single use), tombstoning it when the delete is refused;
 * `consumed` additionally remembers every nonce ever
 * accepted so a replay or a re-created file cannot focus twice. Never throws.
 */
export function consumeOauthReturn(
  options: { dir: string; now?: () => number; consumed?: Set<string> },
  nonce: string,
): OauthReturnPurpose | undefined {
  if (!noncePattern.test(nonce) || options.consumed?.has(nonce)) return undefined;
  const now = options.now ?? Date.now;
  const file = join(options.dir, `${nonce}${fileSuffix}`);
  const entry = readEntry(file);
  if (!entry) return undefined;
  options.consumed?.add(nonce);
  removeEntryFile(file);
  return entry.exp > now() ? entry.purpose : undefined;
}
