import { ContractError } from '@aplos/contract/contract-error';
import type { Frame } from '@aplos/contract';
import { PausedError, ProviderError } from '../ports/base';
import type {
  AccountActorHost,
  AccountId,
  Clock,
  ConnectRequest,
  ConnectResult,
  DeadlineRegistry,
  ProviderKind,
} from '../ports';
import type { FrameBus } from '../runtime/frames';
import type { EngineServices } from '../runtime/services';

// Lifecycle (for the prov-gov lane module that does not exist yet): `connectSessionsOf(services)` creates the engine's one
// `ConnectSessions` on first use and registers its deadline source. The module's `LaneModule.stop` MUST call
// `disposeConnectSessions(services)`, which aborts every waiting sign-in, unregisters the deadline source and clears the maps.
//
// Connect, reconnect and permission grants run in the background, one live sign-in per account. The caller gets a
// `connectId` at once; `connect` frames report the outcome (freeze FR-23). A frame carries a copy key and never a
// sentence, a token or a secret.

/** What one sign-in does once the provider answered. Throw a `ContractError` to refuse the answer and store nothing. */
export type AcceptOutcome = { accountId?: string } | void;

export interface ConnectFlow {
  mode: Extract<Frame, { frame: 'connect' }>['mode'];
  accountId: string;
  /**
   * One live sign-in per key: the account for a reconnect or grant, the address (or none) for a new account. The
   * sessions also hold `account:<accountId>`, so a retry on a waiting row and a reconnect of it exclude each other.
   */
  key: string;
  kind: ProviderKind;
  request: ConnectRequest;
  /** May answer with the id of the account it actually stored, when that is not `accountId` (a retried new account). */
  accept(result: ConnectResult): Promise<AcceptOutcome> | AcceptOutcome;
  /**
   * Which window the sign-in's `aplos://oauth-return` deep link should come back to, resolved by the
   * `Account/*` handler from the caller's connection (`setupId` marks the setup window). The host's
   * sign-in flow looks it up by `oauthReturnKey` while the session is live.
   */
  returnTo?: 'onboarding' | 'mail';
}

interface Session {
  connectId: string;
  flow: ConnectFlow;
  controller: AbortController;
  /** Epoch ms after which the sign-in expires as failed (`auth.timeout`). */
  deadline: number;
  /** The provider answered and the engine is storing it: too late to cancel. */
  accepting: boolean;
  /** The result's stored credential already went back to the host (at most once per result). */
  discarded?: boolean;
  /** The account the sign-in ended up on, when the flow reports one other than its own. */
  storedAccountId?: string;
  /** The host's `connect` was called, and whether it has resolved or rejected since. */
  hostStarted: boolean;
  hostSettled: boolean;
}

export const ALREADY_OPEN =
  'A sign-in for this account is already open. Finish it or cancel it first.';

/** At most this many sign-ins wait at once; the next is refused. */
export const MAX_OPEN = 3;
/** The engine gives up on a sign-in the browser never finished. */
export const SIGN_IN_DEADLINE_MS = 10 * 60_000;
export const TOO_MANY_OPEN =
  'Too many sign-ins are open. Finish or cancel one before starting another.';
const DEADLINE_ID = 'connect';

// ---- oauth-return purpose binding ---------------------------------------------------------------------------
// `aplos://oauth-return?n=<nonce>` links focus the window that started the sign-in. The host flow (prov-gov's
// oauth module) mints the nonce; it finds the window's purpose here by `oauthReturnKey`. A connection is
// marked as the setup window's when it calls `Account/connect` with a `setupId` (only that window runs
// `Setup/begin`; the mail window's Add account dialog never sends one), so a later reconnect or grant on the
// same connection also returns to the setup window. Unmarked connections resolve 'mail', so a later add can
// never be routed to the setup window.
const pendingReturns = new Map<string, 'onboarding' | 'mail'>();
const onboardingConnections = new Set<string>();
const MAX_ONBOARDING_CONNECTIONS = 128;

/** Marks the caller's connection as the setup window's (an `Account/connect` carrying `setupId`). */
export function noteOnboardingConnection(connectionId: string): void {
  onboardingConnections.add(connectionId);
  if (onboardingConnections.size > MAX_ONBOARDING_CONNECTIONS)
    onboardingConnections.delete(onboardingConnections.keys().next().value!);
}

/** Whether the connection was marked by `noteOnboardingConnection` (the setup window's). */
export function connectionOpensOnboarding(connectionId: string): boolean {
  return onboardingConnections.has(connectionId);
}

/**
 * The `ConnectFlow.key` a live sign-in maps to from the `ConnectRequest`/`accountId` the host's connect
 * sees: `new:<lowercased address>` for a new account (matching `newAccountFlow`), `account:<id>` otherwise.
 */
export function oauthReturnKey(
  req: Pick<ConnectRequest, 'mode' | 'address'>,
  accountId: string,
): string {
  return req.mode === 'new' ? `new:${(req.address ?? '').toLowerCase()}` : `account:${accountId}`;
}

/** The window a live sign-in returns to, or undefined when it has ended (or never named one). */
export function oauthReturnFor(key: string): 'onboarding' | 'mail' | undefined {
  return pendingReturns.get(key);
}

export interface ConnectSessionsDeps {
  accounts: AccountActorHost;
  frames: FrameBus;
  randomBytes: (n: number) => Uint8Array;
  clock: Pick<Clock, 'now'>;
  deadlines: DeadlineRegistry;
}

export class ConnectSessions {
  private readonly byId = new Map<string, Session>();
  private readonly byKey = new Map<string, Session>();

  private readonly accounts: AccountActorHost;
  private readonly frames: FrameBus;
  private readonly randomBytes: (n: number) => Uint8Array;
  private readonly unregister: () => void;

  constructor(private readonly deps: ConnectSessionsDeps) {
    this.accounts = deps.accounts;
    this.frames = deps.frames;
    this.randomBytes = deps.randomBytes;
    this.unregister = deps.deadlines.register({
      id: DEADLINE_ID,
      next: async () => this.nextDeadline(),
      fire: async now => this.expire(now),
    });
  }

  private nextDeadline(): number | undefined {
    const times = [...this.byId.values()].map(s => s.deadline);
    return times.length ? Math.min(...times) : undefined;
  }

  /** Sign-ins whose browser never answered in time end as failed, and their controllers abort. */
  private expire(now: number): void {
    for (const session of [...this.byId.values()]) {
      if (session.deadline > now || session.accepting) continue;
      session.controller.abort();
      this.abandon(session);
      this.emit(session, 'failed', 'auth.timeout');
    }
  }

  /** Starts the sign-in and returns its id at once; the first frame follows on the next turn. */
  begin(flow: ConnectFlow): { connectId: string } {
    const keys = guardKeys(flow);
    if (keys.some(key => this.byKey.has(key)))
      throw new ContractError({ type: 'conflict', message: ALREADY_OPEN });
    if (this.byId.size >= MAX_OPEN)
      throw new ContractError({ type: 'conflict', message: TOO_MANY_OPEN });
    const session: Session = {
      deadline: this.deps.clock.now() + SIGN_IN_DEADLINE_MS,
      connectId: hexId(this.randomBytes, 'c'),
      flow,
      controller: new AbortController(),
      accepting: false,
      hostStarted: false,
      hostSettled: false,
    };
    this.byId.set(session.connectId, session);
    if (flow.returnTo) pendingReturns.set(flow.key, flow.returnTo);
    for (const key of keys) this.byKey.set(key, session);
    this.deps.deadlines.changed(DEADLINE_ID);
    setTimeout(() => void this.run(session), 0);
    return { connectId: session.connectId };
  }

  /** False when nothing is waiting under this id (finished, unknown, or already being stored). */
  cancel(connectId: string): boolean {
    const session = this.byId.get(connectId);
    if (!session || session.accepting) return false;
    session.controller.abort();
    this.abandon(session);
    this.emit(session, 'cancelled');
    return true;
  }

  private async run(session: Session): Promise<void> {
    const unfollow = this.followRequestSignal(session);
    try {
      await this.runFlow(session);
    } finally {
      unfollow();
    }
  }

  /**
   * An abort signal the request already carries cancels the sign-in like `cancel` does: it ends `cancelled`, aborts the
   * host's flow and frees the keys once that flow settles. Returns the listener's removal.
   */
  private followRequestSignal(session: Session): () => void {
    const own = session.flow.request.signal;
    if (!own) return () => {};
    const onAbort = () => {
      try {
        this.cancel(session.connectId);
      } catch {
        // The frame bus is broken; `cancel` already released the session.
      }
    };
    if (own.aborted) onAbort();
    else own.addEventListener('abort', onAbort, { once: true });
    return () => own.removeEventListener('abort', onAbort);
  }

  private async runFlow(session: Session): Promise<void> {
    const { signal } = session.controller;
    if (signal.aborted) return;
    try {
      // Inside the try: a frame bus that throws must end in `failed` and a freed key, never a stuck session.
      this.emit(session, 'waiting');
      const { accountId, kind, request } = session.flow;
      // The cancel and the deadline reach the host's browser and loopback flow (`ConnectRequest.signal`), and the host
      // discards a result that still arrives after them (`AccountActorHost.discardCredential`).
      session.hostStarted = true;
      // The request's own signal reaches the host through the session's (`followRequestSignal`).
      const answered = this.accounts.connect(accountId, kind, { ...request, signal });
      this.holdKeysUntilSettled(session, answered);
      this.discardLateAnswer(session, answered);
      const result = await untilAborted(answered, signal);
      // The answer can win the race and still be followed by a cancel before this line runs: the cancel stands.
      if (result === ABORTED) return;
      if (signal.aborted) {
        this.discardResultOnce(session, result);
        return;
      }
      session.accepting = true;
      const outcome = await session.flow.accept(result);
      if (outcome?.accountId) session.storedAccountId = outcome.accountId;
      this.release(session);
      this.emit(session, 'connected');
    } catch (error) {
      if (signal.aborted) return;
      this.release(session);
      this.tryEmit(session, 'failed', failureCode(error));
    }
  }

  /**
   * A `new` answer that arrives after its session ended left a stored credential behind; it goes back as soon as the
   * host produces it. Once `accept` has seen the result the flow owns the discard, so this never fires for it. A
   * reconnect's ref is the account's own live bundle: only `new` answers are handed back.
   */
  private discardLateAnswer(session: Session, answered: Promise<ConnectResult>): void {
    void answered.then(
      result => {
        if (session.controller.signal.aborted && !session.accepting)
          this.discardResultOnce(session, result);
      },
      () => {},
    );
  }

  /** At most once per result: the stored credential of a refused or late `new` answer goes back, best effort. */
  private discardResultOnce(session: Session, result: ConnectResult): void {
    if (session.flow.mode !== 'new' || session.discarded) return;
    session.discarded = true;
    discardCredential(
      this.accounts,
      session.flow.accountId,
      session.flow.kind,
      result.credentialRef,
    );
  }

  private tryEmit(session: Session, state: 'failed', reasonCode: string): void {
    try {
      this.emit(session, state, reasonCode);
    } catch {
      // The frame bus is broken; the session is already released, which is what matters.
    }
  }

  /** Engine stop: abort every waiting sign-in without a frame (the connections are closing) and forget them. */
  dispose(): void {
    for (const session of this.byId.values()) session.controller.abort();
    this.byId.clear();
    this.byKey.clear();
    pendingReturns.clear();
    this.unregister();
  }

  private release(session: Session): void {
    this.byId.delete(session.connectId);
    this.releaseKeys(session);
  }

  /**
   * A cancelled or expired sign-in stops counting as open at once, but keeps its keys until the host's flow has
   * settled (`holdKeysUntilSettled`), so a new sign-in for the same account cannot run beside the one winding down.
   * A host that never settles after the abort keeps the account's key until engine stop (`dispose`).
   */
  private abandon(session: Session): void {
    this.byId.delete(session.connectId);
    if (!session.hostStarted || session.hostSettled) this.releaseKeys(session);
  }

  private holdKeysUntilSettled(session: Session, call: Promise<unknown>): void {
    const settled = () => {
      session.hostSettled = true;
      if (session.controller.signal.aborted) this.releaseKeys(session);
    };
    call.then(settled, settled);
  }

  private releaseKeys(session: Session): void {
    for (const key of guardKeys(session.flow)) {
      if (this.byKey.get(key) === session) this.byKey.delete(key);
    }
    pendingReturns.delete(session.flow.key);
  }

  private emit(
    session: Session,
    state: 'waiting' | 'connected' | 'failed' | 'cancelled',
    reasonCode?: string,
  ) {
    const { mode } = session.flow;
    const accountId = session.storedAccountId ?? session.flow.accountId;
    // A new account has no id the UI knows until it is connected; a reconnect or grant names its account from `waiting` on.
    const named = mode !== 'new' || state === 'connected';
    this.frames.emit({
      frame: 'connect',
      connectId: session.connectId,
      mode,
      state,
      ...(named ? { accountId } : {}),
      ...(reasonCode ? { reasonCode } : {}),
    });
  }
}

/** The flow's own key and its account's: two sign-ins never write the same account's credential at once. */
function guardKeys(flow: ConnectFlow): string[] {
  return [...new Set([flow.key, `account:${flow.accountId}`])];
}

const sessionsByEngine = new WeakMap<object, ConnectSessions>();

/** One map of live sign-ins per engine; the engine's own account actors host keys it. */
export function connectSessionsOf(services: EngineServices): ConnectSessions {
  let sessions = sessionsByEngine.get(services.accounts);
  if (!sessions) {
    sessions = new ConnectSessions({
      accounts: services.accounts,
      frames: services.frames,
      randomBytes: services.randomBytes,
      clock: services.clock,
      deadlines: services.deadlines,
    });
    sessionsByEngine.set(services.accounts, sessions);
  }
  return sessions;
}

/**
 * Aborts and forgets this engine's waiting sign-ins and unregisters their deadline source. NOTHING CALLS IT YET: the
 * composition root (`src/index.ts`, eng-contract's) has no prov-gov lane module, so there is no `LaneModule.stop` to
 * hang it on. The module that adds one (`sync/module.ts`, `createModule(services).stop`) must call this.
 */
export function disposeConnectSessions(services: EngineServices): void {
  sessionsByEngine.get(services.accounts)?.dispose();
  sessionsByEngine.delete(services.accounts);
}

const ABORTED = Symbol('aborted');

/** The provider's answer, or `ABORTED` as soon as the sign-in is cancelled; an answer that comes later is dropped. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => resolve(ABORTED), { once: true });
    promise.then(resolve, error => {
      if (!signal.aborted) reject(error);
    });
  });
}

/**
 * Best effort: hand back a credential the host already stored for a `new` connect result the engine refused or never
 * accepted. Never throws and never changes the outcome the caller reports; a host without the port simply keeps it.
 */
export function discardCredential(
  accounts: AccountActorHost,
  accountId: AccountId,
  kind: ProviderKind,
  credentialRef: string,
): void {
  try {
    void accounts.discardCredential?.(accountId, kind, credentialRef)?.catch(() => {});
  } catch {
    // The refusal or the cancel the caller reports is the outcome; a broken host changes nothing here.
  }
}

export function hexId(randomBytes: (n: number) => Uint8Array, prefix: string): string {
  const hex = Array.from(randomBytes(10), b => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}${hex}`;
}

const BY_REASON: Readonly<Record<string, string>> = {
  wrongAccount: 'auth.wrongAccount',
  missingRequiredScope: 'permission.mailModify',
  access_denied: 'auth.denied',
  timeout: 'auth.timeout',
  clientMissing: 'config.clientMissing',
  accessNotConfigured: 'config.apiDisabled',
};

const BY_CLASS: Readonly<Record<string, string>> = {
  auth: 'auth.expired',
  permission: 'permission.mailModify',
  config: 'config.apiDisabled',
  throttle: 'rate.minute',
  daily: 'quota.daily',
  network: 'net.offline',
  transient: 'server.unavailable',
};

/** The copy key a failed sign-in shows. Nothing from the error's text reaches a frame. */
export function failureCode(error: unknown): string {
  if (error instanceof ContractError) return error.body.reasonCode ?? 'unknown';
  if (error instanceof ProviderError) {
    return BY_REASON[error.error.reason] ?? BY_CLASS[error.error.class] ?? 'unknown';
  }
  if (error instanceof PausedError) return BY_CLASS[error.cls] ?? 'unknown';
  return 'unknown';
}
