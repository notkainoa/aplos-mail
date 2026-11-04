/**
 * Contributed by the Providers lane (prov-gmail-write), as the harness header asks.
 * The Gmail send adapter as the kill-point harness's `SendPort` (see the header of
 * `packages/engine/tests/outbox/killpoint-harness.ts`). The harness runs each engine life in a child process, so the
 * Gmail emulator lives in the test process behind a real HTTP server (`startGmailServer`) and this module, loaded by
 * every child, builds the real `GmailAdapter` with the real `Governor` over that URL, as `send-rig.ts` does in process.
 *
 * Test-only. The faults a scenario needs (the connection reset before the server saw the bytes, the answer lost after it
 * accepted them, a refusal, a provider that is unreachable) are the emulator's own `FaultInjector` rules; the one thing it
 * cannot model, a search index that shows a delivery late, is a filter on the server side of the wire (`lagMs`).
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  type AccountId,
  type AdapterAccount,
  type AdapterContext,
  type KnownLookup,
  type Logger,
  type RequestIo,
  type SendPort,
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
import { Governor } from '../../src/sync/governor';
import type { Clock } from '../../src/ports/time';
import {
  GMAIL_BUDGET,
  GmailAdapter,
} from '../../../../apps/desktop/src/host/providers/google/adapter';
import { googleError } from '../../../../apps/desktop/src/host/providers/google/classify';
import { UploadBridge } from '../../../../apps/desktop/tests/prov-gmail/send-rig';

const ACCOUNT_ID: AccountId = 'acct-kill-gmail';
const CLIENT_ID = 'prov-gmail-killpoint.apps.example.test';
const SCOPES = ['openid', 'email', 'profile', SCOPE.gmailModify];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ORIGIN_HEADER = 'x-kp-origin';
const NOW_HEADER = 'x-kp-now';
const HOUR = 60 * 60_000;
/** The address of the harness's seeded account: the adapter refuses mail from anyone else. */
const OWNER = 'owner@mail.example';

/** What a scenario hands the children: where the server is, who to be, and where to count calls. */
export interface GmailPortConfig {
  baseUrl: string;
  address: string;
  refreshToken: string;
  accessToken: string;
  /** The child's record of calls that reached the port (the engine's own call counts; the server cannot see a dropped one). */
  logPath: string;
}

interface Call {
  op: 'send' | 'findSent';
  internetId: string;
}

export function readCalls(logPath: string): Call[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Call);
}

const quietLog: Logger = { event() {}, with: () => quietLog, enabled: () => false };

// ---------------------------------------------------------------- the child side

/** The host's token source, cut down: refreshes go to the emulator's token endpoint over the wire. */
class WireTokens implements TokenSource {
  constructor(
    private readonly wire: typeof fetch,
    private readonly clock: Clock,
    private readonly refreshToken: string,
    private access: { token: string; expiresAt: number },
  ) {}
  cached() {
    return this.access;
  }
  async refresh(_account: AccountId, io: RequestIo) {
    const response = await this.wire(TOKEN_URL, {
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

/** Sends every Google URL to the test server, naming the origin it was meant for and the engine's time. */
function wireFetch(baseUrl: string, clock: Clock): typeof fetch {
  return (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = new Headers(init?.headers);
    headers.set(ORIGIN_HEADER, url.origin);
    headers.set(NOW_HEADER, String(clock.now()));
    return fetch(`${baseUrl}${url.pathname}${url.search}`, { ...init, headers });
  };
}

const ACCOUNT_CAPABILITIES: AdapterAccount['capabilities'] = {
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
};

export function createSendPort(env: { clock: Clock; config: Record<string, unknown> }): SendPort {
  const config = env.config as unknown as GmailPortConfig;
  const { clock } = env;
  const wire = wireFetch(config.baseUrl, clock);
  const tokens = new WireTokens(wire, clock, config.refreshToken, {
    token: config.accessToken,
    expiresAt: clock.now() + HOUR,
  });
  const governor = new Governor({
    clock,
    budgets: [GMAIL_BUDGET],
    tokens,
    random: () => 0,
    role: 'primary',
  });
  const account: AdapterAccount = {
    id: ACCOUNT_ID,
    provider: 'google',
    address: config.address,
    grantedScopes: SCOPES,
    capabilities: ACCOUNT_CAPABILITIES,
  };
  const adapter = new GmailAdapter(account, { fetch: wire, pace: false, useDraftsSend: false });
  const ctx = (): AdapterContext => ({
    account,
    governor: governor.bind(ACCOUNT_ID),
    clock: {
      now: () => clock.now(),
      sleep: (ms, s) => clock.sleep(ms, s),
      timer: () => ({ cancel() {} }),
    },
    log: quietLog,
    signal: new AbortController().signal,
    lookup: {} as KnownLookup,
    memory: new Map(),
    generation: 0,
  });
  const record = (call: Call) => appendFileSync(config.logPath, `${JSON.stringify(call)}\n`);
  return {
    admission: () => governor.admission(ACCOUNT_ID, 'gmail', 'interactive', 'send'),
    send(_account, payload) {
      record({ op: 'send', internetId: payload.internetId });
      return adapter.send(payload, ctx());
    },
    findSent(_account, internetId, since) {
      record({ op: 'findSent', internetId });
      return adapter.findSent(internetId, since, ctx());
    },
  };
}

// ---------------------------------------------------------------- the server side

export interface GmailServerOptions {
  /** The emulator's clock minus the engine's first send time, in ms (negative: the server is behind). Default 0. */
  serverClockOffsetMs?: number;
  /** The search shows a delivery only this long after the send request arrived (engine time). Default: at once. */
  lagMs?: number;
  /** The same for the label listing (`labelIds=SENT`, no `q`): the `findSent` fallback sees the delivery only this late. */
  listingLagMs?: number;
  /** Plant a DRAFT carrying the outgoing Message-ID when the send request arrives (the "Sent only, never a draft" rule). */
  draftTwin?: boolean;
  /**
   * What `messages.send` and a draft save do to the Message-ID the engine wrote: `rewritten` is Gmail's live behaviour (the
   * Message-ID becomes `<hex@mail.gmail.com>`, the custom `X-Aplos-Send` / `X-Aplos-Draft` headers survive), `kept` is the
   * old emulator default. Set on the emulator itself (it lives in the test process), not through the environment.
   */
  sendIdentity?: 'kept' | 'rewritten';
}

export interface GmailServer {
  emu: GmailEmulator;
  faults: FaultInjector;
  config: Omit<GmailPortConfig, 'logPath'>;
  /** The emulator's own count of SENT messages carrying this Message-ID. */
  deliveries(internetId: string): number;
  /** SENT messages that still carry the Message-ID the engine wrote. Zero when `messages.send` rewrites it (Gmail's live behaviour). */
  sentUnderOwnId(internetId: string): number;
  /** The mode the emulator actually runs in (the environment may have switched the default). */
  sendIdentity(): 'kept' | 'rewritten';
  /** Every exception the bridge or emulator threw that was NOT an injected drop (answered 500). A clean row has none. */
  errors: string[];
  /** The next request the server handles throws this instead of reaching the emulator (to prove it is surfaced). */
  breakNext(error: Error): void;
  close(): Promise<void>;
}

const bare = (id: string) => id.replace(/^<|>$/g, '').toLowerCase();

/** The harness's seed time plus the default undo window: when the send is due. */
const SEND_DUE = Date.UTC(2026, 9, 28, 9, 0, 10);

/** The Gmail emulator behind a real HTTP server, in this process, outliving every child. */
export async function startGmailServer(options: GmailServerOptions = {}): Promise<GmailServer> {
  const clock = new FakeClock({ start: SEND_DUE + (options.serverClockOffsetMs ?? 0), auto: true });
  const faults = createFaultInjector();
  const emu = createGmailEmulator({
    clock,
    retryAfter: 'none',
    faults,
    latencyMs: 0,
    ...(options.sendIdentity
      ? { sendIdentity: options.sendIdentity, draftIdentity: options.sendIdentity }
      : {}),
    users: [{ sub: 'kp-owner', email: OWNER, name: 'Owner' }],
  });
  emu.oauth.addClient(CLIENT_ID);
  const session = await emu.oauth.signIn({ clientId: CLIENT_ID, scopes: SCOPES, fetch: emu.fetch });
  const bridge = new UploadBridge(emu);
  if (options.draftTwin) plantDraftTwin(bridge, emu);
  const state: ServerState = {
    sendAt: Number.POSITIVE_INFINITY,
    errors: [],
    lagMs: options.lagMs,
    listingLagMs: options.listingLagMs,
  };
  const server = createServer((req, res) => {
    void answer(bridge, req, res, state);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    emu,
    faults,
    config: {
      baseUrl: `http://127.0.0.1:${port}`,
      address: emu.users()[0].email,
      refreshToken: session.refreshToken!,
      accessToken: session.accessToken,
    },
    // A delivery carries the submission's id as its Message-ID (Gmail keeps ours) or, when Gmail rewrites it, as the
    // `X-Aplos-Send` token the adapter adds at transmit (`APLOS_EMU_SEND_IDENTITY=rewritten`).
    deliveries: internetId =>
      emu.mailbox
        .listMessages()
        .filter(
          m =>
            m.labelIds.includes('SENT') &&
            (m.messageId.toLowerCase() === bare(internetId) ||
              sendToken(emu.mailbox.rawOf(m.id)) === bare(internetId)),
        ).length,
    sentUnderOwnId: internetId =>
      emu.mailbox
        .listMessages()
        .filter(m => m.labelIds.includes('SENT') && m.messageId.toLowerCase() === bare(internetId))
        .length,
    sendIdentity: () => emu.settings.sendIdentity,
    errors: state.errors,
    breakNext: error => {
      state.breakNext = error;
    },
    close: () => stop(server),
  };
}

/** The `X-Aplos-Send` token in a message's header block, or undefined (lower-cased, without the angle brackets). */
function sendToken(raw: Buffer): string | undefined {
  const head = raw.toString('latin1').split(/\r?\n\r?\n/, 1)[0];
  const match = /^X-Aplos-Send:[ \t]*<?([^>\r\n]*?)>?[ \t]*$/im.exec(head);
  return match?.[1].toLowerCase();
}

interface ServerState {
  /** Engine time of the first send request (the search lag counts from it). */
  sendAt: number;
  lagMs: number | undefined;
  listingLagMs: number | undefined;
  errors: string[];
  breakNext?: Error;
}

function plantDraftTwin(bridge: UploadBridge, emu: GmailEmulator) {
  let planted = false;
  bridge.beforeDelivery = upload => {
    const id = /^Message-ID:\s*<([^>]+)>/im.exec(upload.raw.toString('latin1'))?.[1];
    if (planted || !id) return;
    planted = true;
    emu.mailbox.createDraftElsewhere({
      to: ['jordan@mail.example'],
      subject: 'Lunch (draft copy)',
      messageId: id,
    });
  };
}

function stop(server: Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

type Req = IncomingMessage;
type Res = ServerResponse;

const isSendRequest = (path: string, method: string, search: URLSearchParams): boolean =>
  /\/messages\/send$/.test(path) &&
  !(method === 'POST' && search.get('uploadType') === 'resumable');

/** The emulator's `drop` and `dropAfter` faults throw exactly this (`gmail/emulator.ts`): fetch's own network failure. */
const isInjectedDrop = (error: unknown): boolean =>
  error instanceof TypeError && error.message === 'fetch failed';

async function answer(bridge: UploadBridge, req: Req, res: Res, state: ServerState) {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const origin = String(req.headers[ORIGIN_HEADER] ?? 'https://gmail.googleapis.com');
    const now = Number(req.headers[NOW_HEADER]);
    const url = new URL(req.url ?? '/', origin);
    const method = req.method ?? 'GET';
    if (isSendRequest(url.pathname, method, url.searchParams) && state.sendAt > now)
      state.sendAt = now;
    const lagging = (lagMs: number | undefined) =>
      lagMs !== undefined && now < state.sendAt + lagMs;
    if (state.breakNext) {
      const error = state.breakNext;
      state.breakNext = undefined;
      throw error;
    }
    const reply = await bridge.fetch(url.href, {
      method,
      headers: forwarded(req.headers),
      ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
    });
    const body = Buffer.from(await reply.arrayBuffer());
    res.writeHead(reply.status, forwardedBack(reply.headers));
    const hidden =
      (isSearch(url) && lagging(state.lagMs)) || (isListing(url) && lagging(state.listingLagMs));
    res.end(hidden ? withoutHits(body) : body);
  } catch (error) {
    fail(req, res, error, state);
  }
}

/** An injected drop resets the connection with no reply; anything else is a bug: answer 500 and record it. */
function fail(req: Req, res: Res, error: unknown, state: ServerState) {
  if (isInjectedDrop(error)) {
    req.socket.destroy();
    return;
  }
  state.errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  if (res.headersSent) {
    req.socket.destroy();
    return;
  }
  res.writeHead(500, { 'content-type': 'text/plain' });
  res.end('test server error');
}

const isSearch = (url: URL) => /\/messages$/.test(url.pathname) && url.searchParams.has('q');

/** The label listing the `findSent` fallback reads: `messages.list` by `labelIds`, with no `q`. */
const isListing = (url: URL) =>
  /\/messages$/.test(url.pathname) &&
  !url.searchParams.has('q') &&
  url.searchParams.has('labelIds');

/** A search or listing that does not show the message yet: the index lags. */
function withoutHits(body: Buffer): Buffer {
  const json = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  delete json.messages;
  return Buffer.from(JSON.stringify(json));
}

function forwarded(headers: Req['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers))
    if (typeof value === 'string' && !/^(host|connection|content-length|x-kp-.*)$/.test(name))
      out[name] = value;
  return out;
}

function forwardedBack(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (!/^(content-length|content-encoding|transfer-encoding|connection)$/.test(name))
      out[name] = value;
  });
  return out;
}
