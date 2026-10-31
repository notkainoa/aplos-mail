import { randomBytes } from 'node:crypto';
import {
  ProviderError,
  type AdapterContext,
  type RequestIo,
  type RequestKind,
} from '@aplos/engine/ports';
import type { ClassifiedError } from '@aplos/contract';
import { googleError } from './classify';
import type { GmailDeps } from './client';
import { gmailCost } from './costs';

/**
 * The media upload behind `drafts.create` and `drafts.update` (Gmail's `/upload/` endpoints, plan 20 PV4, D20): the
 * draft's MIME as `message/rfc822`, multipart with the JSON half (`{message:{threadId}}`, plus the draft `id` on an
 * update) up to `RESUMABLE_ABOVE_BYTES`, resumable (a session, then one PUT of the bytes) above it. One upload is ONE
 * governed request: the governor sees the price and the kind, and this file has no loop and no retry. A create is a
 * `write` (never re-sent); an update by id is an `idempotentWrite` (the governor may re-send identical bytes).
 *
 * What a failure means for the caller:
 * - A create whose request was written and whose answer is missing or not Gmail's Draft (a timeout, a reset, a 5xx, a 2xx
 *   that is not JSON with an id) is thrown as `uncertain: true`; the caller recognises the copy afterwards by its
 *   Message-ID. A refusal Gmail wrote itself (4xx) and a failure before the bytes went (a refused connection, the
 *   resumable session request) is `uncertain: false`.
 * - The session URI Gmail hands back must be Google's, over HTTPS, before the bytes and the token go there.
 */

const UPLOAD_API = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';
/** D20: above this the upload is resumable. */
export const RESUMABLE_ABOVE_BYTES = 5 * 1024 * 1024;
/** An upload that has not answered by then is abandoned, so it cannot hold the account's one slot forever. */
export const uploadTimeoutMs = (bytes: number): number =>
  60_000 + Math.ceil(bytes / 50_000) * 1_000;

export type DraftUploadMethod = 'gmail.drafts.create' | 'gmail.drafts.update';

export interface DraftUploadRequest {
  method: DraftUploadMethod;
  /** Gmail draft id: present on an update. */
  draftId?: string;
  threadId?: string;
  raw: Uint8Array;
}

/** Gmail's Draft resource, as far as the adapter reads it. */
export interface DraftResource {
  id: string;
  message: { id: string; threadId?: string };
}

interface Exchange {
  status: number;
  headers: Headers;
  text: string;
}

const isOk = (status: number) => status >= 200 && status < 300;

const kindOf = (method: DraftUploadMethod): RequestKind =>
  method === 'gmail.drafts.create' ? 'write' : 'idempotentWrite';

function networkKind(error: unknown): 'timeout' | 'reset' | 'refused' {
  const code = (error as { cause?: { code?: string } })?.cause?.code ?? '';
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(code)) return 'refused';
  if (/TIMEOUT/i.test(code) || (error as Error)?.name === 'TimeoutError') return 'timeout';
  return 'reset';
}

function plain(method: string, cls: ClassifiedError['class'], reason: string, uncertain: boolean) {
  return new ProviderError({ class: cls, provider: 'gmail', method, reason, uncertain });
}

/** The session URI Gmail hands back must be Google's, over HTTPS. */
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

/** A multipart boundary that does not occur in the message (128 random bits; checked anyway). */
function boundaryFor(raw: Uint8Array): string {
  const bytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  for (let i = 0; i < 3; i++) {
    const boundary = `aplos_draft_${randomBytes(16).toString('hex')}`;
    if (!bytes.includes(boundary)) return boundary;
  }
  throw plain('gmail.drafts.create', 'permanent', 'boundaryCollision', false);
}

function parseOrNothing(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asDraft(value: unknown): DraftResource | undefined {
  const draft = value as
    { id?: unknown; message?: { id?: unknown; threadId?: unknown } } | undefined;
  if (typeof draft?.id !== 'string' || typeof draft.message?.id !== 'string') return undefined;
  const threadId = draft.message.threadId;
  return {
    id: draft.id,
    message: {
      id: draft.message.id,
      ...(typeof threadId === 'string' ? { threadId } : {}),
    },
  };
}

class Upload {
  private started = 0;

  constructor(
    private readonly deps: GmailDeps,
    private readonly ctx: AdapterContext,
    private readonly req: DraftUploadRequest,
    private readonly io: RequestIo,
  ) {}

  private get kind(): RequestKind {
    return kindOf(this.req.method);
  }

  private get path(): string {
    const id = this.req.draftId;
    return id === undefined ? '/drafts' : `/drafts/${encodeURIComponent(id)}`;
  }

  private get httpMethod(): 'POST' | 'PUT' {
    return this.req.draftId === undefined ? 'POST' : 'PUT';
  }

  private get metadata(): Record<string, unknown> {
    const message = this.req.threadId ? { message: { threadId: this.req.threadId } } : {};
    return this.req.draftId === undefined ? message : { id: this.req.draftId, ...message };
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return {
      'accept-encoding': 'gzip',
      'user-agent': this.deps.userAgent,
      ...(this.io.accessToken ? { authorization: `Bearer ${this.io.accessToken}` } : {}),
      ...extra,
    };
  }

  run(): Promise<DraftResource> {
    return this.req.raw.length > RESUMABLE_ABOVE_BYTES ? this.resumable() : this.multipart();
  }

  private async multipart(): Promise<DraftResource> {
    const boundary = boundaryFor(this.req.raw);
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
          `${JSON.stringify(this.metadata)}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`,
      ),
      this.req.raw,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const url = `${UPLOAD_API}${this.path}?uploadType=multipart`;
    const headers = this.headers({ 'content-type': `multipart/related; boundary=${boundary}` });
    return this.settle(await this.exchange(url, { method: this.httpMethod, headers, body }, true));
  }

  private async resumable(): Promise<DraftResource> {
    const session = await this.initiate();
    const init = {
      method: 'PUT',
      headers: this.headers({ 'content-type': 'message/rfc822' }),
      // A copy over its own ArrayBuffer, which is what `fetch` takes.
      body: Buffer.concat([this.req.raw]),
    };
    return this.settle(await this.exchange(session, init, true));
  }

  /** Opens the upload session. It writes no draft, so every failure here is proof that nothing was stored. */
  private async initiate(): Promise<string> {
    const url = `${UPLOAD_API}${this.path}?uploadType=resumable`;
    const reply = await this.exchange(
      url,
      {
        method: this.httpMethod,
        headers: this.headers({
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': 'message/rfc822',
          'x-upload-content-length': String(this.req.raw.length),
        }),
        body: JSON.stringify(this.metadata),
      },
      false,
    );
    if (!isOk(reply.status)) throw this.refused(reply, false);
    const session = sessionUri(reply.headers.get('location'));
    if (!session) throw plain(this.req.method, 'transient', 'invalidUploadSession', false);
    return session;
  }

  /** One fetch with its body read, under the upload timeout. `writes` marks the request that carries the bytes. */
  private async exchange(url: string, init: RequestInit, writes: boolean): Promise<Exchange> {
    if (this.io.signal.aborted) throw plain(this.req.method, 'cancelled', 'aborted', false);
    const timer = new AbortController();
    const done = new AbortController();
    this.ctx.clock.sleep(uploadTimeoutMs(this.req.raw.length), done.signal).then(
      () => timer.abort(new Error('upload timed out')),
      () => undefined,
    );
    this.started = this.ctx.clock.now();
    try {
      const response = await this.deps.fetch(url, {
        ...init,
        signal: AbortSignal.any([this.io.signal, timer.signal]),
      });
      return { status: response.status, headers: response.headers, text: await response.text() };
    } catch (error) {
      throw this.lost(error, writes, timer.signal.aborted);
    } finally {
      done.abort();
    }
  }

  /** No answer. Only a refused connection (or a request that carried no bytes) proves nothing was stored. */
  private lost(error: unknown, writes: boolean, timedOut: boolean): ProviderError {
    const method = this.req.method;
    if (!timedOut && this.io.signal.aborted) return plain(method, 'cancelled', 'aborted', writes);
    const network = timedOut ? 'timeout' : networkKind(error);
    const failure = googleError({ method, kind: this.kind, now: this.ctx.clock.now(), network });
    if (network === 'refused' || !writes) {
      return new ProviderError({ ...failure.error, uncertain: false }, failure.scope);
    }
    return failure;
  }

  private refused(reply: Exchange, writes = true): ProviderError {
    const failure = googleError({
      method: this.req.method,
      kind: this.kind,
      now: this.ctx.clock.now(),
      status: reply.status,
      body: reply.text,
      headers: reply.headers,
    });
    this.ctx.log.event('sync.gmail.request_refused', { error: failure.error });
    const cls = failure.error.class;
    // A create whose answer is a server fault may have stored the draft; a 4xx Gmail wrote did not.
    const maybeStored = writes && this.kind === 'write' && cls === 'transient';
    if (!maybeStored) return failure;
    return new ProviderError({ ...failure.error, uncertain: true }, failure.scope);
  }

  /** A 2xx is a saved draft only when it is Gmail's Draft (a string `id` and message id): a proxy can answer 200 itself. */
  private settle(reply: Exchange): DraftResource {
    if (!isOk(reply.status)) throw this.refused(reply);
    const draft = asDraft(parseOrNothing(reply.text));
    if (!draft) throw plain(this.req.method, 'transient', 'invalidResponse', this.kind === 'write');
    this.ctx.log.event('sync.gmail.request', {
      method: this.req.method,
      status: reply.status,
      units: gmailCost(this.req.method, undefined, this.deps.costs),
      durationMs: this.ctx.clock.now() - this.started,
    });
    return draft;
  }
}

/** The one governed upload: priced from `GMAIL_COSTS`, opFlush lane, `write` for a create and `idempotentWrite` for an update. */
export function uploadDraft(
  deps: GmailDeps,
  ctx: AdapterContext,
  req: DraftUploadRequest,
): Promise<DraftResource> {
  return ctx.governor.run(
    {
      budget: 'gmail',
      lane: 'opFlush',
      kind: kindOf(req.method),
      method: req.method,
      cost: gmailCost(req.method, undefined, deps.costs),
      signal: AbortSignal.any([ctx.signal, deps.closed]),
    },
    io => new Upload(deps, ctx, req, io).run(),
  );
}
