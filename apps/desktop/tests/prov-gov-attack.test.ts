/**
 * prov-gov adversarial checks against the real stack: the store (SQLite on a temp file), the `Governor` and `ActorHost`
 * from `packages/engine/src/sync`, the Gmail adapter (`pace: false`, so the governor alone paces), the Gmail emulator
 * with the kit's fault injector, and one fake clock. Every count comes from the emulator's own request log. Each test
 * names the check it tries to break; a failing test here is a finding, not a flaky test.
 *
 * Wiring follows prov-gmail-e2e (the factory's `connect` is still a stub, so a test connect stands in for it).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NotSentError,
  PausedError,
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
import {
  FakeClock,
  SCOPE,
  createFaultInjector,
  createGmailEmulator,
  type FaultInjector,
  type GmailEmulator,
  type RequestLogEntry,
} from '@aplos/emulators';
import { Governor } from '../../../packages/engine/src/sync/governor';
import { ActorHost } from '../../../packages/engine/src/sync/host';
import { opPayload } from '../../../packages/engine/src/sync/ops';
import { openSqlite } from '../src/host/sqlite';
import { GMAIL_BUDGET, createGoogleProvider } from '../src/host/providers/google/adapter';
import { googleError } from '../src/host/providers/google/classify';

const ACCOUNT = 'acct-gov-attack';
const CLIENT_ID = 'prov-gov-attack.apps.example.test';
const GMAIL_SCOPES = ['openid', 'email', 'profile', SCOPE.gmailModify, SCOPE.gmailSettingsBasic];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

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
  faults: FaultInjector;
  address: string;
  subject: string;
  env: PlanEnv;
}

function mailWorld(threads: number, seed = 31): Mail {
  const clock = new FakeClock({ auto: false });
  const faults = createFaultInjector();
  const emu = createGmailEmulator({ clock, retryAfter: 'none', faults });
  emu.oauth.addClient(CLIENT_ID);
  emu.seedMailbox({ threads, seed });
  const user = emu.users()[0];
  return {
    clock,
    emu,
    faults,
    address: user.email,
    subject: user.sub,
    env: { now: clock.now(), focused: false, windowVisible: true, onBattery: false },
  };
}

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

/** The keychain: one refresh token and the last access token; every token call goes through the device's fetch. */
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
  cached() {
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
    if (!response.ok) throw googleError({ method: 'oauth.token', kind: 'idempotentWrite', now: this.clock.now(), status: response.status, body: text });
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

class Mac {
  readonly dir = mkdtempSync(join(tmpdir(), 'aplos-attack-'));
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
      }),
  );
  const claims = JSON.parse(Buffer.from(String(session.response.id_token).split('.')[1], 'base64url').toString('utf8')) as { sub: string; email: string };
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

interface CommitRecord {
  step?: string;
  changes?: string;
  origin: string;
  messages: { remoteId: string; internalDate: number }[];
}

interface Engine {
  store: StorePort;
  governor: Governor;
  host: ActorHost;
  commits: CommitRecord[];
  kill(): Promise<void>;
}

let commitIds = 0;

async function boot(mac: Mac, lease?: 'primary' | 'secondary'): Promise<Engine> {
  const { clock } = mac.mail;
  const raw = openStore(openSqlite(mac.path), { now: () => clock.now() });
  const commits: CommitRecord[] = [];
  // Records every commit's step and the message rows it writes (for the notification check), then commits it.
  const store: StorePort = Object.create(raw) as StorePort;
  store.commit = input => {
    const messages = input.writes
      .filter((w): w is Extract<typeof w, { kind: 'message' }> => w.kind === 'message')
      .map(w => ({ remoteId: w.remoteId, internalDate: w.internalDate }));
    commits.push({ step: input.step, changes: input.changes, origin: input.origin, messages });
    return raw.commit(input);
  };
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
  if (!raw.read(q => q.get('SELECT 1 FROM accounts WHERE id = ?', ACCOUNT))) {
    const result = await settle(clock, host.connect(ACCOUNT, 'google', { mode: 'new', loginHint: mac.mail.address }));
    raw.commit({
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
    store: raw,
    governor,
    host,
    commits,
    async kill() {
      await host.dispose();
      raw.close();
    },
  };
}

async function runUntil(clock: FakeClock, cond: () => boolean, what: string, limitMs = 2 * HOUR, stepMs = 250): Promise<void> {
  const end = clock.now() + limitMs;
  while (!cond()) {
    if (clock.now() >= end) throw new Error(`timed out after ${limitMs} ms of fake time waiting for ${what}`);
    await clock.advance(stepMs);
  }
}

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

const accountRow = (store: StorePort) =>
  store.read(q =>
    q.get<{ status: string; status_reason_code: string | null; baseline_done_at: number | null }>(
      'SELECT status, status_reason_code, baseline_done_at FROM accounts WHERE id = ?',
      ACCOUNT,
    ),
  )!;

const stateOf = (store: StorePort, scope: string) =>
  store.read(q =>
    q.get<{ cursor: string | null; page_token: string | null; phase: string | null; pending: string | null; generation: number }>(
      'SELECT cursor, page_token, phase, pending, generation FROM sync_state WHERE account_id = ? AND scope = ?',
      ACCOUNT,
      scope,
    ),
  );

const localInbox = (store: StorePort) =>
  new Set(
    sql<{ id: string }>(
      store,
      `SELECT DISTINCT t.remote_id AS id FROM message_folders mf JOIN messages m ON m.id = mf.message_id
      JOIN threads t ON t.id = m.thread_id JOIN folders f ON f.id = mf.folder_id WHERE m.account_id = ? AND f.remote_id = 'INBOX'`,
      ACCOUNT,
    ).map(r => r.id),
  );
const localInboxMessages = (store: StorePort) =>
  new Set(
    sql<{ id: string }>(
      store,
      `SELECT m.remote_id AS id FROM message_folders mf JOIN messages m ON m.id = mf.message_id
      JOIN folders f ON f.id = mf.folder_id WHERE m.account_id = ? AND f.remote_id = 'INBOX'`,
      ACCOUNT,
    ).map(r => r.id),
  );
const serverInbox = (mail: Mail) => new Set(mail.emu.mailbox.selectThreads({ labelIds: ['INBOX'] }).map(t => t.id));
const statusOf = (engine: Engine) => engine.host.status(ACCOUNT)?.status;
const gmailOnly = (log: readonly RequestLogEntry[]) => log.filter(e => e.service === 'gmail');
const refusals = (log: readonly RequestLogEntry[]) => log.filter(e => e.status === 403 || e.status === 429);
const methodsOf = (log: readonly RequestLogEntry[]) => log.map(e => e.apiMethod.replace(/^gmail\.users\./, ''));
const diff = <T>(a: Set<T>, b: Set<T>) => [...a].filter(x => !b.has(x));

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

const opRows = (store: StorePort) =>
  sql<{ op_id: string; state: string; last_error: string | null }>(store, 'SELECT op_id, state, last_error FROM ops WHERE account_id = ? ORDER BY seq', ACCOUNT);

/** Boots one Mac and runs its first sync (window and Sent) to the end. */
async function synced(threads: number, seed?: number) {
  const mail = mailWorld(threads, seed);
  const mac = new Mac(mail, 'mac-a');
  const engine = await boot(mac);
  await engine.host.start(ACCOUNT);
  await runUntil(
    mail.clock,
    () => stateOf(engine.store, 'window:inbox')?.phase === 'done' && stateOf(engine.store, 'sent:recent')?.phase === 'done',
    'the first sync',
  );
  return { mail, mac, engine };
}

// ---- the attacks ----

test('prov-gov-attack-01 op flush: a throttle on an archive requeues it and it reaches Gmail after the cooldown', async () => {
  const { mail, mac, engine } = await synced(120);
  try {
    const target = [...localInboxMessages(engine.store)].sort()[0];
    queueArchive(engine.store, 'archive-1', target);
    // One per-minute refusal on the flush's single `messages.modify`, exactly what Gmail answers under load.
    mail.faults.failNext({ apiMethod: 'gmail.users.messages.modify' }, { status: 429, reason: 'rateLimitExceeded', message: 'User-rate limit exceeded' });
    const logAt = mac.log.length;
    engine.host.opsChanged(ACCOUNT);
    await runUntil(mail.clock, () => refusals(mac.log.slice(logAt)).length > 0, 'the refused modify', 5 * MINUTE, 50);
    await mail.clock.advance(1_000);
    const afterRefusal = opRows(engine.store);
    // A throttle is the governor's pause, not the op's failure: the op waits, still replayed, and goes after the pause.
    await runUntil(mail.clock, () => !mail.emu.mailbox.getMessage(target)!.labelIds.includes('INBOX'), 'the archive at Gmail', 20 * MINUTE).catch(() => {});
    const atGmail = !mail.emu.mailbox.getMessage(target)!.labelIds.includes('INBOX');
    assert.ok(
      atGmail && afterRefusal.every(r => r.state === 'queued' || r.state === 'inflight' || r.state === 'synced'),
      `after one 429 the op row was ${JSON.stringify(afterRefusal)}; archive at Gmail 20 min later: ${atGmail}`,
    );
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

test('prov-gov-attack-02 fence: a local archive is not flipped back by a server search that raced its flush', async () => {
  const { mail, mac, engine } = await synced(150);
  try {
    // Search hits come back newest first; the newest Inbox thread's newest message is in the search's first batch.
    const newest = mail.emu.mailbox
      .select({ labelIds: ['INBOX'] })
      .map(m => mail.emu.mailbox.getMessage(m.id)!)
      .sort((a, b) => b.internalDate - a.internalDate)[0];
    assert.ok(localInboxMessages(engine.store).has(newest.id));
    // 1. The user archives it (local effect plus op, one local commit); the flush has not started yet.
    queueArchive(engine.store, 'archive-race', newest.id);
    assert.ok(!localInboxMessages(engine.store).has(newest.id), 'archived locally');
    // 2. The user presses Enter on a server search (25 hits: two or three metadata batches).
    const sentAt = mac.sent.length;
    const search = engine.host.search(ACCOUNT, { text: 'in:inbox', limit: 25 });
    search.catch(() => {});
    await runUntil(mail.clock, () => mac.sent.slice(sentAt).some(s => s.url.pathname === '/batch/gmail/v1'), 'the first search batch', MINUTE, 10);
    // 3. The op hint arrives while the first batch (which holds the message, still in INBOX at Gmail) is in flight.
    engine.host.opsChanged(ACCOUNT);
    await settle(mail.clock, search);
    await runUntil(mail.clock, () => opRows(engine.store).every(r => r.state === 'synced'), 'the flush', 5 * MINUTE, 50);
    await mail.clock.advance(1_000);
    const order = methodsOf(gmailOnly(mac.log).filter(e => e.at >= mail.clock.now() - 2 * MINUTE && e.batch === undefined));
    assert.ok(!mail.emu.mailbox.getMessage(newest.id)!.labelIds.includes('INBOX'), 'archived at Gmail');
    const flipped = localInboxMessages(engine.store).has(newest.id);
    // How long the user sees it back in the Inbox: until a later history pass reports the archive.
    const flippedAt = mail.clock.now();
    await runUntil(mail.clock, () => !localInboxMessages(engine.store).has(newest.id), 'the next history pass', 30 * MINUTE).catch(() => {});
    const healedAfter = mail.clock.now() - flippedAt;
    assert.ok(
      !flipped,
      `the archived message is back in the local Inbox after the search commit for ${Math.round(healedAfter / 1000)} s (calls: ${order.join(' ')})`,
    );
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

async function resyncLosses(splitRound: boolean): Promise<{ lost: string[]; fired: number }> {
  const { mail, mac, engine } = await synced(300);
  try {
    assert.deepEqual(localInbox(engine.store), serverInbox(mail), 'in step before the attack');
    for (let i = 0; i < 3; i++) {
      mail.emu.mailbox.addMessage({ from: 'News <news@mail.example.test>', subject: `While away ${i}`, text: 'Synthetic.', labelIds: ['INBOX', 'UNREAD'] });
    }
    mail.emu.mailbox.expireHistory();
    if (splitRound) {
      mail.faults.failNext({ apiMethod: 'gmail.users.messages.get', after: 1 }, { status: 429, reason: 'rateLimitExceeded', message: 'User-rate limit exceeded' });
    }
    const before = stateOf(engine.store, 'window:inbox')!.generation;
    await runUntil(
      mail.clock,
      () => {
        const w = stateOf(engine.store, 'window:inbox');
        return w !== undefined && w.generation !== before && w.phase === 'done';
      },
      'the resync round',
      30 * MINUTE,
    );
    await mail.clock.advance(2 * MINUTE);
    return { lost: diff(serverInbox(mail), localInbox(engine.store)), fired: mail.faults.fired.length };
  } finally {
    await engine.kill();
    mac.cleanup();
  }
}

test('prov-gov-attack-03a control: the same bounded resync in one step loses nothing', async () => {
  const { lost } = await resyncLosses(false);
  assert.deepEqual(lost, []);
});

test('prov-gov-attack-03 sweep: a bounded resync that spans two steps keeps every Inbox message it listed', async () => {
  const { mail, mac, engine } = await synced(300);
  try {
    assert.deepEqual(localInbox(engine.store), serverInbox(mail), 'in step before the attack');
    // A week away: three new Inbox threads arrive and the history cursor expires (404), so a bounded resync runs.
    for (let i = 0; i < 3; i++) {
      mail.emu.mailbox.addMessage({ from: 'News <news@mail.example.test>', subject: `While away ${i}`, text: 'Synthetic.', labelIds: ['INBOX', 'UNREAD'] });
    }
    mail.emu.mailbox.expireHistory();
    // One part of the resync's metadata batch is refused (after the round's one `format=minimal` get), as Gmail does
    // now and then: the round stops after its first step and finishes in a second one.
    mail.faults.failNext({ apiMethod: 'gmail.users.messages.get', after: 1 }, { status: 429, reason: 'rateLimitExceeded', message: 'User-rate limit exceeded' });
    const before = stateOf(engine.store, 'window:inbox')!.generation;
    await runUntil(
      mail.clock,
      () => {
        const w = stateOf(engine.store, 'window:inbox');
        return w !== undefined && w.generation !== before && w.phase === 'done';
      },
      'the resync round',
      30 * MINUTE,
    );
    await mail.clock.advance(2 * MINUTE);
    const fired = mail.faults.fired.length;
    const lost = diff(serverInbox(mail), localInbox(engine.store));
    assert.equal(fired, 1, 'the injected refusal fired');
    assert.deepEqual(lost, [], `${lost.length} Inbox threads Gmail still has were swept out of the local Inbox`);
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

test('prov-gov-attack-04 baseline: a cursor reset before the first 50 threads still sets baseline_done_at', async () => {
  const mail = mailWorld(200);
  const mac = new Mac(mail, 'mac-a');
  const engine = await boot(mac);
  try {
    // The first window's list fails twice with 503 (three governor tries each), so it backs off past the first poll.
    mail.faults.failNext({ apiMethod: 'gmail.users.messages.list' }, { status: 503, reason: 'backendError', message: 'Backend Error' }, { times: 6 });
    await engine.host.start(ACCOUNT);
    await runUntil(mail.clock, () => stateOf(engine.store, 'history')?.cursor != null, 'the cursor (P0)', 5 * MINUTE, 50);
    // Meanwhile a burst of 160 new Inbox messages lands (a list digest, an import on the web): more than one pass fetches.
    for (let i = 0; i < 160; i++) {
      mail.emu.mailbox.addMessage({ from: `Burst ${i} <burst${i}@mail.example.test>`, subject: `Burst ${i}`, text: 'Synthetic.', labelIds: ['INBOX', 'UNREAD'] });
    }
    await runUntil(mail.clock, () => accountRow(engine.store).baseline_done_at !== null, 'baseline_done_at', 30 * MINUTE).catch(() => {});
    const row = accountRow(engine.store);
    const window = stateOf(engine.store, 'window:inbox');
    assert.notEqual(
      row.baseline_done_at,
      null,
      `30 min after start: baseline_done_at null, status ${row.status}, window:inbox phase ${window?.phase}, sent:recent ${stateOf(engine.store, 'sent:recent') ? 'seeded' : 'never seeded'}, local threads ${localInbox(engine.store).size}`,
    );
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

// Known and accepted until `sync/lease.ts` lands (plan 20 PV3): with no lease input both Macs run as primary. ARCH 6.5
// calls the lease soft ("if two devices both act as primary, AIMD and cooldowns absorb it"), and a secondary default
// with no lease would leave every Mac without backfill and prefetch (primary-only lanes). Kept as a todo so it turns
// green, and is noticed, once the lease supplies the role.
test('prov-gov-attack-05 two devices with no lease input stay under the combined primary + secondary target', { todo: 'needs the primary-device lease (sync/lease.ts, PV3)' }, async t => {
  const mail = mailWorld(2_000);
  const macA = new Mac(mail, 'mac-a');
  const macB = new Mac(mail, 'mac-b');
  // No lease module yet: neither Mac is told its role, as on a real install today.
  const a = await boot(macA);
  const b = await boot(macB);
  try {
    const emuAt = mail.emu.log.length;
    await a.host.start(ACCOUNT);
    await b.host.start(ACCOUNT);
    // Both first syncs run side by side for 20 minutes (window, then backfill).
    const startedAt = mail.clock.now();
    await runUntil(mail.clock, () => mail.clock.now() >= startedAt + 20 * MINUTE, '20 minutes', HOUR, 1_000);
    const all = mail.emu.log.slice(emuAt);
    const roles = [a.host.status(ACCOUNT)?.lease?.role, b.host.status(ACCOUNT)?.lease?.role];
    const combined = peakWindow(all);
    t.diagnostic(`roles ${roles.join('/')}; combined peak ${combined}; refusals ${refusals(all).length}`);
    const cap = GMAIL_BUDGET.target.primary + GMAIL_BUDGET.target.secondary;
    assert.ok(roles.includes('secondary') && combined <= cap, `roles ${roles.join('/')} (no Mac runs as secondary), combined peak ${combined} vs ${cap}, refusals ${refusals(all).length}`);
  } finally {
    await a.kill();
    await b.kill();
    macA.cleanup();
    macB.cleanup();
  }
});

test('prov-gov-attack-06 401 storm: no loop, no token call while blocked (also across a restart), reconnect is not blocked by its own block, no resync', async () => {
  const { mail, mac, engine: first } = await synced(120);
  let engine = first;
  try {
    // Gmail refuses every call with 401 (the grant was revoked server side, the token endpoint still answers).
    mail.faults.failNext({ service: 'gmail' }, { status: 401, reason: 'authError', message: 'Invalid Credentials' }, { times: 100 });
    const logAt = mac.log.length;
    assert.equal(engine.host.request(ACCOUNT, { manual: true }).ok, true);
    await runUntil(mail.clock, () => statusOf(engine)?.state === 'needsReauth', 'needsReauth', 10 * MINUTE, 50);
    const storm = mac.log.slice(logAt);
    assert.deepEqual(methodsOf(storm), ['history.list', 'oauth.token', 'history.list'], 'one 401, one forced refresh, one re-send, then the block');

    // A day of manual syncs (plain and forced), wakes, op hints and interactive calls: nothing leaves.
    const blockedAt = mac.log.length;
    const someThread = [...localInbox(engine.store)][0];
    for (let i = 0; i < 24; i++) {
      assert.equal(engine.host.request(ACCOUNT, { manual: true }).ok, false);
      assert.equal(engine.host.request(ACCOUNT, { manual: true, force: true }).ok, false);
      engine.host.wake('network');
      engine.host.opsChanged(ACCOUNT);
      await assert.rejects(settle(mail.clock, engine.host.openThread(ACCOUNT, someThread)), PausedError);
      await assert.rejects(settle(mail.clock, engine.host.search(ACCOUNT, { text: 'hello', limit: 25 })), PausedError);
      await mail.clock.advance(HOUR);
    }
    assert.equal(mac.log.length, blockedAt, 'zero Gmail and zero token calls while auth-blocked');

    // Restart: the block survives and still nothing leaves (the access token is long expired by now).
    await engine.kill();
    engine = await boot(mac);
    await engine.host.start(ACCOUNT);
    await mail.clock.advance(2 * HOUR);
    assert.equal(mac.log.length, blockedAt, 'zero calls after a restart while auth-blocked');
    assert.equal(statusOf(engine)?.state, 'needsReauth');

    // Reconnect through the blocked account's own governor: the consent is not refused by the block.
    mail.faults.clear();
    const result = await settle(mail.clock, engine.host.connect(ACCOUNT, 'google', { mode: 'reconnect', loginHint: mail.address, expectedSubject: mail.subject }));
    const reconnectAt = mac.log.length;
    await engine.host.reconnected(ACCOUNT, result);
    await runUntil(mail.clock, () => statusOf(engine)?.state === 'ok', 'status ok', 10 * MINUTE, 50);
    await mail.clock.advance(3 * MINUTE);
    const after = methodsOf(mac.log.slice(reconnectAt).filter(e => e.apiMethod !== 'gmail.batch'));
    for (const resync of ['messages.list', 'threads.list', 'threads.get', 'messages.get', 'getProfile']) {
      assert.ok(!after.includes(resync), `no ${resync} after the reconnect: ${after.join(' ')}`);
    }
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

test('prov-gov-attack-07 quotaExceeded: interactive calls and a restart make zero requests until Pacific midnight', async () => {
  const { mail, mac, engine: first } = await synced(120);
  let engine = first;
  try {
    mail.emu.setDailyLimit('quotaExceeded');
    const resetsAt = mail.emu.dailyLimit()!.resetsAt;
    const logAt = mac.log.length;
    engine.host.request(ACCOUNT, { manual: true });
    await runUntil(mail.clock, () => statusOf(engine)?.state === 'paused', 'the daily stop', 10 * MINUTE, 50);
    assert.equal(mac.log.length, logAt + 1, 'one refused request');
    const stopAt = mac.log.length;
    const thread = [...localInbox(engine.store)][0];
    await assert.rejects(settle(mail.clock, engine.host.openThread(ACCOUNT, thread)), PausedError);
    await assert.rejects(settle(mail.clock, engine.host.search(ACCOUNT, { text: 'hello', limit: 25 })), PausedError);
    for (let i = 0; i < 10; i++) {
      engine.host.request(ACCOUNT, { manual: true, force: true });
      engine.host.wake('focus');
      await mail.clock.advance(10 * MINUTE);
    }
    // Restart mid-stop.
    await engine.kill();
    engine = await boot(mac);
    await engine.host.start(ACCOUNT);
    assert.equal(statusOf(engine)?.state, 'paused', 'the restarted account shows the daily stop');
    await mail.clock.advanceTo(resetsAt - 1_000);
    assert.equal(mac.log.length, stopAt, `zero requests until midnight; saw ${methodsOf(mac.log.slice(stopAt)).join(' ')}`);
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

test('prov-gov-attack-08 sends and writes are never re-sent: 503, lost reply, reset, concurrent 401s', async () => {
  const mail = mailWorld(5);
  const mac = new Mac(mail, 'mac-a');
  const engine = await boot(mac);
  try {
    const governor = engine.governor;
    governor.setBudgets(ACCOUNT, [GMAIL_BUDGET]);
    governor.setRole(ACCOUNT, 'primary');
    const raw = Buffer.from(`To: someone@example.test\r\nSubject: hi\r\n\r\nSynthetic.\r\n`).toString('base64url');
    const send = (kind: 'send' | 'write') =>
      governor.run(ACCOUNT, { budget: 'gmail', lane: 'interactive', kind, method: 'gmail.messages.send', cost: 100 }, async io => {
        const response = await mac.fetch(`${API}/messages/send`, {
          method: 'POST',
          headers: { authorization: `Bearer ${io.accessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ raw }),
          signal: io.signal,
        });
        const text = await response.text();
        if (!response.ok) throw googleError({ method: 'gmail.messages.send', kind, now: mail.clock.now(), status: response.status, body: text });
        return text;
      });
    const sends = () => mac.log.filter(e => e.apiMethod === 'gmail.users.messages.send').length;
    for (const kind of ['send', 'write'] as const) {
      for (const fault of ['503', 'dropAfter', 'drop'] as const) {
        const before = sends();
        if (fault === '503') mail.faults.failNext({ apiMethod: 'gmail.users.messages.send' }, { status: 503, reason: 'backendError' });
        if (fault === 'dropAfter') mail.faults.dropAfterNext({ apiMethod: 'gmail.users.messages.send' });
        if (fault === 'drop') mail.faults.dropNext({ apiMethod: 'gmail.users.messages.send' });
        await assert.rejects(settle(mail.clock, send(kind)));
        await mail.clock.advance(MINUTE);
        assert.equal(sends() - before, 1, `${kind} after ${fault} was sent ${sends() - before} times`);
      }
    }
    // A drop before any reply is proof it never left only for a NotSentError; anything after the bytes left is uncertain.
    mail.faults.dropAfterNext({ apiMethod: 'gmail.users.messages.send' });
    const lost = await settle(mail.clock, send('send')).catch((e: unknown) => e);
    assert.ok(!(lost instanceof NotSentError), 'a lost reply is never reported as not sent');
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

test('prov-gov-attack-09 in flight: "Retry now" after a concurrency 429 never puts a second request beside one still in flight', async () => {
  const mail = mailWorld(5);
  const mac = new Mac(mail, 'mac-a');
  const engine = await boot(mac);
  try {
    const governor = engine.governor;
    governor.setBudgets(ACCOUNT, [GMAIL_BUDGET]);
    governor.setRole(ACCOUNT, 'primary');
    mail.emu.settings.latencyMs = 5_000;
    const raw = Buffer.from(`To: someone@example.test\r\nSubject: big\r\n\r\nSynthetic.\r\n`).toString('base64url');
    // A send is in flight (a slow upload; a pause never aborts a send).
    const sending = governor.run(ACCOUNT, { budget: 'gmail', lane: 'interactive', kind: 'send', method: 'gmail.messages.send', cost: 100 }, async io => {
      const response = await mac.fetch(`${API}/messages/send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${io.accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ raw }),
        signal: io.signal,
      });
      return response.text();
    });
    sending.catch(() => {});
    await mail.clock.advance(500);
    assert.equal(mail.emu.inFlight(), 1);
    // A metadata batch that finished just before the send was admitted reports its part's concurrency 429 now
    // (`GmailClient.batch` observes refused parts after `run` resolves).
    governor.observe(ACCOUNT, 'gmail', {
      class: 'throttle',
      provider: 'gmail',
      method: 'gmail.messages.get',
      reason: 'rateLimitExceeded',
      status: 429,
      concurrency: true,
    });
    assert.equal(governor.inspect(ACCOUNT, 'gmail').inFlightLimit, 1);
    // The user presses "Retry now".
    assert.equal(governor.retryNow(ACCOUNT, 'gmail').ok, true);
    const read = governor.run(ACCOUNT, { budget: 'gmail', lane: 'interactive', kind: 'read', method: 'gmail.getProfile', cost: 1 }, async io => {
      const response = await mac.fetch(`${API}/profile?fields=historyId`, { headers: { authorization: `Bearer ${io.accessToken}` }, signal: io.signal });
      return response.text();
    });
    read.catch(() => {});
    await mail.clock.advance(100);
    const peak = Math.max(...gmailOnly(mac.log).filter(e => e.batch === undefined).map(e => e.inFlight));
    await settle(mail.clock, Promise.allSettled([sending, read]));
    assert.ok(peak <= 1, `${peak} Gmail requests in flight at once (inFlight limit 1)`);
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

// The backfill half holds. The other half depends on eng-time's notification rule: an old message moved back to the
// Inbox elsewhere is a real Inbox change and has to commit with the history page that reports it (`incremental`), and
// F3 has no per-message "new arrival" fact to tell it from new mail (port gap). Kept as a todo until eng-time's rule exists.
test('prov-gov-attack-10 notifications: backfill pages commit coarse and no incremental commit brings in old mail', { todo: 'depends on eng-time notification rule and a port fact for regained mail' }, async () => {
  const mail = mailWorld(800);
  const mac = new Mac(mail, 'mac-a');
  const engine = await boot(mac);
  try {
    const start = mail.clock.now();
    await engine.host.start(ACCOUNT);
    await runUntil(mail.clock, () => accountRow(engine.store).baseline_done_at !== null, 'baseline');
    // Mail keeps arriving during the window and backfill; and on the web the user moves one old archived message back to
    // the Inbox (it is not on this device).
    const archivedOld = mail.emu.mailbox
      .listMessages()
      .filter(m => !m.labelIds.includes('INBOX') && !m.labelIds.includes('DRAFT') && !m.labelIds.includes('SENT'))
      .sort((x, y) => x.internalDate - y.internalDate)[0];
    for (let i = 0; i < 5; i++) {
      mail.emu.mailbox.addMessage({ from: 'News <news@mail.example.test>', subject: `Live ${i}`, text: 'Synthetic.', labelIds: ['INBOX', 'UNREAD'] });
      await mail.clock.advance(MINUTE);
    }
    if (archivedOld) mail.emu.mailbox.modifyMessages([archivedOld.id], ['INBOX'], []);
    await runUntil(
      mail.clock,
      () => stateOf(engine.store, 'backfill:inbox')?.phase === 'done' && stateOf(engine.store, 'sent:recent')?.phase === 'done',
      'backfill and Sent',
    );
    await mail.clock.advance(3 * MINUTE);
    const syncCommits = engine.commits.filter(c => c.origin === 'sync');
    const backfill = syncCommits.filter(c => c.step === 'backfill');
    assert.ok(backfill.length > 0, 'there were backfill pages');
    assert.ok(backfill.every(c => c.changes === 'coarse'), 'every backfill page is one coarse change');
    const baseline = accountRow(engine.store).baseline_done_at!;
    // eng-time notifies for `incremental` commits after the baseline (F3 StepOrigin); any message older than the start
    // in such a commit would be announced as new mail.
    const oldInIncremental = syncCommits
      .filter(c => c.step === 'incremental')
      .flatMap(c => c.messages)
      .filter(m => m.internalDate < start);
    const noStep = syncCommits.filter(c => c.step === undefined && c.messages.length);
    assert.equal(baseline >= start, true);
    assert.deepEqual(
      oldInIncremental.map(m => m.remoteId),
      [],
      `incremental commits after the baseline carried ${oldInIncremental.length} messages older than the first sync (${noStep.length} step-less sync commits with messages)`,
    );
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});

test('prov-gov-attack-11 restart churn: killing the engine every 20 s through a heavy sync never re-spends the minute', async t => {
  const mail = mailWorld(1_500);
  const mac = new Mac(mail, 'mac-a');
  let engine = await boot(mac);
  try {
    const logAt = mac.log.length;
    await engine.host.start(ACCOUNT);
    await runUntil(mail.clock, () => accountRow(engine.store).baseline_done_at !== null, 'baseline');
    // Thirty restarts, 20 s apart, while the window and backfill run at full rate.
    for (let i = 0; i < 30; i++) {
      await mail.clock.advance(20_000);
      await engine.kill();
      engine = await boot(mac);
      await engine.host.start(ACCOUNT);
    }
    await mail.clock.advance(2 * MINUTE);
    const log = mac.log.slice(logAt);
    const peak = peakWindow(log);
    t.diagnostic(`peak ${peak}, refusals ${refusals(log).length}, requests ${log.length}`);
    assert.ok(peak <= GMAIL_BUDGET.target.primary, `peak ${peak} units in a 60 s window across restarts`);
    assert.equal(refusals(log).filter(e => e.batch === undefined).length, 0, 'no per-minute refusal of a whole request');
  } finally {
    await engine.kill();
    mac.cleanup();
  }
});
