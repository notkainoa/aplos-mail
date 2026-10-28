import type {
  Account,
  AiJob,
  Calendar,
  Client,
  Consent,
  Conversation,
  Draft,
  Event,
  Folder,
  Message,
  Output,
  Plan,
  SenderRule,
  Settings,
  State,
  Submission,
  ThreadRow,
} from '@aplos/contract';

type FollowupSuggestion = NonNullable<Output<'Ai/followup'>['suggestion']>;

/** One account's first-sync progress, the source of `Setup/status` (plan 10 section 4.1). */
export interface SetupRecord {
  id: string;
  state:
    | 'connecting'
    | 'finding'
    | 'reading'
    | 'sorting'
    | 'ready'
    | 'paused'
    | 'failed'
    | 'notConnected';
  found?: number;
  read: number;
  total: number;
  done: boolean;
  ai?: { sorted: number; total: number; capped: number; failed: number; reasonCode?: string };
  backfill: { read: number; target: number };
  pausedUntil?: number;
  reasonCode?: string;
  runId: string;
  errors: {
    phase: 'connect' | 'firstWindow' | 'ai' | 'backfill';
    reasonCode: string;
    at: number;
  }[];
}

/** Session-level facts that are not rows of their own. */
export interface MetaRecord {
  id: 'meta';
  setup: { completedAt?: number; skippedAt?: number };
  engine: {
    state: 'starting' | 'ready' | 'parked';
    parked?: { reasonCode: string; message: string; at: number; canRetry: boolean };
  };
  listener: { enabled: boolean };
  workflowSync: boolean;
  verboseUntil?: number;
  usage: { backgroundTokens: number; pausedUntil?: number };
  /** Provider id → where its key comes from. The fixture never holds a key or any of its characters. */
  keys: Record<string, { keySource: 'env' | 'keychain' | 'none' }>;
}

/** Every table of the fixture's database, keyed by row id. Singletons use a fixed id. */
export interface Tables {
  Account: Account;
  Thread: ThreadRow;
  Message: Message;
  Draft: Draft;
  Submission: Submission;
  Event: Event;
  Calendar: Calendar;
  Plan: Plan;
  Conversation: Conversation;
  Folder: Folder;
  SenderRule: SenderRule;
  AiJob: AiJob;
  Client: Client;
  Followup: FollowupSuggestion & { id: string };
  Settings: Settings & { id: 'settings' };
  Consent: Consent & { id: 'background' };
  Setup: SetupRecord;
  Meta: MetaRecord;
}
export type Table = keyof Tables;
export const tableNames: Table[] = [
  'Account',
  'Thread',
  'Message',
  'Draft',
  'Submission',
  'Event',
  'Calendar',
  'Plan',
  'Conversation',
  'Folder',
  'SenderRule',
  'AiJob',
  'Client',
  'Followup',
  'Settings',
  'Consent',
  'Setup',
  'Meta',
];

/** The `state` frame's type for each table (wire `ChangeType`). */
const changeType: Record<Table, string> = {
  Account: 'Account',
  Thread: 'Thread',
  Message: 'Message',
  Draft: 'Draft',
  Submission: 'Submission',
  Event: 'Event',
  Calendar: 'Calendar',
  Plan: 'Plan',
  Conversation: 'Conversation',
  Folder: 'Folder',
  SenderRule: 'SenderRule',
  AiJob: 'AiJob',
  Client: 'Client',
  Followup: 'Thread',
  Settings: 'Settings',
  Consent: 'Consent',
  Setup: 'Setup',
  Meta: 'Session',
};

export interface LogEntry {
  seq: number;
  type: string;
  id: string;
  op: 'u' | 'd';
}
/** One row a commit touched: what it was before the commit and after it (absent when it did not exist). */
export interface Touch {
  table: Table;
  id: string;
  before?: unknown;
  after?: unknown;
}

export interface Tx {
  get<T extends Table>(table: T, id: string): Tables[T] | undefined;
  /** Writes a row; a row with `rev` gets the next revision, so windows report it in `changed` and clients re-read it. */
  put<T extends Table>(table: T, row: Tables[T]): Tables[T];
  del(table: Table, id: string): void;
  /** The rows this transaction has touched so far. */
  touched(): Touch[];
}

/**
 * The in-memory database: tables, a change log with a floor (older states get `cannotCalculateChanges`), and
 * commits that record each touched row's before- and after-image, which `Operation/undo`, a failed write and
 * `Operation/retry` replay. One commit is one `seq`.
 */
export class Store {
  readonly tables = Object.fromEntries(tableNames.map(t => [t, new Map()])) as {
    [T in Table]: Map<string, Tables[T]>;
  };
  seq = 1;
  floor = 1;
  log: LogEntry[] = [];
  /** `table + id` → the seq that created the row, so a `ThreadSelector` resolved at an older state skips newer rows. */
  born = new Map<string, number>();
  /** How many log entries survive before the floor moves up (a real engine compacts its change log too). */
  maxLog = 5_000;

  constructor(public dbEpoch: string) {}

  get state(): State {
    return { dbEpoch: this.dbEpoch, seq: this.seq };
  }

  get<T extends Table>(table: T, id: string): Tables[T] | undefined {
    return this.tables[table].get(id);
  }
  all<T extends Table>(table: T): Tables[T][] {
    return [...this.tables[table].values()];
  }

  /** Loads a row with no commit, for building a scenario. */
  seed<T extends Table>(table: T, row: Tables[T]) {
    this.tables[table].set((row as { id: string }).id, row);
  }

  commit<V>(fn: (tx: Tx) => V): { value: V; touched: Touch[]; types: Set<string> } {
    const touched = new Map<string, Touch>();
    const touch = (table: Table, id: string) => {
      const key = `${table}\u0000${id}`;
      let t = touched.get(key);
      if (!t) touched.set(key, (t = { table, id, before: this.tables[table].get(id) }));
      return t;
    };
    const tx: Tx = {
      get: (table, id) => this.tables[table].get(id),
      put: (table, row) => {
        const id = (row as { id: string }).id;
        const t = touch(table, id);
        const prev = this.tables[table].get(id) as { rev?: number } | undefined;
        const next =
          'rev' in (row as object)
            ? { ...row, rev: Math.max(prev?.rev ?? 0, (row as { rev: number }).rev ?? 0) + 1 }
            : row;
        this.tables[table].set(id, next as Tables[typeof table]);
        t.after = next;
        return next as Tables[typeof table];
      },
      del: (table, id) => {
        if (this.tables[table].has(id)) {
          touch(table, id).after = undefined;
          this.tables[table].delete(id);
        }
      },
      touched: () => [...touched.values()],
    };
    const value = fn(tx);
    const changes = [...touched.values()].filter(t => t.before !== t.after);
    const types = new Set<string>();
    if (changes.length) {
      this.seq += 1;
      for (const t of changes) {
        types.add(changeType[t.table]);
        this.log.push({
          seq: this.seq,
          type: changeType[t.table],
          id: t.id,
          op: t.after === undefined ? 'd' : 'u',
        });
        if (t.before === undefined) this.born.set(`${t.table}\u0000${t.id}`, this.seq);
      }
      if (types.has('Thread') || types.has('Draft') || types.has('Submission')) types.add('Counts');
      if (this.log.length > this.maxLog)
        this.compact(this.log[this.log.length - this.maxLog]!.seq - 1);
    }
    return { value, touched: changes, types };
  }

  /** Drops log entries at or below `seq`; a state below the new floor can no longer be caught up. */
  compact(seq = this.seq) {
    this.floor = Math.max(this.floor, Math.min(seq, this.seq));
    this.log = this.log.filter(e => e.seq > this.floor);
  }
}
