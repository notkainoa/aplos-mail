/**
 * The upload bridge for the draft tests. The Gmail emulator does not model Gmail's `/upload/` protocol for drafts yet
 * (a prov-emu gap), so this stands in for it: it parses each upload strictly (`uploadType=multipart`, JSON metadata
 * then the `message/rfc822` media; `uploadType=resumable`, a session then one PUT), records the exact bytes, and replays
 * the draft on the emulator's own JSON endpoints (`drafts.create`, `drafts.update`), so faults injected on those
 * methods still fire and the emulator's request log and meter still see them.
 *
 * Every request the adapter sends passes through `fetch` here, so `requests` is the full request record (the harness
 * `Rig.fetches` is bypassed because the adapter's fetch is replaced).
 */
import type { GmailEmulator } from '@aplos/emulators';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';

export interface UploadRecord {
  httpMethod: string;
  draftId?: string;
  uploadType: 'multipart' | 'resumable';
  metadata: Record<string, unknown>;
  raw: Buffer;
}

export interface RequestRecord {
  method: string;
  path: string;
  query: URLSearchParams;
}

interface Session {
  httpMethod: string;
  draftId?: string;
  metadata: Record<string, unknown>;
  length: number;
}

const bad = (message: string) =>
  new Response(
    JSON.stringify({ error: { code: 400, message, errors: [{ reason: 'badRequest', message }] } }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );

const bytesOf = (body: unknown): Buffer =>
  typeof body === 'string' ? Buffer.from(body) : Buffer.from(body as Uint8Array);

/** Strict `multipart/related`: exactly the JSON part, then the `message/rfc822` part. */
export function parseRelated(
  contentType: string,
  body: Buffer,
): { metadata: Record<string, unknown>; raw: Buffer } | undefined {
  const boundary = /^multipart\/related; boundary=([A-Za-z0-9_]+)$/.exec(contentType)?.[1];
  if (!boundary) return undefined;
  const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`;
  const mid = `\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  if (!body.subarray(0, head.length).equals(Buffer.from(head))) return undefined;
  if (!body.subarray(body.length - tail.length).equals(Buffer.from(tail))) return undefined;
  const at = body.indexOf(mid, head.length);
  if (at < 0) return undefined;
  const metadata = JSON.parse(body.subarray(head.length, at).toString('utf8')) as Record<
    string,
    unknown
  >;
  return { metadata, raw: Buffer.from(body.subarray(at + mid.length, body.length - tail.length)) };
}

export class DraftBridge {
  readonly uploads: UploadRecord[] = [];
  readonly requests: RequestRecord[] = [];
  /** Rewrites the JSON of a `drafts.get` reply (a draft that is still addressable but no longer a draft). */
  rewriteDraftGet?: (json: Record<string, unknown>) => Record<string, unknown>;
  /** Makes `drafts.list?q=` answer with no drafts (the search index lags behind a draft just created). */
  blindSearch = false;
  /** Runs after an upload is parsed and before it reaches the emulator (a draft deleted mid-write). */
  beforeDelivery?: () => void;
  /** Answers every resumable session request with this Location instead of the bridge's own. */
  sessionLocation?: string;
  private emu?: GmailEmulator;
  private readonly sessions = new Map<string, Session>();
  private nextSession = 0;

  attach(emu: GmailEmulator): void {
    this.emu = emu;
  }

  /** Requests of one HTTP method and path suffix (`drafts`, `drafts/<id>`), for the "no request was made" checks. */
  count(method: string, pathSuffix: RegExp): number {
    return this.requests.filter(r => r.method === method && pathSuffix.test(r.path)).length;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    this.requests.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
    });
    if (url.href.startsWith(UPLOAD)) return this.upload(url, init ?? {});
    if (this.blindSearch && /\/drafts$/.test(url.pathname) && url.searchParams.has('q'))
      return new Response('{"resultSizeEstimate":0}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    const reply = await this.emu!.fetch(url.href, init);
    if (!this.rewriteDraftGet || (init?.method ?? 'GET') !== 'GET') return reply;
    if (!/\/drafts\/[^/]+$/.test(url.pathname) || !reply.ok) return reply;
    const json = this.rewriteDraftGet((await reply.json()) as Record<string, unknown>);
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  private upload(url: URL, init: RequestInit): Promise<Response> {
    const httpMethod = init.method ?? 'POST';
    const draftId = /\/drafts\/([^/?]+)$/.exec(url.pathname)?.[1];
    const headers = new Headers(init.headers);
    const type = url.searchParams.get('uploadType');
    if (type === 'resumable' && url.searchParams.has('upload_id'))
      return this.complete(url, headers, init);
    if (type === 'resumable') return this.initiate(httpMethod, draftId, headers, init);
    if (type !== 'multipart') return Promise.resolve(bad('unsupported upload'));
    const parsed = parseRelated(headers.get('content-type') ?? '', bytesOf(init.body));
    if (!parsed) return Promise.resolve(bad('malformed multipart/related upload'));
    return this.deliver({ httpMethod, draftId, uploadType: 'multipart', ...parsed }, headers);
  }

  private async initiate(
    httpMethod: string,
    draftId: string | undefined,
    headers: Headers,
    init: RequestInit,
  ): Promise<Response> {
    if (headers.get('x-upload-content-type') !== 'message/rfc822') return bad('wrong upload type');
    const length = Number(headers.get('x-upload-content-length'));
    if (!Number.isInteger(length) || length <= 0) return bad('missing upload length');
    const id = `s${++this.nextSession}`;
    const metadata = JSON.parse(String(init.body)) as Record<string, unknown>;
    this.sessions.set(id, { httpMethod, draftId, metadata, length });
    const where = draftId ? `/drafts/${draftId}` : '/drafts';
    const location =
      this.sessionLocation ?? `${UPLOAD}${where}?uploadType=resumable&upload_id=${id}`;
    return new Response('', { status: 200, headers: { location } });
  }

  private async complete(url: URL, headers: Headers, init: RequestInit): Promise<Response> {
    const id = url.searchParams.get('upload_id')!;
    const session = this.sessions.get(id);
    if (!session) return new Response('', { status: 404 });
    this.sessions.delete(id);
    const raw = bytesOf(init.body);
    if (headers.get('content-type') !== 'message/rfc822') return bad('wrong media type');
    if (raw.length !== session.length) return bad('upload length mismatch');
    return this.deliver({ ...session, uploadType: 'resumable', raw }, headers);
  }

  private deliver(upload: UploadRecord, headers: Headers): Promise<Response> {
    this.uploads.push(upload);
    this.beforeDelivery?.();
    const message: Record<string, unknown> = { raw: upload.raw.toString('base64url') };
    const thread = (upload.metadata.message as { threadId?: unknown } | undefined)?.threadId;
    if (typeof thread === 'string') message.threadId = thread;
    const auth = {
      authorization: headers.get('authorization') ?? '',
      'content-type': 'application/json',
    };
    const where = upload.draftId ? `${API}/drafts/${upload.draftId}` : `${API}/drafts`;
    return this.emu!.fetch(where, {
      method: upload.draftId ? 'PUT' : 'POST',
      headers: auth,
      body: JSON.stringify({ message }),
    });
  }
}
