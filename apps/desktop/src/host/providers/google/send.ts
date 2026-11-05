import { randomBytes } from 'node:crypto';
import type { ClassifiedError } from '@aplos/contract';
import {
  NotSentError,
  PausedError,
  ProviderError,
  sendsRemoteDraft,
  type AdapterContext,
  type FindSentResult,
  type RequestIo,
  type SendReceipt,
  type SubmissionPayload,
} from '@aplos/engine/ports';
import { googleError } from './classify';
import { isDraftToken } from './draft-token';
import { headerEnd, headerFields, singleFields } from './mime-headers';
import { GmailClient, type GmailDeps } from './client';
import { gmailCost } from './costs';

/**
 * The Gmail send transport (plan 20 PV4, ARCH 7.1) behind `ProviderAdapter.send` and `findSent`.
 *
 * What leaves is always the submission's pinned bytes (`SubmissionPayload.mime`), checked here and never rewritten. The
 * one header this file adds is `Bcc`, for envelope recipients the MIME does not name: Gmail's API has no envelope and
 * reads the recipients from the headers (it removes `Bcc` from the copies it delivers), and the engine never writes Bcc
 * into a sent message. By default every send goes through `messages.send`; the `drafts.send` route is off until the
 * live gate proves it (`SendOptions.useDraftsSend`, TODO(live)). When on, it is used only when `sendsRemoteDraft` holds
 * for the copy just read, and it carries the pinned bytes as its media, so a phone edit landing between the read and
 * the send cannot leave instead. Both endpoints upload `message/rfc822` (multipart, resumable above 5 MB: D20) as ONE
 * governed `send` request, never re-sent here. A failure is `NotSentError` (or the governor's `PausedError`) only with
 * proof that nothing left: the sending request was never written, the connection was refused, or Gmail answered one of
 * the known refusals (`REFUSALS`). Anything else after the request was written, a 2xx that is not Gmail's Message
 * included, is thrown as uncertain, and the outbox settles it through `findSent`, which searches Sent only (then reads
 * the newest SENT messages by label, for a send the search index has not caught up with). No upload request
 * follows a redirect (`redirect: 'manual'`; if `deps.fetch` is ever wired to Electron's `net.fetch`, re-verify it honours
 * that), and a refusal is logged without Gmail's own text.
 */

const UPLOAD_API = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';
/** D20: above this the upload is resumable (a session, then one PUT of the bytes). */
export const RESUMABLE_ABOVE_BYTES = 5 * 1024 * 1024;
/** Gmail's media limit for `messages.send` and `drafts.send` (35 MB). Larger is refused before anything leaves. */
export const MAX_SEND_BYTES = 35 * 1024 * 1024;
/** A send that has not answered by then is abandoned as uncertain, so it cannot hold the account's one slot forever. */
export const sendTimeoutMs = (bytes: number): number => 60_000 + Math.ceil(bytes / 50_000) * 1_000;
/** `after:` slack before `since`: Gmail reads the date in its own zone, and a sent draft keeps the draft's date. */
const AFTER_SLACK_MS = 3 * 86_400_000;
/** Hits verified per search: a Message-ID is unique, so more than one is already unusual. */
const SENT_CANDIDATES = 10;

const SEND_METHOD = 'gmail.messages.send';

function record(
  method: string,
  cls: ClassifiedError['class'],
  reason: string,
  uncertain?: boolean,
): ClassifiedError {
  return {
    class: cls,
    provider: 'gmail',
    method,
    reason,
    ...(uncertain !== undefined ? { uncertain } : {}),
  };
}

/** A refusal of the pinned MIME itself: nothing was sent, and sending it again would fail the same way. */
function refuse(reason: string): NotSentError {
  return new NotSentError(record(SEND_METHOD, 'permanent', reason, false));
}

// ---------------------------------------------------------------- the pinned bytes

/**
 * The header names the outbox's writer puts in a sent message's top header block (`buildMime`, `withDate`). Anything
 * else is refused rather than sent: a CR or LF that slipped into a value would show up exactly as a new header line
 * (`Bcc:`, `Reply-To:`), and nothing here can tell that from a real one. A header the engine starts writing must be
 * added here, on purpose.
 */
const PINNED_HEADERS: ReadonlySet<string> = new Set([
  'date',
  'from',
  'to',
  'cc',
  'subject',
  'message-id',
  'in-reply-to',
  'references',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
]);
/** A plain `local@domain`, as the outbox writes it (`checkAddress`): no space, quote, comma, angle bracket or CR/LF. */
const ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

/** Splits an address list at commas outside quotes and angle brackets; groups and comments are not the writer's. */
function addressElements(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted && c === '\\') {
      current += c + (value[i + 1] ?? '');
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '<') angle = true;
    else if (!quoted && c === '>') angle = false;
    else if (!quoted && /[():;]/.test(c)) throw refuse('unreadableAddress');
    if (!quoted && !angle && c === ',') {
      out.push(current);
      current = '';
    } else current += c;
  }
  if (quoted || angle) throw refuse('unreadableAddress');
  out.push(current);
  return out.map(e => e.trim()).filter(Boolean);
}

/** The addr-spec of `Name <a@b>` or `a@b`, lower-cased for comparison. */
function addressOf(element: string): string {
  const angled = /<([^<>]*)>$/.exec(element);
  const address = angled ? angled[1] : element;
  if (!ADDRESS.test(address)) throw refuse('unreadableAddress');
  return address.toLowerCase();
}

const addressesIn = (value: string | undefined): string[] =>
  value === undefined ? [] : addressElements(value).map(addressOf);

/** The checked envelope: From is the account, and every recipient is a plain address. */
function envelopeOf(payload: SubmissionPayload, account: string): string[] {
  if (payload.envelope.from.trim().toLowerCase() !== account.trim().toLowerCase())
    throw refuse('wrongSender');
  if (payload.envelope.rcpt.length === 0) throw refuse('noRecipients');
  return payload.envelope.rcpt.map(r => {
    if (!ADDRESS.test(r)) throw refuse('unreadableAddress');
    return r;
  });
}

/** The header checks that need the payload: sender, Message-ID and recipients the envelope does not cover. */
function checkHeaders(byName: Map<string, string>, payload: SubmissionPayload, account: string) {
  const from = addressesIn(byName.get('from'));
  if (from.length !== 1 || from[0] !== account.trim().toLowerCase()) throw refuse('wrongSender');
  if (byName.get('message-id') !== payload.internetId) throw refuse('messageIdMismatch');
  const envelope = new Set(payload.envelope.rcpt.map(r => r.toLowerCase()));
  const named = [...addressesIn(byName.get('to')), ...addressesIn(byName.get('cc'))];
  if (named.some(a => !envelope.has(a))) throw refuse('recipientNotInEnvelope');
  return new Set(named);
}

/** `Bcc: a, b` folded at the commas into lines of at most 76 characters (each address is far below 998). */
export function bccHeader(addresses: string[]): string {
  const lines: string[] = [];
  let line = 'Bcc:';
  for (const [i, address] of addresses.entries()) {
    const piece = `${address}${i < addresses.length - 1 ? ',' : ''}`;
    if (line.length > 4 && line.length + 1 + piece.length > 76) {
      lines.push(line);
      line = '';
    }
    line += ` ${piece}`;
  }
  lines.push(line);
  return lines.join('\r\n');
}

function withBcc(mime: Uint8Array, end: number, bcc: string[]): Uint8Array {
  if (bcc.length === 0) return mime;
  const header = Buffer.from(`\r\n${bccHeader(bcc)}`, 'latin1');
  return Buffer.concat([mime.subarray(0, end), header, mime.subarray(end)]);
}

/**
 * The bytes to upload: the pinned MIME after its checks, byte for byte, plus a `Bcc:` line for envelope recipients
 * the headers do not name. Throws `NotSentError` (class `permanent`) for anything it would have to fix up to send.
 */
export function pinnedMime(payload: SubmissionPayload, account: string): Uint8Array {
  const mime = payload.mime;
  if (mime.length > MAX_SEND_BYTES) throw refuse('messageTooLarge');
  const end = headerEnd(mime);
  if (end < 0) throw refuse('noHeaderBlock');
  const head = Buffer.from(mime.subarray(0, end)).toString('latin1');
  const byName = singleFields(headerFields(head, refuse), PINNED_HEADERS, refuse);
  const rcpt = envelopeOf(payload, account);
  const named = checkHeaders(byName, payload, account);
  const bcc = rcpt.filter(r => !named.has(r.toLowerCase()));
  const out = withBcc(mime, end, bcc);
  if (out.length > MAX_SEND_BYTES) throw refuse('messageTooLarge');
  return out;
}

/** The header the adapter adds to what it uploads, so a Sent copy can be found by it (plans/providers/findsent-token.md). */
export const SEND_TOKEN_HEADER = 'X-Aplos-Send';

/**
 * Gmail replaces the Message-ID of a message it sends (live finding 2026-11-05) but keeps a custom header. The upload
 * carries `X-Aplos-Send: <internetId>` as its first header: the submission's own Message-ID value, random and stable per
 * submission, so a retry of one submission has the same token and two submissions never share one. The engine's pinned
 * bytes are not changed (`pinnedMime` still refuses this header inside them); this is added to what goes on the wire.
 * An `internetId` that is not a well-formed token is not written (it could never be read back as one).
 */
export function withSendToken(raw: Uint8Array, internetId: string): Uint8Array {
  if (!isDraftToken(internetId)) return raw;
  return Buffer.concat([Buffer.from(`${SEND_TOKEN_HEADER}: ${internetId}\r\n`, 'latin1'), raw]);
}

// ---------------------------------------------------------------- errors by proof

/** Nothing could have left: keep the governor's pause, else a `NotSentError` with the failure's own class. */
function notSent(error: unknown, method: string): PausedError | NotSentError {
  if (error instanceof PausedError || error instanceof NotSentError) return error;
  if (error instanceof ProviderError) return new NotSentError({ ...error.error, uncertain: false });
  return new NotSentError(record(method, 'transient', 'notSent', false));
}

/** The sending request was written and no answer proves a refusal: never a `NotSentError` or `PausedError`. */
function uncertain(error: unknown, method: string): unknown {
  if (error instanceof ProviderError) {
    if (error.error.uncertain) return error;
    return new ProviderError({ ...error.error, uncertain: true }, error.scope);
  }
  if (error instanceof PausedError || error instanceof NotSentError)
    return new ProviderError(record(method, 'transient', 'uncertain', true));
  return error;
}

function networkKind(error: unknown): 'timeout' | 'reset' | 'refused' {
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? '';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(code)) return 'refused';
  if (/TIMEOUT/i.test(code) || (error as Error)?.name === 'TimeoutError') return 'timeout';
  return 'reset';
}

// ---------------------------------------------------------------- the upload

interface SendRoute {
  kind: 'message' | 'draft';
  method: 'gmail.messages.send' | 'gmail.drafts.send';
  path: '/messages/send' | '/drafts/send';
  /** The JSON half of the upload: a Message (`threadId`) or a Draft (`id`, `message.threadId`). */
  metadata: Record<string, unknown>;
}

function messageRoute(payload: SubmissionPayload): SendRoute {
  const thread = payload.remoteThreadId ? { threadId: payload.remoteThreadId } : {};
  return { kind: 'message', method: SEND_METHOD, path: '/messages/send', metadata: thread };
}

function draftRoute(payload: SubmissionPayload, draftId: string): SendRoute {
  const thread = payload.remoteThreadId ? { threadId: payload.remoteThreadId } : {};
  return {
    kind: 'draft',
    method: 'gmail.drafts.send',
    path: '/drafts/send',
    metadata: { id: draftId, message: thread },
  };
}

interface Exchange {
  status: number;
  headers: Headers;
  text: string;
}

/** Whether `written` is true: the request that can deliver the mail has been handed to `fetch`. */
interface SendState {
  written: boolean;
}

const isOk = (status: number) => status >= 200 && status < 300;

/** The statuses that are Gmail refusing the request before it did anything. Every other status is uncertain. */
const REFUSALS: ReadonlySet<number> = new Set([400, 401, 403, 413, 429]);

/**
 * Only a known refusal proves nothing left: 408, 409, 499 and anything unlisted are uncertain. 404 proves it on the
 * message route only; a `drafts.send` 404 means the draft vanished between the read and the send (sent or deleted on
 * another device), so the mail may well be out under this Message-ID, and only `findSent` can tell.
 */
function provesRefusal(status: number, route: SendRoute): boolean {
  if (status === 404) return route.kind === 'message';
  return REFUSALS.has(status);
}

/** The session URI Gmail hands back must be Google's, over HTTPS: the bytes and the token go there next. */
function sessionUri(location: string | null): string | undefined {
  if (!location) return undefined;
  try {
    const url = new URL(location);
    const google = url.hostname === 'googleapis.com' || url.hostname.endsWith('.googleapis.com');
    return url.protocol === 'https:' && google ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** One send's upload inside `governor.run`: multipart, or a resumable session then a single PUT. */
class Upload {
  private started = 0;

  constructor(
    private readonly deps: GmailDeps,
    private readonly ctx: AdapterContext,
    private readonly route: SendRoute,
    private readonly raw: Uint8Array,
    private readonly io: RequestIo,
    private readonly state: SendState,
  ) {}

  run(): Promise<unknown> {
    return this.raw.length > RESUMABLE_ABOVE_BYTES ? this.resumable() : this.multipart();
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return {
      'accept-encoding': 'gzip',
      'user-agent': this.deps.userAgent,
      ...(this.io.accessToken ? { authorization: `Bearer ${this.io.accessToken}` } : {}),
      ...extra,
    };
  }

  private async multipart(): Promise<unknown> {
    const boundary = boundaryFor(this.raw);
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
          `${JSON.stringify(this.route.metadata)}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`,
      ),
      this.raw,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const url = `${UPLOAD_API}${this.route.path}?uploadType=multipart`;
    const init = {
      method: 'POST',
      headers: this.headers({ 'content-type': `multipart/related; boundary=${boundary}` }),
      body,
    };
    return this.settle(await this.exchange(url, init, true));
  }

  private async resumable(): Promise<unknown> {
    const session = await this.initiate();
    const init = {
      method: 'PUT',
      headers: this.headers({ 'content-type': 'message/rfc822' }),
      // A copy over its own ArrayBuffer, which is what `fetch` takes.
      body: Buffer.concat([this.raw]),
    };
    return this.settle(await this.exchange(session, init, true));
  }

  /** Opens the upload session. It cannot deliver anything, so every failure here is proof of not sent. */
  private async initiate(): Promise<string> {
    const url = `${UPLOAD_API}${this.route.path}?uploadType=resumable`;
    const reply = await this.exchange(
      url,
      {
        method: 'POST',
        headers: this.headers({
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': 'message/rfc822',
          'x-upload-content-length': String(this.raw.length),
        }),
        body: JSON.stringify(this.route.metadata),
      },
      false,
    );
    if (!isOk(reply.status)) throw this.refused(reply);
    const session = sessionUri(reply.headers.get('location'));
    if (!session)
      throw new ProviderError(
        record(this.route.method, 'transient', 'invalidUploadSession', false),
      );
    return session;
  }

  /** One fetch with its body read, under the send timeout. `sending` marks the request that can deliver the mail. */
  private async exchange(url: string, init: RequestInit, sending: boolean): Promise<Exchange> {
    if (this.io.signal.aborted)
      throw new ProviderError(record(this.route.method, 'cancelled', 'aborted', false));
    const timer = new AbortController();
    const done = new AbortController();
    this.ctx.clock.sleep(sendTimeoutMs(this.raw.length), done.signal).then(
      () => timer.abort(new Error('send timed out')),
      () => undefined,
    );
    if (sending) this.state.written = true;
    this.started = this.ctx.clock.now();
    try {
      const response = await this.deps.fetch(url, {
        ...init,
        // Never followed: a 307/308 would re-send the pinned bytes (and, same-origin, the token) to wherever it
        // points. A 3xx is answered like any other unknown status: before the sending request it proves nothing
        // left; after it, the outcome is uncertain and `findSent` settles it.
        redirect: 'manual',
        signal: AbortSignal.any([this.io.signal, timer.signal]),
      });
      return { status: response.status, headers: response.headers, text: await response.text() };
    } catch (error) {
      throw this.lost(error, sending, timer.signal.aborted);
    } finally {
      done.abort();
    }
  }

  /** No answer. Only a refused connection proves the sending request never reached Gmail. */
  private lost(error: unknown, sending: boolean, timedOut: boolean): ProviderError {
    const now = this.ctx.clock.now();
    const method = this.route.method;
    if (!timedOut && this.io.signal.aborted)
      return new ProviderError(record(method, 'cancelled', 'aborted', sending));
    const network = timedOut ? 'timeout' : networkKind(error);
    if (network === 'refused' || !sending) {
      this.state.written = false;
      return new ProviderError({
        ...googleError({ method, kind: 'send', now, network }).error,
        uncertain: false,
      });
    }
    return googleError({ method, kind: 'send', now, network });
  }

  private refused(reply: Exchange): ProviderError {
    const error = googleError({
      method: this.route.method,
      kind: 'send',
      now: this.ctx.clock.now(),
      status: reply.status,
      body: reply.text,
      headers: reply.headers,
    });
    this.ctx.log.event('sync.gmail.request_refused', { error: withoutProviderText(error.error) });
    return error;
  }

  /**
   * The sending request's answer. A 2xx is accepted mail only when it is Gmail's Message (a string `id`): a proxy or a
   * captive portal can answer 200 with a page of its own, so a 2xx without one is uncertain and `findSent` settles it.
   */
  private settle(reply: Exchange): unknown {
    if (isOk(reply.status)) {
      const message = parseOrNothing(reply.text) as { id?: unknown } | undefined;
      if (typeof message?.id !== 'string')
        throw new ProviderError(record(this.route.method, 'transient', 'invalidResponse', true));
      this.ctx.log.event('sync.gmail.request', {
        method: this.route.method,
        status: reply.status,
        units: gmailCost(this.route.method, undefined, this.deps.costs),
        durationMs: this.ctx.clock.now() - this.started,
      });
      return message;
    }
    if (provesRefusal(reply.status, this.route)) this.state.written = false;
    throw this.refused(reply);
  }
}

/**
 * A send refusal as it is logged: Gmail's own text is left out, because for `messages.send` and `drafts.send` it can
 * quote the message itself (an address from a header Gmail rejected). The class, reason and status say enough.
 */
function withoutProviderText(error: ClassifiedError): ClassifiedError {
  const logged = { ...error };
  delete logged.providerMessage;
  return logged;
}

function parseOrNothing(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A multipart boundary that does not occur in the message (128 random bits; checked anyway). */
function boundaryFor(raw: Uint8Array): string {
  for (let i = 0; i < 3; i++) {
    const boundary = `aplos_send_${randomBytes(16).toString('hex')}`;
    if (!Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).includes(boundary))
      return boundary;
  }
  throw refuse('boundaryCollision');
}

function receiptOf(reply: unknown, route: SendRoute, now: number): SendReceipt {
  const message = (typeof reply === 'object' && reply !== null ? reply : {}) as {
    id?: unknown;
    threadId?: unknown;
  };
  return {
    ...(typeof message.id === 'string' ? { remoteMessageId: message.id } : {}),
    ...(typeof message.threadId === 'string' ? { remoteThreadId: message.threadId } : {}),
    acceptedAt: now,
    ...(route.kind === 'draft' ? { draftConsumed: true } : {}),
  };
}

/** The one governed `send` request: one price, never re-sent by the governor (`kind: 'send'`), interactive lane. */
async function transmit(
  deps: GmailDeps,
  route: SendRoute,
  raw: Uint8Array,
  ctx: AdapterContext,
): Promise<SendReceipt> {
  const state: SendState = { written: false };
  try {
    const reply = await ctx.governor.run(
      {
        budget: 'gmail',
        lane: 'interactive',
        kind: 'send',
        method: route.method,
        cost: gmailCost(route.method, undefined, deps.costs),
        signal: AbortSignal.any([ctx.signal, deps.closed]),
      },
      io => new Upload(deps, ctx, route, raw, io, state).run(),
    );
    return receiptOf(reply, route, ctx.clock.now());
  } catch (error) {
    throw state.written ? uncertain(error, route.method) : notSent(error, route.method);
  }
}

// ---------------------------------------------------------------- choosing what to send

/** The remote draft as it is now: its message id, or undefined when Gmail says it no longer exists. */
async function remoteDraft(
  client: GmailClient,
  draftId: string,
): Promise<{ remoteMessageId: string } | undefined> {
  try {
    const draft = await client.call<{ message?: { id?: unknown } }>({
      method: 'gmail.drafts.get',
      path: `/drafts/${encodeURIComponent(draftId)}`,
      format: 'minimal',
      fields: 'id,message/id',
      lane: 'interactive',
      item: draftId,
    });
    const id = draft.message?.id;
    // A draft that exists but names no message is not provably the pinned revision, and it is not gone either.
    return { remoteMessageId: typeof id === 'string' ? id : '' };
  } catch (error) {
    if (error instanceof ProviderError && error.error.status === 404) return undefined;
    throw error;
  }
}

export interface SendOptions {
  /**
   * Default false: every send is the pinned MIME through `messages.send`, and the engine removes the remote draft itself
   * after `sent` (no `draftConsumed`). True turns on the `drafts.send` route below.
   *
   * TODO(live): switch on only after the live gate proves, on real Gmail, that (1) `drafts.send` with uploaded
   * `message/rfc822` media sends exactly those bytes, not the stored draft; (2) MEASURED 2026-11-05: Gmail REPLACES the
   * Message-ID on `messages.send` (a custom header survives), so `findSent` finds a sent copy by the `X-Aplos-Send` token
   * (`withSendToken`, `isSentCopy`); whether `drafts.send` does the same is still unmeasured; (3) Gmail strips the
   * `Bcc:` header from delivered copies. The emulator does not model the upload protocol (the test rig bridges it).
   *
   * The `X-Aplos-Draft` token (drafts.ts IDENTITY): the stored draft copy carries it, the pinned bytes never do (the
   * engine's MIME has no such header and `checkHeaders` here does not allow it). Both routes upload the pinned bytes as
   * the media, so the token does not leave in sent mail, provided (1) above holds. If the live gate shows that
   * `drafts.send` sends the STORED draft instead, the token would leave with it: then do not switch this on (strip
   * would mean rewriting the stored copy first). Also note for (2): on Gmail a draft copy shows Gmail's own Message-ID,
   * so the Sent lookup of a gone draft below (`sentCopy` by `rfc822msgid:`) cannot find a copy a phone sent; that case
   * stays uncertain (`DRAFT_GONE`, nothing sent twice).
   */
  useDraftsSend?: boolean;
}

/** The draft is gone and Sent has no copy: it may have just been sent elsewhere, so nothing is sent and `findSent` decides. */
const DRAFT_GONE = 'draftGone';

/**
 * With `useDraftsSend` only: `drafts.send` for a draft that is provably the pinned revision. A draft edited elsewhere
 * stays in place and the pinned bytes go as a new message. A draft that is gone may have been sent already (by another
 * device, or by an earlier attempt of this row): when Sent holds this Message-ID the mail is out and nothing is sent
 * again; when it does not (yet: the search index lags), the outcome is uncertain rather than a second copy.
 */
async function chooseRoute(
  deps: GmailDeps,
  payload: SubmissionPayload,
  ctx: AdapterContext,
  options: SendOptions,
): Promise<SendRoute | SendReceipt | typeof DRAFT_GONE> {
  const plain = messageRoute(payload);
  const draftId = payload.remoteDraftId;
  if (!options.useDraftsSend) return plain;
  if (draftId === undefined || payload.baseRemoteMessageId === undefined) return plain;
  const client = new GmailClient(deps, ctx);
  const current = await remoteDraft(client, draftId);
  if (sendsRemoteDraft(payload, current)) return draftRoute(payload, draftId);
  if (current) return plain;
  const out = await sentCopy(client, payload.internetId);
  if (!out) return DRAFT_GONE;
  return {
    remoteMessageId: out.id,
    ...(out.threadId ? { remoteThreadId: out.threadId } : {}),
    acceptedAt: ctx.clock.now(),
  };
}

/** `ProviderAdapter.send` for Gmail. `ctx` is the paced context; see the file header for the rules. */
export async function sendSubmission(
  deps: GmailDeps,
  payload: SubmissionPayload,
  ctx: AdapterContext,
  options: SendOptions = {},
): Promise<SendReceipt> {
  const pinned = pinnedMime(payload, ctx.account.address);
  const raw = withSendToken(pinned, payload.internetId);
  // The token is a few dozen bytes on top of what `pinnedMime` already measured: the limit holds for what goes up.
  if (raw.length > MAX_SEND_BYTES) throw refuse('messageTooLarge');
  const route = await chooseRoute(deps, payload, ctx, options).catch((error: unknown) => {
    throw notSent(error, 'gmail.drafts.get');
  });
  if (route === DRAFT_GONE)
    throw new ProviderError(record('gmail.drafts.get', 'transient', DRAFT_GONE, true));
  if (!('method' in route)) return route;
  return transmit(deps, route, raw, ctx);
}

// ---------------------------------------------------------------- findSent

/** Message-ID characters that are plain words to Gmail search: no quote, brace, parenthesis, bar or space. */
const SEARCHABLE_ID = /^<([A-Za-z0-9.!#$%&'*+/=?^_`~@-]{1,900})>$/;

const bareId = (id: string): string => id.trim().replace(/^<|>$/g, '').toLowerCase();

function searchDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}`;
}

/**
 * Sent only, never a draft, bounded by `after:` a generous `AFTER_SLACK_MS` before `since`: Gmail reads the date in its
 * own zone, and a sent draft's internalDate can predate the send. The bound only trims the search; the Message-ID and
 * the labels decide.
 */
export function sentQuery(internetId: string, since?: number): string {
  const bare = SEARCHABLE_ID.exec(internetId)?.[1];
  if (!bare)
    throw new ProviderError(record('gmail.messages.list', 'permanent', 'unsearchableMessageId'));
  const bounded = since !== undefined && Number.isFinite(since) && since > AFTER_SLACK_MS;
  const after = bounded ? ` after:${searchDate(since - AFTER_SLACK_MS)}` : '';
  return `rfc822msgid:${bare} in:sent -in:drafts${after}`;
}

interface SentHit {
  id: string;
  threadId?: string;
}

export interface Candidate {
  id?: unknown;
  threadId?: unknown;
  labelIds?: unknown;
  /** Epoch milliseconds as a decimal string; asked for by the recent-SENT fallback only. */
  internalDate?: unknown;
  payload?: { headers?: { name?: unknown; value?: unknown }[] };
}

/** A header's trimmed value, or undefined; a header that appears twice is not one value and is ignored. */
function headerValue(m: Candidate, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const found = (m.payload?.headers ?? []).filter(
    h => typeof h.name === 'string' && h.name.toLowerCase() === wanted,
  );
  return found.length === 1 && typeof found[0].value === 'string'
    ? found[0].value.trim()
    : undefined;
}

/**
 * Whether the message's own labels and headers say it is this mail, sent: SENT, never DRAFT, and either the
 * `X-Aplos-Send` token we wrote equals `internetId` (Gmail replaces the Message-ID of a send but keeps the header) or,
 * on an account that kept it, the Message-ID does. The token FINDS and names the copy; the labels and the caller's time
 * window prove it is a sent message of this submission.
 */
export function isSentCopy(m: Candidate, internetId: string): boolean {
  const labels = Array.isArray(m.labelIds) ? m.labelIds : [];
  if (!labels.includes('SENT') || labels.includes('DRAFT')) return false;
  const token = headerValue(m, SEND_TOKEN_HEADER);
  if (token !== undefined && isDraftToken(token) && bareId(token) === bareId(internetId))
    return true;
  const id = headerValue(m, 'Message-ID');
  return id !== undefined && bareId(id) === bareId(internetId);
}

/** One hit's metadata (20 units), or 'gone' when it disappeared between the search and the read. */
async function candidate(
  client: GmailClient,
  id: string,
  withDate = false,
): Promise<Candidate | 'gone'> {
  try {
    return await client.call<Candidate>({
      method: 'gmail.messages.get',
      path: `/messages/${encodeURIComponent(id)}`,
      format: 'metadata',
      query: { metadataHeaders: ['Message-ID', SEND_TOKEN_HEADER] },
      fields: `id,threadId,labelIds,${withDate ? 'internalDate,' : ''}payload/headers`,
      lane: 'interactive',
      item: id,
    });
  } catch (error) {
    if (error instanceof ProviderError && error.error.status === 404) return 'gone';
    throw error;
  }
}

function incomplete(reason: string): ProviderError {
  return new ProviderError(record('gmail.messages.list', 'transient', reason));
}

/**
 * The Sent copy of `internetId`, or undefined when Gmail has none. A search that errors, a hit that vanished before it
 * could be checked, or more hits than one page holds is thrown: an answer that is not complete is never "absent".
 */
async function sentCopy(
  client: GmailClient,
  internetId: string,
  since?: number,
): Promise<SentHit | undefined> {
  const page = await client.call<{ messages?: { id?: unknown }[]; nextPageToken?: string }>({
    method: 'gmail.messages.list',
    path: '/messages',
    query: {
      q: sentQuery(internetId, since),
      maxResults: SENT_CANDIDATES,
      includeSpamTrash: 'true',
    },
    fields: 'messages(id,threadId),nextPageToken',
    lane: 'interactive',
  });
  let vanished = false;
  for (const hit of page.messages ?? []) {
    if (typeof hit.id !== 'string') continue;
    const m = await candidate(client, hit.id);
    if (m === 'gone') vanished = true;
    else if (isSentCopy(m, internetId))
      return { id: hit.id, ...(typeof m.threadId === 'string' ? { threadId: m.threadId } : {}) };
  }
  if (vanished) throw incomplete('sentHitVanished');
  if (page.nextPageToken) throw incomplete('sentSearchPartial');
  return undefined;
}

/** Newest SENT messages read per page when the search misses (one `messages.list`, then that many metadata gets). */
export const RECENT_SENT = 10;
/** Pages of the SENT listing read in all: the first, then at most this many more while no older candidate shows. */
export const RECENT_EXTRA_PAGES = 2;
/** A recent candidate older than `since` by more than this is outside the window (Gmail's clock against this device's). */
const RECENT_MARGIN_MS = 10 * 60_000;

interface SentListing {
  ids: string[];
  /** The listing continues past this page: a next page exists, or the page is full. */
  more: boolean;
  /** Where the next page starts; absent when Gmail named none (a full page without one cannot be followed). */
  nextPageToken?: string;
}

/** One page of the newest SENT message ids by label, not by search: the label index shows a send the search may not yet. */
async function newestSent(client: GmailClient, pageToken?: string): Promise<SentListing> {
  const page = await client.call<{ messages?: { id?: unknown }[]; nextPageToken?: string }>({
    method: 'gmail.messages.list',
    path: '/messages',
    query: {
      labelIds: ['SENT'],
      maxResults: RECENT_SENT,
      includeSpamTrash: 'true',
      ...(pageToken ? { pageToken } : {}),
    },
    fields: 'messages(id),nextPageToken',
    lane: 'interactive',
  });
  const listed = (page.messages ?? []).slice(0, RECENT_SENT);
  const ids = listed.map(m => m.id).filter((id): id is string => typeof id === 'string');
  const token =
    typeof page.nextPageToken === 'string' && page.nextPageToken ? page.nextPageToken : undefined;
  return { ids, more: Boolean(token) || listed.length >= RECENT_SENT, nextPageToken: token };
}

/**
 * The fallback when the search found nothing: the newest SENT messages, each re-checked like a search hit (SENT, no
 * DRAFT, this Message-ID). Every id listed is read, in any order, so neither the listing's order nor the device clock
 * decides a "found". The copy is matched by its labels and header on EVERY candidate; the date only decides whether the
 * window has been reached (a candidate older than `since` minus `RECENT_MARGIN_MS`), so a copy that predates `since`
 * (a device clock ahead of Gmail's, a sent draft keeping its old date) is still found, as the search path would find
 * it. The one date limit on a match is the search's own (`AFTER_SLACK_MS` before `since`), so the two paths agree and
 * the contract's "a copy from days before `since` is not returned" holds. While no older candidate has shown and a next
 * page exists, up to `RECENT_EXTRA_PAGES` more pages are read. It answers "absent" (undefined) only when the listing
 * is provably complete for the window: some candidate is older than the window, or a page is short with no next page.
 * Past the pages cap, a listing that still reached no older candidate may hide the copy, so it is thrown
 * (`sentListingPartial`, retryable). Any other failure in it, a vanished candidate too, is thrown, never "absent".
 */
async function recentSentCopy(
  client: GmailClient,
  internetId: string,
  since: number,
): Promise<SentHit | undefined> {
  let pageToken: string | undefined;
  for (let page = 0; page <= RECENT_EXTRA_PAGES; page++) {
    const { ids, more, nextPageToken } = await newestSent(client, pageToken);
    let reachedOlder = false;
    for (const id of ids) {
      const m = await candidate(client, id, true);
      if (m === 'gone') throw incomplete('sentHitVanished');
      if (isSentCopy(m, internetId) && !(Number(m.internalDate) < since - AFTER_SLACK_MS))
        return { id, ...(typeof m.threadId === 'string' ? { threadId: m.threadId } : {}) };
      if (Number(m.internalDate) < since - RECENT_MARGIN_MS) reachedOlder = true;
    }
    if (reachedOlder || !more) return undefined;
    if (!nextPageToken) break;
    pageToken = nextPageToken;
  }
  throw incomplete('sentListingPartial');
}

/**
 * `ProviderAdapter.findSent` for Gmail: `found` only for a SENT, non-DRAFT message carrying our `X-Aplos-Send` token
 * (or, where Gmail kept it, our Message-ID), found by the search or the newest-SENT listing. One pass: Gmail's index
 * shows a send a few seconds late (live: the 4th try, about 3 s apart), and the engine asks again after 60 s before it
 * asks the owner, which covers that lag without holding this call (and the engine's dispatch) for seconds. An error in
 * the pass is thrown, never "absent" (an answer that is not complete is never "absent").
 */
export async function findSentCopy(
  deps: GmailDeps,
  internetId: string,
  since: number,
  ctx: AdapterContext,
): Promise<FindSentResult> {
  const checkedAt = ctx.clock.now();
  const client = new GmailClient(deps, ctx);
  const hit =
    (await sentCopy(client, internetId, since)) ??
    (await recentSentCopy(client, internetId, since));
  if (!hit) return { kind: 'absent', checkedAt };
  return {
    kind: 'found',
    remoteMessageId: hit.id,
    ...(hit.threadId ? { remoteThreadId: hit.threadId } : {}),
  };
}
