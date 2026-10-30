/** The prov-gov attack rig on the real stack: the emulated world, the engine on a Mac, the clock driver and store/log readers (see gov-stack-attack.test.ts). */
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
  SCOPE,
  createFaultInjector,
  createGmailEmulator,
  type FaultInjector,
  type GmailEmulator,
  type RequestLogEntry,
} from '@aplos/emulators';
import { Governor } from '../../../../packages/engine/src/sync/governor';
import { ActorHost } from '../../../../packages/engine/src/sync/host';
import { storeLookup } from '../../../../packages/engine/src/sync/lookup';
import { opPayload } from '../../../../packages/engine/src/sync/ops';
import { openSqlite } from '../../src/host/sqlite';
import { createGoogleProvider } from '../../src/host/providers/google/adapter';
import { googleError } from '../../src/host/providers/google/classify';
import {
  googleWorkflowChannel,
  googleWorkflowMerged,
} from '../../src/host/providers/google/workflow-host';
import { keysOf } from './workflow-rig';

export const ACCOUNT = 'acct-gov-attack';
const CLIENT_ID = 'prov-gov-attack.apps.example.test';
const GMAIL_SCOPES = ['openid', 'email', 'profile', SCOPE.gmailModify, SCOPE.gmailSettingsBasic];
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

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

export function mailWorld(threads: number, seed = 31): Mail {
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

/** The engine's clock over the fake one, reading `skew()` ahead of it (a Mac whose clock is off); sleeps stay relative. */
function portClock(fake: FakeClock, skew: () => number): Clock {
  return {
    now: () => fake.now() + skew(),
    sleep: (ms, signal) => fake.sleep(ms, signal),
    timer(at, fire) {
      const controller = new AbortController();
      fake.sleep(Math.max(0, at - skew() - fake.now()), controller.signal).then(fire, () => {});
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

interface Sent {
  at: number;
  url: URL;
  body?: string;
}

export class Mac {
  readonly dir = scratchDir('aplos-attack-');
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
      }),
  );
  const claims = JSON.parse(
    Buffer.from(String(session.response.id_token).split('.')[1], 'base64url').toString('utf8'),
  ) as { sub: string; email: string };
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

interface CommitRecord {
  step?: string;
  changes?: string;
  origin: string;
  messages: { remoteId: string; internalDate: number }[];
}

export interface BootOptions {
  /**
   * Wires the Gmail workflow channel the way a real account does (`google/workflow-host.ts`): the provider gets
   * `workflow`, the host gets `workflowChannel`/`onWorkflowMerged` over the emulator's shared mailbox, and a
   * stand-in timer loop fires the `lease:` deadline sources as the clock moves.
   */
  workflow?: boolean;
  /** This Mac's clock runs this far ahead of the emulator's (negative: behind); only the engine host sees it. */
  skewMs?: number;
  /** The same, read on every use (overrides `skewMs`): a test sets the Mac's clock forward or back with it. */
  skew?: () => number;
  /** How often the stand-in timer loop wakes (250 ms); a day-long run may wake less often. */
  leaseTickMs?: number;
}

interface Engine {
  store: StorePort;
  governor: Governor;
  host: ActorHost;
  deadlines: Deadlines;
  commits: CommitRecord[];
  kill(): Promise<void>;
}

let commitIds = 0;

/** The timer loop's stand-in for a workflow Mac: fires every `lease:` source whose `next()` is due. */
async function pumpLease(
  clock: FakeClock,
  deadlines: Deadlines,
  signal: AbortSignal,
  skew: () => number,
  tickMs: number,
): Promise<void> {
  while (!signal.aborted) {
    try {
      await clock.sleep(tickMs, signal);
    } catch {
      return;
    }
    for (const source of [...deadlines.sources.values()]) {
      if (signal.aborted || !source.id.startsWith('lease:')) continue;
      const next = await source.next();
      const now = clock.now() + skew();
      if (next !== undefined && next <= now) await source.fire(now);
    }
  }
}

export async function boot(
  mac: Mac,
  lease?: 'primary' | 'secondary',
  options: BootOptions = {},
): Promise<Engine> {
  const { clock } = mac.mail;
  const skew = options.skew ?? (() => options.skewMs ?? 0);
  const raw = openStore(openSqlite(mac.path), { now: () => clock.now() + skew() });
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
  const provider = createGoogleProvider({
    fetch: mac.fetch,
    pace: false,
    ...(options.workflow ? { workflow: {} } : {}),
  });
  const factory: ProviderFactory = {
    kind: 'google',
    connect: (req, ctx) => connectGoogle(mac, req, ctx),
    budgets: (account, memory) => provider.budgets(account, memory),
    open: account => provider.open(account),
  };
  const deadlines = new Deadlines();
  const host = new ActorHost(
    {
      store,
      governor,
      providers: [factory],
      tokens: mac.vault,
      clock: portClock(clock, skew),
      log: quietLog,
      deadlines,
      deviceId: mac.id,
      env: () => ({ ...mac.mail.env, now: clock.now() + skew() }),
    },
    {
      newId: () => `${mac.id}-commit-${++commitIds}`,
      random: () => 0,
      ...(options.workflow
        ? {
            workflowChannel: googleWorkflowChannel({ keys: keysOf('shared'), device: mac.id }),
            onWorkflowMerged: googleWorkflowMerged({
              store: raw,
              lookup: account => storeLookup(raw, account),
              log: quietLog,
            }),
          }
        : {}),
    },
  );
  const pumpStop = new AbortController();
  if (options.workflow)
    void pumpLease(clock, deadlines, pumpStop.signal, skew, options.leaseTickMs ?? 250);
  // With the workflow channel the lease is the controller's: a primary asks for it ("Use this Mac") like the owner.
  if (lease && options.workflow) {
    if (lease === 'primary') await host.claimLease(ACCOUNT);
  } else if (lease)
    host.leaseChanged(ACCOUNT, {
      role: lease,
      holder: lease === 'primary' ? mac.id : 'another-mac',
    });
  if (!raw.read(q => q.get('SELECT 1 FROM accounts WHERE id = ?', ACCOUNT))) {
    const result = await settle(
      clock,
      host.connect(ACCOUNT, 'google', { mode: 'new', loginHint: mac.mail.address }),
    );
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
    deadlines,
    commits,
    async kill() {
      pumpStop.abort();
      await host.dispose();
      raw.close();
    },
  };
}

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

const sql = <T extends Record<string, string | number | null>>(
  store: StorePort,
  query: string,
  ...params: (string | number)[]
): T[] => store.read(q => q.all<T>(query, ...params));

export const accountRow = (store: StorePort) =>
  store.read(q =>
    q.get<{ status: string; status_reason_code: string | null; baseline_done_at: number | null }>(
      'SELECT status, status_reason_code, baseline_done_at FROM accounts WHERE id = ?',
      ACCOUNT,
    ),
  )!;

export const stateOf = (store: StorePort, scope: string) =>
  store.read(q =>
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

export const localInbox = (store: StorePort) =>
  new Set(
    sql<{ id: string }>(
      store,
      `SELECT DISTINCT t.remote_id AS id FROM message_folders mf JOIN messages m ON m.id = mf.message_id
      JOIN threads t ON t.id = m.thread_id JOIN folders f ON f.id = mf.folder_id WHERE m.account_id = ? AND f.remote_id = 'INBOX'`,
      ACCOUNT,
    ).map(r => r.id),
  );
export const localInboxMessages = (store: StorePort) =>
  new Set(
    sql<{ id: string }>(
      store,
      `SELECT m.remote_id AS id FROM message_folders mf JOIN messages m ON m.id = mf.message_id
      JOIN folders f ON f.id = mf.folder_id WHERE m.account_id = ? AND f.remote_id = 'INBOX'`,
      ACCOUNT,
    ).map(r => r.id),
  );
export const serverInbox = (mail: Mail) =>
  new Set(mail.emu.mailbox.selectThreads({ labelIds: ['INBOX'] }).map(t => t.id));
export const statusOf = (engine: Engine) => engine.host.status(ACCOUNT)?.status;
export const gmailOnly = (log: readonly RequestLogEntry[]) =>
  log.filter(e => e.service === 'gmail');
export const refusals = (log: readonly RequestLogEntry[]) =>
  log.filter(e => e.status === 403 || e.status === 429);
export const methodsOf = (log: readonly RequestLogEntry[]) =>
  log.map(e => e.apiMethod.replace(/^gmail\.users\./, ''));
export const diff = <T>(a: Set<T>, b: Set<T>) => [...a].filter(x => !b.has(x));

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

export const opRows = (store: StorePort) =>
  sql<{ op_id: string; state: string; last_error: string | null }>(
    store,
    'SELECT op_id, state, last_error FROM ops WHERE account_id = ? ORDER BY seq',
    ACCOUNT,
  );

/** Boots one Mac and runs its first sync (window and Sent) to the end. */
export async function synced(threads: number, seed?: number) {
  const mail = mailWorld(threads, seed);
  const mac = new Mac(mail, 'mac-a');
  const engine = await boot(mac);
  await engine.host.start(ACCOUNT);
  await runUntil(
    mail.clock,
    () =>
      stateOf(engine.store, 'window:inbox')?.phase === 'done' &&
      stateOf(engine.store, 'sent:recent')?.phase === 'done',
    'the first sync',
  );
  return { mail, mac, engine };
}
