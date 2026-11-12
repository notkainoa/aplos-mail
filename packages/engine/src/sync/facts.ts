import type {
  AdapterAccount,
  AccountId,
  FlagDelta,
  MessageFacts,
  PlacementDelta,
  PlannedStep,
  RemoteDraftFact,
  StepResult,
  StoreWrite,
  SyncState,
} from '../ports';
import { effectiveClearedFailures } from '../ports';
import type { HeaderBits, MessageTarget, MessageWrite } from '../store/port';

// Provider facts to store writes. Pure: the actor adds the account and step bookkeeping and commits the lot in one
// transaction, so a page's facts and its resume token land together or not at all (ARCH 4.2 rule 2).

/** A quarantined item's next try: 5 minutes, doubling, at most a day (ARCH 4.2 rule 7). */
export function quarantineDelay(attempts: number): number {
  return Math.min(86_400_000, 300_000 * 2 ** Math.max(0, attempts - 1));
}

const NOREPLY = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|notifications?)@/i;

/** ARCH 5.1's header facts as the store's bits: bulk, list, auto-submitted, no-reply, to me, cc me. */
function headerBits(facts: MessageFacts, self: string): HeaderBits {
  const precedence = facts.list.precedence?.toLowerCase();
  const me = self.toLowerCase();
  const bits: HeaderBits = {
    bulk: precedence === 'bulk' || precedence === 'list' || precedence === 'junk',
    list: facts.list.listId !== undefined,
    autoSubmitted:
      facts.list.autoSubmitted !== undefined && facts.list.autoSubmitted.toLowerCase() !== 'no',
    noreply: facts.from !== undefined && NOREPLY.test(facts.from.address),
    directToMe: facts.to.some(a => a.address.toLowerCase() === me),
    ccMe: facts.cc.some(a => a.address.toLowerCase() === me),
  };
  return bits;
}

/** RFC 8058 section 3.1: the whole `List-Unsubscribe-Post` value is exactly this, case-sensitive; surrounding space is not part of it. */
const ONE_CLICK_POST = 'List-Unsubscribe=One-Click';

/** One-click only for the exact value: extra text, another case or several values never count. */
function oneClickPost(post: string | undefined): boolean {
  return post !== undefined && post.trim() === ONE_CLICK_POST;
}

/** A longer header is ignored whole (same limit as the host executor); the sender controls this text. */
const MAX_UNSUBSCRIBE_HEADER = 8_192;

/** One `<uri>`; no `<` inside, so a run of `<` cannot make the scan quadratic and an entry with `<` is skipped, as the executor does. */
const URI_ENTRY = /<([^<>]*)>/g;

/** `List-Unsubscribe: <https://...>, <mailto:...>` and RFC 8058 one-click. */
function unsubscribe(facts: MessageFacts): MessageWrite['listUnsubscribe'] {
  const header = facts.list.listUnsubscribe;
  if (!header || header.length > MAX_UNSUBSCRIBE_HEADER) return undefined;
  const urls = [...header.matchAll(URI_ENTRY)].map(m => m[1].trim()).filter(Boolean);
  if (!urls.length) return undefined;
  return oneClickPost(facts.list.listUnsubscribePost) ? { urls, oneClick: true } : { urls };
}

/** One message's metadata. `seenGen` only for list rounds; history, open and search leave the stamp alone. */
export function messageWrite(
  accountId: AccountId,
  self: string,
  facts: MessageFacts,
  seenGen?: number,
): MessageWrite {
  const write: MessageWrite = {
    kind: 'message',
    accountId,
    remoteId: facts.remoteId,
    remoteThreadId: facts.remoteThreadId,
    to: facts.to,
    cc: facts.cc,
    date: facts.date,
    internalDate: facts.internalDate,
    flags: facts.flags,
    hdr: headerBits(facts, self),
  };
  if (facts.internetId !== undefined) write.internetId = facts.internetId;
  if (facts.inReplyTo !== undefined) write.inReplyTo = facts.inReplyTo;
  if (facts.references !== undefined) write.refs = facts.references;
  if (facts.from !== undefined) write.from = facts.from;
  if (facts.bcc !== undefined) write.bcc = facts.bcc;
  if (facts.replyTo !== undefined) write.replyTo = facts.replyTo;
  if (facts.subject !== undefined) write.subject = facts.subject;
  if (facts.snippet !== undefined) write.snippet = facts.snippet;
  if (facts.size !== undefined) write.size = facts.size;
  if (facts.attachments) write.hasAttachments = facts.attachments.some(a => !a.inline);
  const unsub = unsubscribe(facts);
  if (unsub) write.listUnsubscribe = unsub;
  // The verdict is about List-Unsubscribe, so it is kept only with one, and only as a real boolean (absent is unknown).
  const verdict: unknown = facts.list.authenticated;
  if (unsub && typeof verdict === 'boolean') write.listAuthenticated = verdict;
  // A complete folder set replaces the stored one; a per-folder step adds placements instead (F3 `placementsComplete`).
  if (facts.placementsComplete !== false) {
    write.folders = facts.placements.map(p =>
      p.uid === undefined ? { folder: p.folder } : { folder: p.folder, uid: p.uid },
    );
  }
  if (seenGen !== undefined) write.seenGen = seenGen;
  return write;
}

export function messageWrites(
  accountId: AccountId,
  self: string,
  facts: MessageFacts,
  seenGen?: number,
): StoreWrite[] {
  const writes: StoreWrite[] = [messageWrite(accountId, self, facts, seenGen)];
  if (facts.placementsComplete === false && facts.placements.length) {
    writes.push({
      kind: 'placements',
      accountId,
      target: { remoteId: facts.remoteId },
      add: facts.placements.map(p =>
        p.uid === undefined ? { folder: p.folder } : { folder: p.folder, uid: p.uid },
      ),
      remove: [],
      ...(seenGen !== undefined ? { seenGen } : {}),
    });
  }
  if (facts.attachments) {
    writes.push({
      kind: 'attachments',
      accountId,
      remoteId: facts.remoteId,
      list: facts.attachments.map(a => ({
        remotePart: a.part,
        name: a.name,
        mime: a.mime,
        size: a.size,
        cid: a.cid,
        inline: a.inline,
      })),
    });
  }
  return writes;
}

function target(d: {
  remoteId?: string;
  folder?: string;
  uid?: number;
}): MessageTarget | undefined {
  if (d.remoteId !== undefined) return { remoteId: d.remoteId };
  if (d.folder !== undefined && d.uid !== undefined) return { folder: d.folder, uid: d.uid };
  return undefined;
}

function flagWrite(accountId: AccountId, d: FlagDelta): StoreWrite | undefined {
  const t = target(d);
  if (!t) return undefined;
  return {
    kind: 'flags',
    accountId,
    target: t,
    seen: d.seen,
    flagged: d.flagged,
    answered: d.answered,
  };
}

function placementWrite(
  accountId: AccountId,
  d: PlacementDelta,
  seenGen?: number,
): StoreWrite | undefined {
  const t = target(d);
  if (!t) return undefined;
  if (!d.present) return { kind: 'placements', accountId, target: t, add: [], remove: [d.folder] };
  const ref = d.uid === undefined ? { folder: d.folder } : { folder: d.folder, uid: d.uid };
  return {
    kind: 'placements',
    accountId,
    target: t,
    add: [ref],
    remove: [],
    ...(seenGen !== undefined ? { seenGen } : {}),
  };
}

/** The draft body limit of the engine (`REMOTE_BODY_MAX` in the outbox); a remote body over it is not delivered. */
const REMOTE_BODY_LIMIT = 1_000_000;

function draftWrite(accountId: AccountId, self: string, d: RemoteDraftFact): StoreWrite {
  const write: StoreWrite = {
    kind: 'remoteDraft',
    accountId,
    remoteDraftId: d.remoteDraftId,
    remoteMessageId: d.remoteMessageId,
    changedAt: d.changedAt,
  };
  if (d.remoteThreadId !== undefined) write.remoteThreadId = d.remoteThreadId;
  if (d.internetId !== undefined) write.internetId = d.internetId;
  if (d.removed) write.removed = true;
  // A body over the draft limit is never stored, but the engine must still see that one was offered (it then leaves the
  // draft snippet-only instead of falling back to another source), so it is cut one character past the limit.
  if (d.html !== undefined) write.html = d.html.slice(0, REMOTE_BODY_LIMIT + 1);
  if (d.text !== undefined) write.text = d.text.slice(0, REMOTE_BODY_LIMIT + 1);
  if (d.supersedes?.length) write.supersedes = d.supersedes;
  if (d.message) {
    const {
      kind: _kind,
      accountId: _account,
      ...message
    } = messageWrite(accountId, self, d.message);
    write.message = message;
    // An inline part (a pasted image) is not delivered either: the copy has parts this device cannot carry, so it is not
    // complete. `hasAttachments` of a message counts only the visible ones.
    if (d.message.attachments?.some(a => a.inline)) write.message.hasAttachments = true;
  }
  return write;
}

/** Which round stamp a step's upserts carry: list rounds only (window, backfill, resync), never history. */
export function roundGeneration(
  step: PlannedStep,
  state: SyncState,
  result: StepResult,
): number | undefined {
  if (step.origin !== 'baseline' && step.origin !== 'backfill' && step.origin !== 'resync')
    return undefined;
  if (step.scope === 'history') return undefined;
  const next = result.nextStates.find(s => s.scope === step.scope);
  return next?.generation ?? state.generation;
}

export interface StepWriteContext {
  account: AdapterAccount;
  step: PlannedStep;
  state: SyncState;
  now: number;
  /** `sync_failures.attempts` so far, by item. */
  failures: ReadonlyMap<string, number>;
  /** `accounts.baseline_done_at` is already set. */
  baselineDone: boolean;
}

function folderWrites(id: AccountId, result: StepResult): StoreWrite[] {
  const writes: StoreWrite[] = [];
  for (const f of result.folders ?? []) {
    if (f.removed) {
      writes.push({ kind: 'folderDelete', accountId: id, remoteId: f.remoteId });
      continue;
    }
    writes.push({
      kind: 'folder',
      accountId: id,
      remoteId: f.remoteId,
      name: f.name,
      role: f.role ?? null,
      folderKind: f.kind,
      ...(f.hidden !== undefined ? { hidden: f.hidden } : {}),
      ...(f.uidValidity !== undefined ? { uidValidity: f.uidValidity } : {}),
    });
  }
  return writes;
}

function upsertWrites(
  id: AccountId,
  self: string,
  result: StepResult,
  gen: number | undefined,
): StoreWrite[] {
  const writes: StoreWrite[] = [];
  const sizes = new Map<string, number>();
  for (const m of result.upserts ?? []) {
    writes.push(...messageWrites(id, self, m, gen));
    if (m.threadSize !== undefined) sizes.set(m.remoteThreadId, m.threadSize);
  }
  for (const [remoteThreadId, remoteCount] of sizes) {
    writes.push({ kind: 'thread', accountId: id, remoteThreadId, remoteCount });
  }
  return writes;
}

function deltaWrites(id: AccountId, result: StepResult, gen: number | undefined): StoreWrite[] {
  const writes: StoreWrite[] = [];
  for (const d of result.labelDeltas ?? []) {
    writes.push({
      kind: 'placements',
      accountId: id,
      target: { remoteId: d.remoteId },
      add: d.add.map(folder => ({ folder })),
      remove: d.remove,
    });
  }
  for (const d of result.flagDeltas ?? []) {
    const w = flagWrite(id, d);
    if (w) writes.push(w);
  }
  // A list round's present deltas (the Gmail window's listed-but-not-fetched ids) carry the round stamp on the step
  // that listed them, as its upserts do. A round that spans steps sets `scopeCovered` only on its last one, so stamping
  // there alone would let that step's sweep remove what an earlier step listed (prov-gov-attack-03). Outside a list
  // round, only the covered folder's deltas are stamped.
  const covered = result.scopeCovered?.bound.folder;
  for (const d of result.placements ?? []) {
    const stamp = gen ?? (d.folder === covered ? result.scopeCovered!.generation : undefined);
    const w = placementWrite(id, d, d.present ? stamp : undefined);
    if (w) writes.push(w);
  }
  return writes;
}

/** One `sync_state` row as a write, exactly as a step commits it (the lease's channel rounds use it too). */
export function syncStateWrite(id: AccountId, s: SyncState): StoreWrite {
  return {
    kind: 'syncState',
    accountId: id,
    scope: s.scope,
    generation: s.generation,
    ...(s.cursor !== undefined ? { cursor: s.cursor } : {}),
    ...(s.pageToken !== undefined ? { pageToken: s.pageToken } : {}),
    ...(s.phase !== undefined ? { phase: s.phase } : {}),
    ...(s.oldestLoaded !== undefined ? { oldestLoaded: s.oldestLoaded } : {}),
    ...(s.pending?.length ? { pending: s.pending } : {}),
  };
}

function syncStateWrites(id: AccountId, result: StepResult): StoreWrite[] {
  return result.nextStates.map(s => syncStateWrite(id, s));
}

function sweepWrites(account: AdapterAccount, result: StepResult): StoreWrite[] {
  // The sweep commits with the step that covered the scope, never after a partial answer or on a partial-view host.
  if (!result.scopeCovered || !result.done || account.capabilities.partialView) return [];
  const { bound, generation } = result.scopeCovered;
  return [
    {
      kind: 'sweep',
      accountId: account.id,
      folder: bound.folder,
      generation,
      ...(bound.since !== undefined ? { since: bound.since } : {}),
      ...(bound.until !== undefined ? { until: bound.until } : {}),
      ...(bound.uidFrom !== undefined ? { uidFrom: bound.uidFrom } : {}),
      ...(bound.uidTo !== undefined ? { uidTo: bound.uidTo } : {}),
    },
  ];
}

function trailingWrites(result: StepResult, ctx: StepWriteContext): StoreWrite[] {
  const { account, now } = ctx;
  const id = account.id;
  const writes: StoreWrite[] = [];
  if (result.memory && Object.keys(result.memory).length) {
    writes.push({ kind: 'providerMemory', accountId: id, values: result.memory });
  }
  for (const q of result.quarantine ?? []) {
    const attempts = (ctx.failures.get(q.item) ?? 0) + 1;
    writes.push({
      kind: 'syncFailure',
      accountId: id,
      item: q.item,
      failure: {
        attempts,
        nextRetryAt: now + quarantineDelay(attempts),
        lastReason: q.error.reason,
      },
    });
  }
  // After the quarantine writes; items quarantined by this same step are skipped, so quarantine wins.
  for (const item of effectiveClearedFailures(result)) {
    writes.push({ kind: 'syncFailure', accountId: id, item, failure: null });
  }
  if (result.baselineReached && !ctx.baselineDone) {
    writes.push({ kind: 'account', id, baselineDoneAt: now });
  }
  return writes;
}

/** Everything one `StepResult` writes, in one commit with its `nextStates` (F3 `StepResult`, ports.walk.md). */
export function stepWrites(result: StepResult, ctx: StepWriteContext): StoreWrite[] {
  const { account } = ctx;
  const id = account.id;
  const self = account.address;
  const gen = roundGeneration(ctx.step, ctx.state, result);
  const writes: StoreWrite[] = [...folderWrites(id, result)];
  for (const merge of result.threadMerges ?? []) {
    writes.push({ kind: 'threadMerge', accountId: id, from: merge.from, into: merge.into });
  }
  writes.push(...upsertWrites(id, self, result, gen), ...deltaWrites(id, result, gen));
  for (const r of result.removals ?? []) {
    writes.push({ kind: 'messageDelete', accountId: id, remoteId: r.remoteId });
  }
  for (const d of result.drafts ?? []) writes.push(draftWrite(id, self, d));
  writes.push(
    ...syncStateWrites(id, result),
    ...sweepWrites(account, result),
    ...trailingWrites(result, ctx),
  );
  return writes;
}
