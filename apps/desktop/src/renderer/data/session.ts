/**
 * Session, connection and the small singletons (plan 30 4.1 `session.ts`, ARCH 6.4 and 9.5): `Session/get` with the
 * `apiVersion` check, accounts, counts, settings, consent and first-sync status, each re-read when a `state` frame
 * names its type. `pickStatus` chooses the status slot's one line in DESIGN 7.1's order.
 */
import { apiVersion } from '@aplos/contract';
import type {
  Account,
  AccountId,
  AccountStatus,
  Consent,
  Counts,
  CountsBlock,
  EpochMs,
  Frame,
  MethodName,
  ReasonCode,
  Session,
  SetupStatus,
  Settings,
} from './contract-shapes';
import { toErrorBody, UNREACHABLE_MESSAGE, type DataClient } from './client';
import { SESSION_TOPIC, sameJson, type Emitter } from './emitter';
import type { ConnectionView, CountsView, StatusSlotState } from './index';

/** Most urgent first (DESIGN 7.1). `reconnectSoon` sits between `offline` and `backfilling`. */
export const STATUS_PRIORITY = [
  'misconfigured',
  'needsReauth',
  'needsPermission',
  'needsAdmin',
  'error',
  'paused',
  'offline',
  'reconnectSoon',
  'backfilling',
  'syncing',
  'starting',
  'demo',
  'ok',
] as const;

const DAY_MS = 86_400_000;
const KNOWN_STATES = new Set<string>(STATUS_PRIORITY);

function rankOf(account: Account, now: EpochMs): number {
  const state: string = account.health.status.state;
  const known = KNOWN_STATES.has(state) && state !== 'reconnectSoon' && state !== 'demo';
  const base = known ? state : 'error';
  if (base === 'ok' || base === 'syncing' || base === 'starting' || base === 'backfilling') {
    const by = account.health.reconnectBy;
    if (by !== undefined && by - now <= DAY_MS) return STATUS_PRIORITY.indexOf('reconnectSoon');
    if (base === 'ok' && account.demo) return STATUS_PRIORITY.indexOf('demo');
  }
  return STATUS_PRIORITY.indexOf(base as (typeof STATUS_PRIORITY)[number]);
}

/** The one status line for a scope: the most urgent account; an unknown state from a newer engine counts as `error`. */
export function pickStatus(
  accounts: readonly Account[],
  accountId: AccountId | undefined,
  now: EpochMs,
): StatusSlotState | undefined {
  const scope = accountId ? accounts.filter(a => a.id === accountId) : accounts;
  if (!scope.length) return undefined;
  const soonRank = STATUS_PRIORITY.indexOf('reconnectSoon');
  let best = scope[0]!;
  let bestRank = rankOf(best, now);
  for (const account of scope.slice(1)) {
    const rank = rankOf(account, now);
    const earlier =
      rank === soonRank &&
      bestRank === soonRank &&
      (account.health.reconnectBy ?? Infinity) < (best.health.reconnectBy ?? Infinity);
    if (rank < bestRank || earlier) [best, bestRank] = [account, rank];
  }
  const raw = best.health.status;
  const status: AccountStatus = KNOWN_STATES.has(raw.state)
    ? raw
    : { state: 'error', reason: (raw as { reason?: string }).reason ?? raw.state };
  const by = best.health.reconnectBy;
  return {
    account: best,
    status,
    reasonCode: (best.health.reasonCode as ReasonCode | undefined) ?? null,
    reconnectSoon: by !== undefined && by - now <= DAY_MS,
    demo: bestRank === STATUS_PRIORITY.indexOf('demo'),
  };
}

export const ZERO_COUNTS: CountsBlock = {
  home: 0,
  do: 0,
  update: 0,
  follow: 0,
  laterDue: 0,
  drafts: 0,
  scheduled: 0,
  unread: 0,
  handledToday: 0,
};

/** Counts for a scope; hidden while any account in it has not finished its first sync (DESIGN 7.1). */
export function countsFor(
  counts: Counts | undefined,
  accounts: readonly Account[],
  accountId: AccountId | undefined,
): CountsView {
  const scope = accountId ? accounts.filter(a => a.id === accountId) : accounts;
  return {
    counts: (accountId ? counts?.accounts[accountId] : counts?.all) ?? ZERO_COUNTS,
    folders: counts?.folders ?? {},
    hidden: !counts || scope.some(a => a.baselineDoneAt === undefined),
  };
}

type Singleton = 'session' | 'accounts' | 'counts' | 'settings' | 'consent' | 'setup';

/** Which singletons a `state` frame's types re-read. */
const READS_ON: Record<string, readonly Singleton[]> = {
  Session: ['session'],
  // First sync is mail progress: account status transitions and each committed mail batch re-read Setup/status.
  Account: ['accounts', 'setup'],
  Counts: ['counts'],
  Settings: ['settings'],
  Consent: ['consent'],
  Setup: ['setup'],
  Thread: ['setup'],
  Message: ['setup'],
};

const CONNECTING: ConnectionView = {
  state: 'connecting',
  reason: null,
  reasonCode: null,
  canRetry: true,
};

export class SessionStore {
  session: Session | undefined;
  accounts: readonly Account[] = [];
  /** True once `Account/get` has answered at least once (an empty list is then a real answer, not "not yet"). */
  accountsLoaded = false;
  counts: Counts | undefined;
  settings: Settings | undefined;
  consent: Consent | undefined;
  setup: SetupStatus | undefined;
  connection: ConnectionView = CONNECTING;
  private readonly loaded = new Set<Singleton>();
  private readonly generation = new Map<Singleton, number>();

  constructor(
    private readonly client: DataClient,
    private readonly emitter: Emitter,
    private readonly onSession: (session: Session) => void = () => {},
  ) {}

  start(): void {
    this.read('session');
  }

  /** Read a singleton on first use. */
  want(name: Singleton): void {
    if (this.loaded.has(name)) return;
    this.read(name);
  }

  frame(frame: Frame): void {
    if (frame.frame === 'reset') {
      for (const name of this.loaded) this.read(name);
    } else if (frame.frame === 'state') {
      const again = new Set<Singleton>();
      for (const type of Object.keys(frame.types))
        for (const name of READS_ON[type] ?? []) if (this.loaded.has(name)) again.add(name);
      for (const name of again) this.read(name);
    } else if (frame.frame === 'host' && frame.event.type === 'parked') {
      this.setConnection({
        state: 'parked',
        reason: frame.event.message,
        reasonCode: frame.event.reasonCode,
        canRetry: frame.event.canRetry,
      });
    } else if (frame.frame === 'desktop' && frame.event.type === 'engine') {
      const e = frame.event;
      const known = ['connecting', 'ready', 'unreachable', 'parked'].includes(e.state);
      const state = (known ? e.state : 'unreachable') as ConnectionView['state'];
      this.setConnection({
        state,
        reason: e.message ?? (state === 'unreachable' ? UNREACHABLE_MESSAGE : null),
        reasonCode: e.reasonCode ?? null,
        canRetry: e.canRetry ?? true,
      });
      if (state === 'ready') for (const name of this.loaded) this.read(name);
    }
  }

  private setConnection(next: ConnectionView): void {
    if (sameJson(next, this.connection)) return;
    this.connection = next;
    this.emitter.emit(SESSION_TOPIC);
  }

  private read(name: Singleton): void {
    this.loaded.add(name);
    const generation = (this.generation.get(name) ?? 0) + 1;
    this.generation.set(name, generation);
    const current = () => this.generation.get(name) === generation;
    const call = <M extends MethodName>(method: M, args: unknown) =>
      this.client.call(method, args as never);
    switch (name) {
      case 'session':
        call('Session/get', {}).then(
          session => {
            if (!current()) return;
            this.session = session;
            this.onSession(session);
            if (session.apiVersion !== apiVersion)
              this.setConnection({
                state: 'unreachable',
                reason: UNREACHABLE_MESSAGE,
                reasonCode: 'apiVersion',
                canRetry: false,
              });
            else if (session.engine.state === 'parked' && session.engine.parked)
              this.setConnection({
                state: 'parked',
                reason: session.engine.parked.message,
                reasonCode: session.engine.parked.reasonCode,
                canRetry: session.engine.parked.canRetry,
              });
            else if (this.connection.state === 'connecting')
              this.setConnection({
                state: 'ready',
                reason: null,
                reasonCode: null,
                canRetry: true,
              });
            // The epoch and the engine clock may have moved: every store re-reads.
            this.emitter.emit();
          },
          error => {
            if (!current()) return;
            // A parked engine (main said so) stays parked: its port is refused, which is not "unreachable".
            if (this.connection.state === 'parked') return;
            const body = toErrorBody(error);
            this.setConnection({
              state: 'unreachable',
              reason: body.message,
              reasonCode: body.reasonCode ?? null,
              canRetry: true,
            });
          },
        );
        return;
      case 'accounts':
        call('Account/get', {}).then(r => {
          if (!current()) return;
          const first = !this.accountsLoaded;
          this.accountsLoaded = true;
          if (!sameJson(r.list, this.accounts)) this.accounts = r.list;
          else if (!first) return;
          this.emitter.emit(SESSION_TOPIC);
        }, noop);
        return;
      case 'counts':
        call('Counts/get', {}).then(r => this.store(current, 'counts', r), noop);
        return;
      case 'settings':
        call('Settings/get', {}).then(r => this.store(current, 'settings', r), noop);
        return;
      case 'consent':
        call('Consent/get', {}).then(r => this.store(current, 'consent', r), noop);
        return;
      case 'setup':
        call('Setup/status', {}).then(r => this.store(current, 'setup', r), noop);
        return;
    }
  }

  private store<K extends 'counts' | 'settings' | 'consent' | 'setup'>(
    current: () => boolean,
    key: K,
    value: SessionStore[K],
  ): void {
    if (!current() || sameJson(value, this[key])) return;
    (this as SessionStore)[key] = value;
    this.emitter.emit(SESSION_TOPIC);
  }
}

const noop = () => {};
