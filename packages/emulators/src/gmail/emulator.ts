import type { Clock } from '../kit/clock';
import type { EmulatedRequest, FaultDecision, FaultHook, RequestLogEntry } from '../kit/types';
import {
  batchRefusalProbability,
  boundaryOf,
  buildBatchResponse,
  MAX_BATCH_PARTS,
  parseBatch,
} from './batch';
import { costOf } from './costs';
import {
  ApiError,
  authChallenge,
  authError,
  badRequest,
  batchRefusalError,
  concurrencyError,
  dailyLimitError,
  delegationDenied,
  insufficientScopeError,
  scopeChallenge,
  invalidFieldError,
  notFound,
  sendLimitError,
  throttleError,
  type DailyLimitKind,
} from './errors';
import { calendarAbuseError, calendarThrottleError } from '../gcal/errors';
import { CalendarHub } from '../gcal/hub';
import { calendarShapeOf, CAL_SCOPES_FOR, matchCalendarRoute } from '../gcal/routes';
import { generateInto, type GenerateOptions } from './generate';
import { SearchLag } from './search-lag';
import { Mailbox } from './mailbox';
import { UnitMeter } from './meter';
import { OAuthServer, type TestUser, type TestUserInput } from './oauth';
import { nextPacificMidnight, pacificDay } from './pacific';
import { errorReply, replyBody, replyFromResponse, toResponse, type Reply } from './reply';
import { Random, mixSeed } from './rng';
import {
  matchRoute,
  responseShapeOf,
  SCOPES_FOR,
  type RouteContext,
  type RouteMatch,
} from './routes';
import type {
  DailyLimitState,
  GmailEmulator,
  GmailEmulatorOptions,
  GmailSettings,
  MeterHelpers,
  RetryAfterMode,
} from './types';
import { applyFieldsMask, invalidFieldIn } from './fields';

const GMAIL = 'https://gmail.googleapis.com';
const EMULATED_ORIGINS = new Set([
  GMAIL,
  'https://oauth2.googleapis.com',
  'https://accounts.google.com',
  'https://www.googleapis.com',
  'https://openidconnect.googleapis.com',
]);
const DEFAULT_USER: TestUserInput = {
  sub: '100000000000000000001',
  email: 'test.user@example.test',
  name: 'Test User',
};

interface ParsedRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: Buffer;
  signal?: AbortSignal | null;
}

/** A request after the synchronous "arrival" checks: either already answered or ready to run. */
interface Prepared {
  entry: RequestLogEntry;
  fault?: FaultDecision;
  immediate?: Reply;
  run?: () => Promise<Reply>;
  fieldsMask?: string;
  release?: () => void;
}

function bodyToBuffer(body: BodyInit, headers: Headers): Buffer | Promise<Buffer> {
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof URLSearchParams) {
    if (!headers.has('content-type'))
      headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
    return Buffer.from(body.toString());
  }
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return new Response(body).arrayBuffer().then(buffer => Buffer.from(buffer));
}

/** Reads fetch's arguments. Returns synchronously when the body is already in memory, so arrival order is call order. */
function readRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): ParsedRequest | Promise<ParsedRequest> {
  const request = typeof Request !== 'undefined' && input instanceof Request ? input : undefined;
  const url = new URL(request ? request.url : input instanceof URL ? input.href : String(input));
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  const headers = new Headers(init?.headers ?? request?.headers);
  const signal = init?.signal ?? request?.signal;
  const complete = (body: Buffer): ParsedRequest => ({ method, url, headers, body, signal });
  if (init?.body !== undefined && init.body !== null) {
    const body = bodyToBuffer(init.body, headers);
    return body instanceof Promise ? body.then(complete) : complete(body);
  }
  if (request && method !== 'GET' && method !== 'HEAD')
    return request
      .clone()
      .arrayBuffer()
      .then(buffer => complete(Buffer.from(buffer)));
  return complete(Buffer.alloc(0));
}

function formFields(req: ParsedRequest): URLSearchParams {
  const text = req.body.toString('utf8');
  if ((req.headers.get('content-type') ?? '').includes('json')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return new URLSearchParams(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(text);
}

function parseJson(body: Buffer): Record<string, unknown> {
  if (!body.length) return {};
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // fall through to the 400 below
  }
  throw new ApiError(400, 'parseError', 'Invalid JSON payload received.');
}

/** A 200 whose body is cut off halfway, for faults that corrupt the reply. */
function corrupted(reply: Reply): Reply {
  const text = replyBody(reply);
  return {
    status: 200,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
    text: text ? text.slice(0, Math.max(1, Math.floor(text.length / 2))) : '{"',
  };
}

export class GmailEmulatorImpl implements GmailEmulator {
  readonly fetch: typeof fetch = (input, init) => this.handle(input, init);
  readonly clock: Clock;
  readonly log: RequestLogEntry[] = [];
  readonly settings: GmailSettings;
  private readonly lag = new SearchLag(() => this.settings.searchLagMs);
  readonly blockedOrigins: string[] = [];
  readonly oauth: OAuthServer;
  readonly meter: MeterHelpers;
  readonly calendar: CalendarHub;

  private readonly seed: number;
  private readonly faults?: FaultHook;
  private readonly unitMeter = new UnitMeter();
  private readonly mailboxes = new Map<string, Mailbox>();
  private readonly inFlightBy = new Map<string, number>();
  private readonly sends = new Map<string, { day: string; count: number }>();
  private daily: DailyLimitState | null = null;
  private seq = 0;

  constructor(options: GmailEmulatorOptions) {
    this.clock = options.clock;
    this.seed = options.seed ?? 1;
    this.faults = options.faults;
    this.settings = {
      latencyMs: options.latencyMs ?? 150,
      unitsPerMinute: options.unitsPerMinute ?? 6000,
      concurrency: options.concurrency ?? 10,
      grandfathered: options.grandfathered ?? false,
      chargeRefused: options.chargeRefused ?? false,
      throttleShape: options.throttleShape ?? 'rateLimitExceeded403',
      retryAfter: options.retryAfter ?? 'none',
      historyRetentionMs: options.historyRetentionMs ?? 7 * 86400_000,
      sendLimitPerDay: options.sendLimitPerDay ?? 2000,
      // The environment is a switch for running any existing test suite as real Gmail behaves:
      // APLOS_EMU_DRAFT_IDENTITY=rewritten, APLOS_EMU_DROP_DRAFT_HEADERS=X-Aplos-Probe,X-Other (comma separated).
      draftIdentity:
        options.draftIdentity ??
        (process.env.APLOS_EMU_DRAFT_IDENTITY === 'rewritten' ? 'rewritten' : 'kept'),
      sendIdentity:
        options.sendIdentity ??
        (process.env.APLOS_EMU_SEND_IDENTITY === 'rewritten' ? 'rewritten' : 'kept'),
      searchLagMs: options.searchLagMs ?? 0,
      dropDraftHeaders:
        options.dropDraftHeaders ??
        (process.env.APLOS_EMU_DROP_DRAFT_HEADERS ?? '').split(',').filter(Boolean),
    };
    this.oauth = new OAuthServer(this.clock, new Random(mixSeed(this.seed, 1)), {
      testingMode: options.testingMode ?? true,
      repeatConsentIssuesRefreshToken: options.repeatConsentIssuesRefreshToken ?? true,
      requirePkceAndState: options.requirePkceAndState ?? false,
    });
    this.calendar = new CalendarHub({
      clock: this.clock,
      seed: this.seed,
      options: options.calendar ?? {},
      account: who => this.account(who),
      users: () => this.users(),
    });
    for (const user of options.users ?? [DEFAULT_USER]) this.addUser(user);
    this.meter = {
      unitsInWindow: account =>
        this.unitMeter.unitsInWindow(this.account(account).sub, this.clock.now()),
      perMinuteSeries: account => this.unitMeter.perMinuteSeries(this.account(account).sub),
      peakWindow: account => this.unitMeter.peakWindow(this.account(account).sub),
      reset: () => this.unitMeter.reset(),
    };
  }

  // ---------- accounts and mailboxes ----------

  addUser(input: TestUserInput): TestUser {
    const user = this.oauth.addUser(input);
    this.mailboxes.set(
      user.sub,
      new Mailbox({
        clock: this.clock,
        emailAddress: user.email,
        seed: mixSeed(this.seed, 100 + this.mailboxes.size),
        historyRetentionMs: () => this.settings.historyRetentionMs,
        rewriteSentMessageId: () => this.settings.sendIdentity === 'rewritten',
        draftIdentity: () => ({
          rewriteMessageId: this.settings.draftIdentity === 'rewritten',
          dropHeaders: this.settings.dropDraftHeaders,
        }),
      }),
    );
    return user;
  }

  users(): TestUser[] {
    return this.oauth.listUsers();
  }

  private account(who?: string): TestUser {
    const user = who ? this.oauth.findUser(who) : this.oauth.listUsers()[0];
    if (!user)
      throw new Error(who ? `Unknown test user: ${who}` : 'The emulator has no test users');
    return user;
  }

  get mailbox(): Mailbox {
    return this.mailboxFor();
  }

  mailboxFor(who?: string): Mailbox {
    return this.mailboxes.get(this.account(who).sub)!;
  }

  seedMailbox(options: GenerateOptions & { user?: string }): Mailbox {
    const mailbox = this.mailboxFor(options.user);
    generateInto(mailbox, { ...options, seed: options.seed ?? this.seed, clock: this.clock });
    return mailbox;
  }

  inFlight(who?: string): number {
    return this.inFlightBy.get(this.account(who).sub) ?? 0;
  }

  // ---------- daily switches ----------

  setDailyLimit(kind: DailyLimitKind | null): void {
    this.daily = kind ? { kind, resetsAt: nextPacificMidnight(this.clock.now()) } : null;
  }

  dailyLimit(): DailyLimitState | null {
    return this.activeDaily(this.clock.now());
  }

  private activeDaily(now: number): DailyLimitState | null {
    if (this.daily && now >= this.daily.resetsAt) this.daily = null;
    return this.daily;
  }

  setCalendarAbuse(on: boolean, options?: { forMs?: number }): void {
    this.calendar.setAbuse(on, options);
  }

  sendsToday(who?: string): number {
    const record = this.sends.get(this.account(who).sub);
    return record && record.day === pacificDay(this.clock.now()) ? record.count : 0;
  }

  setSendsToday(count: number, who?: string): void {
    this.sends.set(this.account(who).sub, { day: pacificDay(this.clock.now()), count });
  }

  // ---------- request handling ----------

  private async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const parsed = readRequest(input, init);
    const req = parsed instanceof Promise ? await parsed : parsed;
    if (!EMULATED_ORIGINS.has(req.url.origin)) {
      this.blockedOrigins.push(req.url.origin);
      throw new TypeError(`External network blocked: ${req.url.origin}`);
    }
    if (req.signal?.aborted) throw req.signal.reason;
    return this.complete(req, this.prepareRequest(req));
  }

  /** Waits out the simulated latency, then answers. The in-flight slot is held the whole time. */
  private async complete(req: ParsedRequest, prepared: Prepared): Promise<Response> {
    try {
      await this.clock.sleep(this.settings.latencyMs, req.signal ?? undefined);
      if (prepared.fault?.kind === 'drop') throw new TypeError('fetch failed');
      let reply = await this.execute(prepared);
      if (prepared.fault?.kind === 'dropAfter') throw new TypeError('fetch failed');
      if (prepared.fault?.kind === 'corrupt' && reply.status < 300) reply = corrupted(reply);
      return toResponse(reply);
    } finally {
      prepared.release?.();
    }
  }

  /** Produces the reply, applies `fields=`, and records the outcome in the log. */
  private async execute(prepared: Prepared): Promise<Reply> {
    let reply: Reply;
    if (prepared.fault?.kind === 'respond')
      reply = await replyFromResponse(prepared.fault.response.clone());
    else if (prepared.immediate) reply = prepared.immediate;
    else reply = await prepared.run!();
    if (
      prepared.fieldsMask &&
      reply.json !== undefined &&
      reply.status >= 200 &&
      reply.status < 300
    ) {
      reply = { ...reply, json: applyFieldsMask(reply.json, prepared.fieldsMask) };
    }
    prepared.entry.status = reply.status;
    if (reply.reason) prepared.entry.reason = reply.reason;
    return reply;
  }

  private prepareRequest(req: ParsedRequest): Prepared {
    const { url } = req;
    const path = url.pathname;
    switch (url.origin) {
      case 'https://accounts.google.com':
        if (req.method === 'GET' && (path === '/o/oauth2/v2/auth' || path === '/o/oauth2/auth')) {
          return this.prepareSimple(req, 'oauth', 'oauth.authorize', () => this.oauth.consent(url));
        }
        break;
      case 'https://oauth2.googleapis.com':
        if (req.method === 'POST' && path === '/token')
          return this.prepareSimple(req, 'oauth', 'oauth.token', () =>
            this.oauth.token(formFields(req)),
          );
        if (req.method === 'POST' && path === '/revoke')
          return this.prepareSimple(req, 'oauth', 'oauth.revoke', () =>
            this.oauth.revokeToken(formFields(req)),
          );
        break;
      case 'https://openidconnect.googleapis.com':
        if (path === '/v1/userinfo')
          return this.prepareSimple(req, 'oauth', 'oauth.userinfo', () =>
            this.oauth.userinfo(req.headers.get('authorization')),
          );
        break;
      case 'https://www.googleapis.com':
        if (path === '/oauth2/v3/userinfo')
          return this.prepareSimple(req, 'oauth', 'oauth.userinfo', () =>
            this.oauth.userinfo(req.headers.get('authorization')),
          );
        if (path.startsWith('/calendar/')) return this.prepareCalendar(req);
        if (path.startsWith('/upload/gmail/v1/')) return this.prepareGmailRoute(req);
        break;
      case GMAIL:
        if (path === '/batch/gmail/v1' && req.method === 'POST') return this.prepareBatch(req);
        return this.prepareGmailRoute(req);
    }
    return this.prepareUnrouted(req, 'gmail');
  }

  /**
   * The arrival checks for one Calendar call: credentials, fields mask, scope, anti-abuse (writes),
   * then the per-user request budget. Calendar has no concurrency cap, but the slot still shows in
   * the log's `inFlight` (kept apart from Gmail's, which Calendar traffic must not use up).
   */
  private prepareCalendar(req: ParsedRequest): Prepared {
    const match = matchCalendarRoute(req.method, req.url.pathname);
    if (!match) return this.prepareUnrouted(req, 'gcal');
    const { route, params } = match;
    const auth = this.oauth.checkBearer(req.headers.get('authorization'));
    const account = auth.ok ? auth.user.sub : undefined;
    const entry = this.newEntry(req, 'gcal', route.apiMethod, { account });
    const prepared: Prepared = { entry };
    entry.inFlight = (account ? this.takeSlot(`gcal:${account}`, prepared) : 0) + 1;
    const meter = this.calendar.requests;
    if (this.applyFault(prepared, req, 1, account, meter)) return prepared;

    const now = entry.at;
    const settings = this.calendar.settings;
    const refuse = (
      error: ApiError,
      headers: Record<string, string> = {},
      chargeIfConfigured = false,
    ): Prepared => {
      prepared.immediate = errorReply(error, headers);
      if (chargeIfConfigured && settings.chargeRefused && account) {
        meter.charge(account, 1, now, false);
        entry.units = 1;
      }
      return prepared;
    };
    if (!auth.ok)
      return refuse(authError(auth.reason === 'missing'), authChallenge(auth.reason === 'missing'));
    const fieldsMask = req.url.searchParams.get('fields') ?? undefined;
    const shape = calendarShapeOf(route.apiMethod);
    const badField = fieldsMask && shape ? invalidFieldIn(fieldsMask, shape) : undefined;
    if (badField !== undefined) return refuse(invalidFieldError(badField));
    if (!CAL_SCOPES_FOR[route.scope].some(scope => auth.scopes.includes(scope)))
      return refuse(
        insufficientScopeError(route.apiMethod, 'calendar-json.googleapis.com'),
        scopeChallenge(CAL_SCOPES_FOR[route.scope][0]),
      );
    if (route.write && this.calendar.activeAbuse(now)) return refuse(calendarAbuseError());

    const verdict = meter.check(auth.user.sub, 1, now, settings.requestsPerMinute);
    if (!verdict.allowed)
      return refuse(
        calendarThrottleError(settings.throttleShape),
        this.retryAfterHeaders(verdict.retryAfterMs, now, settings.retryAfter),
        true,
      );
    meter.charge(auth.user.sub, 1, now);
    entry.units = 1;

    prepared.fieldsMask = fieldsMask;
    prepared.run = async () => {
      try {
        return route.handler({
          store: this.calendar.storeFor(auth.user.sub),
          query: req.url.searchParams,
          params,
          headers: req.headers,
          json: () => parseJson(req.body),
        });
      } catch (error) {
        if (error instanceof ApiError) return errorReply(error);
        throw error;
      }
    };
    return prepared;
  }

  private prepareGmailRoute(req: ParsedRequest): Prepared {
    const match = matchRoute(req.method, req.url.pathname);
    if (!match) return this.prepareUnrouted(req, 'gmail');
    return this.prepareGmail(req, match, { bearer: req.headers.get('authorization') });
  }

  private newEntry(
    req: ParsedRequest,
    service: string,
    apiMethod: string,
    extra: Partial<RequestLogEntry> = {},
  ): RequestLogEntry {
    const entry: RequestLogEntry = {
      seq: ++this.seq,
      at: this.clock.now(),
      service,
      apiMethod,
      httpMethod: req.method,
      units: 0,
      status: 0,
      inFlight: 1,
      ...extra,
    };
    this.log.push(entry);
    return entry;
  }

  /** Asks the fault hook; returns true when the fault already settles the request (respond, drop). */
  private applyFault(
    prepared: Prepared,
    req: ParsedRequest,
    cost: number,
    account: string | undefined,
    meter: UnitMeter = this.unitMeter,
  ): boolean {
    const entry = prepared.entry;
    const decision = this.faults?.intercept(
      {
        service: entry.service,
        apiMethod: entry.apiMethod,
        httpMethod: req.method,
        path: req.url.pathname,
        cost,
        account,
        seq: entry.seq,
      } satisfies EmulatedRequest,
      entry.at,
    );
    if (!decision) return false;
    prepared.fault = decision;
    entry.fault = decision.kind;
    if (decision.kind === 'respond') {
      if (decision.charge && account && cost) {
        meter.charge(account, cost, entry.at);
        entry.units = cost;
      }
      return true;
    }
    return decision.kind === 'drop';
  }

  private prepareUnrouted(
    req: ParsedRequest,
    service: string,
    note?: string,
    extra: Partial<RequestLogEntry> = {},
  ): Prepared {
    const prepared: Prepared = { entry: this.newEntry(req, service, 'unrouted', extra) };
    if (this.applyFault(prepared, req, 0, undefined)) return prepared;
    prepared.immediate = errorReply(notFound(note ?? 'Requested entity was not found.'));
    return prepared;
  }

  /** Endpoints that are not metered: OAuth and userinfo. */
  private prepareSimple(
    req: ParsedRequest,
    service: string,
    apiMethod: string,
    make: () => Reply,
  ): Prepared {
    const check = this.oauth.checkBearer(req.headers.get('authorization'));
    const account = check.ok ? check.user.sub : undefined;
    const prepared: Prepared = { entry: this.newEntry(req, service, apiMethod, { account }) };
    if (this.applyFault(prepared, req, 0, account)) return prepared;
    prepared.run = async () => make();
    return prepared;
  }

  private inFlightCount(account: string): number {
    return this.inFlightBy.get(account) ?? 0;
  }

  /**
   * Holds one of the user's in-flight slots until the reply is sent. Every authenticated call takes
   * one, refusals included: a refused request still occupies a connection for its latency, so a
   * client that bursts on every refusal shows up in the log's `inFlight` and trips the cap.
   * Returns how many were in flight before this one.
   */
  private takeSlot(account: string, prepared: Prepared): number {
    const before = this.inFlightCount(account);
    this.inFlightBy.set(account, before + 1);
    prepared.release = () =>
      this.inFlightBy.set(account, Math.max(0, this.inFlightCount(account) - 1));
    return before;
  }

  private retryAfterHeaders(
    retryAfterMs: number,
    now: number,
    mode: RetryAfterMode = this.settings.retryAfter,
  ): Record<string, string> {
    switch (mode) {
      case 'seconds':
        return { 'retry-after': String(Math.max(1, Math.ceil(retryAfterMs / 1000))) };
      case 'httpDate':
        return {
          'retry-after': new Date(Math.ceil((now + retryAfterMs) / 1000) * 1000).toUTCString(),
        };
      default:
        return {};
    }
  }

  /**
   * The arrival checks for one Gmail call, in Google's order: credentials, userId, fields mask,
   * daily stop, scope, concurrency, send limit, quota.
   */
  private prepareGmail(
    req: ParsedRequest,
    match: RouteMatch,
    opts: { bearer: string | null; batch?: number; batchSize?: number; batchIndex?: number },
  ): Prepared {
    const { route, params } = match;
    const auth = this.oauth.checkBearer(opts.bearer);
    const account = auth.ok ? auth.user.sub : undefined;
    const cost = costOf(
      route.apiMethod,
      req.url.searchParams.get('format'),
      this.settings.grandfathered,
    );
    const isBatchPart = opts.batchSize !== undefined;
    const entry = this.newEntry(req, 'gmail', route.apiMethod, {
      account,
      ...(opts.batch !== undefined ? { batch: opts.batch } : {}),
    });
    const prepared: Prepared = { entry };
    // Batch parts ride on the batch's own slot.
    const inFlightBefore = account && !isBatchPart ? this.takeSlot(account, prepared) : 0;
    entry.inFlight = inFlightBefore + 1;
    if (this.applyFault(prepared, req, cost, account)) return prepared;

    const now = entry.at;
    const refuse = (
      error: ApiError,
      headers: Record<string, string> = {},
      chargeIfConfigured = false,
    ): Prepared => {
      prepared.immediate = errorReply(error, headers);
      if (chargeIfConfigured && this.settings.chargeRefused && account) {
        this.unitMeter.charge(account, cost, now, false);
        entry.units = cost;
      }
      return prepared;
    };

    if (!auth.ok)
      return refuse(authError(auth.reason === 'missing'), authChallenge(auth.reason === 'missing'));
    const user = auth.user;
    const limits = this.settings;

    // "me" or the signed-in address; any other mailbox needs domain-wide delegation, which no test user has.
    if (match.userId !== 'me' && match.userId.toLowerCase() !== user.email.toLowerCase())
      return refuse(delegationDenied(user.email));
    const fieldsMask = req.url.searchParams.get('fields') ?? undefined;
    const shape = responseShapeOf(route.apiMethod);
    const badField = fieldsMask && shape ? invalidFieldIn(fieldsMask, shape) : undefined;
    if (badField !== undefined) return refuse(invalidFieldError(badField));

    if (this.activeDaily(now)) return refuse(dailyLimitError(this.daily!.kind));
    if (!SCOPES_FOR[route.scope].some(scope => auth.scopes.includes(scope)))
      return refuse(
        insufficientScopeError(route.apiMethod),
        scopeChallenge(SCOPES_FOR[route.scope][0]),
      );

    if (!isBatchPart && inFlightBefore >= limits.concurrency)
      return refuse(concurrencyError(), {}, true);
    if (route.send && this.sendsToday(user.sub) >= limits.sendLimitPerDay) {
      const retryAt = nextPacificMidnight(now);
      return refuse(sendLimitError(retryAt), this.retryAfterHeaders(retryAt - now, now));
    }

    if (isBatchPart) {
      // A refusal curve that has nothing to do with the unit meter: big batches get throttled harder.
      const roll = new Random(mixSeed(this.seed, opts.batch!, opts.batchIndex!)).float();
      if (roll < batchRefusalProbability(opts.batchSize!))
        return refuse(batchRefusalError(), {}, true);
    }

    const verdict = this.unitMeter.check(user.sub, cost, now, limits.unitsPerMinute);
    if (!verdict.allowed)
      return refuse(
        throttleError(limits.throttleShape),
        this.retryAfterHeaders(verdict.retryAfterMs, now),
        true,
      );
    this.unitMeter.charge(user.sub, cost, now);
    entry.units = cost;

    prepared.fieldsMask = fieldsMask;
    prepared.run = async () => {
      try {
        const ctx: RouteContext = {
          mailbox: this.mailboxFor(user.sub),
          lag: this.lag,
          query: req.url.searchParams,
          params,
          body: req.body,
          now: this.clock.now(),
          json: () => parseJson(req.body),
        };
        const reply = route.handler(ctx);
        if (route.send && reply.status < 300)
          this.sends.set(user.sub, { day: pacificDay(now), count: this.sendsToday(user.sub) + 1 });
        return reply;
      } catch (error) {
        if (error instanceof ApiError) return errorReply(error);
        throw error;
      }
    };
    return prepared;
  }

  /** POST /batch/gmail/v1. Every part goes through the same checks as a call of its own. */
  private prepareBatch(req: ParsedRequest): Prepared {
    const bearer = req.headers.get('authorization');
    const auth = this.oauth.checkBearer(bearer);
    const account = auth.ok ? auth.user.sub : undefined;
    const entry = this.newEntry(req, 'gmail', 'gmail.batch', { account });
    const prepared: Prepared = { entry };
    const inFlightBefore = account ? this.takeSlot(account, prepared) : 0;
    entry.inFlight = inFlightBefore + 1;
    if (this.applyFault(prepared, req, 0, account)) return prepared;
    const refuse = (error: ApiError, headers: Record<string, string> = {}): Prepared => {
      prepared.immediate = errorReply(error, headers);
      return prepared;
    };

    if (!auth.ok)
      return refuse(authError(auth.reason === 'missing'), authChallenge(auth.reason === 'missing'));
    if (inFlightBefore >= this.settings.concurrency) return refuse(concurrencyError());
    const boundary = boundaryOf(req.headers.get('content-type'));
    if (!boundary)
      return refuse(
        badRequest(
          'Batch request needs a multipart/mixed Content-Type with a boundary',
          'badRequest',
        ),
      );
    let parts;
    try {
      parts = parseBatch(req.body.toString('utf8'), boundary);
    } catch (error) {
      return refuse(
        badRequest(`Malformed batch request: ${(error as Error).message}`, 'badRequest'),
      );
    }
    if (parts.length === 0) return refuse(badRequest('Batch request has no parts', 'badRequest'));
    if (parts.length > MAX_BATCH_PARTS)
      return refuse(
        badRequest(`Batch request cannot contain more than ${MAX_BATCH_PARTS} calls`, 'badRequest'),
      );

    const subs = parts.map((part, index) => {
      const url = new URL(part.target, GMAIL);
      const sub: ParsedRequest = {
        method: part.method,
        url,
        headers: part.headers,
        body: part.body,
      };
      const match = matchRoute(part.method, url.pathname);
      const prepare = match
        ? this.prepareGmail(sub, match, {
            bearer: part.headers.get('authorization') ?? bearer,
            batch: entry.seq,
            batchSize: parts.length,
            batchIndex: index,
          })
        : this.prepareUnrouted(sub, 'gmail', undefined, { batch: entry.seq });
      return { contentId: part.contentId, prepared: prepare };
    });

    prepared.run = async () => {
      const replies: { contentId: string; reply: Reply }[] = [];
      for (const sub of subs) {
        // A dropped connection takes the whole batch with it; other faults only apply to single calls.
        if (sub.prepared.fault?.kind === 'drop') throw new TypeError('fetch failed');
        replies.push({ contentId: sub.contentId, reply: await this.execute(sub.prepared) });
      }
      const built = buildBatchResponse(
        replies,
        `batch_${entry.seq.toString(36)}${this.seed.toString(36)}`,
      );
      return { status: 200, headers: { 'content-type': built.contentType }, text: built.body };
    };
    return prepared;
  }
}

/** Creates the Gmail, OAuth and userinfo emulator. See `GmailEmulatorOptions` and `GmailEmulator`. */
export function createGmailEmulator(options: GmailEmulatorOptions): GmailEmulator {
  return new GmailEmulatorImpl(options);
}
