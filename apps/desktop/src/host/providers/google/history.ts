import {
  ProviderError,
  type AdapterContext,
  type FlagDelta,
  type LabelDelta,
  type PlannedStep,
  type RemoteDraftFact,
  type Removal,
  type ResetReason,
  type StepResult,
  type SyncState,
} from '@aplos/engine/ports';
import { GmailClient, isStop } from './client';
import { FLAG_LABELS, folderFacts, type GmailLabel } from './facts';
import { settleFailures } from './failures';
import {
  FIRST_WINDOW_KEY,
  INBOX_ROUND_MARK,
  REGAINED_KEY,
  entriesFor,
  entryThread,
  fetchMetadata,
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
    return {
      folders: folderFacts(labels.labels ?? []),
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

/** What one history page says, in record order. */
interface PageChanges {
  labels: Map<string, Pending>;
  added: HistoryRef[];
  inboxGained: HistoryRef[];
  /** Messages that lost DRAFT without being deleted: a draft sent with `drafts.send` keeps its id and becomes mail. */
  undrafted: HistoryRef[];
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
    deleted: new Set(),
    inboxMoves: [],
  };
  const { labels, added, inboxGained, undrafted, deleted, inboxMoves } = changes;
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
      if (entry.labelIds?.includes('INBOX')) inboxMoves.push([entry.message.id, false]);
    }
  }
  return changes;
}

/**
 * Drafts (D9). Google documents history messages as "typically" carrying only id and threadId (proto-google D17), so a
 * message without labelIds may be a draft; one `drafts.list` (5 units) settles every such message, finds the drafts
 * deleted or sent elsewhere, and maps message ids to draft ids. It runs only when the page touches a draft.
 */
function needsDrafts(changes: PageChanges, draftMap: ReadonlyMap<string, string>): boolean {
  const { added, undrafted, deleted } = changes;
  return (
    added.some(m => !deleted.has(m.id) && (!m.labelIds || m.labelIds.includes('DRAFT'))) ||
    undrafted.length > 0 ||
    [...deleted].some(id => draftMap.has(id))
  );
}

/** The drafts facts and the next message id -> draft id map, given the drafts Gmail has now (`current`). */
async function settleDrafts(
  ctx: AdapterContext,
  changes: PageChanges,
  draftMap: Map<string, string>,
  current: Map<string, string>,
  now: number,
): Promise<{ drafts: RemoteDraftFact[]; nextDraftMap: Map<string, string> }> {
  const { added, deleted } = changes;
  const live = (m: HistoryRef) => !deleted.has(m.id);
  const drafts: RemoteDraftFact[] = [];
  const currentIds = new Set(current.values());
  const nextDraftMap = new Map<string, string>();
  const draftOf = new Map([...current].map(([messageId, draftId]) => [draftId, messageId]));
  for (const [messageId, draftId] of draftMap) {
    if (currentIds.has(draftId)) nextDraftMap.set(draftOf.get(draftId)!, draftId);
    // Deleted or sent elsewhere: it leaves Drafts.
    else
      drafts.push({
        remoteDraftId: draftId,
        remoteMessageId: messageId,
        changedAt: now,
        removed: true,
      });
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
    drafts.push({
      remoteDraftId: draftId,
      remoteMessageId: m.id,
      remoteThreadId: m.threadId,
      changedAt: now,
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
  inboxMoves: readonly [string, boolean][],
): Pick<StepResult, 'drafts' | 'memory'> {
  const memory: Record<string, string | null> = {};
  const draftsJson = nextDraftMap.size ? JSON.stringify(Object.fromEntries(nextDraftMap)) : null;
  if (draftsJson !== (ctx.memory.get(DRAFTS_KEY) ?? null)) memory[DRAFTS_KEY] = draftsJson;
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
  try {
    if (needsDrafts(changes, draftMap)) current = await listDrafts(client, step);
  } catch (error) {
    if (isStop(error)) return untouched(state, client.spent);
    throw error;
  }
  const { drafts, nextDraftMap } = current
    ? await settleDrafts(ctx, changes, draftMap, current, now)
    : { drafts: [], nextDraftMap: draftMap };

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
  const extras = pageExtras(ctx, drafts, nextDraftMap, changes.inboxMoves);

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
  const memory = { ...extras.memory, ...settleFailures(ctx, fetched, toFetch) };

  // The fetched rows carry the current labels; their deltas from this page would only repeat them.
  const upserted = new Set(fetched.facts.map(f => f.remoteId));
  const next = nextHistoryState(state, page, records, fetched, passFetches, now);
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

/** The account's drafts now, message id -> draft id (one `drafts.list` page, 5 units; the body stays lazy). */
async function listDrafts(client: GmailClient, step: PlannedStep): Promise<Map<string, string>> {
  const list = await client.call<{ drafts?: { id: string; message?: { id: string } }[] }>({
    method: 'gmail.drafts.list',
    path: '/drafts',
    query: { maxResults: 500 },
    fields: 'drafts(id,message(id))',
    lane: step.lane,
  });
  return new Map((list.drafts ?? []).filter(d => d.message).map(d => [d.message!.id, d.id]));
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
