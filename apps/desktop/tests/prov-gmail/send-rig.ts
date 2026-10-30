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

const quietLog: Logger = { event() {}, with: () => quietLog, enabled: () => false };

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

const bad = (message: string) =>
  new Response(
    JSON.stringify({ error: { code: 400, message, errors: [{ reason: 'badRequest', message }] } }),
    {
      status: 400,
      headers: { 'content-type': 'application/json' },
    },
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
  /** The next upload request fails like this instead of reaching the emulator. */
  failNext?: 'refused' | 'hang' | 'dropInitiate' | 'corrupt';
  /** Rewrites a `messages.list` search (to prove the metadata check stands even if the search let a draft through). */
  rewriteQuery?: (q: string) => string;
  private readonly sessions = new Map<string, Session>();
  private nextSession = 0;

  constructor(private readonly emu: GmailEmulator) {}

  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.href.startsWith(UPLOAD)) return this.upload(url, init ?? {});
    if (this.rewriteQuery && url.pathname.endsWith('/messages') && url.searchParams.has('q'))
      url.searchParams.set('q', this.rewriteQuery(url.searchParams.get('q')!));
    return this.emu.fetch(url.href, init);
  };

  private fault(signal: AbortSignal | null | undefined): Promise<Response> | undefined {
    const fault = this.failNext;
    if (fault === undefined || fault === 'dropInitiate' || fault === 'corrupt') return undefined;
    this.failNext = undefined;
    if (fault === 'refused')
      return Promise.reject(
        Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
      );
    // Never answers; only the caller's abort ends it.
    return new Promise((_, reject) =>
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true }),
    );
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
    return this.deliver({ endpoint, uploadType: 'multipart', ...parsed }, headers);
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
    return this.deliver({ ...session, uploadType: 'resumable', raw }, headers);
  }

  private async deliver(upload: UploadRecord, headers: Headers): Promise<Response> {
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
    if (this.failNext !== 'corrupt') return reply;
    this.failNext = undefined;
    return new Response('{"id": "trunc', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  private async sendDraft(upload: UploadRecord, auth: Record<string, string>, raw: string) {
    const id = String(upload.metadata.id);
    const message = (upload.metadata.message ?? {}) as Record<string, unknown>;
    const updated = await this.emu.fetch(`${API}/drafts/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: auth,
      body: JSON.stringify({ message: { ...message, raw } }),
    });
    if (!updated.ok) return updated;
    return this.emu.fetch(`${API}/drafts/send`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ id }),
    });
  }
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
}

export async function sendWorld(options: { sendLimitPerDay?: number } = {}): Promise<SendWorld> {
  const clock = new FakeClock();
  const faults = createFaultInjector();
  const emu = createGmailEmulator({ clock, retryAfter: 'none', faults, ...options });
  emu.oauth.addClient(CLIENT_ID);
  const session = await emu.oauth.signIn({ clientId: CLIENT_ID, scopes: SCOPES, fetch: emu.fetch });
  const tokens = new Tokens(emu, clock, session.refreshToken!, {
    token: session.accessToken,
    expiresAt: clock.now() + Number(session.response.expires_in) * 1000,
  });
  const governor = new Governor({
    clock,
    budgets: [GMAIL_BUDGET],
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
  const adapter = new GmailAdapter(account, { fetch: bridge.fetch, pace: false });
  const ctx = (signal = new AbortController().signal): AdapterContext => ({
    account,
    governor: governor.bind(ACCOUNT),
    clock: {
      now: () => clock.now(),
      sleep: (ms, s) => clock.sleep(ms, s),
      timer: () => ({ cancel() {} }),
    },
    log: quietLog,
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
export async function contractHarness(): Promise<SendPortHarness> {
  const world = await sendWorld();
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
