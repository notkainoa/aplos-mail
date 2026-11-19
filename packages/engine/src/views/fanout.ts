import type { ViewSpec } from '@aplos/contract';
import { isAbsent } from '../runtime/engine';
import type { Clock, DeadlineRegistry, DeadlineSource, StorePort, Timer } from '../ports';
import type { Change } from '../store';

/*
 * Fan-out (views-2): after a commit, the change rows since the last look become one summary, and the summary decides
 * which open windows might have moved (gated by the row types a view shows and by account). A window is only marked;
 * the window engine re-runs it at most four times a second. A coarse backfill commit is a handful of `*` rows, so it
 * costs one summary and one mark per window, never a pass over its rows.
 */

/** Fine ids kept per type; a commit with more is treated as touching the whole type. */
const ID_CAP = 2_000;
const PAGE = 1_000;

export interface ChangeSummary {
  /** The seq this summary is complete up to. */
  seq: number;
  /** type -> account ids it touched (`''` for a type with no account, such as settings). */
  accounts: Map<string, Set<string>>;
  /** type -> changed ids; an empty set for a type that overflowed `ID_CAP` or changed coarsely (ids unknown). */
  ids: Map<string, Set<string>>;
  /** Threads that were deleted, so a frozen order can drop them. */
  deleted: Set<string>;
}

export type Summary = ChangeSummary | 'void';

const empty = (seq: number): ChangeSummary => ({
  seq,
  accounts: new Map(),
  ids: new Map(),
  deleted: new Set(),
});

/** The account an id belongs to: the longest account id that prefixes it (an account id may hold a colon). */
export function accountOf(id: string, accounts: readonly string[]): string {
  let best = '';
  for (const a of accounts)
    if ((id === a || id.startsWith(`${a}:`)) && a.length > best.length) best = a;
  return best;
}

/** Everything committed after `since`, or `'void'` when the log no longer reaches back that far. */
export function summarize(store: StorePort, since: number, accounts: readonly string[]): Summary {
  const sum = empty(since);
  let from = since;
  for (;;) {
    const page = store.changesSince(from, { limit: PAGE });
    if (page.status !== 'ok') return 'void';
    for (const change of page.changes) add(sum, change, accounts);
    sum.seq = page.toSeq;
    if (!page.hasMore || page.toSeq <= from) return sum;
    from = page.toSeq;
  }
}

function add(sum: ChangeSummary, change: Change, accounts: readonly string[]): void {
  // An Account row also moves for every queued change (`pendingChanges`); only its removal changes what a view holds.
  if (change.type === 'Account' && change.op !== 'd') return;
  const account = accountOf(change.id, accounts);
  let touched = sum.accounts.get(change.type);
  if (!touched) sum.accounts.set(change.type, (touched = new Set()));
  touched.add(account);
  if (change.op === 'd' && change.type === 'Thread') sum.deleted.add(change.id);
  addId(sum, change);
}

function addId(sum: ChangeSummary, change: Change): void {
  if (change.op === '*') return void sum.ids.set(change.type, new Set<string>());
  const seen = sum.ids.get(change.type);
  if (seen && seen.size === 0) return; // already coarse
  if (seen && seen.size >= ID_CAP) return void sum.ids.set(change.type, new Set<string>());
  if (seen) seen.add(change.id);
  else sum.ids.set(change.type, new Set([change.id]));
}

// ------------------------------------------------------------ which windows a summary reaches

/** What a spec depends on: the change types its rows come from. */
export function typesOf(spec: ViewSpec): readonly string[] {
  switch (spec.kind) {
    case 'drafts':
      return ['Draft'];
    case 'scheduled':
      return ['Submission', 'Draft'];
    case 'thread':
      return ['Message', 'Thread'];
    case 'events':
      return ['Event', 'Calendar'];
    case 'plans':
      return ['Plan'];
    case 'conversations':
      return ['Conversation'];
    case 'mailbox':
    case 'label':
    case 'search':
      return ['Thread', 'Folder', 'Account'];
    case 'home':
    case 'homeSection':
      return ['Thread', 'Account', 'Setting', 'Settings'];
    default:
      return ['Thread', 'Account'];
  }
}

/** The one account a spec is limited to, if any; `accounts` splits a folder or thread id. */
export function accountFilter(spec: ViewSpec, accounts: readonly string[]): string | undefined {
  if (spec.kind === 'label') return accountOf(spec.folderId, accounts) || undefined;
  if (spec.kind === 'thread') return accountOf(spec.threadId, accounts) || undefined;
  return 'accountId' in spec ? spec.accountId : undefined;
}

export interface Gate {
  types: readonly string[];
  accountId?: string;
}

export const gateOf = (spec: ViewSpec, accounts: readonly string[]): Gate => ({
  types: typesOf(spec),
  accountId: accountFilter(spec, accounts),
});

/** True when the summary touched a type the window shows, in an account it covers. */
export function reaches(gate: Gate, sum: ChangeSummary): boolean {
  for (const type of gate.types) {
    const touched = sum.accounts.get(type);
    if (!touched) continue;
    if (gate.accountId === undefined || touched.has(gate.accountId) || touched.has('')) return true;
  }
  return false;
}

// ------------------------------------------------------------ the tick

/** How often the engine looks for commits and due work while a window is open. */
export const TICK_MS = 50;

export interface Ticker {
  /** Runs while a window is open; idempotent. */
  start(): void;
  stop(): void;
  close(): void;
}

interface TickerDeps {
  clock: Clock;
  deadlines: DeadlineRegistry;
  tick(now: number): void;
}

/**
 * The window engine's one wake-up. With the timer loop's registry (`eng-time`) it is a deadline source; before that
 * lands (a host or test without `deadlines`) it is one `clock.timer`, re-armed after each tick. Either way time comes
 * only from the injected clock, so tests drive it with a fake one.
 */
export function createTicker(deps: TickerDeps): Ticker {
  const useLoop = !isAbsent(deps.deadlines);
  let running = false;
  let nextAt = 0;
  let timer: Timer | undefined;
  let unregister: (() => void) | undefined;

  const fire = (now: number) => {
    if (!running) return;
    try {
      deps.tick(now);
    } finally {
      arm();
    }
  };
  const arm = () => {
    if (!running) return;
    nextAt = deps.clock.now() + TICK_MS;
    if (useLoop) deps.deadlines.changed('views');
    else timer = deps.clock.timer(nextAt, () => fire(deps.clock.now()));
  };
  const source: DeadlineSource = {
    id: 'views',
    next: async () => (running ? nextAt : undefined),
    fire: async now => fire(now),
  };

  return {
    start() {
      if (running) return;
      running = true;
      if (useLoop) unregister = deps.deadlines.register(source);
      arm();
    },
    stop() {
      running = false;
      timer?.cancel();
      timer = undefined;
      unregister?.();
      unregister = undefined;
    },
    close() {
      this.stop();
    },
  };
}
