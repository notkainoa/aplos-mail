import {
  type AdapterContext,
  type FolderList,
  type MessageFacts,
  type ProviderError,
  type PlacementDelta,
  type PlanInput,
  type PlannedStep,
  type PlanTrigger,
  type Quarantine,
  type ScopeId,
  type StepResult,
  type SyncLane,
  type SyncState,
} from '@aplos/engine/ports';
import { GmailClient, isStop, type GmailDeps, type GmailRequest } from './client';
import { METADATA_HEADERS, messageFacts, type GmailMessage } from './facts';
import { RETRY_SCOPE, dueRetries, readSchedule, settleFailures } from './failures';

/**
 * First sync P0-P5 (ARCH 5.1, plan 20 PV3) as pure planning plus bounded steps. Each step lists or fetches one chunk
 * and returns facts with the next `SyncState`; the actor commits both in one transaction, so a pause, a kill or a stale
 * re-run resumes at the last committed chunk and never re-spends it.
 *
 * P1's call was measured on the emulator at the 3,000-unit target (tests/prov-gmail-window.test.ts): the newest
 * message's `messages.get` metadata (20 units) puts the first 50 threads up in about 1 s; `threads.get` metadata (40)
 * for every thread is the slower call. So a new thread costs one `messages.get` when its page lists one Inbox message
 * and one `threads.get` when it lists several (`entriesFor`): every listed Inbox message becomes a row (D8), and a
 * single-message thread's `threadSize` stays unknown, so opening it uses `threads.get` full (AM-1).
 */

export const BASELINE_THREADS = 50;
export const WINDOW_THREADS = 500;
/** A cursor reset re-lists only the newest Inbox threads: bounded, never a full re-download (D10). */
export const RESYNC_THREADS = 50;
/** Threads fetched per step, so each commit holds about 50 (plan 20 PV0 item 4). */
export const CHUNK = 50;
const LIST_PAGE = 500;
/** A lazy folder's open page: small enough to ride the `interactive` lane beside the owner's own opens. */
const FOLDER_PAGE = 50;
const SENT_DAYS = 30;
const BACKFILL_DAYS = 90;
const DAY = 86_400_000;

const LIST_FIELDS = 'messages(id,threadId),nextPageToken';
/** `historyId` costs nothing extra and lets history tell a fresh memo entry from a stale one. */
export const MESSAGE_METADATA_FIELDS =
  'id,threadId,labelIds,snippet,internalDate,sizeEstimate,historyId,payload/headers';
const THREAD_METADATA_FIELDS = `id,messages(${MESSAGE_METADATA_FIELDS})`;

/** Which call P1 makes per new thread; `threads.get` for every thread exists only to keep the measurement repeatable. */
export type WindowCall = 'messages.get' | 'threads.get';

/**
 * A fetch entry: a message id (`messages.get`) or `thread:<id>` (`threads.get`, every message of the thread). The prefix
 * keeps `SyncState.pending` a plain list of remote ids that a restart can resume without any in-memory map.
 */
const THREAD_PREFIX = 'thread:';
export const threadEntry = (threadId: string): string => THREAD_PREFIX + threadId;
export const entryThread = (entry: string): string | undefined =>
  entry.startsWith(THREAD_PREFIX) ? entry.slice(THREAD_PREFIX.length) : undefined;

/**
 * What to fetch for one thread's listed messages this device lacks (`missing`, newest first). A thread the store
 * already has gets only those messages, never a re-fetch of what it holds; a new thread gets its one message, or the
 * whole thread in one call when several are missing. Either way every listed Inbox message becomes a row: Gmail keeps
 * labels per message (proto-google D8), so a thread stored by its newest message alone would leave the local Inbox
 * when that one reply is archived or trashed elsewhere, while Gmail still shows the conversation there.
 */
export function entriesFor(
  threadId: string,
  missing: readonly string[],
  threadKnown: boolean,
): string[] {
  if (!missing.length) return [];
  if (threadKnown || missing.length === 1) return [...missing];
  return [threadEntry(threadId)];
}

/** Per-adapter memory that is not committed state: the run memo and the threads each round took (for its cap). */
export interface SyncRuntime {
  deps: GmailDeps;
  windowCall: WindowCall;
  memo: FactsMemo;
  rounds: Map<string, Set<string>>;
}

/** Gmail history ids are increasing decimal strings that may pass 2^53. */
export function historyBefore(a: string, b: string): boolean {
  try {
    return BigInt(a) < BigInt(b);
  } catch {
    return true;
  }
}

interface MemoMessage {
  facts: MessageFacts;
  at: number;
  /** The message's `historyId` when fetched: the last history record its facts already show. */
  historyId?: string;
}

function trim<K, V>(map: Map<K, V>, cap: number): void {
  while (map.size > cap) map.delete(map.keys().next().value!);
}

/**
 * Metadata fetched in this run but maybe not committed (the step threw before the actor could commit). A re-run
 * takes it from here instead of re-spending units (plan 20 PV0 item 4), for the window and history alike. History
 * drops an entry only when a record newer than the entry's `historyId` touched it, so a hit never rolls a newer label
 * state back, and a history page re-run after a failure still finds what its first attempt fetched.
 */
export class FactsMemo {
  private readonly messages = new Map<string, MemoMessage>();
  private readonly threads = new Map<string, { ids: string[]; at: number }>();
  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly cap = 2_000,
  ) {}

  /** The facts of one fetch entry, or undefined when any of its messages is missing or stale. */
  get(entry: string, now: number): MessageFacts[] | undefined {
    const threadId = entryThread(entry);
    let ids = [entry];
    if (threadId) {
      const thread = this.threads.get(threadId);
      if (!thread || now - thread.at > this.ttlMs) return undefined;
      ids = thread.ids;
    }
    const out: MessageFacts[] = [];
    for (const id of ids) {
      const hit = this.messages.get(id);
      if (!hit || now - hit.at > this.ttlMs) return undefined;
      out.push(hit.facts);
    }
    return out;
  }

  put(entry: string, fetched: { facts: MessageFacts; historyId?: string }[], now: number): void {
    for (const { facts, historyId } of fetched) {
      this.messages.delete(facts.remoteId);
      this.messages.set(facts.remoteId, { facts, at: now, ...(historyId ? { historyId } : {}) });
    }
    const threadId = entryThread(entry);
    if (threadId) {
      this.threads.delete(threadId);
      this.threads.set(threadId, { ids: fetched.map(f => f.facts.remoteId), at: now });
    }
    trim(this.messages, this.cap);
    trim(this.threads, this.cap);
  }

  /** History record `recordId` touched this message: drop the entry unless it was fetched after that record. */
  changed(id: string, recordId: string): void {
    const hit = this.messages.get(id);
    if (hit && (!hit.historyId || historyBefore(hit.historyId, recordId))) this.messages.delete(id);
  }

  forget(ids: Iterable<string>): void {
    for (const id of ids) this.messages.delete(id);
  }
}

// ---- metadata fetch (shared by the window, history and search) ----

export interface FetchOutcome {
  facts: MessageFacts[];
  /** The facts of each answered entry, for callers that reason about an entry's place in a list. */
  byEntry: Map<string, MessageFacts[]>;
  /** Entries not fetched because a refusal or pause stopped the step, or a part failed transiently. */
  pending: string[];
  /** Gone at the server between list and get. */
  missing: string[];
  quarantine: Quarantine[];
  /** Entries (also in `pending`) whose own part failed without stopping the step, for `settleFailures`. */
  failed: { entry: string; item: string; error: Quarantine['error'] }[];
  /** Fetched messages that are drafts: never thread rows (D9), left to the caller. */
  drafts: { id: string; threadId: string }[];
  /** Set when a refusal or pause cut the fetch short. */
  stopped: boolean;
  /** The refusal or pause that did. */
  error?: Error;
}

/**
 * Metadata for fetch entries (message ids or `thread:` entries), in HTTP batches sized by the governor. Never serial
 * and never re-sent: a refused part goes to `pending` for the next step.
 */
export async function fetchMetadata(
  client: GmailClient,
  entries: readonly string[],
  opts: { lane: SyncLane; self: string; memo?: FactsMemo; now: number },
): Promise<FetchOutcome> {
  const out: FetchOutcome = {
    facts: [],
    byEntry: new Map(),
    pending: [],
    missing: [],
    quarantine: [],
    failed: [],
    drafts: [],
    stopped: false,
  };
  const toFetch: string[] = [];
  for (const entry of entries) {
    const hit = opts.memo?.get(entry, opts.now);
    if (hit) {
      out.byEntry.set(entry, hit);
      out.facts.push(...hit);
    } else toFetch.push(entry);
  }
  const size = client.batchSize();
  for (let start = 0; start < toFetch.length; start += size) {
    const chunk = toFetch.slice(start, start + size);
    if (out.stopped) {
      out.pending.push(...chunk);
      continue;
    }
    const reqs: GmailRequest[] = chunk.map(entry => {
      const threadId = entryThread(entry);
      return threadId
        ? {
            method: 'gmail.threads.get',
            path: `/threads/${threadId}`,
            format: 'metadata',
            query: { metadataHeaders: METADATA_HEADERS },
            fields: THREAD_METADATA_FIELDS,
            lane: opts.lane,
            item: threadId,
          }
        : {
            method: 'gmail.messages.get',
            path: `/messages/${entry}`,
            format: 'metadata',
            query: { metadataHeaders: METADATA_HEADERS },
            fields: MESSAGE_METADATA_FIELDS,
            lane: opts.lane,
            item: entry,
          };
    });
    let outcomes;
    try {
      outcomes = await client.batch<GmailMessage & { messages?: GmailMessage[] }>(reqs, opts.lane);
    } catch (error) {
      if (!isStop(error)) throw error;
      out.stopped = true;
      out.error = error;
      out.pending.push(...chunk);
      continue;
    }
    outcomes.forEach((outcome, i) => {
      if (outcome.ok) recordAnswer(out, chunk[i], outcome.data, opts);
      else recordRefusal(out, chunk[i], outcome.error);
    });
  }
  return out;
}

/** One answered entry: its facts, with drafts set aside (D9). */
function recordAnswer(
  out: FetchOutcome,
  entry: string,
  data: GmailMessage & { messages?: GmailMessage[] },
  opts: { self: string; memo?: FactsMemo; now: number },
): void {
  const threadId = entryThread(entry);
  const raw = threadId ? (data.messages ?? []) : [data];
  // Drafts are never part of a conversation (D9).
  const live = raw.filter(m => !m.labelIds?.includes('DRAFT'));
  for (const m of raw)
    if (m.labelIds?.includes('DRAFT')) out.drafts.push({ id: m.id, threadId: m.threadId });
  const fetched = live.map(m => ({
    facts: messageFacts(m, {
      self: opts.self,
      partial: true,
      ...(threadId ? { threadSize: live.length } : {}),
    }),
    historyId: m.historyId,
  }));
  opts.memo?.put(entry, fetched, opts.now);
  const facts = fetched.map(f => f.facts);
  out.byEntry.set(entry, facts);
  out.facts.push(...facts);
}

/** One refused entry: gone (404), quarantined (permanent), or pending (a stop, or its own transient failure). */
function recordRefusal(out: FetchOutcome, entry: string, error: ProviderError): void {
  const classified = error.error;
  const item = entryThread(entry) ?? entry;
  if (classified.class === 'permanent' && classified.status === 404) out.missing.push(entry);
  else if (classified.class === 'permanent') out.quarantine.push({ item, error: classified });
  else {
    out.pending.push(entry);
    if (isStop(error)) {
      out.stopped = true;
      out.error ??= error;
    } else out.failed.push({ entry, item, error: classified });
  }
}

// ---- planning ----

const stateOf = (states: SyncState[], scope: ScopeId) => states.find(s => s.scope === scope);

/** Poll cadence (ARCH 5.1): 15 s focused, 60 s with no visible window, 5 min on battery with no window. */
export function pollInterval(env: PlanInput['env']): number {
  if (env.focused) return 15_000;
  if (!env.windowVisible && env.onBattery) return 300_000;
  return 60_000;
}

/** A deterministic +-25% jitter, so plan() stays pure and two devices do not poll in step. */
function jitter(seed: number): number {
  const x = Math.sin(seed % 1_000_003) * 10_000;
  return (x - Math.floor(x)) * 0.5 - 0.25;
}

const IMMEDIATE: ReadonlySet<PlanTrigger> = new Set([
  'first',
  'manual',
  'wake',
  'push',
  'resume',
  'reset',
]);

/** When the next history poll is due: at once for an immediate trigger, else one jittered interval after the last. */
function pollDue(history: SyncState, trigger: PlanTrigger, env: PlanInput['env']): number {
  if (IMMEDIATE.has(trigger)) return env.now;
  const interval = pollInterval(env);
  const due = history.updatedAt + Math.round(interval * (1 + jitter(history.updatedAt)));
  return Math.max(env.now, due);
}

/** A re-seeded cursor after a reset delivers missed Inbox arrivals as `incremental`; a first sync is a `baseline`. */
function resetOrigin(
  history: SyncState | undefined,
  memory: ReadonlyMap<string, string>,
): PlannedStep['origin'] {
  if (history?.phase !== 'reset') return 'baseline';
  return memory.has(LAST_SEEN_KEY) ? 'incremental' : 'resync';
}

/**
 * Pure: steps from committed state. The cursor comes first (P0); then the Inbox window (P1, continuing to 500 as P2);
 * the history poll at its cadence; and once the window is done, Sent (P3) and Inbox backfill (P5). P4 (body prefetch)
 * is not a sync step here: see the port gaps in the lane report.
 */
export function plan(input: PlanInput): PlannedStep[] {
  const { states, trigger, env } = input;
  const history = stateOf(states, 'history');
  if (!history?.cursor) {
    // A P0 whose missed-arrivals check met a failed fetch (`pending`) tries again at the poll cadence, never at once.
    const retry = history?.pending?.length ? { notBefore: pollDue(history, trigger, env) } : {};
    return [
      {
        scope: 'history',
        lane: 'incremental',
        origin: resetOrigin(history, input.memory),
        trigger,
        ...retry,
      },
    ];
  }
  const steps: PlannedStep[] = [];
  const window = stateOf(states, 'window:inbox');
  if (!window || window.phase !== 'done') {
    const phase = window?.phase;
    if (phase === 'resync' || phase === 'resyncing')
      steps.push({ scope: 'window:inbox', lane: 'incremental', origin: 'resync', trigger });
    else if (phase === 'more')
      steps.push({ scope: 'window:inbox', lane: 'backfill', origin: 'backfill', trigger });
    else steps.push({ scope: 'window:inbox', lane: 'incremental', origin: 'baseline', trigger });
  }
  steps.push({
    scope: 'history',
    lane: 'incremental',
    origin: 'incremental',
    trigger,
    notBefore: pollDue(history, trigger, env),
  });
  if (window?.phase === 'done') {
    const sent = stateOf(states, 'sent:recent');
    if (sent && sent.phase !== 'done')
      steps.push({ scope: 'sent:recent', lane: 'backfill', origin: 'backfill', trigger });
    const backfill = stateOf(states, 'backfill:inbox');
    if (backfill && backfill.phase !== 'done')
      steps.push({ scope: 'backfill:inbox', lane: 'backfill', origin: 'backfill', trigger });
    // A quarantined message due for another try (by sync passes, so never a tight loop); quiet, like backfill.
    if (dueRetries(readSchedule(input.memory)).length)
      steps.push({ scope: RETRY_SCOPE, lane: 'backfill', origin: 'backfill', trigger });
  }
  return steps;
}

// ---- paged list scopes: window:inbox, sent:recent, backfill:inbox ----

interface ListSpec {
  scope: ScopeId;
  labelIds: string[];
  q?: string;
  folder: string;
  /** Threads a round may take: 500 for the window, 50 for a resync. */
  cap: number;
  /** Stop once fetched mail is older than this (backfill: 90 days). */
  stopBefore?: number;
  /** The round may set `scopeCovered` (the Inbox window only). */
  coverage: boolean;
  /** The round's first ~50 threads are the baseline (AM-4). */
  baseline: boolean;
}

function specFor(scope: ScopeId, state: SyncState, now: number): ListSpec {
  const resync = state.phase === 'resync' || state.phase === 'resyncing';
  switch (scope) {
    case 'window:inbox':
      return {
        scope,
        labelIds: ['INBOX'],
        folder: 'INBOX',
        cap: resync ? RESYNC_THREADS : WINDOW_THREADS,
        coverage: true,
        baseline: !resync,
      };
    case 'backfill:inbox':
      return {
        scope,
        labelIds: ['INBOX'],
        folder: 'INBOX',
        cap: Infinity,
        stopBefore: now - BACKFILL_DAYS * DAY,
        coverage: false,
        baseline: false,
      };
    case 'sent:recent':
      return {
        scope,
        labelIds: ['SENT'],
        q: `newer_than:${SENT_DAYS}d`,
        folder: 'SENT',
        cap: Infinity,
        coverage: false,
        baseline: false,
      };
    default:
      throw new Error(`not a list scope: ${scope}`);
  }
}

type RoundKey = 'read' | 'extra' | 'capped';
const memKey = (scope: ScopeId, key: RoundKey) => `${scope}.${key}`;

/** Present while an Inbox window or resync round is between its first listing and its sweep. */
export const INBOX_ROUND_MARK = memKey('window:inbox', 'read');
/**
 * Message ids history saw enter the Inbox while an Inbox round was running (space-separated, or `*` when too many).
 * The round's sweep re-stamps them: they may have been archived when the round listed the Inbox, and a history label
 * delta never refreshes a placement's stamp, so without this the sweep would remove a message Gmail has in the Inbox.
 */
export const REGAINED_KEY = 'inbox.regained';

/**
 * Set once the first Inbox window round (P1-P2, the 500 threads) has ended. Until then a cursor reset restarts that
 * round instead of starting a 50-thread resync: a resync is not a baseline round, so it would never set
 * `baseline_done_at` or seed Sent and backfill, and the account would stay `syncing` with 50 threads (prov-gov-attack-04).
 */
export const FIRST_WINDOW_KEY = 'inbox.firstWindow';

/**
 * provider_memory: epoch ms of the last history pass that worked, written when a cursor reset begins after the baseline
 * and cleared by the P0 step that re-seeds the cursor. While it is set, that step is planned as `incremental` (the one
 * origin the store's notification hook treats as new mail) and delivers the Inbox mail newer than this time that the
 * device lacks (`missedArrivals`); the resync that follows is `resync` and stays quiet.
 */
export const LAST_SEEN_KEY = 'inbox.lastSeen';

/** The date of an answered entry's listed message: its own, or a thread's newest message in the listed folder. */
function listedDate(entry: string, facts: readonly MessageFacts[], folder: string): number {
  if (!facts.length) return Infinity;
  if (!entryThread(entry)) return facts[0].internalDate;
  const inFolder = facts.filter(f => f.placements.some(p => p.folder === folder));
  return Math.max(...(inFolder.length ? inFolder : facts).map(f => f.internalDate));
}

/**
 * One chunk of a paged list scope. A round lists `messages.list` pages (500 ids, 5 units), groups each page by thread
 * and queues the listed messages this device lacks (`entriesFor`), then fetches 50 entries per step. Every listed id
 * comes back as a `PlacementDelta { present: true }`, so the sweep that ends an Inbox round only removes placements the
 * round really did not see. State and memory:
 * - `phase`: undefined or `resync` (round not started), `baseline`, `more`, `resyncing`, `running`, `done`;
 * - `pageToken`: the next page to list (or, before a round starts, where it starts);
 * - `pending`: fetch entries still to fetch from pages already listed;
 * - `oldestLoaded`: the sweep's `since` when the round stopped at its thread cap before the folder's end;
 * - memory `<scope>.read` (threads taken, which the cap counts), `.extra` (entries beyond one per thread) and
 *   `.capped` (the round stopped at its cap with more of the folder left, so it may only sweep above `oldestLoaded`).
 */
export async function listStep(
  rt: SyncRuntime,
  state: SyncState,
  ctx: AdapterContext,
): Promise<StepResult> {
  const env = listEnv(rt, state, ctx);
  const round = openRound(env);
  // Work done: each thread taken is one unit, each fetch entry beyond its first one more.
  const doneBefore = round.read + round.extra - round.pending.length;

  try {
    // List the next page when nothing is left to fetch from the last one.
    if (!round.pending.length && !round.listedAll && round.read < env.spec.cap)
      await listPage(env, round);
    await fetchChunk(env, round);
  } catch (error) {
    if (!isStop(error)) throw error;
    round.stopped = true;
  }

  return endStep(env, round, doneBefore);
}

/** What a list step knows before it starts and never changes. */
interface ListEnv {
  rt: SyncRuntime;
  state: SyncState;
  ctx: AdapterContext;
  spec: ListSpec;
  client: GmailClient;
  now: number;
  starting: boolean;
  resync: boolean;
  generation: number;
  /** Threads this round took, for its cap only. */
  handled: Set<string>;
}

/**
 * A list step's progress. The phase helpers update it in place, so a stop thrown part-way through one leaves exactly
 * what was done before it, and the step result is built from that.
 */
interface ListRound {
  read: number;
  extra: number;
  capped: boolean;
  pending: string[];
  pageToken?: string;
  oldestLoaded?: number;
  /** No further page to list in this round. */
  listedAll: boolean;
  placements: PlacementDelta[];
  seeds: SyncState[];
  result: Omit<StepResult, 'nextStates' | 'done' | 'costUnits'>;
  stopped: boolean;
  facts: MessageFacts[];
  quarantine: Quarantine[];
  /** provider_memory writes from the fetch (failure counts), merged into the round's own. */
  memory: Record<string, string | null>;
}

function listEnv(rt: SyncRuntime, state: SyncState, ctx: AdapterContext): ListEnv {
  const now = ctx.clock.now();
  const spec = specFor(state.scope, state, now);
  const client = new GmailClient(rt.deps, ctx);
  const starting = state.phase === undefined || state.phase === 'resync';
  const resync = state.phase === 'resync' || state.phase === 'resyncing';
  const generation = starting ? ctx.generation : state.generation;
  // What to fetch comes from the store, so a restart that loses `handled` fetches nothing twice; at worst a thread
  // spanning two pages then counts twice toward the cap.
  const roundKey = `${spec.scope}@${generation}`;
  if (starting)
    for (const key of rt.rounds.keys()) if (key.startsWith(`${spec.scope}@`)) rt.rounds.delete(key);
  const handled = rt.rounds.get(roundKey) ?? new Set<string>();
  rt.rounds.set(roundKey, handled);
  return { rt, state, ctx, spec, client, now, starting, resync, generation, handled };
}

function openRound({ state, ctx, spec, starting }: ListEnv): ListRound {
  const remembered = (key: RoundKey) =>
    starting ? undefined : ctx.memory.get(memKey(spec.scope, key));
  const pageToken = state.pageToken;
  return {
    read: Number(remembered('read') ?? 0),
    extra: Number(remembered('extra') ?? 0),
    capped: remembered('capped') === '1',
    pending: starting ? [] : [...(state.pending ?? [])],
    pageToken,
    oldestLoaded: starting ? undefined : state.oldestLoaded,
    listedAll: !starting && !pageToken,
    placements: [],
    seeds: [],
    result: {},
    stopped: false,
    facts: [],
    quarantine: [],
    memory: {},
  };
}

/** Lists one page, queues what this device lacks from it, and stops the round at its thread cap. */
async function listPage(env: ListEnv, round: ListRound): Promise<void> {
  const { state, ctx, spec, client } = env;
  const listedToken = round.pageToken;
  const page = await client.call<{
    messages?: { id: string; threadId: string }[];
    nextPageToken?: string;
  }>({
    method: 'gmail.messages.list',
    path: '/messages',
    query: {
      labelIds: spec.labelIds,
      maxResults: LIST_PAGE,
      pageToken: round.pageToken,
      q: spec.q,
    },
    fields: LIST_FIELDS,
    lane: stepLane(state, spec),
  });
  const listed = page.messages ?? [];
  round.pageToken = page.nextPageToken;
  round.listedAll = !round.pageToken;
  for (const m of listed)
    round.placements.push({ remoteId: m.id, folder: spec.folder, present: true });

  // The page by thread, newest first: a thread's first id is its newest listed message.
  const groups = new Map<string, string[]>();
  for (const m of listed) groups.set(m.threadId, [...(groups.get(m.threadId) ?? []), m.id]);
  const known = listed.length
    ? await ctx.lookup.knownMessages(listed.map(m => m.id))
    : new Set<string>();
  const knownThreads = groups.size
    ? await ctx.lookup.knownThreads([...groups.keys()])
    : new Set<string>();
  const { lastTaken, left } = takeThreads(env, round, groups, known, knownThreads);
  // Stopped at the cap with more of the folder left (threads past the cap here, or another page). Reaching the cap
  // exactly at the folder's end is not a stop: that round listed everything and may sweep the whole folder.
  if (round.read >= spec.cap && (left || round.pageToken))
    await stopAtCap(env, round, listedToken, lastTaken);
}

/** Queues the fetch entries of a listed page's threads, up to the round's cap. */
function takeThreads(
  { rt, spec, handled }: ListEnv,
  round: ListRound,
  groups: ReadonlyMap<string, string[]>,
  known: ReadonlySet<string>,
  knownThreads: ReadonlySet<string>,
): { lastTaken?: string; left: boolean } {
  let lastTaken: string | undefined;
  let left = false;
  for (const [threadId, ids] of groups) {
    const missing = ids.filter(id => !known.has(id));
    if (handled.has(threadId)) {
      // Older Inbox messages of a thread an earlier page gave: fetched, but not a new thread for the cap.
      const entries = entriesFor(threadId, missing, true);
      round.pending.push(...entries);
      round.extra += entries.length;
      continue;
    }
    if (round.read >= spec.cap) {
      left = true;
      continue;
    }
    handled.add(threadId);
    round.read++;
    lastTaken = ids[0];
    const entries =
      rt.windowCall === 'threads.get' &&
      spec.scope === 'window:inbox' &&
      missing.length &&
      !knownThreads.has(threadId)
        ? [threadEntry(threadId)]
        : entriesFor(threadId, missing, knownThreads.has(threadId));
    round.pending.push(...entries);
    round.extra += Math.max(0, entries.length - 1);
  }
  return { lastTaken, left };
}

/** The round stopped at its thread cap with more of the folder left. */
async function stopAtCap(
  { state, ctx, spec, client, now, resync }: ListEnv,
  round: ListRound,
  listedToken: string | undefined,
  lastTaken: string | undefined,
): Promise<void> {
  round.capped = true;
  round.listedAll = true;
  // P5 picks up from here: it re-lists this page and skips the messages already stored (5 units per 500 ids). A
  // resync seeds it too, so Inbox mail that arrived past its 50 threads while the cursor was gone is still fetched;
  // the resync itself stays bounded (D10).
  if (spec.baseline || resync)
    round.seeds.push({
      scope: 'backfill:inbox',
      pageToken: listedToken,
      generation: ctx.generation,
      updatedAt: now,
    });
  // Everything newer than the last thread taken was listed, so the sweep may cover (its date, now).
  // Ask Gmail for that date (minimal, 20 units) rather than trust a guess.
  if (spec.coverage && lastTaken) {
    const minimal = await client.call<{ internalDate?: string }>({
      method: 'gmail.messages.get',
      path: `/messages/${lastTaken}`,
      format: 'minimal',
      fields: 'id,internalDate',
      lane: stepLane(state, spec),
      item: lastTaken,
    });
    round.oldestLoaded = Number(minimal.internalDate ?? 0) || undefined;
  }
}

/** Fetches the next chunk of pending entries. */
async function fetchChunk(
  { rt, state, ctx, spec, client, now }: ListEnv,
  round: ListRound,
): Promise<void> {
  const chunk = round.pending.slice(0, CHUNK);
  round.pending = round.pending.slice(CHUNK);
  if (!chunk.length) return;
  const fetched = await fetchMetadata(client, chunk, {
    lane: stepLane(state, spec),
    self: ctx.account.address,
    memo: rt.memo,
    now,
  });
  // An entry that keeps failing on its own is quarantined after a few steps, so it cannot hold the round open.
  Object.assign(round.memory, settleFailures(ctx, fetched, chunk));
  round.facts.push(...fetched.facts);
  round.quarantine.push(...fetched.quarantine);
  round.pending = [...fetched.pending, ...round.pending];
  round.stopped = fetched.stopped;
  const before = spec.stopBefore;
  if (
    before !== undefined &&
    [...fetched.byEntry].some(([entry, f]) => listedDate(entry, f, spec.folder) < before)
  ) {
    // Backfill reached 90 days: older Inbox mail stays reachable through server search.
    round.pending = [];
    round.listedAll = true;
  }
}

function nextListPhase({ spec, resync }: ListEnv, roundEnded: boolean, done: number): string {
  if (roundEnded) return 'done';
  if (resync) return 'resyncing';
  if (spec.scope !== 'window:inbox') return 'running';
  return done >= BASELINE_THREADS ? 'more' : 'baseline';
}

/**
 * The baseline seed and the round's sweep. A round that stopped at its cap covers only (oldestLoaded, now); one that
 * listed to the end covers the folder. Without a known bound there is no sweep at all: a missed ghost is better than a
 * false removal.
 */
function settleRound(
  { ctx, spec, now, starting, generation }: ListEnv,
  round: ListRound,
  doneBefore: number,
  done: number,
  roundEnded: boolean,
): void {
  if (spec.baseline && doneBefore < BASELINE_THREADS && (done >= BASELINE_THREADS || roundEnded)) {
    round.result.baselineReached = true;
    // Sent (P3) waits for the window to finish (plan()), but its state exists from the baseline on.
    round.seeds.push({ scope: 'sent:recent', generation: ctx.generation, updatedAt: now });
  }
  if (roundEnded && spec.coverage && (!round.capped || round.oldestLoaded !== undefined)) {
    const regained = starting ? '' : (ctx.memory.get(REGAINED_KEY) ?? '');
    if (regained !== '*') {
      for (const id of regained.split(' ').filter(Boolean))
        round.placements.push({ remoteId: id, folder: spec.folder, present: true });
      round.result.scopeCovered = {
        scope: spec.scope,
        generation,
        bound: { folder: spec.folder, ...(round.capped ? { since: round.oldestLoaded } : {}) },
      };
    }
  }
}

function roundMemory(
  { spec, starting }: ListEnv,
  round: ListRound,
  roundEnded: boolean,
): Record<string, string | null> {
  const { read, extra, capped } = round;
  const memory: Record<string, string | null> = {
    ...round.memory,
    [memKey(spec.scope, 'read')]: roundEnded ? null : String(read),
    [memKey(spec.scope, 'extra')]: roundEnded || !extra ? null : String(extra),
    [memKey(spec.scope, 'capped')]: !roundEnded && capped ? '1' : null,
  };
  // History records regained ids only while a round runs; a new round starts from an empty list.
  if (spec.coverage && (starting || roundEnded)) memory[REGAINED_KEY] = null;
  if (spec.baseline && spec.scope === 'window:inbox' && roundEnded) memory[FIRST_WINDOW_KEY] = '1';
  return memory;
}

function endStep(env: ListEnv, round: ListRound, doneBefore: number): StepResult {
  const { state, spec, client, now, generation } = env;
  const { stopped, pending, pageToken, oldestLoaded, placements, facts, quarantine } = round;
  const roundEnded = !stopped && !pending.length && (round.listedAll || round.read >= spec.cap);
  const done = round.read + round.extra - pending.length;
  const nextPhase = nextListPhase(env, roundEnded, done);
  settleRound(env, round, doneBefore, done, roundEnded);

  const next: SyncState = {
    scope: spec.scope,
    generation,
    updatedAt: now,
    phase: nextPhase,
    ...(pageToken && !roundEnded ? { pageToken } : {}),
    ...(pending.length ? { pending: pending.slice(0, 500) } : {}),
    ...(oldestLoaded !== undefined ? { oldestLoaded } : {}),
  };
  const memory = roundMemory(env, round, roundEnded);
  // A pause before anything was listed leaves the state exactly as it was.
  const untouched = stopped && !placements.length && !facts.length;
  return {
    ...round.result,
    ...(facts.length ? { upserts: facts } : {}),
    ...(placements.length ? { placements } : {}),
    ...(quarantine.length ? { quarantine } : {}),
    nextStates: untouched ? [state] : [next, ...round.seeds],
    done: !stopped,
    progress: {
      read: Number.isFinite(spec.cap) ? Math.min(done, spec.cap) : done,
      ...(Number.isFinite(spec.cap) ? { total: spec.cap } : {}),
    },
    ...(untouched ? {} : { memory }),
    costUnits: client.spent,
  };
}

function stepLane(state: SyncState, spec: ListSpec): SyncLane {
  if (spec.scope !== 'window:inbox') return 'backfill';
  return state.phase === 'more' ? 'backfill' : 'incremental';
}

/**
 * `ProviderAdapter.listFolder`: one page of a `lazy` folder (Spam, Trash, Starred, a user label) the UI opened.
 * Newest first, `FOLDER_PAGE` ids a page — the fetch rides the `interactive` lane next to the owner's own thread
 * opens, so it stays small (Opus review: a `LIST_PAGE` page could bill ~2,500 quota units an open). Only messages
 * this device lacks are fetched, so a re-open of a folder the
 * walk already covered costs one `messages.list`. STARRED ids land as `flagged` facts (the Bookmarks view), label
 * ids as placements on the page's own folder and every other label the messages carry.
 */
export async function listFolder(
  rt: SyncRuntime,
  folder: string,
  pageToken: string | undefined,
  ctx: AdapterContext,
): Promise<FolderList> {
  const client = new GmailClient(rt.deps, ctx);
  const page = await client.call<{
    messages?: { id: string; threadId: string }[];
    nextPageToken?: string;
  }>({
    method: 'gmail.messages.list',
    path: '/messages',
    query: {
      labelIds: [folder],
      maxResults: FOLDER_PAGE,
      pageToken,
      // The default listing excludes Spam and Trash; an explicit label page must not.
      includeSpamTrash: 'true',
    },
    fields: LIST_FIELDS,
    lane: 'interactive',
  });
  const ids = (page.messages ?? []).map(m => m.id);
  const known = ids.length ? await ctx.lookup.knownMessages(ids) : new Set<string>();
  const out = await fetchMetadata(
    client,
    ids.filter(id => !known.has(id)),
    { lane: 'interactive', self: ctx.account.address, memo: rt.memo, now: ctx.clock.now() },
  );
  if (out.error) throw out.error;
  return {
    upserts: out.facts,
    ...(page.nextPageToken !== undefined ? { nextPageToken: page.nextPageToken } : {}),
  };
}
