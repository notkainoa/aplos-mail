import { ContractError } from '@aplos/contract/contract-error';
import type { Frame } from '@aplos/contract';
import { PausedError, ProviderError } from '../ports/base';
import type { AccountActorHost, ConnectRequest, ConnectResult, ProviderKind } from '../ports';
import type { FrameBus } from '../runtime/frames';

// Connect, reconnect and permission grants run in the background, one live sign-in per account. The caller gets a
// `connectId` at once; `connect` frames report the outcome (freeze FR-23). A frame carries a copy key and never a
// sentence, a token or a secret.

/** What one sign-in does once the provider answered. Throw a `ContractError` to refuse the answer and store nothing. */
export interface ConnectFlow {
  mode: Extract<Frame, { frame: 'connect' }>['mode'];
  accountId: string;
  /** One live sign-in per key: the account for a reconnect or grant, the address (or none) for a new account. */
  key: string;
  kind: ProviderKind;
  request: ConnectRequest;
  accept(result: ConnectResult): Promise<void> | void;
}

interface Session {
  connectId: string;
  flow: ConnectFlow;
  controller: AbortController;
  /** The provider answered and the engine is storing it: too late to cancel. */
  accepting: boolean;
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
      const result = await untilAborted(this.accounts.connect(accountId, kind, request), signal);
      if (result === ABORTED) return;
      session.accepting = true;
      await session.flow.accept(result);
      this.release(session);
      this.emit(session, 'connected');
    } catch (error) {
      if (signal.aborted) return;
      this.release(session);
      this.emit(session, 'failed', failureCode(error));
    }
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
    const { mode, accountId } = session.flow;
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
