/**
 * prov-gmail end to end on the Gmail emulator: the real store (SQLite on a temp file, opened as the store's own tests
 * open it), the real governor and `ActorHost` from `packages/engine/src/sync`, the Gmail adapter, the emulator's OAuth
 * behind a test `TokenSource` (no vault) and one fake clock. Nothing is stubbed between the actor and the emulator, and
 * every count below is read from the emulator's own request log; the fetch spy only adds what the log leaves out on
 * purpose (ids and query strings).
 *
 * `connect` is still a `NotInThisLaneError` stub in the adapter (the OAuth host is not built yet), so the factory here
 * wraps `createGoogleProvider` and supplies a test connect: the emulator's consent with `login_hint`, the code exchange
 * on the `oauth` budget through the connect-mode governor, and the D25 `sub` check.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ProviderError,
  type AccountId,
  type Capabilities,
  type Clock,
  type ConnectContext,
  type ConnectRequest,
  type ConnectResult,
  type DeadlineRegistry,
  type DeadlineSource,
  type Logger,
  type PlanEnv,
  type ProviderFactory,
  type RequestIo,
  type TokenSource,
} from '@aplos/engine/ports';
import { openStore, type StorePort } from '@aplos/engine/store';
import { FakeClock, createGmailEmulator, type GmailEmulator, type RequestLogEntry } from '@aplos/emulators';
import { Governor } from '../../../packages/engine/src/sync/governor';
import { ActorHost } from '../../../packages/engine/src/sync/host';
import { opPayload } from '../../../packages/engine/src/sync/ops';
import { openSqlite } from '../src/host/sqlite';
import { GMAIL_BUDGET, createGoogleProvider } from '../src/host/providers/google/adapter';
import { googleError } from '../src/host/providers/google/classify';
import { CLIENT_ID, GMAIL_SCOPES } from './prov-gmail-harness.test';

const ACCOUNT = 'acct-gmail-e2e';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PRIMARY_TARGET = GMAIL_BUDGET.target.primary;
const SECONDARY_TARGET = GMAIL_BUDGET.target.secondary;
const OTHER_USER = { sub: '100000000000000000002', email: 'other.user@example.test', name: 'Other User' };

const GMAIL_CAPS: Capabilities = {
  labels: true,
  folders: false,
  drafts: true,
  serverSearch: true,
  calendar: false,
  filters: true,
  push: false,
  sendAs: true,
  unsubscribeHeaders: true,
  importance: true,
  threading: 'native',
};

// ---- the emulated world ----

interface Mail {
  clock: FakeClock;
  emu: GmailEmulator;
  address: string;
  subject: string;
  /** Focus, window and battery as every device's host sees them; tests change it between phases. */
  env: PlanEnv;
  /** The account the next consent picks on Google's chooser (`as`); undefined lets `login_hint` decide. */
  pick?: string;
}

function mailWorld(threads: number): Mail {
  const clock = new FakeClock({ auto: false });
  // retryAfter pinned to 'none' as in the legacy D1 gate: nothing may depend on a header Gmail may not send.
  const emu = createGmailEmulator({ clock, retryAfter: 'none' });
  emu.oauth.addClient(CLIENT_ID);
  emu.seedMailbox({ threads, seed: 23 });
  const user = emu.users()[0];
  return {
    clock,
    emu,
    address: user.email,
    subject: user.sub,
    env: { now: clock.now(), focused: false, windowVisible: true, onBattery: false },
  };
}

/** The F3 clock over the emulator kit's fake clock (which has no `timer`). */
function portClock(fake: FakeClock): Clock {
  return {
    now: () => fake.now(),
    sleep: (ms, signal) => fake.sleep(ms, signal),
    timer(at, fire) {
      const controller = new AbortController();
      fake.sleep(Math.max(0, at - fake.now()), controller.signal).then(fire, () => {});
      return { cancel: () => controller.abort() };
    },
  };
}

/** Records sources; the actors wait on the clock themselves, so nothing here needs to fire. */
class Deadlines implements DeadlineRegistry {
  readonly sources = new Map<string, DeadlineSource>();
  register(source: DeadlineSource) {
    this.sources.set(source.id, source);
    return () => {
      if (this.sources.get(source.id) === source) this.sources.delete(source.id);
    };
  }
  changed() {}
}

const quietLog: Logger = { event() {}, with: () => quietLog, enabled: () => false };

/**
 * The host's TokenSource, cut down to what the governor needs: one refresh token (the "keychain", which survives a
 * restart) and the access token it last got. Every token call goes out through the device's fetch, so it is in the log.
 */
class Vault implements TokenSource {
  refreshToken = '';
  access?: { token: string; expiresAt: number };
  constructor(
    private readonly send: typeof globalThis.fetch,
    private readonly clock: FakeClock,
  ) {}

  keep(refreshToken: string, accessToken: string, expiresInS: number): void {
    this.refreshToken = refreshToken;
    this.access = { token: accessToken, expiresAt: this.clock.now() + expiresInS * 1000 };
  }

  cached(): { token: string; expiresAt: number } | undefined {
    return this.access;
  }

  async refresh(_account: AccountId, io: RequestIo): Promise<{ token: string; expiresAt: number }> {
    const response = await this.send(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken, client_id: CLIENT_ID }).toString(),
      signal: io.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw googleError({ method: 'oauth.token', kind: 'idempotentWrite', now: this.clock.now(), status: response.status, body: text });
    }
    const json = JSON.parse(text) as { access_token: string; expires_in: number };
    this.access = { token: json.access_token, expiresAt: this.clock.now() + json.expires_in * 1000 };
    return this.access;
  }
}

interface Sent {
  at: number;
  url: URL;
  body?: string;
}

/**
 * One Mac: its database file, its keychain and its share of the emulator log. The emulator logs a request (and every
 * part of a batch) synchronously on arrival, so the entries appended during one `fetch` call are that device's.
 */
class Mac {
  readonly dir = mkdtempSync(join(tmpdir(), 'aplos-e2e-'));
  readonly path = join(this.dir, 'mail.db');
  readonly log: RequestLogEntry[] = [];
  readonly sent: Sent[] = [];
  readonly vault: Vault;
  readonly fetch: typeof fetch;

  constructor(
    readonly mail: Mail,
    readonly id: string,
  ) {
    const emu = mail.emu;
    this.fetch = (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      this.sent.push({ at: mail.clock.now(), url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      const before = emu.log.length;
      const answer = emu.fetch(input, init);
      this.log.push(...emu.log.slice(before));
      return answer;
    };
    this.vault = new Vault(this.fetch, mail.clock);
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** The test connect (the OAuth host is another package): consent, code exchange on `oauth`, the D25 `sub` check. */
async function connectGoogle(mac: Mac, req: ConnectRequest, ctx: ConnectContext): Promise<ConnectResult> {
  const { mail } = mac;
  const session = await ctx.governor.run(
    { budget: 'oauth', lane: 'interactive', kind: 'write', method: 'oauth.token', cost: 1, auth: false },
    () =>
      mail.emu.oauth.signIn({
        clientId: CLIENT_ID,
        scopes: GMAIL_SCOPES,
        prompt: 'select_account',
        fetch: mac.fetch,
        ...(req.loginHint ? { loginHint: req.loginHint } : {}),
        ...(mail.pick ? { as: mail.pick } : {}),
      }),
  );
  const claims = JSON.parse(Buffer.from(String(session.response.id_token).split('.')[1], 'base64url').toString('utf8')) as {
    sub: string;
    email: string;
  };
  // A different Google account is refused before anything is kept: the foreign grant is never stored.
  if (req.expectedSubject !== undefined && claims.sub !== req.expectedSubject) {
    throw new ProviderError({ class: 'auth', provider: 'oauth', method: 'oauth.token', reason: 'wrongAccount' });
  }
  const now = ctx.clock.now();
  mac.vault.keep(session.refreshToken!, session.accessToken, Number(session.response.expires_in));
  return {
    identity: { subject: claims.sub, address: claims.email },
    grantedScopes: session.scope.split(' '),
    capabilities: GMAIL_CAPS,
    grant: { grantedAt: now, refreshExpiresAt: now + Number(session.response.refresh_token_expires_in) * 1000, client: CLIENT_ID },
    credentialRef: `vault:${mac.id}`,
  };
}

/** One running engine on a Mac: store, governor and actor host. `kill` stops it without waiting and closes the file. */
interface Engine {
  store: StorePort;
  governor: Governor;
  host: ActorHost;
  kill(): Promise<void>;
}

let commitIds = 0;

async function boot(mac: Mac, lease?: 'primary' | 'secondary'): Promise<Engine> {
  const { clock } = mac.mail;
  const store = openStore(openSqlite(mac.path), { now: () => clock.now() });
  const governor = new Governor({ clock, tokens: mac.vault, random: () => 0, role: 'secondary' });
  const provider = createGoogleProvider({ fetch: mac.fetch, pace: false });
  const factory: ProviderFactory = {
    kind: 'google',
    connect: (req, ctx) => connectGoogle(mac, req, ctx),
    budgets: (account, memory) => provider.budgets(account, memory),
    open: account => provider.open(account),
  };
  const host = new ActorHost(
    {
      store,
      governor,
      providers: [factory],
      tokens: mac.vault,
      clock: portClock(clock),
      log: quietLog,
      deadlines: new Deadlines(),
      deviceId: mac.id,
      env: () => ({ ...mac.mail.env, now: clock.now() }),
    },
    { newId: () => `${mac.id}-commit-${++commitIds}`, random: () => 0 },
  );
  if (lease) host.leaseChanged(ACCOUNT, { role: lease, holder: lease === 'primary' ? mac.id : 'another-mac' });
  if (!store.read(q => q.get('SELECT 1 FROM accounts WHERE id = ?', ACCOUNT))) {
    // Account/connect, as the engine will run it: connect through the host, then the account row from the result.
    const result = await settle(clock, host.connect(ACCOUNT, 'google', { mode: 'new', loginHint: mac.mail.address }));
    store.commit({
      opId: `${mac.id}-connect`,
      origin: 'system',
      writes: [
        {
          kind: 'account',
          id: ACCOUNT,
          provider: 'google',
          address: result.identity.address,
          capabilities: { ...result.capabilities },
          grantedScopes: result.grantedScopes,
          status: { state: 'ok' },
          remoteSubject: result.identity.subject,
          tokenGrantedAt: result.grant!.grantedAt,
          refreshExpiresAt: result.grant!.refreshExpiresAt ?? null,
          oauthClient: result.grant!.client ?? null,
        },
      ],
    });
  }
  return {
    store,
    governor,
    host,
    async kill() {
      await host.dispose();
      store.close();
    },
  };
}

// ---- driving the clock ----

/** Moves the fake clock in small steps, letting every wake-up run, until `cond` holds. */
async function runUntil(clock: FakeClock, cond: () => boolean, what: string, limitMs = 2 * HOUR, stepMs = 250): Promise<void> {
  const end = clock.now() + limitMs;
  while (!cond()) {
    if (clock.now() >= end) throw new Error(`timed out after ${limitMs} ms of fake time waiting for ${what}`);
    await clock.advance(stepMs);
  }
}

/** Runs the clock until `promise` settles (each request waits the emulator's latency on the clock). */
async function settle<T>(clock: FakeClock, promise: Promise<T>): Promise<T> {
  let done = false;
  const tracked = promise.finally(() => {
    done = true;
  });
  tracked.catch(() => {});
  await runUntil(clock, () => done, 'a call to settle', HOUR, 50);
  return tracked;
}

// ---- reading the store and the log ----

const sql = <T extends Record<string, string | number | null>>(store: StorePort, query: string, ...params: (string | number)[]): T[] =>
  store.read(q => q.all<T>(query, ...params));

function accountRow(store: StorePort) {
  return store.read(q =>
    q.get<{
      status: string;
      status_reason_code: string | null;
      baseline_done_at: number | null;
      refresh_expires_at: number | null;
      remote_subject: string | null;
      token_granted_at: number | null;
    }>('SELECT * FROM accounts WHERE id = ?', ACCOUNT),
  )!;
}

function stateOf(store: StorePort, scope: string) {
  return store.read(q =>
    q.get<{ cursor: string | null; page_token: string | null; phase: string | null; pending: string | null; generation: number }>(
      'SELECT cursor, page_token, phase, pending, generation FROM sync_state WHERE account_id = ? AND scope = ?',
      ACCOUNT,
      scope,
    ),
  );
}

const threadCount = (store: StorePort) => sql<{ n: number }>(store, 'SELECT COUNT(*) AS n FROM threads WHERE account_id = ?', ACCOUNT)[0].n;
const messageIds = (store: StorePort) => new Set(sql<{ id: string }>(store, 'SELECT remote_id AS id FROM messages WHERE account_id = ?', ACCOUNT).map(r => r.id));
const threadIds = (store: StorePort) => new Set(sql<{ id: string }>(store, 'SELECT remote_id AS id FROM threads WHERE account_id = ?', ACCOUNT).map(r => r.id));

/** Threads with at least one message in the local Inbox. */
const localInbox = (store: StorePort) =>
  new Set(
    sql<{ id: string }>(
      store,
      `SELECT DISTINCT t.remote_id AS id FROM message_folders mf JOIN messages m ON m.id = mf.message_id
      JOIN threads t ON t.id = m.thread_id JOIN folders f ON f.id = mf.folder_id WHERE m.account_id = ? AND f.remote_id = 'INBOX'`,
      ACCOUNT,
    ).map(r => r.id),
  );
const serverInbox = (mail: Mail) => new Set(mail.emu.mailbox.selectThreads({ labelIds: ['INBOX'] }).map(t => t.id));

const windowDone = (store: StorePort) => stateOf(store, 'window:inbox')?.phase === 'done';
const statusOf = (engine: Engine) => engine.host.status(ACCOUNT)?.status;

/** Gmail calls only: no batch envelope, no OAuth. */
const gmailCalls = (log: readonly RequestLogEntry[], since = 0) => log.filter(e => e.service === 'gmail' && e.apiMethod !== 'gmail.batch' && e.at >= since);
const refusals = (log: readonly RequestLogEntry[]) => log.filter(e => e.status === 403 || e.status === 429);
const methodsOf = (log: readonly RequestLogEntry[]) => log.map(e => e.apiMethod.replace(/^gmail\.users\./, ''));

/** Highest units the emulator charged in any sliding 60 s window, recomputed from log entries. */
function peakWindow(log: readonly RequestLogEntry[]): number {
  const charged = log.filter(e => e.units > 0);
  let peak = 0;
  let start = 0;
  let sum = 0;
  for (const entry of charged) {
    sum += entry.units;
    while (charged[start].at <= entry.at - MINUTE) sum -= charged[start++].units;
    peak = Math.max(peak, sum);
  }
  return peak;
}

/** Metadata fetches the device sent (singles and batch parts): message ids, and `thread:<id>` for `threads.get`. */
function metadataFetches(sent: readonly Sent[], since = 0): string[] {
  const out: string[] = [];
  const add = (path: string, query: string) => {
    if (!/(^|&)format=metadata(&|$)/.test(query)) return;
    const m = /\/(messages|threads)\/([0-9a-f]+)$/.exec(path);
    if (m) out.push(m[1] === 'threads' ? `thread:${m[2]}` : m[2]);
  };
  for (const s of sent) {
    if (s.at < since) continue;
    add(s.url.pathname, s.url.searchParams.toString());
    if (s.body) for (const m of s.body.matchAll(/GET \/gmail\/v1\/users\/me(\/(?:messages|threads)\/[0-9a-f]+)\?(\S*) HTTP/g)) add(m[1], m[2]);
  }
  return out;
}

/** Enqueues an archive as `Thread/act` does: the local effect and the op row in one local commit. */
function queueArchive(store: StorePort, opId: string, remoteId: string): void {
  store.commit({
    opId: `local-${opId}`,
    origin: 'local',
    writes: [
      {
        kind: 'op',
        opId,
        accountId: ACCOUNT,
        opKind: 'archive',
        targets: [`${ACCOUNT}:${remoteId}`],
        payload: opPayload(remoteId, { kind: 'folders', add: [], remove: ['INBOX'] }),
        effect: [{ kind: 'placements', target: { remoteId }, add: [], remove: ['INBOX'] }],
        scope: 'mail.write',
      },
    ],
  });
}

const openOps = (store: StorePort) => sql<{ op_id: string; state: string }>(store, 'SELECT op_id, state FROM ops WHERE account_id = ? ORDER BY seq', ACCOUNT);

// ---- the scenarios ----

test('prov-gmail-T04/T05/T11/T34 prov-gov-T11 D1 inverted end to end: a 600-thread first window through the governor', async () => {
  const mail = mailWorld(600);
  const mac = new Mac(mail, 'mac-a');
  const engine = await boot(mac);
  try {
    const start = mail.clock.now();
    const since = mac.log.length;
    await engine.host.start(ACCOUNT);

    // AM-4: baseline_done_at is set by the commit that holds the first ~50 threads, well inside 15 s.
    await runUntil(mail.clock, () => accountRow(engine.store).baseline_done_at !== null, 'the baseline');
    const atBaseline = threadCount(engine.store);
    assert.ok(atBaseline >= 50 && atBaseline <= 100, `${atBaseline} threads when baseline_done_at was set`);
    assert.ok(accountRow(engine.store).baseline_done_at! - start < 15_000, 'first 50 threads in under 15 s');

    await runUntil(mail.clock, () => windowDone(engine.store), 'the first window');
    const window = mac.log.slice(since);
    assert.equal(refusals(window).length, 0, 'zero 403/429 in the whole first window');
    const peak = peakWindow(window);
    assert.ok(peak <= PRIMARY_TARGET, `peak ${peak} units in a 60 s window, target ${PRIMARY_TARGET}`);
    assert.deepEqual(localInbox(engine.store), serverInbox(mail), 'the local Inbox is the server Inbox');
    // Sent (P3) starts right after the window, so the account shows `backfilling` or `ok`, never a refusal.
    assert.ok(['ok', 'backfilling'].includes(statusOf(engine)!.state), statusOf(engine)!.state);

    // Every thread row is partial (metadata only) until it is opened.
    const complete = () => sql<{ n: number }>(engine.store, 'SELECT COUNT(*) AS n FROM threads WHERE account_id = ? AND complete = 1', ACCOUNT)[0].n;
    assert.equal(complete(), 0, 'no thread is complete before it is opened');

    // AM-1: a thread not known to have exactly one message opens with one threads.get full. Sent (P3) finishes
    // first, so the only other traffic is the history poll.
    await runUntil(mail.clock, () => stateOf(engine.store, 'sent:recent')?.phase === 'done', 'Sent to finish');
    assert.equal(refusals(mac.log).length, 0);
    assert.ok(peakWindow(mac.log) <= PRIMARY_TARGET);
    const pick = sql<{ id: string; count: number | null }>(
      engine.store,
      'SELECT remote_id AS id, remote_count AS count FROM threads WHERE account_id = ? AND (remote_count IS NULL OR remote_count > 1) LIMIT 1',
      ACCOUNT,
    )[0];
    const openAt = mail.clock.now();
    const logAt = mac.log.length;
    const sentAt = mac.sent.length;
    const opened = await settle(
      mail.clock,
      engine.host.openThread(ACCOUNT, pick.id, pick.count === null ? {} : { knownCount: pick.count }),
    );
    // History polls may run beside the open; everything else in the log is the open itself.
    const openCalls = gmailCalls(mac.log.slice(logAt), openAt).filter(e => e.apiMethod !== 'gmail.users.history.list');
    assert.deepEqual(methodsOf(openCalls), ['threads.get']);
    const openSent = mac.sent.slice(sentAt).filter(s => s.url.pathname.endsWith(`/threads/${pick.id}`));
    assert.equal(openSent.length, 1);
    assert.equal(openSent[0].url.searchParams.get('format'), 'full');
    assert.ok(opened.messages.length >= 1);
    assert.equal(complete(), 1, 'the opened thread is complete; every other one stays partial');
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

test('prov-gmail-T13 prov-gov-T21/T33/T41 kill mid-backfill and restart; then prov-gmail-T39 2,000 threads archived elsewhere', async t => {
  // 2,800 threads: about 2,070 in the Inbox, so the window stops at its 500-thread cap and backfill:inbox has work.
  const mail = mailWorld(2_800);
  const mac = new Mac(mail, 'mac-a');
  let engine = await boot(mac);
  try {
    await t.test('prov-gmail-T13 prov-gov-T21/T33 a kill mid-backfill resumes from the stored page; spend and cooldown survive', async () => {
      await engine.host.start(ACCOUNT);
      // Mid-backfill: at least one backfill page committed with entries still to fetch.
      await runUntil(
        mail.clock,
        () => {
          const s = stateOf(engine.store, 'backfill:inbox');
          return s?.phase === 'running' && s.pending !== null;
        },
        'a committed backfill:inbox page',
      );
      // A per-minute refusal right before the kill, so there is a cooldown to carry over.
      // (A long first sync may already have met one: batches grow past 10 parts after quiet minutes, and the
      // emulator refuses a part of a big batch now and then, as Gmail does.)
      const natural = refusals(mac.log).length;
      t.diagnostic(`refusals before the provoked one: ${natural}`);
      const provokedAt = mail.clock.now();
      mail.emu.settings.unitsPerMinute = 1;
      await runUntil(mail.clock, () => refusals(mac.log.filter(e => e.at >= provokedAt)).length > 0, 'a throttle refusal', 5 * MINUTE, 50);
      mail.emu.settings.unitsPerMinute = 6_000;
      const refusedAt = mail.clock.now();
      const before = engine.governor.snapshot(ACCOUNT).find(s => s.budget === 'gmail')!;
      assert.ok(before.cooldownUntil !== undefined && before.cooldownUntil > mail.clock.now(), 'the refusal started a cooldown');
      // Units the emulator charged in the minute before the kill: the restarted governor must not spend them again.
      const killAt = mail.clock.now();
      const chargedThisMinute = mac.log.filter(e => e.at > killAt - MINUTE).reduce((sum, e) => sum + e.units, 0);
      const stored = stateOf(engine.store, 'backfill:inbox')!;
      const committedMessages = messageIds(engine.store);
      const committedThreads = threadIds(engine.store);
      await engine.kill();

      engine = await boot(mac);
      const sentAt = mac.sent.length;
      const logAt = mac.log.length;
      await engine.host.start(ACCOUNT);
      // Restored before the first request: the cooldown exactly, and a spend that covers what the minute already used.
      const after = engine.governor.snapshot(ACCOUNT).find(s => s.budget === 'gmail')!;
      assert.equal(after.cooldownUntil, before.cooldownUntil);
      assert.equal(after.cooldownStep, before.cooldownStep);
      assert.equal(after.target, before.target);
      assert.ok(after.windowSpent >= chargedThisMinute, `restored spend ${after.windowSpent} >= ${chargedThisMinute} charged`);
      assert.equal(after.windowAt, before.windowAt);
      assert.equal(statusOf(engine)?.state, 'paused', 'the restarted account shows the pause');

      // Zero requests until the restored cooldown ends, then the backfill resumes where it stopped.
      await mail.clock.advanceTo(before.cooldownUntil! - 1);
      assert.equal(mac.log.length, logAt, 'nothing reaches Gmail (or the token endpoint) during the restored cooldown');
      await runUntil(mail.clock, () => stateOf(engine.store, 'backfill:inbox')?.phase === 'done', 'the backfill to finish', 2 * HOUR);
      const resumed = metadataFetches(mac.sent.slice(sentAt));
      const pending = JSON.parse(stored.pending!) as string[];
      // The stored page's pending entries are what the backfill fetched after the restart: none lost, none twice.
      const resumedSet = new Set(resumed);
      assert.deepEqual(pending.filter(entry => !resumedSet.has(entry)), [], 'every stored pending entry is fetched');
      // Only a part Gmail refused (a big batch's occasional 429) is fetched again, once, after the cooldown.
      const after429 = refusals(mac.log.slice(logAt));
      assert.ok(after429.every(e => e.batch !== undefined && e.reason === 'rateLimitExceeded'), 'only batch-part refusals');
      assert.ok(resumed.length - resumedSet.size <= after429.length, 'nothing answered is fetched twice after the restart');
      const lists = mac.sent.slice(sentAt).filter(s => s.url.pathname.endsWith('/messages') && s.url.searchParams.get('labelIds') === 'INBOX');
      // The next Inbox page listed is the stored one; the backfill never lists the Inbox from the top again.
      assert.ok(lists.length > 0);
      assert.equal(lists[0].url.searchParams.get('pageToken'), stored.page_token, 'the first Inbox list is the stored page');
      assert.ok(lists.every(list => list.url.searchParams.get('pageToken')), 'no Inbox list from the top');
      for (const entry of resumed) {
        const thread = entry.startsWith('thread:') ? entry.slice(7) : undefined;
        assert.ok(thread ? !committedThreads.has(thread) : !committedMessages.has(entry), `committed ${entry} fetched again`);
      }
      assert.deepEqual(localInbox(engine.store), serverInbox(mail), 'thread counts match the server');
      // The restart never re-spent the minute.
      t.diagnostic(`batch-part refusals after the restart: ${after429.length}`);
      assert.ok(peakWindow(mac.log.filter(e => e.at > refusedAt)) <= PRIMARY_TARGET);
    });

    await t.test('prov-gmail-T39 prov-gov-T59 2,000 threads archived elsewhere: the next pass costs under 2,500 units', async () => {
      await runUntil(
        mail.clock,
        () => stateOf(engine.store, 'sent:recent')?.phase === 'done' && stateOf(engine.store, 'backfill:inbox')?.phase === 'done',
        'Sent and backfill to finish',
      );
      // Let a poll pass so the next one is purely the archive.
      await mail.clock.advance(2 * MINUTE);
      const archived = mail.emu.mailbox.archiveThreads(2_000);
      assert.equal(archived.length, 2_000);
      const since = mail.clock.now();
      const logAt = mac.log.length;
      const cursor = () => stateOf(engine.store, 'history')?.cursor;
      const target = String(mail.emu.mailbox.history.currentId);
      await runUntil(mail.clock, () => cursor() === target, 'history to catch up', 10 * MINUTE);
      const pass = mac.log.slice(logAt);
      const units = pass.reduce((sum, e) => sum + e.units, 0);
      t.diagnostic(`2,000-thread archive: ${units} units over ${gmailCalls(pass, since).length} requests`);
      assert.ok(units < 2_500, `${units} units`);
      assert.equal(
        gmailCalls(pass).filter(e => /(messages|threads)\.get$/.test(e.apiMethod)).length,
        0,
        'label-only changes fetch nothing',
      );
      assert.deepEqual(localInbox(engine.store), serverInbox(mail), 'the local Inbox matches the emulator');
      assert.equal(refusals(pass).length, 0);
    });
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

test('prov-gmail-T23 prov-gov-T19/T29 quotaExceeded: one request, paused until Pacific midnight, manual sync refused, resumes after', async () => {
  const mail = mailWorld(120);
  const mac = new Mac(mail, 'mac-a');
  const engine = await boot(mac);
  try {
    await engine.host.start(ACCOUNT);
    await runUntil(mail.clock, () => stateOf(engine.store, 'sent:recent')?.phase === 'done', 'the first sync');
    mail.emu.setDailyLimit('quotaExceeded');
    const resetsAt = mail.emu.dailyLimit()!.resetsAt;
    // The fake clock starts 2026-10-27 09:00 PDT: the next Pacific midnight is 07:00 UTC on the 28th.
    assert.equal(resetsAt, Date.UTC(2026, 9, 28, 7, 0, 0));
    const logAt = mac.log.length;
    assert.equal(engine.host.request(ACCOUNT, { manual: true }).ok, true);
    await runUntil(mail.clock, () => statusOf(engine)?.state === 'paused', 'the daily stop');
    const stop = mac.log.slice(logAt);
    assert.deepEqual(methodsOf(stop), ['history.list'], 'exactly one request');
    assert.equal(stop[0].reason, 'quotaExceeded');
    assert.deepEqual(statusOf(engine), { state: 'paused', until: resetsAt, class: 'daily', reason: 'quotaExceeded' });
    assert.equal(accountRow(engine.store).status_reason_code, 'quota.daily');

    // Ten hours of manual syncs (plain and "Retry now") and wakes: every one refused with zero requests.
    for (let i = 0; i < 30; i++) {
      const plain = engine.host.request(ACCOUNT, { manual: true });
      const forced = engine.host.request(ACCOUNT, { manual: true, force: true });
      for (const admission of [plain, forced]) {
        assert.equal(admission.ok, false);
        if (!admission.ok) {
          assert.equal(admission.cls, 'daily');
          assert.equal(admission.until, resetsAt);
        }
      }
      engine.host.wake('wake');
      await mail.clock.advance(20 * MINUTE);
    }
    await mail.clock.advanceTo(resetsAt - 1_000);
    assert.equal(mac.log.length, logAt + 1, 'still the one request just before midnight');

    // After midnight Pacific the account resumes on its own.
    await runUntil(mail.clock, () => gmailCalls(mac.log, resetsAt).some(e => e.status > 0), 'the first answer after midnight', 10 * MINUTE);
    const first = gmailCalls(mac.log, resetsAt)[0];
    assert.ok(first.at >= resetsAt);
    assert.equal(first.status, 200);
    await runUntil(mail.clock, () => statusOf(engine)?.state === 'ok', 'status ok', 10 * MINUTE);
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

test('prov-gmail-T26/T62 prov-gov-T49/T53/T54 weekly reconnect: invalid_grant, queued archives, wrong account refused, flush with zero resync', async () => {
  const mail = mailWorld(200);
  mail.emu.addUser(OTHER_USER);
  const mac = new Mac(mail, 'mac-a');
  let engine = await boot(mac);
  try {
    const reconnectBy = accountRow(engine.store).refresh_expires_at!;
    assert.equal(reconnectBy, mail.clock.now() + 7 * DAY, 'Testing mode: the grant dies 7 days after consent');
    await engine.host.start(ACCOUNT);
    await runUntil(mail.clock, () => stateOf(engine.store, 'sent:recent')?.phase === 'done', 'the first sync');
    const baseline = accountRow(engine.store).baseline_done_at;

    // The Mac is shut for most of the week, then runs on battery with no window (5-minute polls, an hourly token
    // refresh) through the last hours of the grant, until the refresh is refused.
    // Mail keeps arriving meanwhile, so the history cursor moves on with each poll (a quiet mailbox is not this test).
    await engine.kill();
    for (let day = 1; day <= 6; day++) {
      await mail.clock.advanceTo(reconnectBy - 7 * DAY + day * DAY);
      mail.emu.mailbox.addMessage({
        from: 'Daily Digest <digest@mail.example.test>',
        to: [mail.address],
        subject: `Digest ${day}`,
        text: 'A synthetic digest.',
        labelIds: ['INBOX', 'UNREAD'],
      });
    }
    await mail.clock.advanceTo(reconnectBy - 3 * HOUR);
    engine = await boot(mac);
    mail.env = { ...mail.env, windowVisible: false, onBattery: true };
    await engine.host.start(ACCOUNT);
    await runUntil(mail.clock, () => statusOf(engine)?.state === 'needsReauth', 'needsReauth', 6 * HOUR, MINUTE);
    const dead = mac.log.filter(e => e.service === 'oauth' && e.status === 400);
    assert.equal(dead.length, 1, 'one refused refresh');
    assert.equal(dead[0].reason, 'invalid_grant');
    assert.ok(dead[0].at >= reconnectBy);
    assert.equal(mac.log.at(-1), dead[0], 'nothing after the refused refresh');
    assert.equal(accountRow(engine.store).status_reason_code, 'auth.testingModeExpiry');

    // Ten archives made while expired queue locally; 24 hours of manual syncs, wakes and op hints send nothing.
    const inbox = sql<{ id: string }>(
      engine.store,
      `SELECT m.remote_id AS id FROM message_folders mf JOIN messages m ON m.id = mf.message_id JOIN folders f ON f.id = mf.folder_id
      WHERE m.account_id = ? AND f.remote_id = 'INBOX' ORDER BY m.remote_id LIMIT 10`,
      ACCOUNT,
    ).map(r => r.id);
    assert.equal(inbox.length, 10);
    inbox.forEach((id, i) => queueArchive(engine.store, `archive-${i}`, id));
    const logAt = mac.log.length;
    for (let i = 0; i < 24; i++) {
      assert.equal(engine.host.request(ACCOUNT, { manual: true }).ok, false);
      engine.host.opsChanged(ACCOUNT);
      engine.host.wake('network');
      await mail.clock.advance(HOUR);
    }
    assert.equal(mac.log.length, logAt, 'zero Gmail and zero token-endpoint calls while expired');
    assert.equal(openOps(engine.store).length, 10, 'the archives wait, in order');
    const cursor = stateOf(engine.store, 'history')!.cursor;

    // D25: consent as another Google account is refused and changes nothing.
    const vaultBefore = mac.vault.refreshToken;
    mail.pick = OTHER_USER.email;
    await assert.rejects(
      settle(mail.clock, engine.host.connect(ACCOUNT, 'google', { mode: 'reconnect', loginHint: mail.address, expectedSubject: mail.subject })),
      (error: unknown) => error instanceof ProviderError && error.error.class === 'auth' && error.error.reason === 'wrongAccount',
    );
    mail.pick = undefined;
    assert.equal(mac.vault.refreshToken, vaultBefore, 'the foreign grant is not kept');
    assert.equal(accountRow(engine.store).remote_subject, mail.subject);
    assert.equal(accountRow(engine.store).refresh_expires_at, reconnectBy);
    assert.equal(statusOf(engine)?.state, 'needsReauth');
    await mail.clock.advance(MINUTE);
    assert.deepEqual(methodsOf(mac.log.slice(logAt)), ['oauth.token'], 'only the refused account\'s code exchange');
    assert.equal(openOps(engine.store).length, 10, 'no flush after a refused reconnect');

    // The same account through the consent screen with login_hint: reconnected() flushes and resumes, no resync.
    const exchangeAt = mac.log.length;
    const result = await settle(
      mail.clock,
      engine.host.connect(ACCOUNT, 'google', { mode: 'reconnect', loginHint: mail.address, expectedSubject: mail.subject }),
    );
    assert.equal(result.identity.subject, mail.subject);
    const resumeAt = mail.clock.now();
    await engine.host.reconnected(ACCOUNT, result);
    await runUntil(mail.clock, () => openOps(engine.store).length === 0 && stateOf(engine.store, 'history')?.cursor !== cursor, 'flush and a history pass', 10 * MINUTE, 50);
    await mail.clock.advance(2 * MINUTE);
    const after = mac.log.slice(exchangeAt);
    const calls = methodsOf(after.filter(e => e.apiMethod !== 'gmail.batch'));
    assert.equal(calls[0], 'oauth.token', 'the code exchange');
    assert.equal(calls[1], 'messages.batchModify', 'the queued archives go first, as one batchModify');
    assert.equal(calls.filter(c => c === 'messages.batchModify').length, 1);
    assert.equal(calls[2], 'history.list', 'then history from the stored cursor');
    for (const resync of ['messages.list', 'threads.list', 'threads.get', 'messages.get', 'getProfile']) {
      assert.ok(!calls.includes(resync), `no ${resync} after the reconnect: ${calls.join(' ')}`);
    }
    const batch = mac.sent.find(s => s.at >= resumeAt && s.url.pathname.endsWith('/messages/batchModify'))!;
    const body = JSON.parse(batch.body!) as { ids: string[]; removeLabelIds?: string[] };
    assert.deepEqual([...body.ids].sort(), [...inbox].sort());
    assert.deepEqual(body.removeLabelIds, ['INBOX']);
    for (const id of inbox) assert.ok(!mail.emu.mailbox.getMessage(id)!.labelIds.includes('INBOX'), `${id} archived at Gmail`);
    const row = accountRow(engine.store);
    assert.equal(row.baseline_done_at, baseline, 'baseline_done_at unchanged');
    assert.equal(row.remote_subject, mail.subject);
    assert.ok(row.refresh_expires_at! >= resumeAt + 7 * DAY - MINUTE, 'reconnectBy moves a week on');
    assert.equal(statusOf(engine)?.state, 'ok');
    assert.equal(refusals(after).length, 0);
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

test('prov-gov-T39 prov-gmail-T57 two devices on one account stay under 6,000 combined in every window', async t => {
  const mail = mailWorld(600);
  const macA = new Mac(mail, 'mac-a');
  const macB = new Mac(mail, 'mac-b');
  const a = await boot(macA, 'primary');
  const b = await boot(macB, 'secondary');
  try {
    const start = mail.clock.now();
    const emuAt = mail.emu.log.length;
    const [aAt, bAt] = [macA.log.length, macB.log.length];
    await a.host.start(ACCOUNT);
    await b.host.start(ACCOUNT);
    // The secondary opens what it has while the primary runs its first sync: interactive load on both at once.
    await runUntil(mail.clock, () => accountRow(b.store).baseline_done_at !== null, 'the secondary\'s baseline');
    const toOpen = [...threadIds(b.store)].slice(0, 40);
    const opens = Promise.all(toOpen.map(id => b.host.openThread(ACCOUNT, id)));
    await settle(mail.clock, opens);
    await runUntil(mail.clock, () => windowDone(a.store), 'the primary\'s first window');
    await runUntil(mail.clock, () => mail.clock.now() >= start + 30 * MINUTE, '30 minutes', HOUR, 1_000);

    const all = mail.emu.log.slice(emuAt);
    const logA = macA.log.slice(aAt);
    const logB = macB.log.slice(bAt);
    assert.equal(logA.length + logB.length, all.length, 'every request is attributed to one device');
    const combined = peakWindow(all);
    const peakA = peakWindow(logA);
    const peakB = peakWindow(logB);
    t.diagnostic(`peaks: combined ${combined}, primary ${peakA}, secondary ${peakB}`);
    assert.equal(refusals(all).length, 0, 'zero refusals');
    assert.ok(combined <= 6_000, `combined peak ${combined}`);
    assert.ok(peakA <= PRIMARY_TARGET, `primary peak ${peakA}`);
    assert.ok(peakB <= SECONDARY_TARGET, `secondary peak ${peakB}`);
    assert.ok(peakA > SECONDARY_TARGET, 'the primary really used its larger share');
    // The secondary drops backfill: it keeps its baseline and polls, and never runs the rest of the window.
    assert.notEqual(stateOf(b.store, 'window:inbox')?.phase, 'done');
    assert.equal(b.host.status(ACCOUNT)?.lease?.role, 'secondary');
  } finally {
    await a.kill();
    await b.kill();
    macA.cleanup();
    macB.cleanup();
  }
});
