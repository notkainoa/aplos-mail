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
 * start a bounded Inbox resync round whose sweep removes ghosts (D10). Never a full re-download. Before the first
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
  const labels = new Map<string, Pending>();
  const added: HistoryRef[] = [];
  const inboxGained: HistoryRef[] = [];
  /** Messages that lost DRAFT without being deleted: a draft sent with `drafts.send` keeps its id and becomes mail. */
  const undrafted: HistoryRef[] = [];
  const deleted = new Set<string>();
  // Inbox entries and exits in record order, for the running Inbox round's sweep (REGAINED_KEY).
  const inboxMoves: [string, boolean][] = [];
  const change = (ref: HistoryRef, ids: readonly string[] | undefined, adding: boolean) => {
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
  };
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
      change(entry.message, entry.labelIds, true);
      if (entry.labelIds?.includes('INBOX')) {
        inboxGained.push(entry.message);
        inboxMoves.push([entry.message.id, true]);
      }
    }
    for (const entry of record.labelsRemoved ?? []) {
      rt.memo.changed(entry.message.id, record.id);
      change(entry.message, entry.labelIds, false);
      if (entry.labelIds?.includes('DRAFT')) undrafted.push(entry.message);
      if (entry.labelIds?.includes('INBOX')) inboxMoves.push([entry.message.id, false]);
    }
  }

  // Drafts (D9). Google documents history messages as "typically" carrying only id and threadId (proto-google D17), so
  // a message without labelIds may be a draft; one `drafts.list` (5 units) settles every such message, finds the
  // drafts deleted or sent elsewhere, and maps message ids to draft ids. It runs only when the page touches a draft.
  const draftMap = readDraftMap(ctx.memory);
  const live = (m: HistoryRef) => !deleted.has(m.id);
  const needDrafts =
    added.some(m => live(m) && (!m.labelIds || m.labelIds.includes('DRAFT'))) ||
    undrafted.length > 0 ||
    [...deleted].some(id => draftMap.has(id));
  let current: Map<string, string> | undefined; // message id -> draft id, as Gmail has them now
  let drafts: RemoteDraftFact[] = [];
  let nextDraftMap = draftMap;
  try {
    if (needDrafts) current = await listDrafts(client, step);
  } catch (error) {
    if (isStop(error)) return untouched(state, client.spent);
    throw error;
  }
  const isDraft = (m: HistoryRef) =>
    current ? current.has(m.id) : Boolean(m.labelIds?.includes('DRAFT'));
  if (current) {
    const currentIds = new Set(current.values());
    nextDraftMap = new Map();
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
    const candidates = added.filter(m => live(m) && current!.has(m.id)).map(m => m.id);
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
  }

  // Which messages need a fetch: new mail in a known thread or in the Inbox (D14), a sent draft that is now mail, and
  // any message that entered the Inbox which this device lacks (D3). Everything else is a zero-cost delta.
  const mail = [...added, ...undrafted].filter(
    m => live(m) && !isDraft(m) && !m.labelIds?.includes('DRAFT'),
  );
  const gained = inboxGained.filter(m => live(m) && !isDraft(m));
  const threadIds = [...new Set([...mail, ...gained].map(m => m.threadId))];
  const knownThreads = threadIds.length
    ? await ctx.lookup.knownThreads(threadIds)
    : new Set<string>();
  // Without labelIds, Inbox membership of mail in an unknown thread comes from one Inbox list page (5 units): new mail
  // is the newest, so it is on that page if it is in the Inbox at all. Never a fetch per message to find out.
  const unsure = mail.filter(m => !m.labelIds && !knownThreads.has(m.threadId));
  let inboxNow = new Set<string>();
  try {
    if (unsure.length) inboxNow = await listInbox(client, step);
  } catch (error) {
    if (isStop(error)) return untouched(state, client.spent);
    throw error;
  }
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
  const toFetch = [...byThread].flatMap(([threadId, ids]) =>
    entriesFor(threadId, ids, knownThreads.has(threadId)),
  );

  const passFetches =
    Number(/^pass:(\d+)$/.exec(state.phase ?? '')?.[1] ?? 0) +
    toFetch.reduce((sum, e) => sum + weight(e), 0);
  const draftMessages = new Set([...draftMap.keys(), ...(current?.keys() ?? [])]);
  const removals: Removal[] = [...deleted]
    .filter(id => !draftMessages.has(id))
    .map(remoteId => ({ remoteId }));
  const deltas = (skip: ReadonlySet<string>) => {
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
  };
  const memory: Record<string, string | null> = {};
  const draftsJson = nextDraftMap.size ? JSON.stringify(Object.fromEntries(nextDraftMap)) : null;
  if (draftsJson !== (ctx.memory.get(DRAFTS_KEY) ?? null)) memory[DRAFTS_KEY] = draftsJson;
  const regained = regainedList(ctx.memory, inboxMoves);
  if (regained !== undefined) memory[REGAINED_KEY] = regained;
  const extras = {
    ...(drafts.length ? { drafts } : {}),
    ...(Object.keys(memory).length ? { memory } : {}),
  };

  if (passFetches > CHANGE_CAP) {
    // Keep the free part of this page (deltas, removals, drafts); the resync fetches what the Inbox now holds.
    return reset('changeCapExceeded', {
      ...deltas(new Set()),
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
  const stopped = fetched.stopped;
  const pending = fetched.pending;

  // The fetched rows carry the current labels; their deltas from this page would only repeat them.
  const upserted = new Set(fetched.facts.map(f => f.remoteId));
  const complete = !stopped && !pending.length;
  const more = Boolean(page.nextPageToken);
  const lastRecord = records[records.length - 1]?.id;
  const cursor = !complete
    ? state.cursor
    : more
      ? (lastRecord ?? state.cursor)
      : (page.historyId ?? lastRecord ?? state.cursor);
  const next: SyncState = {
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
  return {
    ...deltas(upserted),
    ...(fetched.facts.length ? { upserts: fetched.facts } : {}),
    ...(removals.length ? { removals } : {}),
    ...extras,
    ...(fetched.quarantine.length ? { quarantine: fetched.quarantine } : {}),
    nextStates: [next],
    done: !stopped,
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
