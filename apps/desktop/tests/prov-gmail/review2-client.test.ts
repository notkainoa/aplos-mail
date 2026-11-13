/**
 * Second review of prov-gmail, client side: the pacer's budget wait inside the queue (3), no message content in the
 * logs on a malformed 2xx (4), the retry time in a throttle's text (5), send-limit variants (6), a thread open that
 * keeps its 120 units and flags unresolved bodies partial (7) and a server search capped at 10 hits that reports
 * what it could not fetch (9). Synthetic data only (example.test), fake clock, the emulator's fetch only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PausedError,
  ProviderError,
  type BoundGovernor,
  type Clock,
  type SyncLane,
} from '@aplos/engine/ports';
import { FakeClock } from '@aplos/emulators';
import { classifyGoogle, type GoogleFailure } from '../../src/host/providers/google/classify';
import { GmailClient, GmailPacer, parseAnswer } from '../../src/host/providers/google/client';
import { GMAIL_COSTS } from '../../src/host/providers/google/costs';
import { rig, type Rig } from './harness';

const SELF_FROM = 'Willa Pennick <willa.pennick@mail.example.test>';
const NOW = Date.UTC(2026, 9, 27, 16, 0, 0);
const MIDNIGHT = Date.UTC(2026, 9, 28, 7, 0, 0);
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
};

// ---- 3: the pacer ----

/** The engine's Clock around a FakeClock (the harness does the same). */
const asClock = (clock: FakeClock): Clock => ({
  now: () => clock.now(),
  sleep: (ms, signal) => clock.sleep(ms, signal),
  timer: () => ({ cancel() {} }),
});

const passThrough: BoundGovernor = {
  run: (req, fn) => fn({ signal: req.signal ?? new AbortController().signal }),
  observe() {},
  charge() {},
  batchSize: () => 10,
};

test('prov-gmail review2 D3 a background call waiting for budget does not hold up an interactive call that fits', async () => {
  // The scenario scaled down 10x: target 300 per 6 s window, 270 used, a 50-unit batch must wait, a 12-unit open fits.
  const clock = new FakeClock({ auto: false });
  const start = clock.now();
  const governor = new GmailPacer(300, 6_000).bind(passThrough, asClock(clock));
  const sentAt: Record<string, number> = {};
  const call = (name: string, lane: SyncLane, cost: number) =>
    governor.run({ budget: 'gmail', lane, kind: 'read', method: 'gmail.test', cost }, async () => {
      sentAt[name] = clock.now() - start;
    });
  await call('used', 'backfill', 270);
  const backfill = call('backfill', 'backfill', 50);
  await flush();
  assert.equal(sentAt.backfill, undefined, 'the batch waits for the window');
  const open = call('open', 'interactive', 12);
  await flush();
  assert.equal(sentAt.open, 0, 'the open goes out at once, while the batch is still waiting');
  assert.equal(sentAt.backfill, undefined);
  await clock.advance(6_000);
  await Promise.all([backfill, open]);
  assert.equal(sentAt.backfill, 6_000, 'the batch goes when the first 270 leave the window');
});

test('prov-gmail review2 D3 an interactive call that does not fit waits, and sync does not slip past it', async () => {
  const clock = new FakeClock({ auto: false });
  const start = clock.now();
  const governor = new GmailPacer(300, 6_000).bind(passThrough, asClock(clock));
  const sentAt: Record<string, number> = {};
  const call = (name: string, lane: SyncLane, cost: number) =>
    governor.run({ budget: 'gmail', lane, kind: 'read', method: 'gmail.test', cost }, async () => {
      sentAt[name] = clock.now() - start;
    });
  await call('used', 'backfill', 280);
  const open = call('open', 'interactive', 120);
  const small = call('small', 'backfill', 10);
  await flush();
  assert.equal(
    Object.keys(sentAt).length,
    1,
    'nothing fits yet, and the small call does not jump the open',
  );
  await clock.advance(6_000);
  await Promise.all([small, open]);
  assert.ok(sentAt.open <= sentAt.small, 'the open went first');
});

// ---- 4: no content in logs ----

const SNIPPET = 'SNIPPET-quarterly-numbers-for-the-board-meeting';
const MAIL_SENDING_BODY = '{"snippet":"Mail sending is down, Too many concurrent requests';
const truncated = `{"id":"18c0ffee","threadId":"18c0ffee","snippet":"${SNIPPET} and then the rest of`;

test('prov-gmail review2 D4 a truncated 200 body leaves no message text in anything logged or thrown', async () => {
  const r = await rig({
    adapter: { fetch: async () => new Response(truncated, { status: 200 }) },
  });
  const client = new GmailClient(
    {
      fetch: async () => new Response(truncated, { status: 200 }),
      costs: GMAIL_COSTS,
      userAgent: 'test',
      closed: new AbortController().signal,
    },
    r.ctx(),
  );
  const error = await client
    .call({
      method: 'gmail.messages.get',
      path: '/messages/18c0ffee',
      format: 'metadata',
      fields: 'id',
      lane: 'interactive',
    })
    .then(
      () => undefined,
      (e: unknown) => e,
    );
  assert.ok(error instanceof ProviderError);
  assert.equal(error.error.providerMessage, `unparseable response, ${truncated.length} bytes`);
  const seen = JSON.stringify([r.log.lines, r.governor.errors, error.error]);
  assert.ok(
    !seen.includes(SNIPPET) && !seen.includes('18c0ffee'.repeat(2)),
    'no body text anywhere',
  );
  assert.ok(r.log.lines.some(l => l.event === 'sync.gmail.request_refused'));
});

test('prov-gmail review2 D4 a 2xx body is never read for words; an error body keeps Google message', () => {
  const cases: { name: string; failure: Partial<GoogleFailure>; message?: string; cls: string }[] =
    [
      {
        name: 'a snippet that says "Mail sending" does not make a send limit',
        failure: {
          status: 200,
          body: `{"snippet":"Mail sending is down, Too many concurrent requests`,
        },
        message: `unparseable response, ${MAIL_SENDING_BODY.length} bytes`,
        cls: 'transient',
      },
      {
        name: 'non-JSON 502 page is reduced to its size',
        failure: { status: 502, body: '<html>Bad gateway</html>' },
        message: 'unparseable response, 24 bytes',
        cls: 'transient',
      },
      {
        name: 'Google error JSON keeps its message',
        failure: {
          status: 404,
          body: { error: { code: 404, message: 'Requested entity was not found.' } },
        },
        message: 'Requested entity was not found.',
        cls: 'permanent',
      },
      {
        name: 'no body, no message',
        failure: { network: 'reset' },
        message: undefined,
        cls: 'transient',
      },
    ];
  for (const { name, failure, message, cls } of cases) {
    const { error } = classifyGoogle({
      method: 'gmail.messages.get',
      kind: 'read',
      now: NOW,
      ...failure,
    });
    assert.equal(error.class, cls, name);
    assert.equal(error.providerMessage, message, name);
  }
});

// ---- 5 and 6: throttle retry text, send-limit variants ----

const google = (code: number, reason: string | undefined, message: string) => ({
  error: {
    code,
    message,
    ...(reason ? { errors: [{ message, domain: 'usageLimits', reason }] } : {}),
  },
});

interface Row {
  name: string;
  failure: Partial<GoogleFailure>;
  cls: string;
  retryAfterMs?: number;
  resumeAt?: number;
}

const ROWS: Row[] = [
  {
    name: 'throttle: the retry time in the text when there is no header',
    failure: {
      status: 403,
      body: google(
        403,
        'userRateLimitExceeded',
        'User-rate limit exceeded.  Retry after 2026-10-27T16:00:45.000Z',
      ),
    },
    cls: 'throttle',
    retryAfterMs: 45_000,
  },
  {
    name: 'throttle: the header wins over the text',
    failure: {
      status: 403,
      body: google(
        403,
        'userRateLimitExceeded',
        'User-rate limit exceeded.  Retry after 2026-10-27T16:00:45.000Z',
      ),
      headers: { 'Retry-After': '7' },
    },
    cls: 'throttle',
    retryAfterMs: 7_000,
  },
  {
    name: 'throttle: a retry time already past is zero',
    failure: {
      status: 429,
      body: google(
        429,
        'rateLimitExceeded',
        'Rate limit exceeded. Retry after 2026-10-27T15:00:00.000Z',
      ),
    },
    cls: 'throttle',
    retryAfterMs: 0,
  },
  {
    name: 'throttle: a retry time days away is capped at 25 hours',
    failure: {
      status: 429,
      body: google(
        429,
        'rateLimitExceeded',
        'Rate limit exceeded. Retry after 2026-12-31T00:00:00.000Z',
      ),
    },
    cls: 'throttle',
    retryAfterMs: 25 * 60 * 60 * 1000,
  },
  {
    name: 'throttle: a retry time without a zone is not trusted',
    failure: {
      status: 429,
      body: google(
        429,
        'rateLimitExceeded',
        'Rate limit exceeded. Retry after 2026-10-27T16:00:45',
      ),
    },
    cls: 'throttle',
  },
  {
    name: 'throttle: no hint at all gives no retryAfterMs',
    failure: { status: 429, body: google(429, 'rateLimitExceeded', 'Rate limit exceeded.') },
    cls: 'throttle',
  },
  {
    name: 'send limit: Daily user sending quota exceeded on a 429',
    failure: {
      method: 'gmail.messages.send',
      kind: 'send',
      status: 429,
      body: google(429, 'rateLimitExceeded', 'Daily user sending quota exceeded.'),
    },
    cls: 'send_limit',
    resumeAt: MIDNIGHT,
  },
  {
    name: 'send limit: User-rate limit exceeded (user sending) with a retry time',
    failure: {
      method: 'gmail.messages.send',
      kind: 'send',
      status: 403,
      body: google(
        403,
        'userRateLimitExceeded',
        'Exceeded user sending limits. Retry after 2026-10-28T01:00:00.000Z',
      ),
    },
    cls: 'send_limit',
    resumeAt: Date.UTC(2026, 9, 28, 1, 0, 0),
  },
  {
    name: 'send limit: a send refused with quotaExceeded and no other limit named',
    failure: {
      method: 'gmail.messages.send',
      kind: 'send',
      status: 403,
      body: google(403, 'quotaExceeded', 'Quota exceeded.'),
    },
    cls: 'send_limit',
  },
  {
    name: 'send limit: the sentence alone decides, whatever the kind',
    failure: {
      status: 429,
      body: google(429, 'rateLimitExceeded', 'Daily user sending quota exceeded.'),
    },
    cls: 'send_limit',
  },
  {
    name: 'a send hitting the per-minute limit is still a throttle',
    failure: {
      method: 'gmail.messages.send',
      kind: 'send',
      status: 429,
      body: google(
        429,
        'rateLimitExceeded',
        "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user'.",
      ),
    },
    cls: 'throttle',
  },
  {
    name: 'a send refused for too many concurrent requests is a throttle',
    failure: {
      method: 'gmail.messages.send',
      kind: 'send',
      status: 429,
      body: google(429, 'rateLimitExceeded', 'Too many concurrent requests for user.'),
    },
    cls: 'throttle',
  },
  {
    name: 'a send over the project daily limit is daily, not a send limit',
    failure: {
      method: 'gmail.messages.send',
      kind: 'send',
      status: 403,
      body: google(403, 'dailyLimitExceeded', 'Daily Limit Exceeded'),
    },
    cls: 'daily',
  },
];

test('prov-gmail review2 D5 D6 throttle retry text and send-limit variants', () => {
  for (const row of ROWS) {
    const failure: GoogleFailure = {
      method: 'gmail.messages.get',
      kind: 'read',
      now: NOW,
      ...row.failure,
    };
    const { error } = classifyGoogle(failure);
    assert.equal(error.class, row.cls, row.name);
    if (row.cls === 'throttle') assert.equal(error.retryAfterMs, row.retryAfterMs, row.name);
    if (row.resumeAt !== undefined) assert.equal(error.resumeAt, row.resumeAt, row.name);
  }
});

// ---- 7: thread open ----

function seedThread(r: Rig, count: number) {
  let threadId: string | undefined;
  for (let i = 0; i < count; i++) {
    const m = r.emu.mailbox.addMessage({
      from: SELF_FROM,
      to: [r.account.address],
      subject: 'Synthetic plans',
      text: `Plain part ${i}.`,
      html: `<p>Html part ${i}</p>`,
      htmlAsAttachment: true,
      labelIds: ['INBOX'],
      threadId,
      internalDate: r.clock.now() - (count - i) * 60_000,
    });
    threadId ??= m.threadId;
  }
  return threadId!;
}

/** Wraps the emulator's fetch so batch answers carry `status` inside a 200 envelope: the first part, or all of them. */
function failParts(emu: () => Rig['emu'], status: number, all = false) {
  const state = { on: true };
  const wrapped: typeof fetch = async (input, init) => {
    const response = await emu().fetch(input, init);
    if (!state.on || !String(input instanceof Request ? input.url : input).includes('/batch/'))
      return response;
    const text = await response.text();
    const broken = text.replace(
      all ? /HTTP\/1\.1 200 OK/g : /HTTP\/1\.1 200 OK/,
      `HTTP/1.1 ${status} Broken`,
    );
    return new Response(broken, { status: response.status, headers: response.headers });
  };
  return { fetch: wrapped, state };
}

test('prov-gmail review2 D7 a part that fails inside a 200 batch leaves its message partial, not blank', async () => {
  const r: Rig = await rig({ adapter: { fetch: failParts(() => r.emu, 500).fetch } });
  const threadId = seedThread(r, 3);
  const opened = await r.adapter.openThread({ remoteThreadId: threadId }, 'interactive', r.ctx());
  assert.equal(opened.messages.length, 3);
  const partial = opened.messages.filter(m => m.partial);
  assert.equal(partial.length, 1, 'exactly the message whose part failed');
  assert.equal(partial[0].body.html, undefined);
  for (const m of opened.messages.filter(m => !m.partial))
    assert.ok(m.body.html?.startsWith('<p>Html part'));
  assert.equal(opened.costUnits, 120 + 2 * 20, 'the 120 units of the thread are kept');
});

test('prov-gmail review2 D7 a pause during the body-part batch returns the fetched thread, every message partial', async () => {
  const r = await rig();
  const threadId = seedThread(r, 3);
  // The thread goes out; the next request (the part batch) is refused by the governor's pause.
  r.governor.pauseAfter = 1;
  const opened = await r.adapter.openThread({ remoteThreadId: threadId }, 'interactive', r.ctx());
  assert.equal(opened.messages.length, 3, 'the thread is not thrown away');
  assert.ok(opened.messages.every(m => m.partial));
  assert.equal(opened.costUnits, 120);
  assert.ok(opened.messages.every(m => m.subject === 'Synthetic plans'));
  // The pause itself is still the governor's: the next open throws before any request.
  const before = r.fetches.length;
  await assert.rejects(
    r.adapter.openThread({ remoteThreadId: threadId }, 'interactive', r.ctx()),
    PausedError,
  );
  assert.equal(r.fetches.length, before);
});

// ---- 9: search ----

const listParam = (r: Rig, name: string) =>
  r.fetches.find(f => f.path.endsWith('/messages') && f.method === 'GET')?.query.get(name);

test('prov-gmail review2 D9 a first search asks for 10 hits (about 210 units); a next page may ask for more', async () => {
  const r = await rig({ threads: 200 });
  const first = await r.adapter.search!({ text: 'subject:Notes', limit: 25 }, r.ctx());
  assert.equal(listParam(r, 'maxResults'), '10');
  assert.ok(first.remoteThreadIds.length > 0 && first.remoteThreadIds.length <= 10);
  assert.ok(first.costUnits <= 5 + 10 * 20, `${first.costUnits} units`);
  assert.ok(first.nextPageToken, 'the rest is one more Enter away');
  r.fetches.length = 0;
  await r.adapter.search!(
    { text: 'subject:Notes', limit: 25, pageToken: first.nextPageToken },
    r.ctx(),
  );
  assert.equal(listParam(r, 'maxResults'), '25');
  r.fetches.length = 0;
  await r.adapter.search!({ text: 'subject:Notes', limit: 4 }, r.ctx());
  assert.equal(listParam(r, 'maxResults'), '4', 'a smaller limit still wins');
});

test('prov-gmail review2 D9 a search with a hit that could not be fetched throws instead of hiding it', async () => {
  let r: Rig | undefined;
  const faults = failParts(() => r!.emu, 500);
  r = await rig({ threads: 200, adapter: { fetch: faults.fetch } });
  faults.state.on = false;
  const full = await r.adapter.search!({ text: 'subject:Notes', limit: 25 }, r.ctx());
  faults.state.on = true;
  r.log.lines.length = 0;
  assert.ok(full.remoteThreadIds.length > 1, 'the seed has several hits');
  await assert.rejects(
    r.adapter.search!({ text: 'subject:Notes', limit: 25 }, r.ctx()),
    (error: unknown) => error instanceof ProviderError && error.error.class === 'transient',
  );
  const refused = r.log.lines.filter(l => l.event === 'sync.gmail.request_refused');
  assert.equal(refused.length, 2, 'the part itself and the incomplete search');
  assert.match(JSON.stringify(refused.at(-1)), /searchIncomplete/);

  // Every part fails: the user is told instead of seeing "no results".
  const all = failParts(() => r!.emu, 500, true);
  r = await rig({ threads: 200, adapter: { fetch: all.fetch } });
  await assert.rejects(
    r.adapter.search!({ text: 'subject:Notes', limit: 25 }, r.ctx()),
    (error: unknown) => error instanceof ProviderError && error.error.class === 'transient',
  );
});

// ---- fix-search: a read answered 204 is the empty answer ----

test('fix-search a read answered 204 (a list whose fields mask leaves nothing) is the empty answer, not invalidResponse', async () => {
  const r = await rig({
    adapter: { fetch: async () => new Response(null, { status: 204 }) },
  });
  const client = new GmailClient(
    {
      fetch: async () => new Response(null, { status: 204 }),
      costs: GMAIL_COSTS,
      userAgent: 'test',
      closed: new AbortController().signal,
    },
    r.ctx(),
  );
  // What a `drafts.list` on an account with no drafts answers: parsed as JSON before, it came out `invalidResponse`
  // and the drafts sync retried forever.
  const page = await client.call<{ drafts?: unknown[] }>({
    method: 'gmail.drafts.list',
    path: '/drafts',
    fields: 'drafts(id),nextPageToken',
    lane: 'opFlush',
  });
  assert.deepEqual(page, {});
});

test('fix-search parseAnswer: 204 on a read is {}, on a write undefined; an empty or broken body otherwise throws', () => {
  assert.deepEqual(parseAnswer('', 204, 'read'), {});
  assert.equal(parseAnswer('', 200, 'write'), undefined);
  assert.throws(() => parseAnswer('', 200, 'read'));
  assert.throws(() => parseAnswer('not json', 200, 'read'));
});
