// The sign-in flow's test doubles and rigs, shared by oauth-flow.test.ts and oauth-wire.test.ts.

import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { inspect } from 'node:util';
import {
  ProviderError,
  type BoundGovernor,
  type Clock,
  type ConnectContext,
  type ConnectRequest,
  type GovernedRequest,
} from '@aplos/engine/ports';
import type { Logger } from '@aplos/engine/diag/log';
import { FakeClock, createGmailEmulator, SCOPE } from '@aplos/emulators';
import { createHttpClient } from '../../src/host/providers/shared/http';
import { resolveGoogleClient } from '../../src/host/providers/oauth/client';
import {
  createGoogleConnect,
  type GoogleConnectDeps,
} from '../../src/host/providers/oauth/connect';
import type {
  CredentialVault,
  GoogleTokenBundle,
} from '../../src/host/providers/oauth/token-source';

export const clientId = 'flow-client.apps.googleusercontent.com';
export const clientSecret = 'GOCSPX-flow-secret-never-shown';
export const account = 'acct-flow';
export const mailScope = SCOPE.gmailModify;
export const oldBundle: GoogleTokenBundle = {
  clientId,
  refreshToken: '1//old-refresh-never-shown',
};

// ---------- doubles ----------

/** No auto-advance: the callback arrives over a real socket, and an idle clock must not jump to the timeout. */
export const manualClock = () => new FakeClock({ auto: false });

/** The port's clock over a fake one; the flow only reads the time and sleeps, and never arms a timer. */
export function portClock(clock: FakeClock): Clock {
  return {
    now: () => clock.now(),
    sleep: (ms, signal) => clock.sleep(ms, signal),
    timer: () => assert.fail('the sign-in flow arms no timer'),
  };
}

export interface MemoryVault extends CredentialVault<GoogleTokenBundle> {
  entries: Map<string, GoogleTokenBundle>;
  writes: number;
  deletes: string[];
  failWrites: boolean;
  /** `set` keeps the entry in memory and then rejects (a persist that failed part-way). */
  failAfterWrite: boolean;
  /** Runs inside `set`, after the entry is in memory and before the write settles (`main/vault.ts` order). */
  duringSet?: () => void;
}

/** Like `main/vault.ts`: the entry is in memory during the write, and a refused write puts the previous value back. */
export function memoryVault(initial?: GoogleTokenBundle): MemoryVault {
  const vault: MemoryVault = {
    entries: new Map(initial ? [[account, { ...initial }]] : []),
    writes: 0,
    deletes: [],
    failWrites: false,
    failAfterWrite: false,
    get: ref => vault.entries.get(ref),
    async set(ref, value) {
      if (vault.failWrites) throw new Error(`disk full while saving ${value.refreshToken}`);
      vault.writes += 1;
      vault.entries.set(ref, { ...value });
      vault.duringSet?.();
      if (vault.failAfterWrite) throw new Error(`persist failed for ${value.refreshToken}`);
    },
    async delete(ref) {
      vault.deletes.push(ref);
      vault.entries.delete(ref);
    },
  };
  return vault;
}

export interface Recorder {
  governor: BoundGovernor;
  tickets: GovernedRequest[];
}

/** Pass-through governor: runs `fn` once with the caller's signal and records each ticket. */
export function recordingGovernor(): Recorder {
  const tickets: GovernedRequest[] = [];
  const governor: BoundGovernor = {
    run(req, fn) {
      tickets.push(req);
      return fn({ signal: req.signal ?? new AbortController().signal });
    },
    observe() {},
    charge() {},
    batchSize: () => 1,
  };
  return { governor, tickets };
}

export interface RandomLog {
  random: (size: number) => Uint8Array;
  sizes: number[];
}

export function countingRandom(): RandomLog {
  const sizes: number[] = [];
  let next = 1;
  const random = (size: number) => {
    sizes.push(size);
    return Uint8Array.from({ length: size }, () => next++ % 256);
  };
  return { random, sizes };
}

export const silentLog: Logger = {
  event: () => assert.fail('the sign-in flow logs nothing'),
  with: () => silentLog,
  enabled: () => false,
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function idToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`;
}

export function claims(
  clock: FakeClock,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    iss: 'https://accounts.google.com',
    aud: clientId,
    sub: 'sub-1',
    email: 'Owner@Example.TEST',
    email_verified: true,
    name: 'Owner',
    exp: Math.floor(clock.now() / 1000) + 3600,
    ...extra,
  };
}

/** A browser that follows the consent URL straight to the loopback callback with a code and the echoed state. */
export interface FakeBrowser {
  openExternal: (url: string) => Promise<void>;
  opened: URL[];
  statuses: number[];
}

export type Callback = (consent: URL) => Array<Record<string, string>>;

export function fakeBrowser(callback: Callback): FakeBrowser {
  const opened: URL[] = [];
  const statuses: number[] = [];
  const openExternal = async (url: string) => {
    const consent = new URL(url);
    opened.push(consent);
    for (const query of callback(consent)) {
      const target = new URL(consent.searchParams.get('redirect_uri')!);
      for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
      statuses.push(await getStatus(target));
    }
  };
  return { openExternal, opened, statuses };
}

/** 0 when the listener is gone (connection refused). */
export async function getStatus(url: URL): Promise<number> {
  try {
    const response = await fetch(url);
    await response.text();
    return response.status;
  } catch {
    return 0;
  }
}

export const authCode = '4/0AflowCode-never-shown';
export const echoState = (consent: URL) => consent.searchParams.get('state')!;
export const withCode: Callback = consent => [{ code: authCode, state: echoState(consent) }];

export interface Scripted {
  fetch: typeof fetch;
  forms: URLSearchParams[];
}

export function tokenEndpoint(
  reply: (form: URLSearchParams) => Response | Promise<Response>,
): Scripted {
  const forms: URLSearchParams[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const form = new URLSearchParams(String(init?.body ?? ''));
    forms.push(form);
    return reply(form);
  }) as typeof fetch;
  return { fetch: fetchFn, forms };
}

export interface Rig {
  connect: ReturnType<typeof createGoogleConnect>;
  ctx: ConnectContext;
  abort: AbortController;
  vault: MemoryVault;
  clock: FakeClock;
  tickets: GovernedRequest[];
  random: RandomLog;
}

export interface RigOptions {
  fetch: typeof fetch;
  openExternal: (url: string) => Promise<void> | void;
  clock?: FakeClock;
  vault?: MemoryVault;
  env?: Record<string, string | undefined>;
  deps?: Partial<GoogleConnectDeps>;
  /** Default: a pass-through recorder. */
  governor?: BoundGovernor;
}

export function rig(options: RigOptions): Rig {
  const clock = options.clock ?? manualClock();
  const vault = options.vault ?? memoryVault();
  const recorder = recordingGovernor();
  const random = countingRandom();
  const env = options.env ?? {
    APLOS_GOOGLE_CLIENT_ID: clientId,
    APLOS_GOOGLE_CLIENT_SECRET: clientSecret,
  };
  const connect = createGoogleConnect({
    http: createHttpClient({ fetch: options.fetch, clock, userAgent: 'aplos-test' }),
    openExternal: options.openExternal,
    random: random.random,
    resolveClient: () => resolveGoogleClient({ env, bundled: {} }),
    vault,
    ...options.deps,
  });
  const abort = new AbortController();
  const ctx: ConnectContext = {
    accountId: account,
    governor: options.governor ?? recorder.governor,
    clock: portClock(clock),
    log: silentLog,
    signal: abort.signal,
  };
  return { connect, ctx, abort, vault, clock, tickets: recorder.tickets, random };
}

export function tokenReply(clock: FakeClock, extra: Record<string, unknown> = {}): Response {
  return json({
    access_token: 'ya29.flow-access-never-shown',
    expires_in: 3599,
    refresh_token: '1//flow-refresh-never-shown',
    scope: `openid ${SCOPE.email} ${mailScope}`,
    id_token: idToken(claims(clock)),
    ...extra,
  });
}

/** A rig whose token endpoint answers `reply` and whose browser returns `authCode`. */
export function scriptedRig(
  reply: (clock: FakeClock, form: URLSearchParams) => Response | Promise<Response>,
  options: Partial<RigOptions> = {},
): Rig & { forms: URLSearchParams[]; browser: FakeBrowser } {
  const clock = options.clock ?? manualClock();
  const endpoint = tokenEndpoint(form => reply(clock, form));
  const browser = fakeBrowser(withCode);
  const r = rig({ fetch: endpoint.fetch, openExternal: browser.openExternal, clock, ...options });
  return { ...r, forms: endpoint.forms, browser };
}

export const newConnect: ConnectRequest = { mode: 'new' };

export async function refusal(promise: Promise<unknown>): Promise<ProviderError> {
  const error = await promise.then(
    () => assert.fail('expected the connect to fail'),
    (e: unknown) => e,
  );
  assert.ok(error instanceof ProviderError, `not a ProviderError: ${String(error)}`);
  return error;
}

export function assertNoSecrets(error: unknown, secrets: string[]): void {
  const views = [String(error), JSON.stringify(error), inspect(error, { depth: 10 })];
  if (error instanceof Error) views.push(error.message, error.stack ?? '');
  for (const view of views) {
    for (const secret of secrets) assert.ok(!view.includes(secret), 'a secret leaked');
  }
}

export function refused(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

export const portOf = (consent: URL) =>
  Number(new URL(consent.searchParams.get('redirect_uri')!).port);

// ---------- the whole flow on the Gmail emulator ----------

export function emulatorRig(options: {
  vault?: MemoryVault;
  as?: string;
  deps?: Partial<GoogleConnectDeps>;
}) {
  const revoked: string[] = [];
  const clock = manualClock();
  // The emulator waits out its latency on its own auto-advancing clock, so the flow's clock never moves by itself.
  const emulator = createGmailEmulator({
    clock: new FakeClock(),
    testingMode: true,
    requirePkceAndState: true,
    users: [],
  });
  emulator.oauth.addClient(clientId, clientSecret);
  emulator.addUser({ sub: 'sub-1', email: 'Owner@Example.TEST', name: 'Owner' });
  emulator.addUser({ sub: 'sub-2', email: 'other@example.test', name: 'Other' });
  const browser = fakeBrowser(consent => {
    const redirect = new URL(emulator.oauth.authorize(consent, { as: options.as }));
    return [Object.fromEntries(redirect.searchParams)];
  });
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/revoke'))
      revoked.push(new URLSearchParams(String(init?.body)).get('token')!);
    return emulator.fetch(url, init);
  }) as typeof fetch;
  const r = rig({ fetch: fetchFn, openExternal: browser.openExternal, clock, ...options });
  /** True when the emulator no longer honours the refresh token. Revokes a live one, so call it last. */
  const dead = (token: string) =>
    emulator.oauth.revokeToken(new URLSearchParams({ token })).status === 400;
  return { ...r, emulator, browser, revoked, dead };
}
