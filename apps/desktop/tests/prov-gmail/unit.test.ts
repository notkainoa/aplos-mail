/**
 * prov-gmail pure parts: the cost table, the classifier on hand-written Google JSON, Retry-After, Pacific midnight,
 * facts parsing, the batch envelope, plan() and the not-in-this-lane stubs. No emulator, no clock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterAccount, PlanEnv, ProviderAdapter, SyncState } from '@aplos/engine/ports';
import { NotInThisLaneError, createGoogleProvider } from '../../src/host/providers/google/adapter';
import {
  classifyGoogle,
  nextPacificMidnight,
  parseRetryAfter,
  type GoogleFailure,
} from '../../src/host/providers/google/classify';
import {
  GMAIL_COSTS,
  GMAIL_COSTS_GRANDFATHERED,
  gmailCost,
} from '../../src/host/providers/google/costs';
import {
  decodeEntities,
  decodeWords,
  folderFacts,
  messageFacts,
  parseAddresses,
} from '../../src/host/providers/google/facts';
import { buildBatch, parseBatch, walkPayload } from '../../src/host/providers/google/mime';
import { plan } from '../../src/host/providers/google/sync';

// ---- T01 ----

test('prov-gmail-T01 one GMAIL_COSTS table prices every method; unknown methods throw', () => {
  const expected: [string, string | undefined, number][] = [
    ['gmail.getProfile', undefined, 1],
    ['gmail.labels.list', undefined, 1],
    ['gmail.history.list', undefined, 2],
    ['gmail.messages.list', undefined, 5],
    ['gmail.threads.list', undefined, 10],
    ['gmail.messages.get', 'metadata', 20],
    ['gmail.messages.get', 'minimal', 20],
    ['gmail.messages.get', 'full', 60],
    ['gmail.messages.get', 'raw', 60],
    ['gmail.messages.get', undefined, 60],
    ['gmail.threads.get', 'metadata', 40],
    ['gmail.threads.get', 'full', 120],
    ['gmail.messages.attachments.get', undefined, 20],
    ['gmail.threads.modify', undefined, 10],
    ['gmail.messages.modify', undefined, 5],
    ['gmail.messages.batchModify', undefined, 50],
    ['gmail.messages.insert', undefined, 25],
    ['gmail.messages.send', undefined, 100],
  ];
  for (const [method, format, units] of expected) {
    assert.equal(gmailCost(method, format as never), units, `${method} ${format ?? ''}`);
  }
  assert.throws(() => gmailCost('gmail.users.messages.get'), /No Gmail price/);
  assert.throws(() => gmailCost('gmail.nothing'), /No Gmail price/);
  // Grandfathered projects: cheaper reads, same table shape.
  assert.equal(gmailCost('gmail.messages.get', 'metadata', GMAIL_COSTS_GRANDFATHERED), 5);
  assert.equal(
    gmailCost('gmail.history.list', undefined, GMAIL_COSTS_GRANDFATHERED),
    GMAIL_COSTS['gmail.history.list'].base,
  );
});

// ---- T20 ----

const NOW = Date.UTC(2026, 9, 27, 16, 0, 0); // 09:00 PDT
const MIDNIGHT = Date.UTC(2026, 9, 28, 7, 0, 0);
const QUOTA_MINUTE =
  "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user' of service 'gmail.googleapis.com' for consumer 'project_number:000000000000'.";
const QUOTA_DAY =
  "Quota exceeded for quota metric 'Queries' and limit 'Queries per day' of service 'gmail.googleapis.com' for consumer 'project_number:000000000000'.";

const google = (
  code: number,
  reason: string | undefined,
  message: string,
  extra: Record<string, unknown> = {},
) => ({
  error: {
    code,
    message,
    ...(reason ? { errors: [{ message, domain: 'usageLimits', reason }] } : {}),
    ...extra,
  },
});

interface Case {
  name: string;
  failure: Partial<GoogleFailure>;
  cls: string;
  reason?: string;
  check?: (e: ReturnType<typeof classifyGoogle>) => void;
}

const CASES: Case[] = [
  {
    name: 'emulator rateLimitExceeded403',
    failure: {
      status: 403,
      body: google(403, 'rateLimitExceeded', QUOTA_MINUTE, { status: 'PERMISSION_DENIED' }),
    },
    cls: 'throttle',
    reason: 'rateLimitExceeded',
  },
  {
    name: 'emulator userRateLimitExceeded403',
    failure: {
      status: 403,
      body: google(403, 'userRateLimitExceeded', 'User-rate limit exceeded.'),
    },
    cls: 'throttle',
    reason: 'userRateLimitExceeded',
  },
  {
    name: 'emulator resourceExhausted429 (ErrorInfo RATE_LIMIT_EXCEEDED)',
    failure: {
      status: 429,
      body: google(429, 'rateLimitExceeded', QUOTA_MINUTE, {
        status: 'RESOURCE_EXHAUSTED',
        details: [
          { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT_EXCEEDED' },
        ],
      }),
    },
    cls: 'throttle',
  },
  {
    name: 'message-only rateLimitExceeded: no status name, no errors array',
    failure: {
      status: 403,
      body: {
        error: {
          code: 403,
          message: "Rate limit exceeded: the quota 'Queries per minute per user' has been used up.",
        },
      },
    },
    cls: 'throttle',
    reason: 'rateLimitExceeded',
  },
  {
    name: 'RESOURCE_EXHAUSTED status only',
    failure: {
      status: 429,
      body: {
        error: {
          code: 429,
          message: 'Resource has been exhausted (e.g. check quota).',
          status: 'RESOURCE_EXHAUSTED',
        },
      },
    },
    cls: 'throttle',
  },
  {
    name: 'concurrentLimitExceeded',
    failure: {
      status: 403,
      body: google(403, 'concurrentLimitExceeded', 'Concurrent limit exceeded.'),
    },
    cls: 'throttle',
    reason: 'concurrentLimitExceeded',
  },
  {
    name: 'emulator concurrency 429 sets concurrency',
    failure: {
      status: 429,
      body: google(429, 'rateLimitExceeded', 'Too many concurrent requests for user.', {
        status: 'RESOURCE_EXHAUSTED',
      }),
    },
    cls: 'throttle',
    check: c => assert.equal(c.error.concurrency, true),
  },
  {
    name: 'Retry-After seconds on a throttle',
    failure: {
      status: 429,
      body: google(429, 'rateLimitExceeded', QUOTA_MINUTE),
      headers: { 'Retry-After': '90' },
    },
    cls: 'throttle',
    check: c => assert.equal(c.error.retryAfterMs, 90_000),
  },
  {
    name: 'quotaExceeded is daily, account scope, resume at Pacific midnight',
    failure: { status: 403, body: google(403, 'quotaExceeded', QUOTA_DAY) },
    cls: 'daily',
    reason: 'quotaExceeded',
    check: c => {
      assert.equal(c.error.resumeAt, MIDNIGHT);
      assert.equal(c.scope, 'account');
    },
  },
  {
    name: 'dailyLimitExceeded is daily with project scope',
    failure: { status: 403, body: google(403, 'dailyLimitExceeded', 'Daily Limit Exceeded') },
    cls: 'daily',
    check: c => {
      assert.equal(c.scope, 'project');
      assert.equal(c.error.resumeAt, MIDNIGHT);
    },
  },
  {
    name: 'bandwidth cap is daily',
    failure: {
      status: 429,
      body: google(429, 'rateLimitExceeded', 'Bandwidth limit exceeded for user.'),
    },
    cls: 'daily',
  },
  {
    name: 'Mail sending is send_limit with the time from the text',
    failure: {
      method: 'gmail.messages.send',
      kind: 'send',
      status: 429,
      body: google(
        429,
        'rateLimitExceeded',
        'User-rate limit exceeded.  Retry after 2026-10-28T07:00:00.000Z (Mail sending)',
      ),
    },
    cls: 'send_limit',
    check: c => assert.equal(c.error.resumeAt, MIDNIGHT),
  },
  {
    name: 'token invalid_grant',
    failure: {
      method: 'oauth.token',
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
    },
    cls: 'auth',
    reason: 'invalid_grant',
  },
  {
    name: 'token admin_policy_enforced',
    failure: { method: 'oauth.token', status: 400, body: { error: 'admin_policy_enforced' } },
    cls: 'auth',
    reason: 'admin_policy_enforced',
  },
  {
    name: 'token 503 is transient',
    failure: { method: 'oauth.token', status: 503, body: 'Service Unavailable' },
    cls: 'transient',
  },
  {
    name: 'token network failure is transient',
    failure: { method: 'oauth.token', network: 'refused' },
    cls: 'transient',
  },
  {
    name: '401 authError',
    failure: { status: 401, body: google(401, 'authError', 'Invalid Credentials') },
    cls: 'auth',
    reason: 'authError',
  },
  {
    name: 'insufficientPermissions carries the missing scope',
    failure: {
      status: 403,
      body: google(
        403,
        'insufficientPermissions',
        'Request had insufficient authentication scopes.',
        { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] },
      ),
      headers: {
        'WWW-Authenticate':
          'Bearer realm="https://accounts.google.com/", error="insufficient_scope", scope="https://www.googleapis.com/auth/gmail.modify"',
      },
    },
    cls: 'permission',
    check: c =>
      assert.deepEqual(c.error.missingScopes, ['https://www.googleapis.com/auth/gmail.modify']),
  },
  {
    name: 'accessNotConfigured is config, project',
    failure: {
      status: 403,
      body: google(
        403,
        'accessNotConfigured',
        'Gmail API has not been used in project 0 before or it is disabled.',
      ),
    },
    cls: 'config',
    check: c => assert.equal(c.scope, 'project'),
  },
  {
    name: 'SERVICE_DISABLED ErrorInfo is config',
    failure: {
      status: 403,
      body: {
        error: {
          code: 403,
          message: 'disabled',
          status: 'PERMISSION_DENIED',
          details: [{ reason: 'SERVICE_DISABLED' }],
        },
      },
    },
    cls: 'config',
  },
  {
    name: '500 backendError is transient',
    failure: { status: 500, body: google(500, 'backendError', 'Backend Error') },
    cls: 'transient',
    reason: 'backendError',
  },
  { name: '503 without a body is transient', failure: { status: 503, body: '' }, cls: 'transient' },
  {
    name: 'a read timeout is transient, not uncertain',
    failure: { network: 'timeout' },
    cls: 'transient',
    check: c => assert.equal(c.error.uncertain, undefined),
  },
  {
    name: 'a send timeout is uncertain',
    failure: { method: 'gmail.messages.send', kind: 'send', network: 'timeout' },
    cls: 'transient',
    check: c => assert.equal(c.error.uncertain, true),
  },
  {
    name: 'one-item 404 is permanent with the item',
    failure: {
      status: 404,
      body: google(404, 'notFound', 'Requested entity was not found.'),
      item: '18c0ffee',
    },
    cls: 'permanent',
    check: c => assert.equal(c.error.item, '18c0ffee'),
  },
  {
    name: '400 invalidArgument is permanent',
    failure: { status: 400, body: google(400, 'invalidArgument', 'Invalid id value') },
    cls: 'permanent',
  },
  {
    name: 'a 400 whose text mentions a rate limit is still permanent',
    failure: {
      status: 400,
      body: google(
        400,
        'invalidArgument',
        'maxResults per day and rate limit settings are invalid',
      ),
    },
    cls: 'permanent',
  },
];

test('prov-gmail-T20 D6 the classifier maps every recorded Google error to its class', () => {
  for (const c of CASES) {
    const result = classifyGoogle({
      method: 'gmail.messages.get',
      kind: 'read',
      now: NOW,
      ...c.failure,
    });
    assert.equal(result.error.class, c.cls, c.name);
    if (c.reason) assert.equal(result.error.reason, c.reason, c.name);
    assert.ok((result.error.providerMessage ?? '').length <= 300);
    c.check?.(result);
  }
});

test('prov-gmail-T66 D6 a 1,000-character provider message is cut to 300', () => {
  const long = 'x'.repeat(1_000);
  const r = classifyGoogle({
    method: 'gmail.messages.get',
    kind: 'read',
    now: NOW,
    status: 400,
    body: google(400, 'invalidArgument', long),
  });
  assert.equal(r.error.providerMessage!.length, 300);
});

// ---- T21 ----

test('prov-gmail-T21 D6 Retry-After parses seconds and HTTP-date with no 30 s cap', () => {
  assert.equal(parseRetryAfter('120', NOW), 120_000);
  assert.equal(parseRetryAfter('3600', NOW), 3_600_000);
  assert.equal(parseRetryAfter(new Date(NOW + 90_000).toUTCString(), NOW), 90_000);
  assert.equal(parseRetryAfter(new Date(NOW - 90_000).toUTCString(), NOW), 0);
  assert.equal(parseRetryAfter('0', NOW), 0);
  for (const bad of ['soon', '-5', '1.5', 'NaN', '', undefined, null])
    assert.equal(parseRetryAfter(bad, NOW), undefined, String(bad));
  assert.equal(parseRetryAfter(String(2 ** 53), NOW), Number.MAX_SAFE_INTEGER);
});

// ---- T23 fixtures ----

test('prov-gmail-T23 D6 next Pacific midnight is found by zone, across both DST changes', () => {
  // 23:59 PDT on 2026-10-27 -> 00:00 PDT on the 28th.
  assert.equal(nextPacificMidnight(Date.UTC(2026, 9, 28, 6, 59)), Date.UTC(2026, 9, 28, 7));
  // Midnight itself moves to the next day.
  assert.equal(nextPacificMidnight(Date.UTC(2026, 9, 28, 7)), Date.UTC(2026, 9, 29, 7));
  // 2026-11-01 is 25 hours long: noon PST that day -> midnight PST (08:00 UTC) on the 2nd.
  assert.equal(nextPacificMidnight(Date.UTC(2026, 10, 1, 20)), Date.UTC(2026, 10, 2, 8));
  // The evening before it, still PDT: midnight is 07:00 UTC on the 1st.
  assert.equal(nextPacificMidnight(Date.UTC(2026, 10, 1, 5)), Date.UTC(2026, 10, 1, 7));
  // Spring forward, 2027-03-14 (23 hours): before and after.
  assert.equal(nextPacificMidnight(Date.UTC(2027, 2, 13, 20)), Date.UTC(2027, 2, 14, 8));
  assert.equal(nextPacificMidnight(Date.UTC(2027, 2, 14, 19)), Date.UTC(2027, 2, 15, 7));
  // Sub-second inputs do not leak into the answer.
  assert.equal(nextPacificMidnight(Date.UTC(2026, 9, 27, 16) + 999), MIDNIGHT);
});

// ---- facts ----

test('prov-gmail-T65 D22 snippet entities decode exactly once', () => {
  assert.equal(
    decodeEntities('It&#39;s &quot;fine&quot; &amp; &lt;ok&gt; &#x27;x&#x27;&nbsp;y'),
    "It's \"fine\" & <ok> 'x' y",
  );
  assert.equal(decodeEntities('&amp;#39;'), '&#39;');
  assert.equal(decodeEntities('<script>'), '<script>');
  assert.equal(decodeEntities('&bogus; &#0;'), '&bogus; &#0;');
});

test('prov-gmail facts: addresses, encoded words, labels as placements, UNREAD and STARRED as flags', () => {
  assert.deepEqual(
    parseAddresses(
      '"Ashgrove, Maren" <maren@mail.example.test>, kofi@mail.example.test, Odessa <o@x.example.test>',
    ),
    [
      { address: 'maren@mail.example.test', name: 'Ashgrove, Maren' },
      { address: 'kofi@mail.example.test' },
      { address: 'o@x.example.test', name: 'Odessa' },
    ],
  );
  assert.equal(decodeWords('=?UTF-8?B?Q2Fmw6k=?= =?ISO-8859-1?Q?_na=EFve?='), 'Café naïve');
  const facts = messageFacts(
    {
      id: '18a',
      threadId: '18a',
      labelIds: ['INBOX', 'UNREAD', 'STARRED', 'CATEGORY_UPDATES', 'IMPORTANT'],
      snippet: 'Hi &amp; bye',
      internalDate: '1761580800000',
      sizeEstimate: 1234,
      payload: {
        headers: [
          { name: 'From', value: 'Lanternworks <hello@lanternworks.example.test>' },
          { name: 'To', value: 'test.user@example.test' },
          { name: 'Subject', value: 'Your receipt' },
          { name: 'Date', value: 'Mon, 27 Oct 2025 16:00:00 +0000' },
          { name: 'Message-ID', value: '<abc@mail.example.test>' },
          { name: 'List-Unsubscribe', value: '<mailto:u@lanternworks.example.test>' },
          { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
          { name: 'Auto-Submitted', value: 'auto-generated' },
          { name: 'Precedence', value: 'bulk' },
        ],
      },
    },
    { self: 'test.user@example.test', partial: true },
  );
  assert.deepEqual(
    facts.placements.map(p => p.folder),
    ['INBOX', 'CATEGORY_UPDATES', 'IMPORTANT'],
  );
  assert.deepEqual(facts.flags, { seen: false, flagged: true, draft: false, fromMe: false });
  assert.equal(facts.snippet, 'Hi & bye');
  assert.equal(facts.internetId, 'abc@mail.example.test');
  assert.equal(facts.list.listUnsubscribePost, 'List-Unsubscribe=One-Click');
  assert.equal(facts.list.autoSubmitted, 'auto-generated');
  assert.equal(facts.partial, true);
  assert.equal(facts.date, Date.UTC(2025, 9, 27, 16));
  const folders = folderFacts([
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'UNREAD', name: 'UNREAD', type: 'system' },
    { id: 'CATEGORY_SOCIAL', name: 'CATEGORY_SOCIAL', type: 'system' },
    { id: 'Label_1', name: 'Projects', type: 'user', labelListVisibility: 'labelHide' },
  ]);
  assert.deepEqual(folders, [
    { remoteId: 'INBOX', name: 'INBOX', role: 'inbox', kind: 'system' },
    {
      remoteId: 'CATEGORY_SOCIAL',
      name: 'CATEGORY_SOCIAL',
      role: 'category.social',
      kind: 'system',
    },
    { remoteId: 'Label_1', name: 'Projects', kind: 'label', hidden: true },
  ]);
});

test('prov-gmail mime: the batch envelope round-trips and the payload walk finds body and attachments', () => {
  const body = buildBatch(
    [
      { target: '/gmail/v1/users/me/messages/a?format=metadata' },
      { target: '/gmail/v1/users/me/messages/b' },
    ],
    'B',
  );
  assert.match(
    body,
    /Content-ID: <item1>\r\n\r\nGET \/gmail\/v1\/users\/me\/messages\/b HTTP\/1.1/,
  );
  const reply = [
    '--R',
    'Content-Type: application/http',
    'Content-ID: <response-item1>',
    '',
    'HTTP/1.1 404 Not Found',
    'Content-Type: application/json',
    '',
    '{"error":{"code":404}}',
    '--R',
    'Content-Type: application/http',
    'Content-ID: <response-item0>',
    '',
    'HTTP/1.1 200 OK',
    'Content-Type: application/json',
    '',
    '{"id":"a"}',
    '--R--',
    '',
  ].join('\r\n');
  const parts = parseBatch('multipart/mixed; boundary=R', reply, 2);
  assert.equal(parts[0]!.status, 200);
  assert.deepEqual(JSON.parse(parts[0]!.body), { id: 'a' });
  assert.equal(parts[1]!.status, 404);

  const leaves = walkPayload({
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [
          { mimeType: 'text/plain', body: { data: 'aGk' } },
          { mimeType: 'text/html', body: { attachmentId: 'ANGjdJ_html' } },
        ],
      },
      {
        mimeType: 'image/png',
        filename: 'logo.png',
        headers: [{ name: 'Content-ID', value: '<logo@x>' }],
        body: { attachmentId: 'ANGjdJ_png', size: 3 },
      },
      {
        mimeType: 'text/plain',
        filename: 'notes.txt',
        headers: [{ name: 'Content-Disposition', value: 'attachment; filename=notes.txt' }],
        body: { attachmentId: 'ANGjdJ_txt' },
      },
    ],
  });
  assert.deepEqual(
    leaves.map(l => [l.kind, l.inline, l.cid ?? null]),
    [
      ['text', false, null],
      ['html', false, null],
      ['attachment', true, 'logo@x'],
      ['attachment', false, null],
    ],
  );
});

// ---- plan ----

const ENV: PlanEnv = { now: 1_000_000, focused: true, windowVisible: true, onBattery: false };
const ACCOUNT: AdapterAccount = {
  id: 'a',
  provider: 'google',
  address: 'test.user@example.test',
  grantedScopes: [],
  capabilities: {
    labels: true,
    folders: false,
    drafts: true,
    serverSearch: true,
    calendar: false,
    filters: true,
    push: false,
    sendAs: true,
    unsubscribeHeaders: true,
    threading: 'native',
  },
};
const st = (scope: SyncState['scope'], extra: Partial<SyncState> = {}): SyncState => ({
  scope,
  generation: 1,
  updatedAt: ENV.now,
  ...extra,
});
const planOf = (states: SyncState[], trigger: 'first' | 'poll' = 'poll', env = ENV) =>
  plan({ account: ACCOUNT, states, trigger, env, memory: new Map() });

test('prov-gmail plan(): cursor first, then the window, then Sent and backfill; cadence from the environment', () => {
  assert.deepEqual(planOf([], 'first'), [
    { scope: 'history', lane: 'incremental', origin: 'baseline', trigger: 'first' },
  ]);
  assert.equal(planOf([st('history', { phase: 'reset' })])[0].origin, 'resync');
  const fresh = planOf([st('history', { cursor: '100' })], 'first');
  assert.deepEqual(
    fresh.map(s => [s.scope, s.origin, s.lane]),
    [
      ['window:inbox', 'baseline', 'incremental'],
      ['history', 'incremental', 'incremental'],
    ],
  );
  assert.equal(fresh[1].notBefore, ENV.now, 'first and manual triggers poll at once');
  const more = planOf([
    st('history', { cursor: '100' }),
    st('window:inbox', { phase: 'more', pageToken: 't' }),
    st('sent:recent'),
  ]);
  assert.deepEqual(
    more.map(s => [s.scope, s.origin]),
    [
      ['window:inbox', 'backfill'],
      ['history', 'incremental'],
    ],
    'Sent waits for the window',
  );
  const done = planOf([
    st('history', { cursor: '100' }),
    st('window:inbox', { phase: 'done' }),
    st('sent:recent'),
    st('backfill:inbox', { pageToken: 't' }),
  ]);
  assert.deepEqual(
    done.map(s => s.scope),
    ['history', 'sent:recent', 'backfill:inbox'],
  );
  const resync = planOf([
    st('history', { cursor: '100' }),
    st('window:inbox', { phase: 'resync' }),
  ]);
  assert.deepEqual([resync[0].scope, resync[0].origin], ['window:inbox', 'resync']);
  // Cadence: 15 s focused, 60 s with no window, 5 min on battery with no window, each +-25%.
  for (const [env, nominal] of [
    [ENV, 15_000],
    [{ ...ENV, focused: false, windowVisible: false }, 60_000],
    [{ ...ENV, focused: false, windowVisible: false, onBattery: true }, 300_000],
  ] as const) {
    for (let i = 0; i < 50; i++) {
      const updatedAt = ENV.now + i * 7_919;
      const poll = planOf(
        [st('history', { cursor: '1', updatedAt }), st('window:inbox', { phase: 'done' })],
        'poll',
        { ...env, now: updatedAt },
      )[0];
      const wait = poll.notBefore! - updatedAt;
      assert.ok(wait >= nominal * 0.75 && wait <= nominal * 1.25, `${wait} vs ${nominal}`);
    }
  }
});

test('prov-gmail parts owned by other lanes are typed not-in-this-lane stubs', async () => {
  const factory = createGoogleProvider({ fetch: () => Promise.reject(new Error('no network')) });
  assert.equal(factory.kind, 'google');
  assert.equal(factory.budgets(ACCOUNT, new Map())[0].id, 'gmail');
  await assert.rejects(factory.connect({ mode: 'new' }, {} as never), NotInThisLaneError);
  const adapter: ProviderAdapter = factory.open(ACCOUNT);
  // send and findSent are built (prov-gmail-write, send.test.ts and send-contract.test.ts).
  assert.deepEqual(adapter.coalesce([]), [], 'ops are built (prov-gmail-ops.test.ts)');
  assert.throws(
    () =>
      adapter.syncStep(
        { scope: 'workflow', lane: 'enrichment', origin: 'workflow', trigger: 'poll' },
        st('workflow'),
        {} as never,
      ),
    NotInThisLaneError,
  );
  assert.equal(adapter.workflow, undefined);
  assert.ok(adapter.calendar, 'calendar is built (prov-cal; tests/prov-gmail/calendar.test.ts)');
  assert.ok(adapter.rules, "rules is prov-gmail-write's filter mirror, not a stub");
  assert.equal(typeof adapter.saveDraft, 'function', 'drafts are built (drafts.test.ts)');
  assert.equal(typeof adapter.deleteDraft, 'function');
});
