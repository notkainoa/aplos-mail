import { ContractError } from '@aplos/contract/contract-error';
import type { Frame } from '@aplos/contract';
import { PausedError, ProviderError } from '../ports/base';
import type { AccountActorHost, ConnectRequest, ConnectResult, ProviderKind } from '../ports';
import type { FrameBus } from '../runtime/frames';
import type { EngineServices } from '../runtime/services';

// Connect, reconnect and permission grants run in the background, one live sign-in per account. The caller gets a
// `connectId` at once; `connect` frames report the outcome (freeze FR-23). A frame carries a copy key and never a
// sentence, a token or a secret.

/** What one sign-in does once the provider answered. Throw a `ContractError` to refuse the answer and store nothing. */
export type AcceptOutcome = { accountId?: string } | void;

export interface ConnectFlow {
  mode: Extract<Frame, { frame: 'connect' }>['mode'];
  accountId: string;
  /** One live sign-in per key: the account for a reconnect or grant, the address (or none) for a new account. */
  key: string;
  kind: ProviderKind;
  request: ConnectRequest;
  /** May answer with the id of the account it actually stored, when that is not `accountId` (a retried new account). */
  accept(result: ConnectResult): Promise<AcceptOutcome> | AcceptOutcome;
}

interface Session {
  connectId: string;
  flow: ConnectFlow;
  controller: AbortController;
  /** The provider answered and the engine is storing it: too late to cancel. */
  accepting: boolean;
  /** The account the sign-in ended up on, when the flow reports one other than its own. */
  storedAccountId?: string;
}

export const ALREADY_OPEN =
  'A sign-in for this account is already open. Finish it or cancel it first.';

export class ConnectSessions {
  private readonly byId = new Map<string, Session>();
  private readonly byKey = new Map<string, Session>();

  constructor(
    private readonly accounts: AccountActorHost,
    private readonly frames: FrameBus,
    private readonly randomBytes: (n: number) => Uint8Array,
  ) {}

  /** Starts the sign-in and returns its id at once; the first frame follows on the next turn. */
  begin(flow: ConnectFlow): { connectId: string } {
    if (this.byKey.has(flow.key))
      throw new ContractError({ type: 'conflict', message: ALREADY_OPEN });
    const session: Session = {
      connectId: hexId(this.randomBytes, 'c'),
      flow,
      controller: new AbortController(),
      accepting: false,
    };
    this.byId.set(session.connectId, session);
    this.byKey.set(flow.key, session);
    setTimeout(() => void this.run(session), 0);
    return { connectId: session.connectId };
  }

  /** False when nothing is waiting under this id (finished, unknown, or already being stored). */
  cancel(connectId: string): boolean {
    const session = this.byId.get(connectId);
    if (!session || session.accepting) return false;
    session.controller.abort();
    this.release(session);
    this.emit(session, 'cancelled');
    return true;
  }

  private async run(session: Session): Promise<void> {
    const { signal } = session.controller;
    if (signal.aborted) return;
    this.emit(session, 'waiting');
    try {
      const { accountId, kind, request } = session.flow;
      // TODO(port): `AccountActorHost.connect` takes no AbortSignal, so a cancel only drops the answer here; the host's
      // browser or loopback flow runs on until its own timeout. Needs a `signal` on the port or on `ConnectRequest`.
      const result = await untilAborted(this.accounts.connect(accountId, kind, request), signal);
      // The answer can win the race and still be followed by a cancel before this line runs: the cancel stands.
      if (result === ABORTED || signal.aborted) return;
      session.accepting = true;
      const outcome = await session.flow.accept(result);
      if (outcome?.accountId) session.storedAccountId = outcome.accountId;
      this.release(session);
      this.emit(session, 'connected');
    } catch (error) {
      if (signal.aborted) return;
      this.release(session);
      this.emit(session, 'failed', failureCode(error));
    }
  }

  /** Engine stop: abort every waiting sign-in without a frame (the connections are closing) and forget them. */
  dispose(): void {
    for (const session of this.byId.values()) session.controller.abort();
    this.byId.clear();
    this.byKey.clear();
  }

  private release(session: Session): void {
    this.byId.delete(session.connectId);
    if (this.byKey.get(session.flow.key) === session) this.byKey.delete(session.flow.key);
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

const sessionsByEngine = new WeakMap<object, ConnectSessions>();

/** One map of live sign-ins per engine; the engine's own account actors host keys it. */
export function connectSessionsOf(services: EngineServices): ConnectSessions {
  let sessions = sessionsByEngine.get(services.accounts);
  if (!sessions) {
    sessions = new ConnectSessions(services.accounts, services.frames, services.randomBytes);
    sessionsByEngine.set(services.accounts, sessions);
  }
  return sessions;
}

/**
 * Aborts and forgets this engine's waiting sign-ins. NOTE: nothing calls it yet. The composition root
 * (`src/index.ts`, eng-contract's) has no prov-gov lane module, so there is no `LaneModule.stop` to hang it on; the
 * module that adds one (`sync/module.ts`) must call this from its `stop`.
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
