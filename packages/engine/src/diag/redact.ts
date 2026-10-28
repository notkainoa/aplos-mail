import { LOG_TEXT_MAX, logCodePattern, logIdPattern } from '@aplos/contract/log/events';
import { sha256Hex } from './sha256';

/**
 * The Logger's redactor (plan 10 E0, ARCH 11). The allowlist in the event catalog is the real defence: no field can
 * hold a subject, body or token. This file covers what the allowlist must let through: the few free-text positions
 * (an error's `providerMessage`, a `text` field) and the shape checks on ids and codes. Free-text redaction is
 * best-effort by nature; it errs towards destroying text, because a log line that says less is cheap and a leak is not.
 */

/** Longer "provider text" is a response body or a mistake, not an error message: it is replaced whole, unscanned. */
const SCAN_MAX = 2000;

// Zero-width, bidi, soft-hyphen and variation characters vanish; other control characters become spaces.
/* eslint-disable no-misleading-character-class -- the ranges list combining and invisible code points on purpose */
const INVISIBLE =
  /[\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff]/g;
/* eslint-enable no-misleading-character-class */
// eslint-disable-next-line no-control-regex -- control characters are exactly what this pattern removes
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
  // A masked key as some providers echo it in a 401 (`sk-proj-****abcd`): the visible tail is still part of a key (FR-33).
  /(?:\b[\w.-]{0,24})?[*\u2022]{3,}[\w-]{0,12}/g,
];
/** `key: value` and `key=value` pairs whose value is a credential, including JSON-escaped quotes. Short numbers stay (`"code":403`). */
const SECRET_PAIR =
  /\b(authorization|proxy-authorization|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|x-api-key|x-goog-api-key|token|password|passwd|pwd|secret|code|cookie|set-cookie|session|sig|signature|key)(\\?["']?\s*[:=]\s*\\?["']?\s*)(?:(?:bearer|basic|token)\s+)?(?!\d{1,5}(?![\w.~+/-]))[^\s"'\\&,;}]+/gi;
const AUTH_SCHEME = /\b(bearer|basic)\s+[\w.~+/=-]+/gi;
/** `token <value>` with a space and no `=`: providers and libraries write it in prose. Short words (`token has`) stay. */
const SECRET_WORD =
  /\b((?:access|refresh|id)?[_ -]?token|api[_ -]?key|key|password|passwd|secret)\s+(?=[\w.~+/=-]{12,})[\w.~+/=-]+/gi;
/** `user:password@host` outside a URL. */
const USER_INFO = /[^\s@"'<>/:]+:[^\s@"'<>/]+@(?=[A-Za-z0-9])/g;
/** A labelled piece of mail (`Subject: …`, `To: …`) outside quotes: everything after the label goes, to the end. */
const CONTENT_LABEL =
  /\b(subject|title|summary|snippet|body|preview|file ?name|display ?name|name|from|to|cc|bcc|reply-to|sender|recipients?)\s*[:=]\s*\S.*$/gi;
const URL = /\b([a-z][a-z0-9+.-]{1,15}):\/\/([^\s"'<>\\]+)/gi;
const ADDRESS = /[^\s@"'<>()[\]{},;:\\/]+@[^\s@"'<>()[\]{},;:\\/]+/g;
/** Quoted text is where providers echo user data (`Invalid label "…"`); only a bare identifier without digits survives. */
const QUOTED =
  /"((?:[^"\\]|\\.)*)"|“([^”]*)”|«([^»]*)»|(?<![A-Za-z])'((?:[^'\\]|\\.){1,200})'(?![A-Za-z])/g;
const SAFE_QUOTED = /^[A-Za-z_][A-Za-z_.-]{0,40}$/;
/** A run of 8+ word characters mixing letters and digits: ids, tokens, hex, canaries. Plain words and short codes stay. */
const MIXED_RUN = /(?<![\w-])(?=[\w-]*[A-Za-z])(?=[\w-]*\d)[\w-]{8,}(?![\w-])/g;
/** Standard base64 with `+` (paths never have one), long letter-only runs, long digit runs. */
const BASE64_PLUS = /(?<![\w+/-])(?=[A-Za-z0-9+/]*\+)[A-Za-z0-9+/]{20,}={0,2}/g;
const LONG_LETTERS = /[A-Za-z]{32,}/g;
const LONG_DIGITS = /\d{10,}/g;
/** IP addresses (an SMTP reply names the owner's): IPv4, and IPv6 with three or more colons so clock times stay. */
const IP = /\b\d{1,3}(?:\.\d{1,3}){3}\b|(?<![\w:])(?:[0-9a-f]{0,4}:){3,7}[0-9a-f]{1,4}(?![\w:])/gi;

/** NFKC-folds (fullwidth `＠` becomes `@`), drops invisible characters and undoes common escapes of `@`. */
function fold(text: string): string {
  return text
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(CONTROL, ' ')
    .replace(/%(?:25)?40/gi, '@')
    .replace(/&#0*64;|&#x0*40;|&commat;|\\u0040/gi, '@')
    .replace(/\s*[[({]\s*at\s*[\])}]\s*/gi, '@')
    .replace(/\s*[[({]\s*dot\s*[\])}]\s*/gi, '.');
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
  if (
    TOKEN_SHAPES.some(re => {
      re.lastIndex = 0;
      return re.test(text);
    })
  )
    return true;
  return (
    /(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{24,}/.test(text) ||
    /\b(bearer|basic)\s/i.test(text)
  );
}

/** An opaque local id, or undefined when the value is anything else. */
export function cleanId(value: unknown): string | undefined {
  return typeof value === 'string' && logIdPattern.test(value) && !looksSecret(value)
    ? value
    : undefined;
}

/** A method id, reason code or model id, or undefined when the value is anything else (a URL included). */
export function cleanCode(value: unknown): string | undefined {
  return typeof value === 'string' &&
    logCodePattern.test(value) &&
    !value.includes('//') &&
    !looksSecret(value)
    ? value
    : undefined;
}

/** An OAuth scope: a code (`Mail.Send`, `openid`), or a URL scope on a provider's own scope host. */
export function cleanScope(value: unknown): string | undefined {
  const url =
    typeof value === 'string' && value.length <= 100
      ? /^https:\/\/(www\.googleapis\.com|mail\.google\.com|graph\.microsoft\.com|outlook\.office\.com)\/([A-Za-z0-9_./-]*)$/.exec(
          value,
        )
      : null;
  return url
    ? url[2] === '' || cleanCode(url[2])
      ? (value as string)
      : undefined
    : cleanCode(value);
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
 * credentials `[secret]`, ids and long runs `[id]`, quoted or labelled text `[text]`, URL queries `?[q]`; then cuts to
 * `max`. What it cannot catch is a plain digit-free word a provider echoes unquoted and unlabelled: the catalog keeps
 * free text to provider error messages for that reason.
 */
export function redactText(input: string, salt: string, max = LOG_TEXT_MAX): string {
  if (input.length > SCAN_MAX) return '[long text]';
  let text = fold(input);
  for (const re of TOKEN_SHAPES) text = text.replace(re, '[secret]');
  text = text
    .replace(SECRET_PAIR, '$1$2[secret]')
    .replace(AUTH_SCHEME, '$1 [secret]')
    .replace(SECRET_WORD, '$1 [secret]')
    .replace(URL, trimUrl)
    .replace(USER_INFO, '[secret]@');
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
  // An unclosed quote (a cut or malformed JSON) leaves its text unpaired: it goes too. Labels run after quotes, so a
  // label inside a quoted string can never eat that string's closing quote.
  if ((text.match(/"/g)?.length ?? 0) % 2) text = text.replace(/"[^"]*$/, '"[text]');
  text = text.replace(CONTENT_LABEL, '$1: [text]');
  text = text
    .replace(IP, '[ip]')
    .replace(BASE64_PLUS, '[secret]')
    .replace(MIXED_RUN, '[id]')
    .replace(LONG_LETTERS, '[secret]')
    .replace(LONG_DIGITS, '[n]');
  text = text
    .replace(/\ue000(\d+)\ue001/g, (_m, i: string) => `[addr:${hashes[Number(i)]}]`)
    .replace(/[\ue000\ue001]/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > max) {
    text = text.slice(0, max);
    if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1);
  }
  return text;
}
