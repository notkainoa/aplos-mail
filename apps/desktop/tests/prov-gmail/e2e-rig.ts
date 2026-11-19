/** The prov-gmail end-to-end rig: the emulated world, the engine on a Mac, the clock driver and store/log readers (see e2e.test.ts). */
import { removeScratchDir, scratchDir } from './scratch';
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
import {
  FakeClock,
  createGmailEmulator,
  type GmailEmulator,
  type RequestLogEntry,
} from '@aplos/emulators';
import { Governor } from '../../../../packages/engine/src/sync/governor';
import { ActorHost } from '../../../../packages/engine/src/sync/host';
import { opPayload } from '../../../../packages/engine/src/sync/ops';
import { openSqlite } from '../../src/host/sqlite';
import { GMAIL_BUDGET, createGoogleProvider } from '../../src/host/providers/google/adapter';
import { googleError } from '../../src/host/providers/google/classify';
import { CLIENT_ID, GMAIL_SCOPES } from './harness';

export const ACCOUNT = 'acct-gmail-e2e';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const PRIMARY_TARGET = GMAIL_BUDGET.target.primary;
export const SECONDARY_TARGET = GMAIL_BUDGET.target.secondary;
export const OTHER_USER = {
  sub: '100000000000000000002',
  email: 'other.user@example.test',
  name: 'Other User',
};

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

export function mailWorld(threads: number): Mail {
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
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: CLIENT_ID,
      }).toString(),
      signal: io.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw googleError({
        method: 'oauth.token',
        kind: 'idempotentWrite',
        now: this.clock.now(),
        status: response.status,
        body: text,
      });
    }
    const json = JSON.parse(text) as { access_token: string; expires_in: number };
    this.access = {
      token: json.access_token,
      expiresAt: this.clock.now() + json.expires_in * 1000,
    };
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
export class Mac {
  readonly dir = scratchDir('aplos-e2e-');
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
      this.sent.push({
        at: mail.clock.now(),
        url,
        ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      });
      const before = emu.log.length;
      const answer = emu.fetch(input, init);
      this.log.push(...emu.log.slice(before));
      return answer;
    };
    this.vault = new Vault(this.fetch, mail.clock);
  }

  cleanup(): void {
    removeScratchDir(this.dir);
  }
}

/** The test connect (the OAuth host is another package): consent, code exchange on `oauth`, the D25 `sub` check. */
async function connectGoogle(
  mac: Mac,
  req: ConnectRequest,
  ctx: ConnectContext,
): Promise<ConnectResult> {
  const { mail } = mac;
  const session = await ctx.governor.run(
    {
      budget: 'oauth',
      lane: 'interactive',
      kind: 'write',
      method: 'oauth.token',
      cost: 1,
      auth: false,
    },
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
  const claims = JSON.parse(
    Buffer.from(String(session.response.id_token).split('.')[1], 'base64url').toString('utf8'),
  ) as {
    sub: string;
    email: string;
  };
  // A different Google account is refused before anything is kept: the foreign grant is never stored.
  if (req.expectedSubject !== undefined && claims.sub !== req.expectedSubject) {
    throw new ProviderError({
      class: 'auth',
      provider: 'oauth',
      method: 'oauth.token',
      reason: 'wrongAccount',
    });
  }
  const now = ctx.clock.now();
  mac.vault.keep(session.refreshToken!, session.accessToken, Number(session.response.expires_in));
  return {
    identity: { subject: claims.sub, address: claims.email },
    grantedScopes: session.scope.split(' '),
    capabilities: GMAIL_CAPS,
    grant: {
      grantedAt: now,
      refreshExpiresAt: now + Number(session.response.refresh_token_expires_in) * 1000,
      client: CLIENT_ID,
    },
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

export async function boot(mac: Mac, lease?: 'primary' | 'secondary'): Promise<Engine> {
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
  if (lease)
    host.leaseChanged(ACCOUNT, {
      role: lease,
      holder: lease === 'primary' ? mac.id : 'another-mac',
    });
  if (!store.read(q => q.get('SELECT 1 FROM accounts WHERE id = ?', ACCOUNT))) {
    // Account/connect, as the engine will run it: connect through the host, then the account row from the result.
    const result = await settle(
      clock,
      host.connect(ACCOUNT, 'google', { mode: 'new', loginHint: mac.mail.address }),
    );
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
export async function runUntil(
  clock: FakeClock,
  cond: () => boolean,
  what: string,
  limitMs = 2 * HOUR,
  stepMs = 250,
): Promise<void> {
  const end = clock.now() + limitMs;
  while (!cond()) {
    if (clock.now() >= end)
      throw new Error(`timed out after ${limitMs} ms of fake time waiting for ${what}`);
    await clock.advance(stepMs);
  }
}

/** Runs the clock until `promise` settles (each request waits the emulator's latency on the clock). */
export async function settle<T>(clock: FakeClock, promise: Promise<T>): Promise<T> {
  let done = false;
  const tracked = promise.finally(() => {
    done = true;
  });
  tracked.catch(() => {});
  await runUntil(clock, () => done, 'a call to settle', HOUR, 50);
  return tracked;
}

// ---- reading the store and the log ----

export const sql = <T extends Record<string, string | number | null>>(
  store: StorePort,
  query: string,
  ...params: (string | number)[]
): T[] => store.read(q => q.all<T>(query, ...params));

export function accountRow(store: StorePort) {
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

export function stateOf(store: StorePort, scope: string) {
  return store.read(q =>
    q.get<{
      cursor: string | null;
      page_token: string | null;
      phase: string | null;
      pending: string | null;
      generation: number;
    }>(
      'SELECT cursor, page_token, phase, pending, generation FROM sync_state WHERE account_id = ? AND scope = ?',
      ACCOUNT,
      scope,
    ),
  );
}

export const threadCount = (store: StorePort) =>
  sql<{ n: number }>(store, 'SELECT COUNT(*) AS n FROM threads WHERE account_id = ?', ACCOUNT)[0].n;
export const messageIds = (store: StorePort) =>
  new Set(
    sql<{ id: string }>(
      store,
      'SELECT remote_id AS id FROM messages WHERE account_id = ?',
      ACCOUNT,
    ).map(r => r.id),
  );
export const threadIds = (store: StorePort) =>
  new Set(
    sql<{ id: string }>(
      store,
      'SELECT remote_id AS id FROM threads WHERE account_id = ?',
      ACCOUNT,
    ).map(r => r.id),
  );

/** Threads with at least one message in the local Inbox. */
export const localInbox = (store: StorePort) =>
  new Set(
    sql<{ id: string }>(
      store,
      `SELECT DISTINCT t.remote_id AS id FROM message_folders mf JOIN messages m ON m.id = mf.message_id
      JOIN threads t ON t.id = m.thread_id JOIN folders f ON f.id = mf.folder_id WHERE m.account_id = ? AND f.remote_id = 'INBOX'`,
      ACCOUNT,
    ).map(r => r.id),
  );
export const serverInbox = (mail: Mail) =>
  new Set(mail.emu.mailbox.selectThreads({ labelIds: ['INBOX'] }).map(t => t.id));

export const windowDone = (store: StorePort) => stateOf(store, 'window:inbox')?.phase === 'done';
export const statusOf = (engine: Engine) => engine.host.status(ACCOUNT)?.status;

/** Gmail calls only: no batch envelope, no OAuth. */
export const gmailCalls = (log: readonly RequestLogEntry[], since = 0) =>
  log.filter(e => e.service === 'gmail' && e.apiMethod !== 'gmail.batch' && e.at >= since);
export const refusals = (log: readonly RequestLogEntry[]) =>
  log.filter(e => e.status === 403 || e.status === 429);
export const methodsOf = (log: readonly RequestLogEntry[]) =>
  log.map(e => e.apiMethod.replace(/^gmail\.users\./, ''));

/** Highest units the emulator charged in any sliding 60 s window, recomputed from log entries. */
export function peakWindow(log: readonly RequestLogEntry[]): number {
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
export function metadataFetches(sent: readonly Sent[], since = 0): string[] {
  const out: string[] = [];
  const add = (path: string, query: string) => {
    if (!/(^|&)format=metadata(&|$)/.test(query)) return;
    const m = /\/(messages|threads)\/([0-9a-f]+)$/.exec(path);
    if (m) out.push(m[1] === 'threads' ? `thread:${m[2]}` : m[2]);
  };
  for (const s of sent) {
    if (s.at < since) continue;
    add(s.url.pathname, s.url.searchParams.toString());
    if (s.body)
      for (const m of s.body.matchAll(
        /GET \/gmail\/v1\/users\/me(\/(?:messages|threads)\/[0-9a-f]+)\?(\S*) HTTP/g,
      ))
        add(m[1], m[2]);
  }
  return out;
}

/** Enqueues an archive as `Thread/act` does: the local effect and the op row in one local commit. */
export function queueArchive(store: StorePort, opId: string, remoteId: string): void {
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

export const openOps = (store: StorePort) =>
  sql<{ op_id: string; state: string }>(
    store,
    'SELECT op_id, state FROM ops WHERE account_id = ? ORDER BY seq',
    ACCOUNT,
  );
