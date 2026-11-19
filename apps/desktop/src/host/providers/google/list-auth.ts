import type { Address } from '@aplos/engine/ports';
import type { GmailHeader } from './mime';

/**
 * `ListHeaders.authenticated` for Gmail (RFC 8058 section 4, DECISIONS 2026-10-31): does a DKIM signature that Gmail's
 * receiving server verified cover From, List-Unsubscribe and List-Unsubscribe-Post, and align with the From domain?
 * Only the topmost `Authentication-Results` header counts, and only when Google wrote it (`mx.google.com`): every lower
 * one, and every `ARC-*` header, is text a sender or an earlier hop could have written. Gmail's results do not list the
 * signed headers, so the passing result is matched to its `DKIM-Signature` (by `d=`, `s=` and the `b=` prefix) to read
 * `h=`. Pure, no I/O, no clock; every parse is a single bounded scan (no backtracking regex on header text).
 *
 * `undefined` = unknown (no `Authentication-Results` at all), `false` = checked and it does not hold.
 */

export const LIST_AUTH_LIMITS = Object.freeze({
  /** An `Authentication-Results` header longer than this is not judged (`false`). */
  maxResultsChars: 4_096,
  maxTokens: 512,
  /** Results after the authserv-id; more and the header is not judged. */
  maxResults: 20,
  maxCommentDepth: 8,
  /** A `DKIM-Signature` longer than this, or more signatures than `maxSignatures`, and the message is `false`. */
  maxSignatureChars: 8_192,
  maxSignatures: 8,
  /** Gmail sends 8 characters of `b=` as `header.b`; fewer cannot tell signatures apart. */
  minBodyPrefix: 6,
});

export const GOOGLE_AUTHSERV_ID = 'mx.google.com';

/** Headers the signature must cover; DKIM `h=` names are case-insensitive. */
const COVERED = ['from', 'list-unsubscribe', 'list-unsubscribe-post'] as const;

type Token = { kind: 'word'; text: string } | { kind: 'eq' } | { kind: 'semi' };

export interface AuthResult {
  method: string;
  result: string;
  /** `ptype.property` (lowercased) -> value, quotes removed. */
  props: ReadonlyMap<string, string>;
}

export interface DkimSignature {
  d: string;
  s: string;
  /** `b=` with all whitespace removed. */
  b: string;
  /** `h=` entries, lowercased. */
  h: readonly string[];
}

// ---- Authentication-Results (RFC 8601) ----

/** The index after a `( ... )` comment starting at `start`, or -1 when it is unterminated, nested too deep or holds a `;`. */
function skipComment(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++;
      if (text[i] === ';') return -1;
      continue;
    }
    // A `;` inside a comment would let sender text echoed into the header hide the results around it.
    if (c === ';') return -1;
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (depth > LIST_AUTH_LIMITS.maxCommentDepth) return -1;
    if (depth === 0) return i + 1;
  }
  return -1;
}

/** A quoted string starting at `start` (`"`), unescaped, and the index after it; null when unterminated. */
function readQuoted(text: string, start: number): { value: string; end: number } | null {
  let value = '';
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"') return { value, end: i + 1 };
    // Same for a quoted string: Google writes neither with a `;`, a sender could.
    if (c === ';') return null;
    if (c === '\\') {
      i++;
      if (text[i] === ';') return null;
      value += text[i] ?? '';
    } else value += c;
  }
  return null;
}

const SPACE = new Set([' ', '\t', '\r', '\n']);

/**
 * Words, `=` and `;`, with comments dropped and quoted strings joined to the word they are in. Null when a comment or
 * quote is unterminated, or there are more than `maxTokens` tokens.
 */
export function tokenize(text: string): Token[] | null {
  const tokens: Token[] = [];
  let word = '';
  const flush = () => {
    if (word) tokens.push({ kind: 'word', text: word });
    word = '';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    // A comment or quote right after word characters is not where RFC 8601 allows one, and it would hide the text
    // around it from this parser (`header.s=k(` ...), so it fails the header.
    if ((c === '(' || c === '"') && word) return null;
    if (c === '(') {
      i = skipComment(text, i);
      if (i < 0) return null;
      continue;
    }
    if (c === '"') {
      const quoted = readQuoted(text, i);
      if (!quoted) return null;
      word += quoted.value;
      i = quoted.end;
      continue;
    }
    if (SPACE.has(c) || c === '=' || c === ';') {
      flush();
      if (c === '=') tokens.push({ kind: 'eq' });
      if (c === ';') tokens.push({ kind: 'semi' });
    } else word += c;
    if (tokens.length > LIST_AUTH_LIMITS.maxTokens) return null;
    i++;
  }
  flush();
  return tokens.length > LIST_AUTH_LIMITS.maxTokens ? null : tokens;
}

function segments(tokens: readonly Token[]): Token[][] {
  const out: Token[][] = [[]];
  for (const token of tokens) {
    if (token.kind === 'semi') out.push([]);
    else out[out.length - 1].push(token);
  }
  return out;
}

/** `[word, '=', word]` triples, or null when the segment is not exactly a run of them. */
function pairs(segment: readonly Token[]): [string, string][] | null {
  if (segment.length === 0 || segment.length % 3 !== 0) return null;
  const out: [string, string][] = [];
  for (let i = 0; i < segment.length; i += 3) {
    const [key, eq, value] = segment.slice(i, i + 3);
    if (key.kind !== 'word' || eq.kind !== 'eq' || value.kind !== 'word') return null;
    out.push([key.text, value.text]);
  }
  return out;
}

/** `method=result` then `ptype.property=value` pairs; null when malformed or a property repeats (ambiguous). */
export function parseResult(segment: readonly Token[]): AuthResult | null {
  const list = pairs(segment);
  if (!list) return null;
  const [[method, result], ...rest] = list;
  const props = new Map<string, string>();
  for (const [key, value] of rest) {
    const name = key.toLowerCase();
    if (name === 'reason') continue;
    if (!name.includes('.') || props.has(name)) return null;
    props.set(name, value);
  }
  return { method: method.toLowerCase().split('/')[0], result: result.toLowerCase(), props };
}

const VERSION = /^[0-9]{1,3}$/;

/** The authserv-id segment: Google's id and an optional numeric version, nothing else. */
function isGoogle(head: readonly Token[]): boolean {
  const [id, version, ...rest] = head;
  if (id?.kind !== 'word' || id.text.toLowerCase() !== GOOGLE_AUTHSERV_ID || rest.length)
    return false;
  return version === undefined || (version.kind === 'word' && VERSION.test(version.text));
}

/**
 * Google's results from one `Authentication-Results` value; null when it is not Google's, too long or malformed. One
 * segment that does not parse fails the whole header: Google's own header echoes sender-chosen text (the envelope sender
 * in an SPF comment), so a stray quote or `;` can make the parser see a result that is not there. An empty segment (a
 * trailing `;`) carries nothing and is skipped.
 */
export function googleResults(value: string): AuthResult[] | null {
  if (value.length > LIST_AUTH_LIMITS.maxResultsChars) return null;
  const tokens = tokenize(value);
  if (!tokens) return null;
  const [head, ...rest] = segments(tokens);
  const parts = rest.filter(segment => segment.length > 0);
  if (!isGoogle(head) || parts.length > LIST_AUTH_LIMITS.maxResults) return null;
  const results = parts.map(segment => parseResult(segment));
  if (!results.every(result => result !== null)) return null;
  return dkimRunFirst(results) ? results : null;
}

/**
 * Google writes its `dkim` results as one unbroken run straight after the authserv-id, then `arc`, `spf` and `dmarc`.
 * A `dkim` result after any other result is not where Google writes it: sender text echoed into an ARC or SPF comment
 * can close the comment and add one (`arc=pass (... dkdomain=x); dkim=pass ...`), so the header is not believed.
 */
function dkimRunFirst(results: readonly AuthResult[]): boolean {
  const firstOther = results.findIndex(r => r.method !== 'dkim');
  return firstOther === -1 || results.slice(firstOther).every(r => r.method !== 'dkim');
}

// ---- DKIM-Signature (RFC 6376 section 3.2 tag list) ----

const TAG_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Tag name -> raw value. Tag names are case-sensitive (`H=` is not `h=`). Null when malformed or a tag repeats. */
export function tagList(value: string): Map<string, string> | null {
  if (value.length > LIST_AUTH_LIMITS.maxSignatureChars) return null;
  const tags = new Map<string, string>();
  for (const spec of value.split(';')) {
    const eq = spec.indexOf('=');
    if (eq === -1 && spec.trim() === '') continue;
    const name = eq === -1 ? '' : spec.slice(0, eq).trim();
    if (!TAG_NAME.test(name) || tags.has(name)) return null;
    tags.set(name, spec.slice(eq + 1));
  }
  return tags;
}

const noSpace = (text: string) => text.replace(/\s+/g, '');

/** The only characters a DKIM `b=` or Google's `header.b` prefix of it holds; anything else is not compared. */
const BASE64 = /^[A-Za-z0-9+/=]+$/;

export function parseSignature(value: string): DkimSignature | null {
  const tags = tagList(value);
  if (!tags) return null;
  const b = noSpace(tags.get('b') ?? '');
  // A signature whose b= is not base64 cannot be told apart from Google's reading of it (`()AAAA` reads back as `AAAA`).
  if (b !== '' && !BASE64.test(b)) return null;
  return {
    d: noSpace(tags.get('d') ?? '').toLowerCase(),
    s: noSpace(tags.get('s') ?? '').toLowerCase(),
    b,
    h: noSpace(tags.get('h') ?? '')
      .toLowerCase()
      .split(':')
      .filter(Boolean),
  };
}

// ---- the verdict ----

const named = (header: GmailHeader, name: string) => header.name.toLowerCase() === name;

function count(headers: readonly GmailHeader[], name: string): number {
  return headers.filter(h => named(h, name)).length;
}

/** Every `DKIM-Signature`, or null when there are too many or one cannot be read (it could be the one that matches). */
function signatures(headers: readonly GmailHeader[]): DkimSignature[] | null {
  const raw = headers.filter(h => named(h, 'dkim-signature'));
  if (raw.length > LIST_AUTH_LIMITS.maxSignatures) return null;
  const parsed = raw.map(h => parseSignature(h.value));
  return parsed.every(s => s !== null) ? parsed : null;
}

/**
 * The domain of the one From address, lowercased; undefined for several From headers or addresses. `from` is the From
 * header already parsed by `facts.ts` (`parseAddresses`), so alignment judges the same address the owner is shown.
 */
export function fromDomain(
  headers: readonly GmailHeader[],
  from: readonly Address[],
): string | undefined {
  if (count(headers, 'from') !== 1 || from.length !== 1) return undefined;
  const address = from[0].address;
  const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
  return address.includes('@') && domain ? domain : undefined;
}

/**
 * DMARC alignment (RFC 7489 section 3.1.1) without a public-suffix list: strict (equal), or relaxed approximated as
 * "From is a subdomain of d" with d holding at least two labels. That rejects a bare `d=com` but accepts a public
 * suffix such as `d=co.uk` for any `*.co.uk` From; a passing signature from `co.uk` itself is not something an attacker
 * can produce, so the gap is theoretical. It never accepts d as a subdomain of From (relaxed would, in DMARC's sense).
 */
export function aligned(from: string, d: string): boolean {
  const labels = d.split('.');
  if (labels.length < 2 || labels.some(label => label === '')) return false;
  return from === d || from.endsWith(`.${d}`);
}

/** `header.d`, else the domain of `header.i` (`[local]@domain`). */
function signingDomain(result: AuthResult): string | undefined {
  const d = result.props.get('header.d');
  if (d !== undefined) return d.toLowerCase();
  const i = result.props.get('header.i');
  const at = i?.lastIndexOf('@') ?? -1;
  return i !== undefined && at !== -1 ? i.slice(at + 1).toLowerCase() : undefined;
}

/** The one signature the result names; undefined when none or several match (a decoy can copy d=, s= and the prefix). */
function signatureFor(
  result: AuthResult,
  domain: string,
  all: readonly DkimSignature[],
): DkimSignature | undefined {
  const prefix = result.props.get('header.b');
  if (prefix === undefined || prefix.length < LIST_AUTH_LIMITS.minBodyPrefix) return undefined;
  const selector = result.props.get('header.s')?.toLowerCase();
  const matches = all.filter(
    s => s.d === domain && (selector === undefined || s.s === selector) && s.b.startsWith(prefix),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Could `other` be Google's verdict on the signature `passing` names? Decided by the `header.b` prefixes alone: one is
 * a prefix of the other, or `other` has none. Not by domain or selector: `d=bank.example; i=@sub.bank.example` makes
 * Google report `header.i=@sub.bank.example` for the same signature an injected pass names as `@bank.example`.
 */
function mayNameSameSignature(other: AuthResult, passing: AuthResult): boolean {
  const prefix = other.props.get('header.b');
  const passingPrefix = passing.props.get('header.b') ?? '';
  // A prefix that is not base64 cannot be compared, so it is taken to name the same signature (fail closed).
  return (
    prefix === undefined ||
    !BASE64.test(prefix) ||
    prefix.startsWith(passingPrefix) ||
    passingPrefix.startsWith(prefix)
  );
}

/**
 * Google reports its own failure for a forged or replayed signature, and a sender can make one `dkim=pass` segment
 * appear through text Google echoes. A pass that another non-pass `dkim` result may also name is therefore not believed.
 */
function contradicted(passing: AuthResult, results: readonly AuthResult[]): boolean {
  return results.some(
    other =>
      other !== passing &&
      other.method === 'dkim' &&
      other.result !== 'pass' &&
      mayNameSameSignature(other, passing),
  );
}

function vouches(result: AuthResult, all: readonly DkimSignature[], from: string): boolean {
  if (result.method !== 'dkim' || result.result !== 'pass') return false;
  const domain = signingDomain(result);
  if (domain === undefined || !aligned(from, domain)) return false;
  const signature = signatureFor(result, domain, all);
  return signature !== undefined && COVERED.every(name => signature.h.includes(name));
}

/**
 * The verdict for one message's headers (in message order, top first) and its parsed From. A DKIM `h=` entry covers one
 * instance of a header, so List-Unsubscribe and List-Unsubscribe-Post must each appear exactly once.
 */
export function listAuthenticated(
  headers: readonly GmailHeader[],
  from: readonly Address[],
): boolean | undefined {
  const top = headers.find(h => named(h, 'authentication-results'));
  if (!top) return undefined;
  const results = googleResults(top.value);
  if (!results) return false;
  if (count(headers, 'list-unsubscribe') !== 1 || count(headers, 'list-unsubscribe-post') !== 1)
    return false;
  const domain = fromDomain(headers, from);
  const all = signatures(headers);
  if (domain === undefined || all === null) return false;
  return results.some(result => vouches(result, all, domain) && !contradicted(result, results));
}
