import { LOG_TEXT_MAX, logCodePattern, logIdPattern } from '@aplos/contract/log/events';
import { sha256Hex } from './sha256';

/**
 * The Logger's redactor (plan 10 E0, ARCH 11). The allowlist in the event catalog is the real defence: no field can
 * hold a subject, body or token. This file covers what the allowlist must let through: the few free-text positions
 * (an error's `providerMessage`, a `text` field) and the shape checks on ids and codes. Free-text redaction is
 * best-effort by nature; it errs towards destroying text, because a log line that says less is cheap and a leak is not.
 */

/** Free text is cut to this before any pattern runs, so a 2 MB string costs no more than a short one. */
const SCAN_MAX = 2000;

// Zero-width, bidi, soft-hyphen and variation characters vanish; other control characters become spaces.
const INVISIBLE = /[\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Provider token and key shapes, and PEM blocks. Each match becomes `[secret]`. */
const TOKEN_SHAPES = [
  /-----BEGIN [^-]{1,40}-----[\s\S]*?(?:-----END [^-]{1,40}-----|$)/g,
  /\bya29\.[\w.-]+/g,
  /(?<![\w/])1\/\/[\w.-]{8,}/g,
  /\beyJ[\w-]{4,}\.[\w-]{4,}(?:\.[\w-]*)?/g,
  /\bsk-[\w-]{8,}/g,
  /\bgsk_[\w-]{4,}/g,
  /\bAIza[\w-]{20,}/g,
  /\bGOCSPX-[\w-]{8,}/g,
  /\bgh[pousr]_\w{20,}/g,
  /\bgithub_pat_\w{20,}/g,
  /\bxox[abposr]-[\w-]{8,}/g,
];
/** `key: value` and `key=value` pairs whose value is a credential, including JSON-escaped quotes. Short numbers stay (`"code":403`). */
const SECRET_PAIR = /\b(authorization|proxy-authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|x-api-key|x-goog-api-key|token|password|passwd|pwd|secret|code|cookie|set-cookie|session|sig|signature|key)(\\?["']?\s*[:=]\s*\\?["']?\s*)(?:(?:bearer|basic|token)\s+)?(?!\d{1,5}(?![\w.~+/-]))[^\s"'\\&,;}]+/gi;
const AUTH_SCHEME = /\b(bearer|basic)\s+[\w.~+/=-]+/gi;
const URL = /\b([a-z][a-z0-9+.-]{1,15}):\/\/([^\s"'<>\\]+)/gi;
const ADDRESS = /[^\s@"'<>()[\]{},;:\\/]+@[^\s@"'<>()[\]{},;:\\/]+/g;
/** Quoted text is where providers echo user data (`Invalid label "…"`); only a bare identifier without digits survives. */
const QUOTED = /"((?:[^"\\]|\\.)*)"|“([^”]*)”|«([^»]*)»|(?<![A-Za-z])'((?:[^'\\]|\\.){1,200})'(?![A-Za-z])/g;
const SAFE_QUOTED = /^[A-Za-z_][A-Za-z_.-]{0,40}$/;
/** A run of 8+ word characters mixing letters and digits: ids, tokens, hex, canaries. Plain words and short codes stay. */
const MIXED_RUN = /(?<![\w-])(?=[\w-]*[A-Za-z])(?=[\w-]*\d)[\w-]{8,}(?![\w-])/g;
/** Standard base64 with `+` (paths never have one), long letter-only runs, long digit runs. */
const BASE64_PLUS = /(?<![\w+/-])(?=[A-Za-z0-9+/]*\+)[A-Za-z0-9+/]{20,}={0,2}/g;
const LONG_LETTERS = /[A-Za-z]{40,}/g;
const LONG_DIGITS = /\d{10,}/g;

/** NFKC-folds (fullwidth `＠` becomes `@`), drops invisible characters and undoes common escapes of `@`. */
function fold(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '').replace(CONTROL, ' ')
    .replace(/%(?:25)?40/gi, '@').replace(/&#0*64;|&#x0*40;|&commat;|\\u0040/gi, '@')
    .replace(/\s*[[({]\s*at\s*[\])}]\s*/gi, '@').replace(/\s*[[({]\s*dot\s*[\])}]\s*/gi, '.');
}

/** Lower-cased, NFKC-folded, invisible characters removed, so `Bob@X.example` and `ｂｏｂ@x.example` hash alike. */
export function normalizeAddress(address: string): string {
  return address.normalize('NFKC').replace(INVISIBLE, '').trim().toLowerCase();
}

/** First 16 hex digits of SHA-256 over the per-install salt and the normalised address: correlatable, not reversible without the salt. */
export function hashAddress(salt: string, address: string): string {
  return sha256Hex(`${salt}\n${normalizeAddress(address)}`).slice(0, 16);
}

/** True when a short string has the shape of a credential: a known token prefix or a long alphanumeric run with digits. */
export function looksSecret(text: string): boolean {
  if (TOKEN_SHAPES.some(re => { re.lastIndex = 0; return re.test(text); })) return true;
  return /(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{24,}/.test(text) || /\b(bearer|basic)\s/i.test(text);
}

/** An opaque local id, or undefined when the value is anything else. */
export function cleanId(value: unknown): string | undefined {
  return typeof value === 'string' && logIdPattern.test(value) && !looksSecret(value) ? value : undefined;
}

/** A method id, reason code or model id, or undefined when the value is anything else (a URL included). */
export function cleanCode(value: unknown): string | undefined {
  return typeof value === 'string' && logCodePattern.test(value) && !value.includes('//') && !looksSecret(value) ? value : undefined;
}

/** An OAuth scope: a code (`Mail.Send`, `openid`), or a URL scope on a provider's own scope host. */
export function cleanScope(value: unknown): string | undefined {
  const url = typeof value === 'string' && value.length <= 100 ? /^https:\/\/(www\.googleapis\.com|mail\.google\.com|graph\.microsoft\.com|outlook\.office\.com)\/([A-Za-z0-9_./-]*)$/.exec(value) : null;
  return url ? (url[2] === '' || cleanCode(url[2]) ? value as string : undefined) : cleanCode(value);
}

/** The URL with its user-info, query and fragment removed; the path stays for the later passes. */
function trimUrl(_match: string, scheme: string, rest: string): string {
  const cut = rest.search(/[?#]/);
  let target = cut < 0 ? rest : rest.slice(0, cut);
  const slash = target.indexOf('/');
  const authority = slash < 0 ? target : target.slice(0, slash);
  const at = authority.lastIndexOf('@');
  if (at >= 0) target = target.slice(at + 1);
  return `${scheme}://${target}${cut < 0 ? '' : '?[q]'}`;
}

/**
 * Redacts free text from a provider or the OS: addresses become `[addr:<hash>]` (the same hash as an address field),
 * credentials `[secret]`, ids and long runs `[id]`, quoted text `"[text]"`, URL queries `?[q]`; then cuts to `max`.
 */
export function redactText(input: string, salt: string, max = LOG_TEXT_MAX): string {
  const truncated = input.length > SCAN_MAX;
  let text = fold(truncated ? input.slice(0, SCAN_MAX) : input);
  for (const re of TOKEN_SHAPES) text = text.replace(re, '[secret]');
  text = text.replace(SECRET_PAIR, '$1$2[secret]').replace(AUTH_SCHEME, '$1 [secret]').replace(URL, trimUrl);
  // Address hashes are parked behind private-use markers so the later passes cannot mangle them.
  const hashes: string[] = [];
  text = text.replace(ADDRESS, match => {
    const address = match.replace(/\.+$/, '');
    hashes.push(hashAddress(salt, address));
    return `\ue000${hashes.length - 1}\ue001${match.slice(address.length)}`;
  });
  text = text.replace(QUOTED, (match, ...groups: (string | undefined)[]) => {
    const inner = groups.slice(0, 4).find(g => g !== undefined) ?? '';
    return SAFE_QUOTED.test(inner) ? match : `${match[0]}[text]${match[match.length - 1]}`;
  });
  text = text.replace(BASE64_PLUS, '[secret]').replace(MIXED_RUN, '[id]').replace(LONG_LETTERS, '[secret]').replace(LONG_DIGITS, '[n]');
  text = text.replace(/\ue000(\d+)\ue001/g, (_m, i: string) => `[addr:${hashes[Number(i)]}]`).replace(/[\ue000\ue001]/g, '');
  // A string cut before scanning may end in half a token the patterns could not recognise: drop that last word.
  if (truncated) text = `${text.replace(/\S*$/, '')}…`;
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > max) {
    text = text.slice(0, max);
    if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
  }
  return text;
}
