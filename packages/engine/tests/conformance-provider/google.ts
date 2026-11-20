/**
 * The Google binding for the provider conformance suite (`suite.ts`): the Google provider on the emulator: the real factory, the
 * real sign-in flow and the engine's real governor, with the emulator behind a fetch. The emulator does not model
 * Gmail's `/upload/` endpoints, so sends go through the upload bridge the send tests use.
 */
import {
  type AdapterAccount,
  type Clock,
  type RequestIo,
  type TokenSource,
} from '@aplos/engine/ports';
import {
  FakeClock,
  SCOPE,
  createFaultInjector,
  createGmailEmulator,
  type FaultInjector,
  type FaultMatch,
  type GmailEmulator,
  type MessageView,
} from '@aplos/emulators';
import { oauthBudget } from '../../src/sync/budgets';
import { Governor } from '../../src/sync/governor';
import {
  GMAIL_BUDGET,
  createGoogleProvider,
} from '../../../../apps/desktop/src/host/providers/google/adapter';
import { googleError } from '../../../../apps/desktop/src/host/providers/google/classify';
import { createGoogleHostConnect } from '../../../../apps/desktop/src/host/providers/oauth/host-connect';
import { createHttpClient } from '../../../../apps/desktop/src/host/providers/shared/http';
import type {
  CredentialVault,
  GoogleTokenBundle,
} from '../../../../apps/desktop/src/host/providers/oauth/token-source';
import { UploadBridge } from '../../../../apps/desktop/tests/prov-gmail/send-rig';
import type {
  ConformanceRig,
  ConformanceServer,
  FaultArea,
  FaultKind,
  NewMail,
  OtherMailbox,
  RigOptions,
  ServerMessage,
} from './types';

const CLIENT_ID = 'conformance-client.apps.googleusercontent.com';
const CLIENT_SECRET = 'conformance-secret-not-real';
const OWNER = { sub: 'sub-owner', email: 'owner@example.test', name: 'Owner' };
const OTHER = { sub: 'sub-other', email: 'other@example.test', name: 'Other' };
const SCOPES = ['openid', 'email', 'profile', SCOPE.gmailModify];
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const WRITES =
  /^gmail\.users\.(messages\.(modify|batchModify|trash|untrash)|threads\.(modify|trash|untrash))$/;

const AREA_METHODS: Record<FaultArea, RegExp> = {
  sync: /^gmail\.users\.(history|messages|threads)\.list$/,
  open: /^gmail\.users\.threads\.get$/,
  write: WRITES,
  send: /^gmail\.users\.(messages|drafts)\.send$/,
};

/** Signs in once on first use, then refreshes against the emulator's token endpoint. */
class EmulatorTokens implements TokenSource {
  private access?: { token: string; expiresAt: number };
  private refreshToken?: string;

  constructor(
    private readonly emu: GmailEmulator,
    private readonly clock: FakeClock,
  ) {}

  cached() {
    return this.access && this.access.expiresAt > this.clock.now() + 60_000
      ? this.access
      : undefined;
  }

  async refresh(_account: string, io: RequestIo) {
    if (!this.refreshToken) return this.signIn();
    const response = await this.emu.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
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
    return this.keep(json.access_token, json.expires_in);
  }

  private async signIn() {
    const session = await this.emu.oauth.signIn({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes: SCOPES,
      as: OWNER.email,
      fetch: this.emu.fetch,
    });
    this.refreshToken = session.refreshToken;
    return this.keep(session.accessToken, Number(session.response.expires_in));
  }

  private keep(token: string, expiresIn: number) {
    this.access = { token, expiresAt: this.clock.now() + expiresIn * 1000 };
    return this.access;
  }
}

function memoryVault(): CredentialVault<GoogleTokenBundle> {
  const entries = new Map<string, GoogleTokenBundle>();
  return {
    get: ref => entries.get(ref),
    async set(ref, value) {
      entries.set(ref, { ...value });
    },
    async delete(ref) {
      entries.delete(ref);
    },
  };
}

/** The browser's part of the sign-in: consent on the emulator, then the redirect to the app's loopback. */
function browserFor(emu: GmailEmulator) {
  return async (url: string) => {
    const redirect = new URL(emu.oauth.authorize(url, { as: OWNER.email }));
    const response = await fetch(redirect);
    await response.text();
  };
}

function portClock(clock: FakeClock): Clock & { advance(ms: number): Promise<void> } {
  return {
    now: () => clock.now(),
    sleep: (ms, signal) => clock.sleep(ms, signal),
    timer: () => ({ cancel() {} }),
    advance: ms => clock.advance(ms),
  };
}

function view(m: MessageView): ServerMessage {
  return {
    remoteId: m.id,
    remoteThreadId: m.threadId,
    seen: !m.labelIds.includes('UNREAD'),
    flagged: m.labelIds.includes('STARRED'),
    inInbox: m.labelIds.includes('INBOX'),
    trashed: m.labelIds.includes('TRASH'),
  };
}

function deliverTo(emu: GmailEmulator, user: string, mail: NewMail): ServerMessage {
  const added = emu.mailboxFor(user).addMessage({
    from: 'sender@example.test',
    to: [user],
    subject: mail.subject,
    text: mail.text,
    labelIds: ['INBOX', 'UNREAD'],
    ...(mail.inReplyTo ? { replyTo: mail.inReplyTo } : {}),
  });
  return view(added);
}

function messageOf(emu: GmailEmulator, user: string, remoteId: string): ServerMessage | undefined {
  const m = emu.mailboxFor(user).getMessage(remoteId);
  return m ? view(m) : undefined;
}

/** The emulator logs the account's subject; the suite speaks in addresses. */
const addressOf = (account: string) =>
  [OWNER, OTHER].find(u => u.sub === account || u.email === account)?.email ?? account;

function arm(faults: FaultInjector, area: FaultArea, kind: FaultKind): void {
  const match: FaultMatch = { apiMethod: AREA_METHODS[area] };
  if (kind === 'throttle') faults.failNext(match, { status: 429, reason: 'rateLimitExceeded' });
  if (kind === 'unavailable') faults.failNext(match, { status: 503, reason: 'backendError' });
  if (kind === 'lostAnswer') faults.dropAfterNext(match);
  if (kind === 'notSent') faults.dropNext(match);
}

function server(emu: GmailEmulator, faults: FaultInjector): ConformanceServer {
  const mine = () => emu.mailboxFor(OWNER.email);
  const other: OtherMailbox = {
    address: OTHER.email,
    deliver: mail => deliverTo(emu, OTHER.email, mail),
    message: id => messageOf(emu, OTHER.email, id),
  };
  return {
    address: OWNER.email,
    deliver: mail => deliverTo(emu, OWNER.email, mail),
    setFlags(remoteId, flags) {
      const add: string[] = [];
      const remove: string[] = [];
      if (flags.seen !== undefined) (flags.seen ? remove : add).push('UNREAD');
      if (flags.flagged !== undefined) (flags.flagged ? add : remove).push('STARRED');
      mine().modifyMessages([remoteId], add, remove);
    },
    remove: remoteId => mine().deleteMessage(remoteId),
    message: id => messageOf(emu, OWNER.email, id),
    inbox: () =>
      mine()
        .listMessages()
        .filter(m => m.labelIds.includes('INBOX'))
        .map(view),
    writes: () => emu.log.filter(e => WRITES.test(e.apiMethod) && e.status < 300).length,
    delivered: internetId =>
      mine()
        .listMessages()
        .filter(
          m =>
            m.labelIds.includes('SENT') && `<${m.messageId.replace(/^<|>$/g, '')}>` === internetId,
        ).length,
    fail: (area, kind) => arm(faults, area, kind),
    touched: () => [...new Set(emu.log.flatMap(e => (e.account ? [addressOf(e.account)] : [])))],
    other,
  };
}

export async function makeGoogle(options: RigOptions): Promise<ConformanceRig> {
  const clock = new FakeClock();
  const faults = createFaultInjector();
  const emu = createGmailEmulator({ clock, retryAfter: 'none', faults, users: [OWNER, OTHER] });
  emu.oauth.addClient(CLIENT_ID, CLIENT_SECRET);
  if (options.threads) emu.seedMailbox({ threads: options.threads, seed: 11, user: OWNER.email });
  const governor = new Governor({
    clock,
    budgets: [GMAIL_BUDGET, oauthBudget],
    tokens: new EmulatorTokens(emu, clock),
    random: () => 0,
    role: 'primary',
  });
  const flowClock = new FakeClock({ auto: false });
  const host = createGoogleHostConnect({
    accountIsCommitted: () => false,
    http: createHttpClient({ fetch: emu.fetch, clock: flowClock, userAgent: 'aplos-conformance' }),
    openExternal: browserFor(emu),
    clientInputs: () => ({
      env: { APLOS_GOOGLE_CLIENT_ID: CLIENT_ID, APLOS_GOOGLE_CLIENT_SECRET: CLIENT_SECRET },
      bundled: {},
    }),
    vault: memoryVault(),
  });
  const bridge = new UploadBridge(emu);
  const factory = createGoogleProvider({ fetch: bridge.fetch, pace: false, ...host });
  return {
    factory,
    server: server(emu, faults),
    clock: portClock(clock),
    connectContext: accountId => ({
      accountId,
      governor: governor.bind(accountId),
      clock: portClock(flowClock),
      log: { event() {}, with: () => ({}) as never, enabled: () => false },
      signal: new AbortController().signal,
    }),
    governor: (account: AdapterAccount) => governor.bind(account.id),
    close: () => faults.reset(),
  };
}
