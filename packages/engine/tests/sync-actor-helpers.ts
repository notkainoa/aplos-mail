import { FakeClock } from '../../emulators/src/kit/clock';
import { openStore, type StorePort } from '../src/store';
import type {
  AccountId,
  AdapterAccount,
  AdapterContext,
  AttachmentRef,
  BudgetSpec,
  Clock,
  CoalescedOp,
  ConnectResult,
  DeadlineRegistry,
  DeadlineSource,
  FindSentResult,
  Logger,
  MessageFacts,
  OpenedThread,
  OpOutcome,
  PendingOp,
  PlanEnv,
  PlanInput,
  PlannedStep,
  ProviderAdapter,
  ProviderFactory,
  SendReceipt,
  StepResult,
  SubmissionPayload,
  SyncState,
  ThreadOpenRef,
  WorkflowChannel,
} from '../src/ports';
import { gmailBudget } from '../src/sync/budgets';
import { Governor } from '../src/sync/governor';
import { ActorHost, type ActorHostOptions } from '../src/sync/host';
import { tempDb } from './store/helpers';

export { FakeClock };
export const ACCOUNT = 'acct-1';
export const ADDRESS = 'owner@example.test';
export const MINUTE = 60_000;

/** The F3 clock over the emulator kit's fake clock (which has no `timer`). */
export function portClock(fake: FakeClock): Clock {
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

/** A clock that reads `skew()` off the one it wraps (a skew that changes is a clock set forward or back). */
function skewed(clock: Clock, skew: () => number): Clock {
  return {
    now: () => clock.now() + skew(),
    sleep: (ms, signal) => clock.sleep(ms, signal),
    timer: (at, fire) => clock.timer(at - skew(), fire),
  };
}

/** Records registered deadline sources; the tests fire them by hand. */
export class FakeDeadlines implements DeadlineRegistry {
  readonly sources = new Map<string, DeadlineSource>();
  readonly changes: string[] = [];
  register(source: DeadlineSource) {
    this.sources.set(source.id, source);
    return () => {
      if (this.sources.get(source.id) === source) this.sources.delete(source.id);
    };
  }
  changed(id: string) {
    this.changes.push(id);
  }
}

export interface LogLine {
  event: string;
  fields: Record<string, unknown>;
}

export function fakeLogger(lines: LogLine[] = []): Logger {
  const logger: Logger = {
    event: (event, fields) => {
      lines.push({ event, fields: fields as Record<string, unknown> });
    },
    with: () => logger,
    enabled: () => true,
  };
  return logger;
}

export type StepFn = (
  step: PlannedStep,
  state: SyncState,
  ctx: AdapterContext,
) => Promise<StepResult>;

/**
 * A scriptable adapter: `planner` is the pure plan, `steps` runs each scope. Every call is logged as
 * `scope:pageToken`, and every request goes through `ctx.governor.run` like a real adapter's.
 */
export class FakeAdapter implements ProviderAdapter {
  readonly kind = 'google' as const;
  readonly calls: string[] = [];
  readonly plans: PlanInput[] = [];
  readonly applied: string[][] = [];
  closed = false;
  workflow?: WorkflowChannel;
  applyFn: (op: CoalescedOp, ctx: AdapterContext) => Promise<OpOutcome[]> = async op =>
    op.opIds.map(opId => ({ opId, result: 'applied' }));

  constructor(
    public planner: (input: PlanInput) => PlannedStep[],
    public steps: Record<string, StepFn>,
  ) {}

  plan(input: PlanInput): PlannedStep[] {
    this.plans.push(input);
    return this.planner(input);
  }

  async syncStep(step: PlannedStep, state: SyncState, ctx: AdapterContext): Promise<StepResult> {
    this.calls.push(`${step.scope}:${state.pageToken ?? ''}`);
    const fn = this.steps[step.scope];
    if (!fn) throw new Error(`no fake step for ${step.scope}`);
    return fn(step, state, ctx);
  }

  async openThread(
    _ref: ThreadOpenRef,
    _lane: 'interactive' | 'prefetch',
    _ctx: AdapterContext,
  ): Promise<OpenedThread> {
    return { messages: [], costUnits: 0 };
  }

  async fetchAttachment(
    _ref: AttachmentRef,
    _ctx: AdapterContext,
  ): Promise<AsyncIterable<Uint8Array>> {
    return (async function* () {})();
  }

  coalesce(ops: PendingOp[]): CoalescedOp[] {
    return ops.map(op => ({ opIds: [op.opId], method: 'fake.modify', cost: 5, body: op }));
  }

  async apply(op: CoalescedOp, ctx: AdapterContext): Promise<OpOutcome[]> {
    this.calls.push(`apply:${op.opIds.join(',')}`);
    this.applied.push(op.opIds);
    return ctx.governor.run(
      {
        budget: 'gmail',
        lane: 'opFlush',
        kind: 'idempotentWrite',
        method: op.method,
        cost: op.cost,
      },
      () => this.applyFn(op, ctx),
    );
  }

  async send(_submission: SubmissionPayload, _ctx: AdapterContext): Promise<SendReceipt> {
    throw new Error('not in this fake');
  }

  async findSent(
    _internetId: string,
    _since: number,
    _ctx: AdapterContext,
  ): Promise<FindSentResult> {
    return { kind: 'absent', checkedAt: 0 };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** A governed read on the step's lane, then `body`: how every fake step reaches the "network". */
export function governed<T>(
  ctx: AdapterContext,
  step: PlannedStep,
  cost: number,
  body: () => Promise<T> | T = () => undefined as T,
): Promise<T> {
  return ctx.governor.run(
    { budget: 'gmail', lane: step.lane, kind: 'read', method: `fake.${step.scope}`, cost },
    async () => body(),
  );
}

export function fact(
  remoteId: string,
  minutes: number,
  extra: Partial<MessageFacts> = {},
): MessageFacts {
  return {
    remoteId,
    remoteThreadId: `t-${remoteId}`,
    from: { address: `sender-${remoteId}@example.test` },
    to: [{ address: ADDRESS }],
    cc: [],
    subject: `Subject ${remoteId}`,
    date: T0 + minutes * MINUTE,
    internalDate: T0 + minutes * MINUTE,
    flags: { seen: false, flagged: false, draft: false, fromMe: false },
    placements: [{ folder: 'INBOX' }],
    list: {},
    partial: true,
    ...extra,
  };
}

export const T0 = Date.UTC(2026, 9, 20, 16, 0, 0);

export interface World {
  clock: FakeClock;
  /** The host's clock: the shared fake clock plus this device's skew. */
  now(): number;
  store: StorePort;
  governor: Governor;
  host: ActorHost;
  deadlines: FakeDeadlines;
  logs: LogLine[];
  env: PlanEnv;
  /** Simulates a crash: stops the host without waiting for anything and closes the database. */
  kill(): Promise<void>;
}

export interface Disk {
  file: ReturnType<typeof tempDb>;
  cleanup(): void;
}

export function disk(): Disk {
  const file = tempDb();
  return { file, cleanup: () => file.cleanup() };
}

let ids = 0;

/** One engine process on `disk`: a store on the file, a governor, and the actor host with one fake provider. */
export function world(
  d: Disk,
  adapter: (account: AdapterAccount) => FakeAdapter,
  options: {
    clock?: FakeClock;
    budgets?: BudgetSpec[];
    create?: boolean;
    random?: () => number;
    deviceId?: string;
    host?: ActorHostOptions;
    /** This device's clock runs this far ahead of the shared fake clock (negative: behind); the host sees it. */
    skewMs?: number;
    /** The same, read on every use (overrides `skewMs`): a test sets the clock forward or back with it. */
    skew?: () => number;
  } = {},
): World {
  const clock = options.clock ?? new FakeClock({ auto: false });
  const skew = options.skew ?? (() => options.skewMs ?? 0);
  const store = openStore(d.file.open(), { now: () => clock.now() });
  const logs: LogLine[] = [];
  const log = fakeLogger(logs);
  const governor = new Governor({ clock, role: 'secondary', random: () => 0 });
  const deadlines = new FakeDeadlines();
  const env: PlanEnv = { now: clock.now(), focused: false, windowVisible: true, onBattery: false };
  const factory: ProviderFactory = {
    kind: 'google',
    connect: async () => {
      throw new Error('not in this fake');
    },
    budgets: () => options.budgets ?? [gmailBudget],
    open: account => adapter(account),
  };
  if (
    options.create !== false &&
    !store.read(q => q.get('SELECT 1 FROM accounts WHERE id = ?', ACCOUNT))
  ) {
    store.commit({
      opId: 'setup',
      origin: 'system',
      writes: [
        {
          kind: 'account',
          id: ACCOUNT,
          provider: 'google',
          address: ADDRESS,
          capabilities: { labels: true, drafts: true, threading: 'native' },
          status: { state: 'ok' },
        },
        {
          kind: 'folder',
          accountId: ACCOUNT,
          remoteId: 'INBOX',
          name: 'Inbox',
          role: 'inbox',
          folderKind: 'system',
        },
        {
          kind: 'folder',
          accountId: ACCOUNT,
          remoteId: 'TRASH',
          name: 'Trash',
          role: 'trash',
          folderKind: 'system',
        },
      ],
    });
  }
  const host = new ActorHost(
    {
      store,
      governor,
      providers: [factory],
      tokens: { cached: () => undefined, refresh: async () => ({ token: 'unused', expiresAt: 0 }) },
      clock: skewed(portClock(clock), skew),
      log,
      deadlines,
      deviceId: options.deviceId ?? 'device-a',
      env: () => env,
    },
    { newId: () => `commit-${++ids}`, random: options.random ?? (() => 0), ...options.host },
  );
  return {
    clock,
    now: () => clock.now() + skew(),
    store,
    governor,
    host,
    deadlines,
    logs,
    env,
    async kill() {
      await host.dispose();
      store.close();
    },
  };
}

/** Let promise callbacks and the fake clock's quiet checks run. */
export async function settle(turns = 10): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>(resolve => setImmediate(resolve));
}

/** Settles until `cond` holds; fails after `turns` rounds. Time does not move. */
export async function until(cond: () => boolean, what: string, turns = 200): Promise<void> {
  for (let i = 0; i < turns; i++) {
    if (cond()) return;
    await settle(2);
  }
  throw new Error(`timed out waiting for ${what}`);
}

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function connectResult(extra: Partial<ConnectResult> = {}): ConnectResult {
  return {
    identity: { subject: 'sub-1', address: ADDRESS },
    grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'],
    capabilities: {
      labels: true,
      folders: false,
      drafts: true,
      serverSearch: true,
      calendar: false,
      filters: false,
      push: false,
      sendAs: false,
      unsubscribeHeaders: true,
      threading: 'native',
    },
    grant: { grantedAt: T0, refreshExpiresAt: T0 + 7 * 86_400_000, client: 'client-fingerprint' },
    credentialRef: 'vault:test',
    ...extra,
  };
}

export const messagesIn = (store: StorePort, folder: string): string[] =>
  store.read(q =>
    q
      .all<{ id: string }>(
        `SELECT m.remote_id AS id FROM message_folders mf JOIN messages m ON m.id = mf.message_id
        JOIN folders f ON f.id = mf.folder_id WHERE f.remote_id = ? AND m.account_id = ? ORDER BY m.remote_id`,
        folder,
        ACCOUNT,
      )
      .map(r => r.id),
  );

export const stateOf = (store: StorePort, scope: string) =>
  store.read(q =>
    q.get<{
      page_token: string | null;
      cursor: string | null;
      generation: number;
      phase: string | null;
    }>(
      'SELECT page_token, cursor, generation, phase FROM sync_state WHERE account_id = ? AND scope = ?',
      ACCOUNT,
      scope,
    ),
  );

export const accountRow = (store: StorePort, account: AccountId = ACCOUNT) =>
  store.read(q =>
    q.get<{
      status: string;
      status_reason: string | null;
      status_reason_code: string | null;
      resume_at: number | null;
      baseline_done_at: number | null;
      refresh_expires_at: number | null;
      remote_subject: string | null;
    }>('SELECT * FROM accounts WHERE id = ?', account),
  )!;
