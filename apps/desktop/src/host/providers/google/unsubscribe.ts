import type http from 'node:http';
import https from 'node:https';
import type { ListHeaders, UnsubscribePort } from '@aplos/engine/ports';
import { ipv4Number } from '../../proxy/classify';
import { requestOptions } from '../../proxy/fetch';
import { pinTarget, systemResolver, type PinnedTarget, type Resolver } from '../../proxy/resolve';

/**
 * List-Unsubscribe (plan 20 PV4, DECISIONS Decision 5): a pure planner over the List-Unsubscribe and
 * List-Unsubscribe-Post headers, and an executor. RFC 8058 one-click is a single POST under the image proxy's address
 * rules (ARCH 10): https on 443 only, the name resolved once with every answer checked, the socket pinned to that
 * address with the name as Host and SNI, no redirect followed, fixed headers, capped body, 10 s. Else a `mailto:` is
 * validated and handed to the composer as a prepared draft the owner reads and sends (nothing is ever sent from here:
 * the recipient, subject and body all come from the sender). Else an https page to open. The headers come from the
 * sender, so every value here is hostile until checked.
 *
 * RFC 8058 section 4: a POST only for a message whose DKIM signature covers List-Unsubscribe and List-Unsubscribe-Post
 * and aligns with From. `facts.ts` derives that as `ListHeaders.authenticated` (`list-auth.ts`) and the engine strips
 * List-Unsubscribe-Post from any other message (`methods/unsubscribe.ts`); the plan also requires the strict boolean
 * `true`, as defence in depth.
 *
 * Known limit: the composer sends a mailto from the receiving account's primary address, not from the alias the list
 * wrote to, so a list that matches the subscriber by the alias address may not recognise the request.
 */

export const UNSUBSCRIBE_LIMITS = Object.freeze({
  /** A header longer than this is ignored whole. */
  maxHeaderChars: 8_192,
  /** URIs read from one header; the rest are ignored. */
  maxUris: 8,
  /** Every URL, raw and normalised; the contract's `url` is at most 2,000 characters. */
  maxUrlChars: 2_000,
  maxAddressChars: 254,
  maxSubjectChars: 200,
  maxBodyChars: 1_000,
  timeoutMs: 10_000,
  maxResponseBytes: 64 * 1024,
});

/** RFC 8058's body, and the only List-Unsubscribe-Post value that turns one-click on. */
export const ONE_CLICK_BODY = 'List-Unsubscribe=One-Click';

/** Every header sent besides `Host`. No cookie, `Referer`, `Origin`, `Authorization` or anything from the mail. */
export const ONE_CLICK_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'User-Agent': 'AplosMail-Unsubscribe/1',
  'Content-Type': 'application/x-www-form-urlencoded',
  'Content-Length': String(ONE_CLICK_BODY.length),
  'Accept-Encoding': 'identity',
  Connection: 'close',
});

/** Controls, whitespace, backslash and the invisible or direction-changing (format) characters that disguise a link. */
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\s\\]/u;
const LOCAL_PART = /^[A-Za-z0-9!$'*+=^_`{|}~.-]{1,64}$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export type UrlRefusal = 'length' | 'chars' | 'scheme' | 'userinfo' | 'port' | 'fragment' | 'host';

export type CheckedUrl = { ok: true; url: URL } | { ok: false; reason: UrlRefusal };

export interface UnsubscribeMail {
  to: string;
  subject: string;
  body: string;
}

export type UnsubscribePlan =
  | { kind: 'oneClick'; url: URL }
  | { kind: 'mailto'; mail: UnsubscribeMail; url: string }
  | { kind: 'open'; url: string }
  | { kind: 'none' };

export type UnsubscribeOutcome = 'done' | 'unsure' | 'failed' | 'open' | 'compose' | 'none';

/** What the UI shows: a plain sentence, and for `open`, `compose` and some failures a link it may offer (never opened here). */
export interface UnsubscribeResult {
  kind: UnsubscribeOutcome;
  message: string;
  url?: string;
}

// ---------------------------------------------------------------- header parsing

/** Removes header folding (CRLF before a space or tab). Any other CR or LF stays and fails the character check. */
function unfold(header: string): string {
  return header.replace(/\r?\n(?=[ \t])/g, '');
}

/** The `<uri>` entries of a List-Unsubscribe header in order (RFC 2369), at most `maxUris`; text outside brackets is ignored. */
export function listUris(header: string | undefined): string[] {
  if (!header || header.length > UNSUBSCRIBE_LIMITS.maxHeaderChars) return [];
  const text = unfold(header);
  const uris: string[] = [];
  let at = 0;
  while (uris.length < UNSUBSCRIBE_LIMITS.maxUris) {
    const open = text.indexOf('<', at);
    const close = open === -1 ? -1 : text.indexOf('>', open + 1);
    if (close === -1) break;
    const inner = text.slice(open + 1, close);
    if (inner && !inner.includes('<')) uris.push(inner);
    at = close + 1;
  }
  return uris;
}

/** RFC 8058: one-click only when List-Unsubscribe-Post is exactly the one key and value. */
export function oneClickOffered(post: string | undefined): boolean {
  return post !== undefined && post.trim() === ONE_CLICK_BODY;
}

// ---------------------------------------------------------------- https URLs

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** The raw authority, before the WHATWG parser normalises it (`https://@host` has an empty, but present, userinfo). */
function rawAuthority(raw: string): string {
  return raw.slice('https://'.length).split(/[/?#]/, 1)[0];
}

/** Names that mean this machine or a private network. The page link is opened in the browser, not fetched here. */
const LOCAL_NAME = /(^|\.)(localhost|local|internal|localdomain|lan|home\.arpa)$/;

/** A public-looking DNS name: no IP literal in any form, no single label, no local name, valid labels. */
function nameHost(host: string): boolean {
  if (host.startsWith('[') || ipv4Number(host) !== null || /^[0-9.]+$/.test(host)) return false;
  if (LOCAL_NAME.test(host.replace(/\.$/, '').toLowerCase())) return false;
  const labels = host.split('.');
  if (labels.length < 2 || /^[0-9]+$/.test(labels[labels.length - 1])) return false;
  return labels.every(label => DOMAIN_LABEL.test(label));
}

/**
 * One https URL from the header, or why it is refused. The result is the WHATWG-normalised URL: an internationalised
 * host is in its punycode (`xn--`) form, so a look-alike name is shown as what it really is.
 */
export function checkHttpsUrl(raw: string): CheckedUrl {
  if (raw.length > UNSUBSCRIBE_LIMITS.maxUrlChars) return { ok: false, reason: 'length' };
  if (UNSAFE_CHARS.test(raw)) return { ok: false, reason: 'chars' };
  if (!/^https:\/\//i.test(raw)) return { ok: false, reason: 'scheme' };
  if (raw.includes('#')) return { ok: false, reason: 'fragment' };
  const url = parse(raw);
  if (!url || url.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (url.username || url.password || rawAuthority(raw).includes('@'))
    return { ok: false, reason: 'userinfo' };
  if (url.port !== '') return { ok: false, reason: 'port' };
  if (!nameHost(url.hostname)) return { ok: false, reason: 'host' };
  if (url.href.length > UNSUBSCRIBE_LIMITS.maxUrlChars) return { ok: false, reason: 'length' };
  return { ok: true, url };
}

// ---------------------------------------------------------------- mailto

function decode(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

/** One plain ASCII address, `local@domain`, with nothing that could split a header or a mailto URL. */
export function plainAddress(address: string): boolean {
  if (address.length > UNSUBSCRIBE_LIMITS.maxAddressChars) return false;
  const at = address.indexOf('@');
  if (at < 1 || at !== address.lastIndexOf('@')) return false;
  const local = address.slice(0, at);
  const labels = address.slice(at + 1).split('.');
  if (
    !LOCAL_PART.test(local) ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..')
  )
    return false;
  if (labels.length < 2 || !/^[a-z]{2,63}$/i.test(labels[labels.length - 1])) return false;
  return labels.every(label => DOMAIN_LABEL.test(label));
}

/** `subject` and `body` from a mailto query; null for any other field (cc, bcc, to, any header), a repeat or bad escape. */
function mailtoFields(query: string): Map<string, string> | null {
  const fields = new Map<string, string>();
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = decode(eq === -1 ? part : part.slice(0, eq))?.toLowerCase();
    const value = eq === -1 ? '' : decode(part.slice(eq + 1));
    if ((key !== 'subject' && key !== 'body') || value === null || fields.has(key)) return null;
    fields.set(key, value);
  }
  return fields;
}

/** Controls, line and paragraph separators, and format characters (bidi overrides and isolates, zero-width, soft hyphen). */
const SUBJECT_UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
/** A body may break lines (CR, LF); every other control, separator and format character is refused. */
const BODY_UNSAFE = /(?![\r\n])\p{Cc}|[\p{Cf}\u2028\u2029]/u;

function mailFrom(to: string, fields: Map<string, string>): UnsubscribeMail | null {
  const subject = fields.get('subject') || 'unsubscribe';
  const body = fields.get('body') ?? '';
  if (subject.length > UNSUBSCRIBE_LIMITS.maxSubjectChars || SUBJECT_UNSAFE.test(subject))
    return null;
  if (body.length > UNSUBSCRIBE_LIMITS.maxBodyChars || BODY_UNSAFE.test(body)) return null;
  return { to, subject, body };
}

/**
 * A `mailto:` URI (RFC 6068) as exactly one recipient, a subject and a body, or null. Strict: one plain address, only
 * `subject` and `body`, no CR or LF in the subject even when percent-encoded, length caps, no fragment.
 */
export function checkMailto(raw: string): UnsubscribeMail | null {
  if (raw.length > UNSUBSCRIBE_LIMITS.maxUrlChars || UNSAFE_CHARS.test(raw)) return null;
  if (!/^mailto:/i.test(raw) || raw.includes('#')) return null;
  const rest = raw.slice('mailto:'.length);
  const q = rest.indexOf('?');
  const to = decode(q === -1 ? rest : rest.slice(0, q));
  if (to === null || !plainAddress(to)) return null;
  const fields = mailtoFields(q === -1 ? '' : rest.slice(q + 1));
  return fields && mailFrom(to, fields);
}

/** The mailto rebuilt from the checked fields only, for the composer. */
export function mailtoUrl(mail: UnsubscribeMail): string {
  const body = mail.body ? `&body=${encodeURIComponent(mail.body)}` : '';
  return `mailto:${mail.to}?subject=${encodeURIComponent(mail.subject)}${body}`;
}

// ---------------------------------------------------------------- the plan

function firstHttps(uris: readonly string[]): URL | undefined {
  for (const uri of uris) {
    const checked = checkHttpsUrl(uri);
    if (checked.ok) return checked.url;
  }
  return undefined;
}

function firstMailto(uris: readonly string[]): UnsubscribeMail | undefined {
  for (const uri of uris) {
    const mail = checkMailto(uri);
    if (mail) return mail;
  }
  return undefined;
}

/**
 * Decision 5's order: one-click (both headers on an authenticated message), else mailto, else an https page to open,
 * else nothing. Pure.
 */
export function planUnsubscribe(
  headers: Pick<ListHeaders, 'listUnsubscribe' | 'listUnsubscribePost' | 'authenticated'>,
): UnsubscribePlan {
  const uris = listUris(headers.listUnsubscribe);
  const page = firstHttps(uris);
  const oneClick = headers.authenticated === true && oneClickOffered(headers.listUnsubscribePost);
  if (page && oneClick) return { kind: 'oneClick', url: page };
  const mail = firstMailto(uris);
  if (mail) return { kind: 'mailto', mail, url: mailtoUrl(mail) };
  if (page) return { kind: 'open', url: page.href };
  return { kind: 'none' };
}

// ---------------------------------------------------------------- one-click transport

export interface OneClickResponse {
  status: number;
  body: AsyncIterable<Uint8Array>;
  /** Drops the connection; called once the executor is done with the response. */
  close(): void;
}

/** Sends the one POST to a pinned target. Injected by tests; production uses `oneClickTransport()`. */
export type OneClickTransport = (
  target: PinnedTarget,
  signal: AbortSignal,
) => Promise<OneClickResponse>;

interface RequestModule {
  request(
    options: https.RequestOptions,
    callback: (response: http.IncomingMessage) => void,
  ): http.ClientRequest;
}

function responseOf(response: http.IncomingMessage): OneClickResponse {
  // Errors surface through iteration; this keeps one that arrives while nobody iterates from crashing the host.
  response.on('error', () => undefined);
  return { status: response.statusCode ?? 0, body: response, close: () => response.destroy() };
}

/** The request on the wire: the proxy's pinned options (address, SNI, no agent), as a POST with the fixed headers. */
export function oneClickOptions(target: PinnedTarget, signal: AbortSignal): https.RequestOptions {
  return {
    ...requestOptions(target, signal),
    method: 'POST',
    headers: { Host: target.hostHeader, ...ONE_CLICK_HEADERS },
  };
}

/** Node's own client, no agent pooling or cookie jar; never follows a redirect. `module` is `https` outside tests. */
export function oneClickTransport(module: RequestModule = https): OneClickTransport {
  return (target, signal) =>
    new Promise((resolve, reject) => {
      const request = module.request(oneClickOptions(target, signal), response =>
        resolve(responseOf(response)),
      );
      request.on('error', reject);
      request.end(ONE_CLICK_BODY);
    });
}

/** Reads at most `maxResponseBytes` and discards them; stops early on abort or any error. */
async function drain(response: OneClickResponse, signal: AbortSignal): Promise<void> {
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.byteLength;
      if (signal.aborted || total >= UNSUBSCRIBE_LIMITS.maxResponseBytes) return;
    }
  } catch {
    // The status is already known; a broken body changes nothing.
  }
}

function whenAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

// ---------------------------------------------------------------- results

const SENTENCES = {
  none: 'This sender does not offer a way to unsubscribe. You can block them instead.',
  open: 'Open the sender’s unsubscribe page to finish.',
  done: 'Unsubscribed. The list confirmed the request.',
  redirect:
    'The list answered with a redirect instead of a confirmation, so Aplos cannot tell whether it worked.',
  refusedStatus: 'The list’s server turned down the unsubscribe request.',
  privateAddress:
    'This list’s unsubscribe link points to a private or local network, so Aplos did not contact it.',
  unsafe: 'This list’s unsubscribe link is not a safe web address, so Aplos did not contact it.',
  unreachable: 'Aplos could not reach the list’s server. Try again later.',
  noAnswer: 'The list’s server did not answer in time, so Aplos cannot tell whether it worked.',
  lost: 'The connection to the list’s server broke, so Aplos cannot tell whether it worked.',
  compose: (to: string) => `Send the prepared email to ${to} to unsubscribe.`,
} as const;

function statusResult(status: number, page: string): UnsubscribeResult {
  if (status >= 200 && status <= 299) return { kind: 'done', message: SENTENCES.done };
  if (status >= 300 && status <= 399)
    return { kind: 'unsure', message: SENTENCES.redirect, url: page };
  return { kind: 'failed', message: SENTENCES.refusedStatus, url: page };
}

// ---------------------------------------------------------------- the executor

export interface UnsubscribeDeps {
  resolve?: Resolver;
  transport?: OneClickTransport;
  /** Tests only: a shorter deadline. Never above `UNSUBSCRIBE_LIMITS.timeoutMs`. */
  timeoutMs?: number;
}

export type UnsubscribeRequest = Parameters<UnsubscribePort['run']>[0];

/** The engine's `UnsubscribePort`; `request.opId` (when sent) is accepted and never logged or put on the wire. */
export type UnsubscribeExecutor = UnsubscribePort;

function deadlineOf(timeoutMs: number | undefined): number {
  const ceiling = UNSUBSCRIBE_LIMITS.timeoutMs;
  if (timeoutMs === undefined) return ceiling;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > ceiling)
    throw new RangeError(`unsubscribe timeout must be an integer from 0 to ${ceiling}`);
  return timeoutMs;
}

interface OneClickRun {
  url: URL;
  resolve: Resolver;
  transport: OneClickTransport;
  signal: AbortSignal;
  deadline: AbortSignal;
}

/** Pins, then sends the POST once. `sent` tells a failure before the request (failed) from one after it (unsure). */
async function postOnce(run: OneClickRun, sent: { value: boolean }): Promise<UnsubscribeResult> {
  const either = AbortSignal.any([run.signal, run.deadline]);
  const pin = await Promise.race([pinTarget(run.url, [443], run.resolve), whenAborted(either)]);
  if (!pin.ok)
    return {
      kind: 'failed',
      message: pin.reason === 'address' ? SENTENCES.privateAddress : SENTENCES.unsafe,
    };
  // Defence in depth: `pinTarget` also pins plain http, and only an https target may carry the POST. The URL is already
  // https here (checkHttpsUrl), so this cannot fire today.
  if (!pin.target.secure) return { kind: 'failed', message: SENTENCES.unsafe };
  either.throwIfAborted();
  sent.value = true;
  const response = await Promise.race([run.transport(pin.target, either), whenAborted(either)]);
  try {
    await Promise.race([drain(response, either), whenAborted(either).catch(() => undefined)]);
  } finally {
    response.close();
  }
  return statusResult(response.status, run.url.href);
}

async function oneClick(
  run: Omit<OneClickRun, 'deadline'>,
  timeoutMs: number,
): Promise<UnsubscribeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const sent = { value: false };
  try {
    return await postOnce({ ...run, deadline: controller.signal }, sent);
  } catch {
    // Before the request went out nothing was sent, so a cancel is a plain rejection. After it, the POST may have
    // landed: answer unsure (never reject), so the engine keeps a receipt and a replay cannot send a second one.
    if (run.signal.aborted && !sent.value) throw run.signal.reason;
    if (!sent.value) return { kind: 'failed', message: SENTENCES.unreachable };
    const message = controller.signal.aborted ? SENTENCES.noAnswer : SENTENCES.lost;
    return { kind: 'unsure', message, url: run.url.href };
  } finally {
    clearTimeout(timer);
  }
}

/** A mailto never sends: the owner reads the prepared email (checked fields only) in the composer and sends it. */
function mailto(plan: Extract<UnsubscribePlan, { kind: 'mailto' }>): UnsubscribeResult {
  return { kind: 'compose', message: SENTENCES.compose(plan.mail.to), url: plan.url };
}

function describePlan(plan: UnsubscribePlan): ReturnType<UnsubscribeExecutor['describe']> {
  if (plan.kind === 'oneClick') return { method: 'oneClick' };
  if (plan.kind === 'mailto') return { method: 'mailto', url: plan.url };
  if (plan.kind === 'open') return { method: 'link', url: plan.url };
  return { method: 'none' };
}

/** The host side of `Unsubscribe/get` and `Unsubscribe/run`. Nothing is opened in a browser from here. */
export function createUnsubscribeExecutor(deps: UnsubscribeDeps = {}): UnsubscribeExecutor {
  const resolve = deps.resolve ?? systemResolver;
  const transport = deps.transport ?? oneClickTransport();
  const timeoutMs = deadlineOf(deps.timeoutMs);
  return {
    describe: headers => describePlan(planUnsubscribe(headers)),
    async run(request) {
      request.signal.throwIfAborted();
      const plan = planUnsubscribe(request.headers);
      if (plan.kind === 'none') return { kind: 'none', message: SENTENCES.none };
      if (plan.kind === 'open') return { kind: 'open', message: SENTENCES.open, url: plan.url };
      if (plan.kind === 'mailto') return mailto(plan);
      return oneClick({ url: plan.url, resolve, transport, signal: request.signal }, timeoutMs);
    },
  };
}
