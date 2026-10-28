/**
 * Seven-scenario smoke for the Gmail emulator and the scenario runner. Each story uses a tiny,
 * well-behaved reference client written below (one request in flight, a 3,000-unit sliding-window
 * pacer, metadata before bodies). It is not production code: it only shows that the emulator rewards
 * a client that behaves and punishes one that doesn't, in the shapes Google uses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Clock } from '../src/kit/clock';
import {
  assertScenariosPassed,
  defineScenario,
  maxInFlight,
  runScenarios,
  unitsNeverAbove,
  type Invariant,
  type Scenario,
  type ScenarioContext,
} from '../src/kit/scenario';
import type { RequestLogEntry } from '../src/kit/types';
import {
  createGmailEmulator,
  nextPacificMidnight,
  pacificDay,
  SCOPE,
  type GmailEmulator,
  type GmailEmulatorOptions,
} from '../src/gmail';

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CLIENT_ID = 'smoke-client.apps.example.test';
const SCOPES = ['openid', 'email', 'profile', SCOPE.gmailModify];
const DAY = 86400_000;

// ---------------------------------------------------------------------------------------------
// The reference client
// ---------------------------------------------------------------------------------------------

/** Unit prices the reference client budgets with (the new, non-grandfathered column). */
const UNITS = {
  profile: 1,
  threadsList: 10,
  threadsGetMetadata: 40,
  threadsGetFull: 120,
  history: 2,
  send: 100,
};

interface Session {
  accessToken: string;
  refreshToken?: string;
}

/**
 * One request at a time, never more than `budget` units in any 60 s, refreshes the access token on
 * 401. A refresh that answers `invalid_grant` marks the account as needing a reconnect.
 */
class PacedClient {
  needsReconnect = false;
  private sent: { at: number; units: number }[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly clock: Clock,
    private session: Session,
    private readonly budget = 3000,
  ) {}

  /** After a reconnect, the client carries on with the new grant. */
  useSession(session: Session): void {
    this.session = session;
    this.needsReconnect = false;
  }

  /** Serialised: each call starts only after the previous one has finished. */
  call(
    path: string,
    units: number,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Response> {
    const run = this.queue.then(() => this.send(path, units, init));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send(
    path: string,
    units: number,
    init: { method?: string; body?: unknown },
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      await this.waitForRoom(units);
      const response = await this.fetchFn(`${GMAIL}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${this.session.accessToken}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      if (response.status !== 401 || attempt > 0) return response;
      if (!(await this.refresh())) return response;
    }
  }

  /** Sliding window: wait until the oldest sends fall out and this one fits. */
  private async waitForRoom(units: number): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      this.sent = this.sent.filter(s => s.at > now - 60_000);
      const used = this.sent.reduce((sum, s) => sum + s.units, 0);
      if (used + units <= this.budget) {
        this.sent.push({ at: now, units });
        return;
      }
      await this.clock.sleep(this.sent[0].at + 60_000 - now);
    }
  }

  private async refresh(): Promise<boolean> {
    if (!this.session.refreshToken) return false;
    const response = await this.fetchFn(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.session.refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    const body = (await response.json()) as { access_token?: string; error?: string };
    if (response.ok && body.access_token) {
      this.session = { ...this.session, accessToken: body.access_token };
      return true;
    }
    if (body.error === 'invalid_grant') this.needsReconnect = true;
    return false;
  }

  /** Metadata first: list ids, then headers only. Returns how many threads came back with headers. */
  async syncMetadata(limit: number): Promise<{ threads: number; withHeaders: number }> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({
        maxResults: String(Math.min(500, limit - ids.length)),
        includeSpamTrash: 'true',
        ...(pageToken ? { pageToken } : {}),
      });
      const page = (await (await this.call(`/threads?${query}`, UNITS.threadsList)).json()) as {
        threads?: { id: string }[];
        nextPageToken?: string;
      };
      ids.push(...(page.threads ?? []).map(t => t.id));
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < limit);

    let withHeaders = 0;
    for (const id of ids.slice(0, limit)) {
      const response = await this.call(
        `/threads/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        UNITS.threadsGetMetadata,
      );
      assert.equal(response.status, 200, 'the paced client is never refused');
      const thread = (await response.json()) as {
        messages?: { payload?: { headers?: unknown[] } }[];
      };
      if (thread.messages?.every(m => (m.payload?.headers?.length ?? 0) > 0)) withHeaders++;
    }
    return { threads: ids.length, withHeaders };
  }
}

// ---------------------------------------------------------------------------------------------
// Scenario plumbing
// ---------------------------------------------------------------------------------------------

/** Builds the emulator on the scenario's clock, signs the default user in and hands the log to the runner. */
async function boot(
  ctx: ScenarioContext,
  options: Partial<GmailEmulatorOptions> = {},
  threads = 0,
): Promise<{ emu: GmailEmulator; client: PacedClient; session: Session }> {
  const emu = createGmailEmulator({ clock: ctx.clock, ...options });
  emu.oauth.addClient(CLIENT_ID);
  if (threads) emu.seedMailbox({ threads, seed: 41 });
  const signed = await emu.oauth.signIn({ clientId: CLIENT_ID, scopes: SCOPES, fetch: emu.fetch });
  const session = { accessToken: signed.accessToken, refreshToken: signed.refreshToken };
  const client = new PacedClient(emu.fetch, ctx.clock, session);
  ctx.subjects.emu = emu;
  ctx.subjects.client = client;
  ctx.requestLog = () => emu.log;
  return { emu, client, session };
}

const log = (ctx: ScenarioContext): readonly RequestLogEntry[] => ctx.requestLog();
const gmailCalls = (ctx: ScenarioContext) => log(ctx).filter(e => e.service === 'gmail');

/** No 60 s window ever charges more than `limit` units for one user. */
const quotaHeld = (limit: number): Invariant => ({
  name: `never above ${limit} units a minute`,
  check: ctx => unitsNeverAbove(ctx.requestLog(), limit),
});

/** The log holds routing facts only: no addresses, tokens or search text. */
const contentFree: Invariant = {
  name: 'request log is content-free',
  check(ctx) {
    const text = JSON.stringify(log(ctx));
    for (const needle of ['@', 'Bearer', 'ya29', '1//', 'example.test', 'metadataHeaders']) {
      assert.ok(!text.includes(needle), `log contains '${needle}'`);
    }
  },
};

async function errorOf(
  response: Response,
): Promise<{ status?: string; message: string; reason?: string; detailReason?: string }> {
  const body = (await response.json()) as {
    error: {
      status?: string;
      message: string;
      errors?: { reason: string }[];
      details?: { reason?: string }[];
    };
  };
  return {
    status: body.error.status,
    message: body.error.message,
    reason: body.error.errors?.[0]?.reason,
    detailReason: body.error.details?.[0]?.reason,
  };
}

/** A small synthetic self-addressed message for the send scenario. */
function selfMessage(to: string, n: number): string {
  return Buffer.from(
    [
      `To: ${to}`,
      `Subject: Smoke note ${n}`,
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      `Synthetic smoke message ${n}.`,
    ].join('\r\n'),
  ).toString('base64url');
}

// ---------------------------------------------------------------------------------------------
// The seven scenarios
// ---------------------------------------------------------------------------------------------

const pacedSync = defineScenario({
  name: '1 paced client syncs metadata for 500 threads with zero refusals',
  timeoutMs: 20 * 60_000,
  async setup(ctx) {
    await boot(ctx, {}, 500);
  },
  async run(ctx) {
    const result = await ctx.subject<PacedClient>('client').syncMetadata(500);
    ctx.subjects.result = result;
  },
  invariants: [
    quotaHeld(3000),
    { name: 'one request in flight', check: ctx => maxInFlight(ctx.requestLog(), 1) },
    {
      name: 'zero refusals',
      check: ctx => assert.deepEqual(gmailCalls(ctx).filter(e => e.status !== 200).length, 0),
    },
    {
      name: 'all 500 threads arrive with headers, metadata only',
      check(ctx) {
        assert.deepEqual(ctx.subject('result'), { threads: 500, withHeaders: 500 });
        const gets = gmailCalls(ctx).filter(e => e.apiMethod === 'gmail.users.threads.get');
        assert.equal(gets.length, 500);
        assert.ok(
          gets.every(e => e.units === UNITS.threadsGetMetadata),
          'no full fetch before the user opens a thread',
        );
      },
    },
    {
      name: 'the pacing spreads 20,000 units over about seven minutes',
      check(ctx) {
        const calls = gmailCalls(ctx);
        const minutes = (calls.at(-1)!.at - calls[0].at) / 60_000;
        assert.ok(minutes > 5 && minutes < 8, `took ${minutes.toFixed(2)} minutes`);
      },
    },
    contentFree,
  ],
});

const unpacedBurst = defineScenario({
  name: '2 an unpaced burst gets throttled with the configured shape',
  timeoutMs: 10 * 60_000,
  async setup(ctx) {
    const { emu, session } = await boot(
      ctx,
      { throttleShape: 'resourceExhausted429', retryAfter: 'seconds' },
      80,
    );
    ctx.subjects.ids = emu.mailbox.threadIds();
    ctx.subjects.session = session;
  },
  async run(ctx) {
    const emu = ctx.subject<GmailEmulator>('emu');
    const token = ctx.subject<Session>('session').accessToken;
    const get = (id: string) =>
      emu.fetch(`${GMAIL}/threads/${id}?format=full`, {
        headers: { authorization: `Bearer ${token}` },
      });
    const statuses: number[] = [];
    let firstRefusal: Response | undefined;
    for (const id of ctx.subject<string[]>('ids').slice(0, 60)) {
      const response = await get(id);
      statuses.push(response.status);
      if (response.status !== 200) firstRefusal ??= response;
      else await response.arrayBuffer();
    }
    // 6,000 / 120 = 50 full threads fit; every later one is refused.
    assert.equal(statuses.filter(s => s === 200).length, 50);
    assert.deepEqual(statuses.slice(50), Array(10).fill(429));
    const retryAfter = Number(firstRefusal!.headers.get('retry-after'));
    assert.ok(retryAfter > 0 && retryAfter <= 60, `Retry-After ${retryAfter}`);
    assert.deepEqual(await errorOf(firstRefusal!), {
      status: 'RESOURCE_EXHAUSTED',
      reason: 'rateLimitExceeded',
      detailReason: 'RATE_LIMIT_EXCEEDED',
      message:
        "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user' of service 'gmail.googleapis.com' for consumer 'project_number:000000000000'.",
    });
    // Honouring Retry-After is enough to get through again.
    await ctx.clock.sleep(retryAfter * 1000);
    assert.equal((await get(ctx.subject<string[]>('ids')[60])).status, 200);
  },
  invariants: [
    quotaHeld(6000),
    {
      name: 'refusals are free',
      check: ctx =>
        assert.ok(
          gmailCalls(ctx)
            .filter(e => e.status !== 200)
            .every(e => e.units === 0),
        ),
    },
    contentFree,
  ],
});

const concurrency = defineScenario({
  name: '3 twelve requests at once get the concurrency 429',
  timeoutMs: 60_000,
  async setup(ctx) {
    await boot(ctx, { concurrency: 10, latencyMs: 300 });
  },
  async run(ctx) {
    const emu = ctx.subject<GmailEmulator>('emu');
    const client = ctx.subject<PacedClient>('client');
    const token = (
      await emu.oauth.signIn({ clientId: CLIENT_ID, scopes: SCOPES, fetch: emu.fetch })
    ).accessToken;
    const responses = await Promise.all(
      Array.from({ length: 12 }, () =>
        emu.fetch(`${GMAIL}/profile`, { headers: { authorization: `Bearer ${token}` } }),
      ),
    );
    const statuses = responses.map(r => r.status).sort();
    assert.deepEqual(statuses, [...Array(10).fill(200), 429, 429]);
    const refusal = responses.find(r => r.status === 429)!;
    assert.deepEqual(await errorOf(refusal), {
      status: 'RESOURCE_EXHAUSTED',
      reason: 'rateLimitExceeded',
      detailReason: undefined,
      message: 'Too many concurrent requests for user.',
    });
    // One at a time always gets through.
    for (let i = 0; i < 12; i++)
      assert.equal((await client.call('/profile', UNITS.profile)).status, 200);
  },
  invariants: [
    quotaHeld(6000),
    {
      name: 'accepted requests never exceed the cap',
      check: ctx =>
        maxInFlight(
          gmailCalls(ctx).filter(e => e.status === 200),
          10,
        ),
    },
    {
      name: 'exactly two refused',
      check: ctx => assert.equal(gmailCalls(ctx).filter(e => e.status === 429).length, 2),
    },
    contentFree,
  ],
});

const dailyStop = defineScenario({
  name: '4 quotaExceeded daily stop holds until Pacific midnight',
  timeoutMs: 2 * DAY,
  async setup(ctx) {
    await boot(ctx);
  },
  async run(ctx) {
    const emu = ctx.subject<GmailEmulator>('emu');
    const client = ctx.subject<PacedClient>('client');
    emu.setDailyLimit('quotaExceeded');
    const resetsAt = emu.dailyLimit()!.resetsAt;
    assert.equal(resetsAt, nextPacificMidnight(ctx.clock.now()));
    assert.notEqual(pacificDay(resetsAt), pacificDay(ctx.clock.now()));
    assert.equal(
      pacificDay(resetsAt - 1),
      pacificDay(ctx.clock.now()),
      'resets exactly at the Pacific day boundary',
    );

    const first = await client.call('/profile', UNITS.profile);
    assert.equal(first.status, 403);
    assert.equal((await errorOf(first)).reason, 'quotaExceeded');
    ctx.subjects.resetsAt = resetsAt;

    // Still stopped a minute before midnight (the client refreshes its expired token on the way).
    await ctx.clock.sleep(resetsAt - 60_000 - ctx.clock.now());
    const late = await client.call('/profile', UNITS.profile);
    assert.equal(late.status, 403);
    assert.equal((await errorOf(late)).reason, 'quotaExceeded');

    await ctx.clock.sleep(resetsAt - ctx.clock.now());
    assert.equal((await client.call('/profile', UNITS.profile)).status, 200);
  },
  invariants: [
    quotaHeld(6000),
    {
      name: 'nothing succeeds before midnight, everything after',
      check(ctx) {
        const resetsAt = ctx.subject<number>('resetsAt');
        const profile = gmailCalls(ctx).filter(
          e => e.apiMethod === 'gmail.users.getProfile' && e.status !== 401,
        );
        assert.ok(
          profile
            .filter(e => e.at < resetsAt)
            .every(e => e.status === 403 && e.reason === 'quotaExceeded'),
        );
        assert.ok(profile.filter(e => e.at >= resetsAt).every(e => e.status === 200));
        assert.equal(profile.length, 3);
      },
    },
    contentFree,
  ],
});

const historyExpiry = defineScenario({
  name: '5 history answers 404 after the retention window',
  timeoutMs: 10 * DAY,
  async setup(ctx) {
    await boot(ctx, { testingMode: false }, 20);
  },
  async run(ctx) {
    const emu = ctx.subject<GmailEmulator>('emu');
    const client = ctx.subject<PacedClient>('client');
    const cursor = (
      (await (await client.call('/profile', UNITS.profile)).json()) as { historyId: string }
    ).historyId;
    assert.equal(
      (await client.call(`/history?startHistoryId=${cursor}`, UNITS.history)).status,
      200,
    );

    emu.mailbox.addMessage({
      from: 'colleague@example.test',
      subject: 'Synthetic change',
      text: 'A new synthetic message.',
      labelIds: ['INBOX', 'UNREAD'],
    });
    const fresh = await client.call(`/history?startHistoryId=${cursor}`, UNITS.history);
    assert.equal(fresh.status, 200);
    assert.ok(
      ((await fresh.json()) as { history?: unknown[] }).history?.length,
      'the change is in history while the cursor is fresh',
    );

    // Eight days later the cursor is past Google's retention window.
    await ctx.clock.sleep(8 * DAY);
    const stale = await client.call(`/history?startHistoryId=${cursor}`, UNITS.history);
    assert.equal(stale.status, 404);
    assert.equal((await errorOf(stale)).reason, 'notFound');

    // The fallback: take a fresh cursor and carry on from there.
    const next = (
      (await (await client.call('/profile', UNITS.profile)).json()) as { historyId: string }
    ).historyId;
    assert.equal((await client.call(`/history?startHistoryId=${next}`, UNITS.history)).status, 200);
  },
  invariants: [quotaHeld(3000), contentFree],
});

const reconnect = defineScenario({
  name: '6 invalid_grant seven days after consent in testing mode, then a login_hint reconnect',
  timeoutMs: 10 * DAY,
  async setup(ctx) {
    const { emu } = await boot(ctx, { testingMode: true });
    // A second account, so the hint (not the default choice) decides who signs back in.
    const second = emu.addUser({
      sub: '100000000000000000002',
      email: 'second.user@example.test',
      name: 'Second User',
    });
    const signed = await emu.oauth.signIn({
      clientId: CLIENT_ID,
      scopes: SCOPES,
      as: second.email,
      fetch: emu.fetch,
    });
    ctx.subjects.second = second.email;
    ctx.subjects.client = new PacedClient(emu.fetch, ctx.clock, {
      accessToken: signed.accessToken,
      refreshToken: signed.refreshToken,
    });
  },
  async run(ctx) {
    const emu = ctx.subject<GmailEmulator>('emu');
    const client = ctx.subject<PacedClient>('client');
    const second = ctx.subject<string>('second');
    const profile = async () => client.call('/profile', UNITS.profile);
    assert.equal(
      ((await (await profile()).json()) as { emailAddress: string }).emailAddress,
      second,
    );

    // Six days in, refresh still works.
    await ctx.clock.sleep(6 * DAY);
    assert.equal((await profile()).status, 200);
    assert.equal(client.needsReconnect, false);

    // Past seven days the refresh token is dead: 401, refresh, invalid_grant, reconnect needed.
    await ctx.clock.sleep(DAY + 60_000);
    assert.equal((await profile()).status, 401);
    assert.equal(client.needsReconnect, true);

    const again = await emu.oauth.signIn({
      clientId: CLIENT_ID,
      scopes: SCOPES,
      loginHint: second,
      fetch: emu.fetch,
    });
    client.useSession({ accessToken: again.accessToken, refreshToken: again.refreshToken });
    const restored = await profile();
    assert.equal(restored.status, 200);
    assert.equal(
      ((await restored.json()) as { emailAddress: string }).emailAddress,
      second,
      'login_hint brought the same account back',
    );
  },
  invariants: [
    quotaHeld(3000),
    {
      name: 'the dead refresh answered invalid_grant exactly once',
      check: ctx =>
        assert.equal(
          log(ctx).filter(e => e.apiMethod === 'oauth.token' && e.reason === 'invalid_grant')
            .length,
          1,
        ),
    },
    contentFree,
  ],
});

const sendLimit = defineScenario({
  name: '7 Mail sending 429 after the daily send limit',
  timeoutMs: 2 * DAY,
  async setup(ctx) {
    await boot(ctx, { sendLimitPerDay: 3 });
  },
  async run(ctx) {
    const emu = ctx.subject<GmailEmulator>('emu');
    const client = ctx.subject<PacedClient>('client');
    const self = emu.users()[0].email;
    const send = (n: number) =>
      client.call('/messages/send', UNITS.send, {
        method: 'POST',
        body: { raw: selfMessage(self, n) },
      });
    for (let n = 1; n <= 3; n++) assert.equal((await send(n)).status, 200);
    const refused = await send(4);
    assert.equal(refused.status, 429);
    const error = await errorOf(refused);
    assert.equal(error.reason, 'rateLimitExceeded');
    assert.match(error.message, /Mail sending/);
    assert.equal(emu.sendsToday(), 3);

    // The limit is per Pacific day.
    await ctx.clock.sleep(nextPacificMidnight(ctx.clock.now()) - ctx.clock.now());
    assert.equal((await send(5)).status, 200);
    assert.equal(emu.sendsToday(), 1);
  },
  invariants: [
    quotaHeld(3000),
    {
      name: 'refused sends are not delivered',
      check: ctx =>
        assert.equal(
          ctx
            .subject<GmailEmulator>('emu')
            .mailbox.listMessages()
            .filter(m => m.labelIds.includes('SENT')).length,
          4,
        ),
    },
    contentFree,
  ],
});

const SCENARIOS: Scenario[] = [
  pacedSync,
  unpacedBurst,
  concurrency,
  dailyStop,
  historyExpiry,
  reconnect,
  sendLimit,
];

test('smoke: seven Gmail emulator scenarios pass in under 60 s of real time', async () => {
  const started = Date.now();
  const results = await runScenarios(SCENARIOS, { realTimeBudgetMs: 30_000 });
  assertScenariosPassed(results);
  const realMs = Date.now() - started;
  assert.equal(results.length, 7);
  assert.ok(realMs < 60_000, `smoke took ${realMs} ms`);
  for (const r of results) {
    // Content-free summary: counts and times only.
    console.log(
      `smoke ${r.name.split(' ')[0]}: requests=${r.requestCount} unitsPeak=${r.unitsPeak} clockS=${Math.round(r.clockMs / 1000)} realMs=${r.realMs}`,
    );
  }
});
