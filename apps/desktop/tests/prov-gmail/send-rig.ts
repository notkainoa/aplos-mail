/**
 * Rig for the Gmail send transport (`google/send.ts`): the Gmail emulator on a fake clock, the engine's real governor
 * (so `kind: 'send'` gets its real no-retry and before-call rules) and the real adapter, plus an upload bridge.
 *
 * The bridge stands in for what the emulator does not model yet (a prov-emu gap): Gmail's `/upload/` protocol for
 * `messages.send` and `drafts.send` with `uploadType=multipart` (JSON metadata plus the `message/rfc822` media) and
 * `uploadType=resumable` (a session, then one PUT). It parses each upload strictly, records the exact bytes, and
 * replays it on the emulator's own endpoints: a message as JSON `messages.send` with its `threadId`, a draft as
 * `drafts.update` with the uploaded bytes then `drafts.send` (what Google's drafts guide describes for a send that
 * carries a message). Faults injected on the emulator's send methods therefore still fire.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ClassifiedError } from '@aplos/contract';
import {
  type AccountId,
  type AdapterAccount,
  type AdapterContext,
  type KnownLookup,
  type Logger,
  type RequestIo,
  type SendPort,
  type SubmissionPayload,
  type TokenSource,
} from '@aplos/engine/ports';
import {
  FakeClock,
  SCOPE,
  createFaultInjector,
  createGmailEmulator,
  type FaultInjector,
  type GmailEmulator,
} from '@aplos/emulators';
import { oauthBudget } from '../../../../packages/engine/src/sync/budgets';
import { Governor } from '../../../../packages/engine/src/sync/governor';
import {
  buildEnvelope,
  buildMime,
  type MimeInput,
} from '../../../../packages/engine/src/outbox/mime';
import { GMAIL_BUDGET, GmailAdapter } from '../../src/host/providers/google/adapter';
import { googleError } from '../../src/host/providers/google/classify';
import type { SendPortHarness } from '../../../../packages/engine/tests/ports/send-port-contract';

export const ACCOUNT: AccountId = 'acct-gmail-send';
const CLIENT_ID = 'prov-gmail-send.apps.example.test';
const SCOPES = ['openid', 'email', 'profile', SCOPE.gmailModify];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const UPLOAD = 'https://gmail.googleapis.com/upload/gmail/v1/users/me';

export interface LoggedEvent {
  name: string;
  fields: unknown;
}

/** A logger that keeps every event, for tests that check what a log line may hold. */
function recordingLog(events: LoggedEvent[]): Logger {
  const log: Logger = {
    event(name, fields) {
      events.push({ name, fields });
    },
    with: () => log,
    enabled: () => false,
  };
  return log;
}

/** The host's token source, cut down: one access token and refreshes against the emulator's token endpoint. */
class Tokens implements TokenSource {
  constructor(
    private readonly emu: GmailEmulator,
    private readonly clock: FakeClock,
    private refreshToken: string,
    private access: { token: string; expiresAt: number },
  ) {}
  cached() {
    return this.access;
  }
  async refresh(_account: AccountId, io: RequestIo) {
    const response = await this.emu.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: CLIENT_ID,
      }).toString(),
      signal: io.signal,
    });
    const text = await response.text();
    if (!response.ok)
      throw googleError({
        method: 'oauth.token',
        kind: 'idempotentWrite',
        now: this.clock.now(),
        status: response.status,
        body: text,
      });
    const json = JSON.parse(text) as { access_token: string; expires_in: number };
    this.access = {
      token: json.access_token,
      expiresAt: this.clock.now() + json.expires_in * 1000,
    };
    return this.access;
  }
}

// ---- the upload bridge ----

export interface UploadRecord {
  endpoint: 'messages' | 'drafts';
  uploadType: 'multipart' | 'resumable';
  metadata: Record<string, unknown>;
  raw: Buffer;
}

interface Session {
  endpoint: 'messages' | 'drafts';
  metadata: Record<string, unknown>;
  length: number;
}

const failure = (status: number, reason: string, message = reason) =>
  new Response(
    JSON.stringify({ error: { code: status, message, errors: [{ reason, message }] } }),
    {
      status,
      headers: { 'content-type': 'application/json' },
    },
  );

const bad = (message: string) => failure(400, 'badRequest', message);

/** A request that never answers; only its own abort ends it. */
const hang = (signal: AbortSignal | null | undefined) =>
  new Promise<Response>((_, reject) =>
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
  );

const bytesOf = (body: unknown): Buffer =>
  typeof body === 'string' ? Buffer.from(body) : Buffer.from(body as Uint8Array);

/** Strict `multipart/related`: exactly the JSON part, then the `message/rfc822` part, as Google's upload guide lays out. */
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
  return {
    metadata: JSON.parse(body.subarray(head.length, at).toString('utf8')) as Record<
      string,
      unknown
    >,
    raw: Buffer.from(body.subarray(at + mid.length, body.length - tail.length)),
  };
}

export class UploadBridge {
  readonly uploads: UploadRecord[] = [];
  /** Runs after an upload is parsed and before it reaches the emulator (a phone edit landing mid-send). */
  beforeDelivery?: (upload: UploadRecord) => void | Promise<void>;
  /**
   * The next upload request fails like this instead of reaching the emulator. `acceptThenHang`: Gmail applies the send,
   * then the answer never arrives (only the caller's abort ends it).
   */
  failNext?: 'refused' | 'hang' | 'dropInitiate' | 'corrupt' | 'portal' | 'acceptThenHang';
  /** Rewrites a `messages.list` search (to prove the metadata check stands even if the search let a draft through). */
  rewriteQuery?: (q: string) => string;
  /** The label a `messages.list` by label alone (no `q`: the recent-SENT fallback) reads instead of the one asked for (a listing that returns a message the SENT check must refuse). */
  listLabel?: string;
  /** Every `messages.list` by label alone (no `q`: the recent-SENT fallback) answers 500. */
  failSentListing?: boolean;
  /** Upload requests go to this fetch instead of the bridge (a real HTTP server, for redirect tests). */
  uploadVia?: typeof fetch;
  private readonly sessions = new Map<string, Session>();
  private nextSession = 0;

  constructor(private readonly emu: GmailEmulator) {}

  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.href.startsWith(UPLOAD)) return this.toUpload(url, init ?? {});
    const listing = url.pathname.endsWith('/messages') && (init?.method ?? 'GET') === 'GET';
    if (this.failSentListing && listing && !url.searchParams.has('q'))
      return Promise.resolve(failure(500, 'backendError'));
    if (this.listLabel && listing && url.searchParams.has('labelIds') && !url.searchParams.has('q'))
      url.searchParams.set('labelIds', this.listLabel);
    if (this.rewriteQuery && listing && url.searchParams.has('q'))
      url.searchParams.set('q', this.rewriteQuery(url.searchParams.get('q')!));
    return this.emu.fetch(url.href, init);
  };

  private toUpload(url: URL, init: RequestInit): Promise<Response> {
    return this.uploadVia ? this.uploadVia(url.href, init) : this.upload(url, init);
  }

  private fault(signal: AbortSignal | null | undefined): Promise<Response> | undefined {
    const fault = this.failNext;
    const later = fault === 'dropInitiate' || fault === 'corrupt' || fault === 'acceptThenHang';
    if (fault === undefined || later) return undefined;
    this.failNext = undefined;
    if (fault === 'portal')
      return Promise.resolve(
        new Response('<html><body>Sign in to the Wi-Fi</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      );
    if (fault === 'refused')
      return Promise.reject(
        Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
      );
    return hang(signal);
  }

  private async upload(url: URL, init: RequestInit): Promise<Response> {
    const endpoint = url.pathname.endsWith('/drafts/send') ? 'drafts' : 'messages';
    const headers = new Headers(init.headers);
    const type = url.searchParams.get('uploadType');
    if (type === 'resumable' && init.method === 'POST')
      return this.initiate(endpoint, headers, init);
    const faulted = this.fault(init.signal);
    if (faulted) return faulted;
    if (type === 'resumable' && init.method === 'PUT') return this.complete(url, headers, init);
    if (type !== 'multipart' || init.method !== 'POST') return bad('unsupported upload');
    const parsed = parseRelated(headers.get('content-type') ?? '', bytesOf(init.body));
    if (!parsed) return bad('malformed multipart/related upload');
    return this.deliver({ endpoint, uploadType: 'multipart', ...parsed }, headers, init.signal);
  }

  private async initiate(endpoint: 'messages' | 'drafts', headers: Headers, init: RequestInit) {
    if (this.failNext === 'dropInitiate') {
      this.failNext = undefined;
      throw new TypeError('fetch failed');
    }
    if (headers.get('x-upload-content-type') !== 'message/rfc822') return bad('wrong upload type');
    const length = Number(headers.get('x-upload-content-length'));
    if (!Number.isInteger(length) || length <= 0) return bad('missing upload length');
    const id = `s${++this.nextSession}`;
    const metadata = JSON.parse(String(init.body)) as Record<string, unknown>;
    this.sessions.set(id, { endpoint, metadata, length });
    const location = `${UPLOAD}/${endpoint}/send?uploadType=resumable&upload_id=${id}`;
    return new Response('', { status: 200, headers: { location } });
  }

  private async complete(url: URL, headers: Headers, init: RequestInit) {
    const session = this.sessions.get(url.searchParams.get('upload_id') ?? '');
    if (!session) return new Response('', { status: 404 });
    this.sessions.delete(url.searchParams.get('upload_id')!);
    const raw = bytesOf(init.body);
    if (headers.get('content-type') !== 'message/rfc822') return bad('wrong media type');
    if (raw.length !== session.length) return bad('upload length mismatch');
    return this.deliver({ ...session, uploadType: 'resumable', raw }, headers, init.signal);
  }

  private async deliver(
    upload: UploadRecord,
    headers: Headers,
    signal: AbortSignal | null | undefined,
  ): Promise<Response> {
    this.uploads.push(upload);
    await this.beforeDelivery?.(upload);
    const auth = {
      authorization: headers.get('authorization') ?? '',
      'content-type': 'application/json',
    };
    const raw = upload.raw.toString('base64url');
    const reply =
      upload.endpoint === 'messages'
        ? await this.emu.fetch(`${API}/messages/send`, {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({ raw, ...upload.metadata }),
          })
        : await this.sendDraft(upload, auth, raw);
    if (this.failNext === 'acceptThenHang') {
      this.failNext = undefined;
      return hang(signal);
    }
    if (this.failNext !== 'corrupt') return reply;
    this.failNext = undefined;
    return new Response('{"id": "trunc', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  /**
   * `drafts.send` with media sends exactly the uploaded bytes (the live-gate assumption (1) in send.ts): a SEND, so the
   * emulator's send identity applies to it, not the draft-save rewrite (`draftIdentity`, `dropDraftHeaders`) that the
   * replay's `drafts.update` would otherwise apply. The settings are restored right after.
   */
  private async sendDraft(upload: UploadRecord, auth: Record<string, string>, raw: string) {
    const id = String(upload.metadata.id);
    const message = (upload.metadata.message ?? {}) as Record<string, unknown>;
    const settings = this.emu.settings;
    const saved = { identity: settings.draftIdentity, dropped: settings.dropDraftHeaders };
    settings.draftIdentity = settings.sendIdentity;
    settings.dropDraftHeaders = [];
    let updated: Response;
    try {
      updated = await this.emu.fetch(`${API}/drafts/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: auth,
        body: JSON.stringify({ message: { ...message, raw } }),
      });
    } finally {
      settings.draftIdentity = saved.identity;
      settings.dropDraftHeaders = saved.dropped;
    }
    if (!updated.ok) return updated;
    return this.emu.fetch(`${API}/drafts/send`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id }),
    });
  }
}

// ---- a redirecting upload endpoint, over real HTTP ----

export type RedirectAt = 'initiate' | 'send';

export interface RedirectingGmail {
  /** The adapter's upload fetch: Node's own `fetch`, so its real redirect handling is what runs. */
  fetch: typeof fetch;
  /**
   * HTTP requests the redirect target parsed (method, URL, body size): must stay empty. A bare connection that opens
   * and closes without a request is not one (the server's request handler never runs for it).
   */
  requests: { method: string; url: string; bytes: number }[];
  close(): Promise<void>;
}

const bodyOf = async (req: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const listen = (server: Server): Promise<number> =>
  new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );

const stop = (server: Server): Promise<void> =>
  new Promise(resolve => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

/**
 * The guard's meaning: nothing the adapter sent reached the redirect target. The tests use 307 and 308, which keep the
 * method and the body when followed, so a followed redirect would arrive as a PUT or POST (or with body bytes). A bare
 * body-less GET is some other process probing the ephemeral port of a busy machine (seen in loaded full runs), not the
 * adapter, so it is not counted.
 */
export function assertNothingReached(gmail: RedirectingGmail): void {
  const reached = gmail.requests.filter(r => r.method !== 'GET' || r.bytes > 0);
  assert.deepEqual(
    reached,
    [],
    'not one PUT or POST, and not one body byte, went to the redirect target',
  );
}

/**
 * Gmail's upload host on 127.0.0.1 answering `status` (307 or 308) at `at`, pointing at a second server (another
 * origin) that would accept the bytes as sent mail. A resumable session opens normally when the redirect is at `send`.
 */
export async function redirectingGmail(
  status: 307 | 308,
  at: RedirectAt,
): Promise<RedirectingGmail> {
  const requests: RedirectingGmail['requests'] = [];
  const target = createServer((req, res) => {
    void bodyOf(req).then(body => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', bytes: body.length });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"18c0ffee00000001","threadId":"18c0ffee00000001"}');
    });
  });
  const targetPort = await listen(target);
  const gmail = createServer((req, res) => {
    void bodyOf(req).then(() => {
      const initiate = req.method === 'POST' && req.url?.includes('uploadType=resumable');
      if (initiate && at === 'send') {
        res.writeHead(200, {
          location: `${UPLOAD}/messages/send?uploadType=resumable&upload_id=s1`,
        });
        return res.end();
      }
      res.writeHead(status, { location: `http://127.0.0.1:${targetPort}/upload/elsewhere` });
      res.end();
    });
  });
  const gmailPort = await listen(gmail);
  const local = `http://127.0.0.1:${gmailPort}`;
  return {
    fetch: (input, init) =>
      fetch(String(input).replace('https://gmail.googleapis.com', local), init),
    requests,
    close: async () => {
      await stop(gmail);
      await stop(target);
    },
  };
}

// ---- the world ----

export interface SendWorld {
  clock: FakeClock;
  emu: GmailEmulator;
  faults: FaultInjector;
  bridge: UploadBridge;
  governor: Governor;
  adapter: GmailAdapter;
  account: AdapterAccount;
  address: string;
  /** A fresh call context; `signal` aborts it (an actor stop). */
  ctx(signal?: AbortSignal): AdapterContext;
  port: SendPort;
  /** Every Gmail API request that reached the emulator (sign-in and token calls are not Gmail's). */
  gmailRequests(): number;
  /** Requests that reached the emulator's send endpoints (`messages.send`, `drafts.send`), refused ones included. */
  sendRequests(): number;
  sentMessages(): { id: string; threadId: string; messageId: string; raw: Buffer }[];
  /** Every log event the adapter wrote through a `ctx()` of this world. */
  events: LoggedEvent[];
}

export interface SendWorldOptions {
  sendLimitPerDay?: number;
  /** The adapter's `useDraftsSend` (default off, as in production until the live gate). */
  useDraftsSend?: boolean;
  /** The adapter's own `GmailPacer` in front of the governor (default off: the governor paces). */
  pace?: boolean;
  /** What `messages.send` does to our Message-ID (the emulator's `sendIdentity`; real Gmail rewrites it). */
  sendIdentity?: 'kept' | 'rewritten';
  /** The emulator's search index lag after a send, in ms of its clock (`searchLagMs`). */
  searchLagMs?: number;
  /** The mailbox owner (default: the emulator's test user). */
  user?: { sub: string; email: string; name: string };
  /** The fake clock's start (default: the emulators' epoch). */
  clockStart?: number;
}

export async function sendWorld(options: SendWorldOptions = {}): Promise<SendWorld> {
  const clock = new FakeClock(
    options.clockStart === undefined ? {} : { start: options.clockStart },
  );
  const faults = createFaultInjector();
  const emu = createGmailEmulator({
    clock,
    retryAfter: 'none',
    faults,
    ...(options.sendIdentity ? { sendIdentity: options.sendIdentity } : {}),
    ...(options.searchLagMs !== undefined ? { searchLagMs: options.searchLagMs } : {}),
    ...(options.user ? { users: [options.user] } : {}),
    ...(options.sendLimitPerDay !== undefined ? { sendLimitPerDay: options.sendLimitPerDay } : {}),
  });
  emu.oauth.addClient(CLIENT_ID);
  const session = await emu.oauth.signIn({ clientId: CLIENT_ID, scopes: SCOPES, fetch: emu.fetch });
  const tokens = new Tokens(emu, clock, session.refreshToken!, {
    token: session.accessToken,
    expiresAt: clock.now() + Number(session.response.expires_in) * 1000,
  });
  const governor = new Governor({
    clock,
    // The token endpoint's own budget, as in the engine's defaults: a 401's forced refresh is governed there.
    budgets: [GMAIL_BUDGET, oauthBudget],
    tokens,
    random: () => 0,
    role: 'primary',
  });
  const address = emu.users()[0].email;
  const account: AdapterAccount = {
    id: ACCOUNT,
    provider: 'google',
    address,
    grantedScopes: SCOPES,
    capabilities: {
      labels: true,
      folders: false,
      drafts: true,
      serverSearch: true,
      calendar: false,
      filters: false,
      push: false,
      sendAs: false,
      unsubscribeHeaders: true,
      threading: 'native',
    },
  };
  const bridge = new UploadBridge(emu);
  const events: LoggedEvent[] = [];
  const log = recordingLog(events);
  const adapter = new GmailAdapter(account, {
    fetch: bridge.fetch,
    pace: options.pace ?? false,
    useDraftsSend: options.useDraftsSend ?? false,
  });
  const ctx = (signal = new AbortController().signal): AdapterContext => ({
    account,
    governor: governor.bind(ACCOUNT),
    clock: {
      now: () => clock.now(),
      sleep: (ms, s) => clock.sleep(ms, s),
      timer: () => ({ cancel() {} }),
    },
    log,
    signal,
    // send and findSent never read the store.
    lookup: {} as KnownLookup,
    memory: new Map(),
    generation: 0,
  });
  const port: SendPort = {
    admission: () => governor.admission(ACCOUNT, 'gmail', 'interactive', 'send'),
    send: (_account, submission) => adapter.send(submission, ctx()),
    findSent: (_account, internetId, since) => adapter.findSent(internetId, since, ctx()),
  };
  return {
    clock,
    emu,
    faults,
    bridge,
    governor,
    adapter,
    account,
    address,
    ctx,
    port,
    events,
    gmailRequests: () => emu.log.filter(e => e.service === 'gmail').length,
    sendRequests: () =>
      emu.log.filter(e => /^gmail\.users\.(messages|drafts)\.send$/.test(e.apiMethod)).length,
    sentMessages: () =>
      emu.mailbox
        .listMessages()
        .filter(m => m.labelIds.includes('SENT'))
        .map(m => ({
          id: m.id,
          threadId: m.threadId,
          messageId: m.messageId,
          raw: emu.mailbox.rawOf(m.id),
        })),
  };
}

// ---- submissions ----

let ids = 0;

export interface Pinned {
  payload: SubmissionPayload;
  mime: Buffer;
}

/** A submission as the outbox pins it: `buildMime` bytes, `buildEnvelope` recipients, a fresh Message-ID. */
export function submission(
  world: Pick<SendWorld, 'address'>,
  overrides: Partial<MimeInput> & { bcc?: MimeInput['to'] } = {},
): Pinned {
  const internetId = overrides.messageId ?? `<send-${++ids}-${'ab'.repeat(8)}@mail.example.test>`;
  const input: MimeInput = {
    from: { address: world.address, name: 'Kai Test' },
    to: [{ address: 'friend@example.test', name: 'A Friend' }],
    cc: [],
    subject: 'Quarterly numbers',
    html: '<p>Hello there</p>',
    messageId: internetId,
    date: Date.UTC(2026, 9, 27, 16, 0, 0),
    randomBytes: n => new Uint8Array(n).fill(7),
    ...overrides,
    bcc: undefined,
  };
  const mime = Buffer.from(buildMime(input));
  const envelope = buildEnvelope(input.from, {
    to: input.to,
    cc: input.cc,
    bcc: overrides.bcc ?? [],
  });
  return { mime, payload: { submissionId: `sub-${ids}`, internetId, mime, envelope } };
}

/** The same payload with its MIME replaced by `mime` (an injection test edits the bytes the outbox pinned). */
export const withMime = (pinned: Pinned, mime: string | Buffer): SubmissionPayload => ({
  ...pinned.payload,
  mime: typeof mime === 'string' ? Buffer.from(mime, 'latin1') : mime,
});

/** Where the header block ends (the CRLF CRLF). */
export const headerEndOf = (mime: Buffer): number => mime.indexOf('\r\n\r\n');

// ---- the contract harness ----

const bare = (id: string) => id.replace(/^<|>$/g, '');

/** `sendPortContract`'s harness over the real adapter: Sent copies and drafts written into the emulator's mailbox. */
export async function contractHarness(options: SendWorldOptions = {}): Promise<SendPortHarness> {
  const world = await sendWorld(options);
  return {
    port: world.port,
    account: ACCOUNT,
    deliver(internetId, at) {
      world.emu.mailbox.addMessage({
        from: world.address,
        to: ['friend@example.test'],
        subject: 'Sent copy',
        messageId: bare(internetId),
        labelIds: ['SENT'],
        internalDate: at,
      });
    },
    keepDraft(internetId, at) {
      world.emu.mailbox.createDraftElsewhere({
        to: ['friend@example.test'],
        subject: 'Draft copy',
        messageId: bare(internetId),
        internalDate: at,
      });
    },
  };
}

export const classOf = (error: unknown): ClassifiedError | undefined =>
  (error as { error?: ClassifiedError }).error;
