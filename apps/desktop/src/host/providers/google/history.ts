import {
  ProviderError,
  type AdapterContext,
  type FlagDelta,
  type LabelDelta,
  type MessageFacts,
  type PlannedStep,
  type Quarantine,
  type RemoteDraftFact,
  type Removal,
  type ResetReason,
  type StepResult,
  type SyncState,
} from '@aplos/engine/ports';
import { GmailClient, isStop } from './client';
import {
  deliverBodies,
  pendingJson,
  BODY_FETCHES,
  PENDING_KEY,
  READS_KEY,
  readPending,
  type PendingBodies,
} from './draft-body';
import { FLAG_LABELS, folderFacts, type GmailLabel } from './facts';
import { isQuarantined, passWrites, readSchedule, settleFailures } from './failures';
import {
  FIRST_WINDOW_KEY,
  INBOX_ROUND_MARK,
  LAST_SEEN_KEY,
  REGAINED_KEY,
  entriesFor,
  entryThread,
  fetchMetadata,
  type FetchOutcome,
  type SyncRuntime,
} from './sync';

/**
 * The `history` scope: P0 (cursor first) when there is no cursor, otherwise one `history.list` page (ARCH 5.1,
 * proto-google 2.4). Label changes become placement and flag deltas at zero fetch cost (D13); a message is fetched, as
 * metadata, only when its thread is already known or it is in the Inbox (D3, D14), with one call per new thread; drafts
 * never become thread rows and leave Drafts when deleted or sent elsewhere (D9); deletions are removals. Fetches use the
 * run memo, so a page re-run after a failure re-spends nothing. The cursor moves forward after every page, so a
 * failure replays nothing committed.
 */

/** More fetches than this in one pass take the bounded fresh-window path instead (plan 20 PV0 item 6). */
export const CHANGE_CAP = 150;
const HISTORY_TYPES = ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'];
const REF = 'message(id,threadId,labelIds)';
const HISTORY_FIELDS = `history(id,messagesAdded(${REF}),messagesDeleted(${REF}),labelsAdded(${REF},labelIds),labelsRemoved(${REF},labelIds)),nextPageToken,historyId`;

interface HistoryRef {
  id: string;
  threadId: string;
  labelIds?: string[];
}
interface HistoryRecord {
  id: string;
  messagesAdded?: { message: HistoryRef }[];
  messagesDeleted?: { message: HistoryRef }[];
  labelsAdded?: { message: HistoryRef; labelIds?: string[] }[];
  labelsRemoved?: { message: HistoryRef; labelIds?: string[] }[];
}
interface HistoryPage {
  history?: HistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
}

const untouched = (state: SyncState, costUnits: number): StepResult => ({
  nextStates: [state],
  done: false,
  costUnits,
});

/**
 * Newest Inbox page a missed-arrivals check lists. Known limits, by design: arrivals past this page reach the device
 * through the quiet resync or backfill and never notify; and an arrival that was quarantined (in a history poll or in
 * this check) and is later fetched by the quarantine retry (`retry.ts`) or the resync never notifies either.
 */
const ARRIVAL_PAGE = 50;

/** provider_memory: epoch ms of the last history pass that reached the head, kept while later passes have not. */
export const HEAD_AT_KEY = 'history.headAt';

/** What a missed-arrivals check fetched: the new Inbox mail, and the fetch it came from (for failure counting). */
interface MissedArrivals {
  arrivals: MessageFacts[];
  fetched: FetchOutcome;
  entries: string[];
}

/**
 * Inbox mail newer than `since` that this device lacks, fetched as metadata (G-B). One list page (5 units) and one
 * fetch per unknown thread, the same calls the resync would make; what the resync would also fetch but is not new
 * stays in the run memo for it. The caller decides what a stopped or partly failed fetch means.
 */
async function missedArrivals(
  rt: SyncRuntime,
  step: PlannedStep,
  ctx: AdapterContext,
  client: GmailClient,
  since: number,
): Promise<MissedArrivals> {
  const list = await client.call<{ messages?: { id: string; threadId: string }[] }>({
    method: 'gmail.messages.list',
    path: '/messages',
    query: { labelIds: ['INBOX'], maxResults: ARRIVAL_PAGE },
    fields: 'messages(id,threadId)',
    lane: step.lane,
  });
  const listed = list.messages ?? [];
  const known = await ctx.lookup.knownMessages(listed.map(m => m.id));
  const knownThreads = await ctx.lookup.knownThreads(listed.map(m => m.threadId));
  const byThread = new Map<string, string[]>();
  for (const m of listed.filter(m => !known.has(m.id)))
    byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m.id]);
  // A quarantined arrival is left to its retry and the resync: fetching it here again would hold the cursor anew.
  const schedule = readSchedule(ctx.memory);
  const entries = [...byThread]
    .flatMap(([thread, ids]) => entriesFor(thread, ids, knownThreads.has(thread)))
    .filter(entry => !isQuarantined(schedule, entry));
  const fetched = await fetchMetadata(client, entries, {
    lane: step.lane,
    self: ctx.account.address,
    memo: rt.memo,
    now: ctx.clock.now(),
  });
  const arrivals = fetched.facts.filter(
    f => f.internalDate > since && f.placements.some(p => p.folder === 'INBOX'),
  );
  return { arrivals, fetched, entries };
}

const storedTime = (memory: ReadonlyMap<string, string>, key: string): number | undefined => {
  const at = Number(memory.get(key));
  return Number.isFinite(at) && memory.has(key) ? at : undefined;
};

/** What the P0 step after a reset delivers, or the result that ends it early. */
type ArrivalsCheck =
  | {
      ok: true;
      arrivals: MessageFacts[];
      memory: Record<string, string | null>;
      quarantine: Quarantine[];
    }
  | { ok: false; result: StepResult };

/**
 * The missed-arrivals check of a P0 step. All or nothing: a pause or refusal leaves the state untouched, and so does an
 * arrival whose own fetch failed (a 500 or a failed batch part), which keeps the marker so the retry can still deliver
 * it as new mail. Such a retry commits only the failure bookkeeping and waits one poll interval (`plan()`); an arrival that
 * keeps failing is quarantined after `MAX_ATTEMPTS` like any fetch, so it cannot keep the cursor from being re-seeded.
 */
async function checkArrivals(
  rt: SyncRuntime,
  step: PlannedStep,
  state: SyncState,
  ctx: AdapterContext,
  client: GmailClient,
): Promise<ArrivalsCheck> {
  const since = storedTime(ctx.memory, LAST_SEEN_KEY);
  if (since === undefined) return { ok: true, arrivals: [], memory: {}, quarantine: [] };
  const { arrivals, fetched, entries } = await missedArrivals(rt, step, ctx, client, since);
  if (fetched.stopped) return { ok: false, result: untouched(state, client.spent) };
  const memory = settleFailures(ctx, fetched, entries);
  const { quarantine } = fetched;
  if (!fetched.pending.length) return { ok: true, arrivals, memory, quarantine };
  const retry: SyncState = { ...state, updatedAt: ctx.clock.now(), pending: fetched.pending };
  return {
    ok: false,
    result: {
      ...(Object.keys(memory).length ? { memory } : {}),
      ...(quarantine.length ? { quarantine } : {}),
      nextStates: [retry],
      done: false,
      costUnits: client.spent,
    },
  };
}

/** P0: `getProfile` for the history id first (so nothing that happens during the window is missed), then labels. */
export async function cursorStep(
  rt: SyncRuntime,
  step: PlannedStep,
  state: SyncState,
  ctx: AdapterContext,
): Promise<StepResult> {
  const client = new GmailClient(rt.deps, ctx);
  try {
    const profile = await client.call<{ historyId?: string }>({
      method: 'gmail.getProfile',
      path: '/profile',
      fields: 'historyId',
      lane: step.lane,
    });
    const labels = await client.call<{ labels?: GmailLabel[] }>({
      method: 'gmail.labels.list',
      path: '/labels',
      fields: 'labels(id,name,type,labelListVisibility)',
      lane: step.lane,
    });
    if (!profile.historyId) throw new Error('getProfile returned no historyId');
    const check = await checkArrivals(rt, step, state, ctx, client);
    if (!check.ok) return check.result;
    const { arrivals, quarantine } = check;
    const memory = { ...check.memory };
    if (ctx.memory.has(LAST_SEEN_KEY)) memory[LAST_SEEN_KEY] = null;
    return {
      folders: folderFacts(labels.labels ?? []),
      ...(arrivals.length ? { upserts: arrivals } : {}),
      ...(Object.keys(memory).length ? { memory } : {}),
      ...(quarantine.length ? { quarantine } : {}),
      nextStates: [
        {
          scope: 'history',
          cursor: profile.historyId,
          generation: ctx.generation,
          updatedAt: ctx.clock.now(),
        },
      ],
      done: true,
      costUnits: client.spent,
    };
  } catch (error) {
    if (isStop(error)) return untouched(state, client.spent);
    throw error;
  }
}

/**
 * The cursor is gone (404) or the pass would fetch too much: clear the cursor so the next plan() emits P0 again, and
 * start a bounded Inbox resync round whose sweep removes ghosts (D10). Never a full re-download: when the resync stops
 * at its 50 threads it re-seeds `backfill:inbox` from there, which skips stored mail and fetches only Inbox mail that
 * arrived beyond those 50 while the cursor was gone (`stopAtCap`). Before the first
 * window round has ended, the reset restarts that round from the top instead (`FIRST_WINDOW_KEY`): it re-lists the
 * newest Inbox like a resync, skips what is stored, and still reaches the baseline and seeds Sent and backfill.
 */
function resetStates(state: SyncState, ctx: AdapterContext): SyncState[] {
  const now = ctx.clock.now();
  const firstWindowDone = ctx.memory.get(FIRST_WINDOW_KEY) === '1';
  return [
    { scope: 'history', phase: 'reset', generation: state.generation, updatedAt: now },
    {
      scope: 'window:inbox',
      ...(firstWindowDone ? { phase: 'resync' } : {}),
      generation: ctx.generation,
      updatedAt: now,
    },
  ];
}

/** A history state whose pass reached the head: every fetch in, no further page. */
const atHead = (state: SyncState): boolean =>
  !state.pending?.length && !/^pass:/.test(state.phase ?? '');

/**
 * When history last reached the head. A pass that did not (a fetch still pending, more pages) still moves `updatedAt`
 * for the poll cadence, so the last head time is kept in `HEAD_AT_KEY` until a pass reaches the head again.
 */
function headAt(state: SyncState, memory: ReadonlyMap<string, string>): number | undefined {
  return storedTime(memory, HEAD_AT_KEY) ?? (state.updatedAt || undefined);
}

/** The `HEAD_AT_KEY` write for a pass from `state` to `next`, or nothing when it stays as it is. */
function headWrites(
  state: SyncState,
  next: SyncState,
  memory: ReadonlyMap<string, string>,
): Record<string, string | null> {
  if (atHead(next)) return memory.has(HEAD_AT_KEY) ? { [HEAD_AT_KEY]: null } : {};
  if (memory.has(HEAD_AT_KEY) || !atHead(state) || !state.updatedAt) return {};
  return { [HEAD_AT_KEY]: String(state.updatedAt) };
}

/** The `READS_KEY` write after a page: the pass's body reads so far while it goes on, cleared once it reaches the head. */
function readsWrite(
  next: SyncState,
  memory: ReadonlyMap<string, string>,
  total: number,
): Record<string, string | null> {
  if (atHead(next)) return memory.has(READS_KEY) ? { [READS_KEY]: null } : {};
  return String(total) === memory.get(READS_KEY) ? {} : { [READS_KEY]: String(total) };
}

/**
 * After the baseline a reset remembers when history last reached the head, for `missedArrivals`; before it, nothing.
 * Never a later time: mail that a stalled pass had not fetched yet must still count as missed.
 */
function lastSeenWrite(state: SyncState, ctx: AdapterContext): Record<string, string | null> {
  const clear: Record<string, string | null> = ctx.memory.has(HEAD_AT_KEY)
    ? { [HEAD_AT_KEY]: null }
    : {};
  const at = headAt(state, ctx.memory);
  if (ctx.memory.get(FIRST_WINDOW_KEY) !== '1' || !at) return clear;
  return { ...clear, [LAST_SEEN_KEY]: String(at) };
}

interface Pending {
  add: Set<string>;
  remove: Set<string>;
  seen?: boolean;
  flagged?: boolean;
}

/** provider_memory: message id -> draft id of the remote drafts this adapter reported (D9), as JSON. */
export const DRAFTS_KEY = 'drafts.byMessage';
/** More regained ids than this and the running round skips its sweep instead (see `REGAINED_KEY`). */
const REGAINED_MAX = 1_000;
/** Fetch weight toward `CHANGE_CAP`: a `threads.get` costs two `messages.get`. */
const weight = (entry: string) => (entryThread(entry) ? 2 : 1);

function readDraftMap(memory: ReadonlyMap<string, string>): Map<string, string> {
  try {
    return new Map(
      Object.entries(JSON.parse(memory.get(DRAFTS_KEY) ?? '{}') as Record<string, string>),
    );
  } catch {
    return new Map();
  }
}

/** A message whose labels are unknown or include DRAFT may be a draft (Google's history refs often carry no labels). */
const mayBeDraft = (m: HistoryRef): boolean => !m.labelIds || m.labelIds.includes('DRAFT');

/** What one history page says, in record order. */
interface PageChanges {
  labels: Map<string, Pending>;
  added: HistoryRef[];
  inboxGained: HistoryRef[];
  /** Messages that lost DRAFT without being deleted: a draft sent with `drafts.send` keeps its id and becomes mail. */
  undrafted: HistoryRef[];
  /** Draft candidates that left Trash: a restored draft is news again (it was reported `removed` while trashed). */
  untrashed: HistoryRef[];
  deleted: Set<string>;
  /** Inbox entries and exits in record order, for the running Inbox round's sweep (REGAINED_KEY). */
  inboxMoves: [string, boolean][];
}

function changeLabels(
  labels: Map<string, Pending>,
  ref: HistoryRef,
  ids: readonly string[] | undefined,
  adding: boolean,
): void {
  const entry = labels.get(ref.id) ?? { add: new Set<string>(), remove: new Set<string>() };
  labels.set(ref.id, entry);
  for (const label of ids ?? []) {
    if (label === 'UNREAD') entry.seen = !adding;
    else if (label === 'STARRED') entry.flagged = adding;
    else if (FLAG_LABELS.has(label)) continue;
    else if (adding) {
      entry.add.add(label);
      entry.remove.delete(label);
    } else {
      entry.remove.add(label);
      entry.add.delete(label);
    }
  }
}

/** Reads the page's records, updating the run memo as it goes. */
function collectChanges(rt: SyncRuntime, records: readonly HistoryRecord[]): PageChanges {
  const changes: PageChanges = {
    labels: new Map(),
    added: [],
    inboxGained: [],
    undrafted: [],
    untrashed: [],
    deleted: new Set(),
    inboxMoves: [],
  };
  const { labels, added, inboxGained, undrafted, untrashed, deleted, inboxMoves } = changes;
  for (const record of records) {
    for (const { message } of record.messagesAdded ?? []) {
      rt.memo.changed(message.id, record.id);
      deleted.delete(message.id);
      added.push(message);
      if (message.labelIds?.includes('INBOX')) inboxMoves.push([message.id, true]);
    }
    for (const { message } of record.messagesDeleted ?? []) {
      rt.memo.forget([message.id]);
      deleted.add(message.id);
      inboxMoves.push([message.id, false]);
    }
    for (const entry of record.labelsAdded ?? []) {
      rt.memo.changed(entry.message.id, record.id);
      changeLabels(labels, entry.message, entry.labelIds, true);
      if (entry.labelIds?.includes('INBOX')) {
        inboxGained.push(entry.message);
        inboxMoves.push([entry.message.id, true]);
      }
    }
    for (const entry of record.labelsRemoved ?? []) {
      rt.memo.changed(entry.message.id, record.id);
      changeLabels(labels, entry.message, entry.labelIds, false);
      if (entry.labelIds?.includes('DRAFT')) undrafted.push(entry.message);
      if (entry.labelIds?.includes('TRASH') && mayBeDraft(entry.message))
        untrashed.push(entry.message);
      if (entry.labelIds?.includes('INBOX')) inboxMoves.push([entry.message.id, false]);
    }
  }
  return changes;
}

/**
 * Drafts (D9). Google documents history messages as "typically" carrying only id and threadId (proto-google D17), so a
 * message without labelIds may be a draft; one `drafts.list` (5 units) settles every such message, finds the drafts
 * deleted or sent elsewhere, and maps message ids to draft ids. It runs only when the page touches a draft. The list is
 * paged to its end (`DRAFT_LIST_PAGES`); a draft is reported `removed` only when the listing is complete AND a
 * `drafts.get` answers 404 for it (`retainedDrafts`; a draft in Trash counts as gone, `drafts.list` hides it): a partial or racing listing never deletes
 * a draft that exists.
 */
function needsDrafts(changes: PageChanges, draftMap: ReadonlyMap<string, string>): boolean {
  const { added, undrafted, untrashed, deleted } = changes;
  return (
    [...added, ...untrashed].some(m => !deleted.has(m.id) && mayBeDraft(m)) ||
    undrafted.length > 0 ||
    [...deleted].some(id => draftMap.has(id))
  );
}

/**
 * The message ids this adapter reported or saw for `draftId` earlier that are not `messageId`: Gmail gives a draft a new
 * message id on every update, so these are the versions the fact replaces. Only ids this adapter itself recorded for the
 * same draft id (`DRAFTS_KEY`) are named; nothing is guessed from the page's deleted messages.
 */
function previousMessages(
  draftMap: ReadonlyMap<string, string>,
  draftId: string,
  messageId: string,
): string[] {
  return [...draftMap].filter(([id, d]) => d === draftId && id !== messageId).map(([id]) => id);
}

/** The drafts facts and the next message id -> draft id map, given the drafts Gmail has now (`current`). */
async function settleDrafts(
  ctx: AdapterContext,
  changes: PageChanges,
  draftMap: Map<string, string>,
  current: Map<string, string>,
  { retained, rotate }: Retained,
  now: number,
): Promise<{ drafts: RemoteDraftFact[]; nextDraftMap: Map<string, string> }> {
  const { deleted } = changes;
  const live = (m: HistoryRef) => !deleted.has(m.id);
  // New messages and restored-from-Trash ones, each once.
  const added = [...new Map([...changes.added, ...changes.untrashed].map(m => [m.id, m])).values()];
  const drafts: RemoteDraftFact[] = [];
  const currentIds = new Set(current.values());
  const nextDraftMap = new Map<string, string>();
  const draftOf = new Map([...current].map(([messageId, draftId]) => [draftId, messageId]));
  for (const [messageId, draftId] of draftMap) {
    if (currentIds.has(draftId)) nextDraftMap.set(draftOf.get(draftId)!, draftId);
    // Not on the listing, but the listing is partial or the draft still answers: it stays tracked, never `removed`.
    else if (retained.has(draftId)) nextDraftMap.set(messageId, draftId);
    // Deleted or sent elsewhere (a 404 confirmed it): it leaves Drafts.
    else
      drafts.push({
        remoteDraftId: draftId,
        remoteMessageId: messageId,
        changedAt: now,
        removed: true,
      });
  }
  // A draft just confirmed alive goes to the back of the line, so the next pass checks the others first.
  for (const [messageId, draftId] of [...nextDraftMap]) {
    if (!rotate.has(draftId)) continue;
    nextDraftMap.delete(messageId);
    nextDraftMap.set(messageId, draftId);
  }
  // A draft copy this device wrote (`drafts.remote_message_id`) is Aplos's own save, not news; any other message id on
  // a draft is a phone draft or an edit made elsewhere, which the engine reconciles (ARCH 7.4, FR-26).
  const candidates = added.filter(m => live(m) && current.has(m.id)).map(m => m.id);
  const own = candidates.length
    ? await ctx.lookup.draftsByMessageId(candidates)
    : new Map<string, string>();
  for (const m of added) {
    const draftId = current.get(m.id);
    if (!draftId || !live(m)) continue;
    nextDraftMap.set(m.id, draftId);
    if (own.has(m.id)) continue;
    const supersedes = previousMessages(draftMap, draftId, m.id);
    drafts.push({
      remoteDraftId: draftId,
      remoteMessageId: m.id,
      remoteThreadId: m.threadId,
      changedAt: now,
      ...(supersedes.length ? { supersedes } : {}),
    });
  }
  return { drafts, nextDraftMap };
}

/** New mail and Inbox gains that are not drafts: the only messages a page may fetch. */
interface FetchCandidates {
  mail: HistoryRef[];
  gained: HistoryRef[];
  knownThreads: ReadonlySet<string>;
}

/**
 * Which messages need a fetch: new mail in a known thread or in the Inbox (D14), a sent draft that is now mail, and
 * any message that entered the Inbox which this device lacks (D3) and did not leave again later on the same page.
 * Everything else is a zero-cost delta.
 */
async function fetchCandidates(
  ctx: AdapterContext,
  changes: PageChanges,
  current: Map<string, string> | undefined,
): Promise<FetchCandidates> {
  const { added, undrafted, inboxGained, deleted, inboxMoves } = changes;
  const live = (m: HistoryRef) => !deleted.has(m.id);
  const isDraft = (m: HistoryRef) =>
    current ? current.has(m.id) : Boolean(m.labelIds?.includes('DRAFT'));
  const mail = [...added, ...undrafted].filter(
    m => live(m) && !isDraft(m) && !m.labelIds?.includes('DRAFT'),
  );
  // Later moves overwrite earlier ones, so this is each message's last Inbox move on the page.
  const lastMove = new Map(inboxMoves);
  const gained = inboxGained.filter(m => live(m) && !isDraft(m) && lastMove.get(m.id) === true);
  const threadIds = [...new Set([...mail, ...gained].map(m => m.threadId))];
  const knownThreads = threadIds.length
    ? await ctx.lookup.knownThreads(threadIds)
    : new Set<string>();
  return { mail, gained, knownThreads };
}

/** The fetch entries, given which candidates the newest Inbox page holds (`inboxNow`). */
async function decideFetches(
  ctx: AdapterContext,
  { mail, gained, knownThreads }: FetchCandidates,
  inboxNow: ReadonlySet<string>,
): Promise<string[]> {
  const wanted = new Map<string, HistoryRef>();
  for (const m of mail) {
    const inbox = m.labelIds ? m.labelIds.includes('INBOX') : inboxNow.has(m.id);
    if (knownThreads.has(m.threadId) || inbox) wanted.set(m.id, m);
  }
  for (const m of gained) wanted.set(m.id, m);
  const knownMessages = wanted.size
    ? await ctx.lookup.knownMessages([...wanted.keys()])
    : new Set<string>();
  const byThread = new Map<string, string[]>();
  for (const m of wanted.values()) {
    if (!knownMessages.has(m.id))
      byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m.id]);
  }
  // One call per new thread, however many of its messages moved (D3); single messages in threads already known.
  return [...byThread].flatMap(([threadId, ids]) =>
    entriesFor(threadId, ids, knownThreads.has(threadId)),
  );
}

/** Label and flag deltas for the page's messages, leaving out deleted ones and `skip`. */
function pageDeltas(
  { labels, deleted }: PageChanges,
  skip: ReadonlySet<string>,
): Pick<StepResult, 'labelDeltas' | 'flagDeltas'> {
  const labelDeltas: LabelDelta[] = [];
  const flagDeltas: FlagDelta[] = [];
  for (const [remoteId, entry] of labels) {
    if (deleted.has(remoteId) || skip.has(remoteId)) continue;
    if (entry.add.size || entry.remove.size)
      labelDeltas.push({ remoteId, add: [...entry.add], remove: [...entry.remove] });
    if (entry.seen !== undefined || entry.flagged !== undefined) {
      flagDeltas.push({
        remoteId,
        ...(entry.seen !== undefined ? { seen: entry.seen } : {}),
        ...(entry.flagged !== undefined ? { flagged: entry.flagged } : {}),
      });
    }
  }
  return {
    ...(labelDeltas.length ? { labelDeltas } : {}),
    ...(flagDeltas.length ? { flagDeltas } : {}),
  };
}

/** The drafts facts and provider_memory writes of a page, which both the capped and the normal result carry. */
function pageExtras(
  ctx: AdapterContext,
  drafts: RemoteDraftFact[],
  nextDraftMap: ReadonlyMap<string, string>,
  pending: PendingBodies,
  inboxMoves: readonly [string, boolean][],
): Pick<StepResult, 'drafts' | 'memory'> {
  const memory: Record<string, string | null> = {};
  const draftsJson = nextDraftMap.size ? JSON.stringify(Object.fromEntries(nextDraftMap)) : null;
  if (draftsJson !== (ctx.memory.get(DRAFTS_KEY) ?? null)) memory[DRAFTS_KEY] = draftsJson;
  const waiting = pendingJson(pending);
  if (waiting !== (ctx.memory.get(PENDING_KEY) ?? null)) memory[PENDING_KEY] = waiting;
  const regained = regainedList(ctx.memory, inboxMoves);
  if (regained !== undefined) memory[REGAINED_KEY] = regained;
  return {
    ...(drafts.length ? { drafts } : {}),
    ...(Object.keys(memory).length ? { memory } : {}),
  };
}

/** The history state after the page's fetches: the cursor moves only when every fetch is in. */
function nextHistoryState(
  state: SyncState,
  page: HistoryPage,
  records: readonly HistoryRecord[],
  fetched: { stopped: boolean; pending: string[] },
  passFetches: number,
  now: number,
): SyncState {
  const { stopped, pending } = fetched;
  const complete = !stopped && !pending.length;
  const more = Boolean(page.nextPageToken);
  const lastRecord = records[records.length - 1]?.id;
  const cursor = !complete
    ? state.cursor
    : more
      ? (lastRecord ?? state.cursor)
      : (page.historyId ?? lastRecord ?? state.cursor);
  return {
    scope: 'history',
    cursor,
    generation: state.generation,
    updatedAt: now,
    ...(complete && more
      ? { phase: `pass:${passFetches}` }
      : !complete && state.phase
        ? { phase: state.phase }
        : {}),
    ...(pending.length ? { pending } : {}),
  };
}

/**
 * Bodies for the foreign drafts of this page (`draft-body.ts`). The bound is per pass (all its pages), not per page: the
 * pages of a pass that is not at its head count together, and a page of a pass that used its reads makes none.
 */
async function bodiesFor(
  client: GmailClient,
  step: PlannedStep,
  state: SyncState,
  ctx: AdapterContext,
  drafts: RemoteDraftFact[],
  now: number,
) {
  const priorReads = atHead(state) ? 0 : Number(ctx.memory.get(READS_KEY)) || 0;
  const budget = Math.max(0, BODY_FETCHES - priorReads);
  const delivered = await deliverBodies(
    client,
    step.lane,
    ctx.log,
    drafts,
    readPending(ctx.memory),
    now,
    ctx.account.address,
    budget,
  );
  return { ...delivered, priorReads };
}

export async function historyStep(
  rt: SyncRuntime,
  step: PlannedStep,
  state: SyncState,
  ctx: AdapterContext,
): Promise<StepResult> {
  if (!state.cursor) return cursorStep(rt, step, state, ctx);
  const client = new GmailClient(rt.deps, ctx);
  const now = ctx.clock.now();
  const reset = (reason: ResetReason, partial: Partial<StepResult> = {}): StepResult => {
    ctx.log.event('sync.gmail.cursor_reset', { reset: reason });
    return {
      ...partial,
      memory: { ...partial.memory, ...lastSeenWrite(state, ctx) },
      reset: reason,
      nextStates: resetStates(state, ctx),
      done: true,
      costUnits: client.spent,
    };
  };

  let page: HistoryPage;
  try {
    page = await client.call<HistoryPage>({
      method: 'gmail.history.list',
      path: '/history',
      query: { startHistoryId: state.cursor, maxResults: 500, historyTypes: HISTORY_TYPES },
      fields: HISTORY_FIELDS,
      lane: step.lane,
    });
  } catch (error) {
    if (error instanceof ProviderError && error.error.status === 404) return reset('cursorExpired');
    if (isStop(error)) return untouched(state, client.spent);
    throw error;
  }

  const records = page.history ?? [];
  const changes = collectChanges(rt, records);

  const draftMap = readDraftMap(ctx.memory);
  let current: Map<string, string> | undefined; // message id -> draft id, as Gmail has them now
  let retained: Retained = { retained: new Set(), rotate: new Set() };
  try {
    if (needsDrafts(changes, draftMap)) {
      const listing = await listDrafts(client, step);
      current = listing.current;
      retained = await retainedDrafts(client, step, draftMap, listing, changes.deleted);
    }
  } catch (error) {
    if (isStop(error)) return untouched(state, client.spent);
    throw error;
  }
  const settled = current
    ? await settleDrafts(ctx, changes, draftMap, current, retained, now)
    : { drafts: [], nextDraftMap: draftMap };
  const { nextDraftMap } = settled;
  const delivered = await bodiesFor(client, step, state, ctx, settled.drafts, now);
  const { drafts } = delivered;

  const candidates = await fetchCandidates(ctx, changes, current);
  // Without labelIds, Inbox membership of mail in an unknown thread comes from one Inbox list page (5 units): new mail
  // is the newest, so it is on that page if it is in the Inbox at all. Never a fetch per message to find out.
  const unsure = candidates.mail.filter(
    m => !m.labelIds && !candidates.knownThreads.has(m.threadId),
  );
  let inboxNow = new Set<string>();
  try {
    if (unsure.length) inboxNow = await listInbox(client, step);
  } catch (error) {
    if (isStop(error)) return untouched(state, client.spent);
    throw error;
  }
  const toFetch = await decideFetches(ctx, candidates, inboxNow);

  const passFetches =
    Number(/^pass:(\d+)$/.exec(state.phase ?? '')?.[1] ?? 0) +
    toFetch.reduce((sum, e) => sum + weight(e), 0);
  const draftMessages = new Set([...draftMap.keys(), ...(current?.keys() ?? [])]);
  const removals: Removal[] = [...changes.deleted]
    .filter(id => !draftMessages.has(id))
    .map(remoteId => ({ remoteId }));
  const extras = pageExtras(ctx, drafts, nextDraftMap, delivered.pending, changes.inboxMoves);

  if (passFetches > CHANGE_CAP) {
    // Keep the free part of this page (deltas, removals, drafts); the resync fetches what the Inbox now holds.
    return reset('changeCapExceeded', {
      ...pageDeltas(changes, new Set()),
      ...(removals.length ? { removals } : {}),
      ...extras,
    });
  }

  const fetched = await fetchMetadata(client, toFetch, {
    lane: step.lane,
    self: ctx.account.address,
    memo: rt.memo,
    now,
  });

  // A message that keeps failing on its own is quarantined after a few polls, so it cannot pin the cursor here.
  // This pass counts toward the back-off of entries quarantined earlier, not of one quarantined by this very pass.
  const memory = { ...extras.memory };
  Object.assign(memory, passWrites(ctx.memory, memory));
  Object.assign(memory, settleFailures(ctx, fetched, toFetch, memory));

  // The fetched rows carry the current labels; their deltas from this page would only repeat them.
  const upserted = new Set(fetched.facts.map(f => f.remoteId));
  const next = nextHistoryState(state, page, records, fetched, passFetches, now);
  Object.assign(memory, headWrites(state, next, ctx.memory));
  Object.assign(memory, readsWrite(next, ctx.memory, delivered.priorReads + delivered.reads));
  return {
    ...pageDeltas(changes, upserted),
    ...(fetched.facts.length ? { upserts: fetched.facts } : {}),
    ...(removals.length ? { removals } : {}),
    ...extras,
    ...(Object.keys(memory).length ? { memory } : {}),
    ...(fetched.quarantine.length ? { quarantine: fetched.quarantine } : {}),
    nextStates: [next],
    done: !fetched.stopped,
    costUnits: client.spent,
  };
}

/**
 * The running Inbox round's regained list after this page's Inbox moves, or undefined when nothing changes. Kept only
 * while a round is between listing and sweep (`INBOX_ROUND_MARK`), so it stays small and never outlives the round.
 */
function regainedList(
  memory: ReadonlyMap<string, string>,
  moves: readonly [string, boolean][],
): string | undefined {
  if (!memory.has(INBOX_ROUND_MARK) || !moves.length) return undefined;
  const before = memory.get(REGAINED_KEY) ?? '';
  if (before === '*') return undefined;
  const ids = new Set(before.split(' ').filter(Boolean));
  for (const [id, entered] of moves) {
    if (entered) ids.add(id);
    else ids.delete(id);
  }
  const after = ids.size > REGAINED_MAX ? '*' : [...ids].join(' ');
  return after === before ? undefined : after;
}

/** At most this many `drafts.list` pages (500 drafts each, 5 units each) are read in one pass. */
export const DRAFT_LIST_PAGES = 20;
/** At most this many missing drafts are checked with a `drafts.get` in one pass; the rest stay tracked. */
export const DRAFT_CONFIRMS = 10;
/** Missing drafts whose message this very page deleted are checked first and have their own, larger bound. */
export const DRAFT_DELETED_CONFIRMS = 50;

interface DraftListing {
  /** message id -> draft id, as Gmail has them now. */
  current: Map<string, string>;
  /** True only when the last page carried no `nextPageToken`: every draft was seen. */
  complete: boolean;
}

/**
 * The account's drafts now, paged through every `nextPageToken` (bounded by `DRAFT_LIST_PAGES`; the body stays lazy).
 * A repeated token or the page bound leaves `complete` false, and nothing may then be concluded from an absence.
 */
async function listDrafts(client: GmailClient, step: PlannedStep): Promise<DraftListing> {
  const current = new Map<string, string>();
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;
  for (let page = 0; page < DRAFT_LIST_PAGES; page++) {
    const list = await client.call<{
      drafts?: { id: string; message?: { id: string } }[];
      nextPageToken?: string;
    }>({
      method: 'gmail.drafts.list',
      path: '/drafts',
      query: { maxResults: 500, ...(pageToken ? { pageToken } : {}) },
      fields: 'drafts(id,message(id)),nextPageToken',
      lane: step.lane,
    });
    for (const d of list.drafts ?? []) if (d.message) current.set(d.message.id, d.id);
    pageToken = list.nextPageToken;
    if (!pageToken) return { current, complete: true };
    if (seenTokens.has(pageToken)) break;
    seenTokens.add(pageToken);
  }
  return { current, complete: false };
}

/** The drafts that stay tracked this pass (`retained`) and the ones just seen alive (`rotate`, moved to the back). */
interface Retained {
  retained: ReadonlySet<string>;
  rotate: ReadonlySet<string>;
}

/**
 * The tracked drafts that must NOT be reported `removed` this pass: all of them when the listing is incomplete, and,
 * for a complete one, every missing draft that still answers `drafts.get` as a live draft (a listing can skip an item
 * when drafts change while it is paged) or that is past the bounds (`DRAFT_DELETED_CONFIRMS` for those this page deleted, `DRAFT_CONFIRMS` for the rest). Gone is: a 404 with Gmail's
 * `notFound` reason, or a draft that is in Trash, sent or no longer a draft (`drafts.list` hides trashed drafts, but
 * `drafts.get` still answers 200 for them). Missing drafts whose message this page deleted are checked first, then the
 * least recently checked (a draft seen alive or unknown moves to the back of the tracked map), so every draft gets its turn. Any
 * other failure keeps the draft tracked and a pause (429) stops the step.
 */
async function retainedDrafts(
  client: GmailClient,
  step: PlannedStep,
  draftMap: ReadonlyMap<string, string>,
  { current, complete }: DraftListing,
  deleted: ReadonlySet<string>,
): Promise<Retained> {
  const listed = new Set(current.values());
  const hot = new Set<string>();
  for (const [messageId, draftId] of draftMap) if (deleted.has(messageId)) hot.add(draftId);
  const missing = [...new Set(draftMap.values())].filter(id => !listed.has(id));
  if (!complete) return { retained: new Set(missing), rotate: new Set() };
  const order = [
    ...missing.filter(id => hot.has(id)).slice(0, DRAFT_DELETED_CONFIRMS),
    ...missing.filter(id => !hot.has(id)).slice(0, DRAFT_CONFIRMS),
  ];
  const retained = new Set(missing.filter(id => !order.includes(id)));
  const rotate = new Set<string>();
  for (const draftId of order) {
    const verdict = await draftVerdict(client, step, draftId);
    if (verdict === 'gone') continue;
    retained.add(draftId);
    rotate.add(draftId); // alive or unknown: either way it goes to the back, so it cannot hold the front
  }
  return { retained, rotate };
}

/** What `drafts.get` says about a draft: gone (proved), alive (a live draft) or unknown (an error that proves nothing). */
async function draftVerdict(
  client: GmailClient,
  step: PlannedStep,
  draftId: string,
): Promise<'gone' | 'alive' | 'unknown'> {
  try {
    const reply = await client.call<{ message?: { labelIds?: string[] } }>({
      method: 'gmail.drafts.get',
      path: `/drafts/${encodeURIComponent(draftId)}`,
      fields: 'id,message(labelIds)',
      lane: step.lane,
      item: draftId,
    });
    const labels = reply.message?.labelIds;
    if (!Array.isArray(labels)) return 'unknown';
    const live = labels.includes('DRAFT') && !labels.includes('TRASH') && !labels.includes('SENT');
    return live ? 'alive' : 'gone';
  } catch (error) {
    if (isStop(error)) throw error;
    const proved = error instanceof ProviderError && error.error.status === 404;
    return proved && error.error.reason === 'notFound' ? 'gone' : 'unknown';
  }
}

/** Ids on the newest Inbox page (one `messages.list`, 5 units). */
async function listInbox(client: GmailClient, step: PlannedStep): Promise<Set<string>> {
  const list = await client.call<{ messages?: { id: string }[] }>({
    method: 'gmail.messages.list',
    path: '/messages',
    query: { labelIds: ['INBOX'], maxResults: 500 },
    fields: 'messages(id)',
    lane: step.lane,
  });
  return new Set((list.messages ?? []).map(m => m.id));
}
