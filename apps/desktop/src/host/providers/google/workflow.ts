import {
  ProviderError,
  type AdapterContext,
  type SyncState,
  type WorkflowCopy,
} from '@aplos/engine/ports';
import { GmailClient, type GmailDeps, type GmailRequest } from './client';
import {
  APP_LABEL,
  buildCopyMessage,
  copyMessageId,
  logSkipped,
  parseCopyMessage,
  remember,
} from './workflow-message';
import type { SentWindow, WorkflowTransport } from './workflow-state';

/**
 * The Gmail workflow channel (plan 20 PV3, D17, D18; ARCH 6.5, 13.1; DECISIONS M29): Done, Later, todos, reminders and
 * the primary-device lease, shared between devices as sealed copies under the hidden "Aplos Mail Data" label. Ported
 * from `src/main/workflow-sync.ts` and the legacy `readAppData`/`writeAppData` in `src/main/google.ts`, without their
 * Electron coupling, and with their two defects fixed:
 * - D17: a round no longer full-fetches every copy. It is gated on `history.list?labelId=<app label>` (2 units) and
 *   downloads only message ids this process has not already read; a copy is immutable, so its id is enough.
 * - D18: the full read (first round of a process, a lost cursor) pages `messages.list` past 50 copies until Gmail says
 *   there are no more; a read cut short by the page cap resumes next round and does not count as complete.
 * A stale or duplicate copy can never shadow a newer one, because nothing here picks "the newest copy": every copy ever
 * read is merged per key by a logical clock (`workflow-merge.ts`) and the merged view is kept for the process.
 *
 * Two layers, both per account:
 *
 * 1. `GmailWorkflowTransport` implements the port's `WorkflowChannel` (`ports/provider.ts`), plus `readBack`
 *    (`WorkflowTransport` in `workflow-state.ts`), over sealed strings only:
 *    - `round(state, ctx)` returns the copies not read before, the next `workflow` scope state (`cursor` = the label's
 *      history id, `pending` = ids to retry) and the units spent. Costs: no app label yet, 1 unit (`labels.list`, once
 *      per process when found); a round with no label change, 2 units (one `history.list`); a full read, 1 + 1 + 5 per
 *      100 copies + 60 per copy. Throws on a pause or a stop-class refusal, so the actor commits nothing and the next
 *      round resumes from the old cursor; copies it already downloaded are handed over then.
 *    - A download that fails is retried through `pending` (a permanent failure at most 3 times, then given up and
 *      logged). When more ids fail than `pending` holds, the round keeps its old cursor so none is skipped. A history
 *      read longer than the page cap advances to the last record it read.
 *    - `put(copy, ctx, { retry })` inserts one copy (`messages.insert`, 25, kind `write`, never re-sent). A repeated
 *      `put` of the same copy in this process, or one the caller marks `retry` (a sealed copy it kept across a
 *      restart), first looks for it by its content-derived Message-ID (5), so an uncertain insert lands once; a first
 *      `put` pays nothing extra. A 404 from history or insert drops the cached label id and resolves it once more.
 *    - `compact(ids, ctx)` trashes superseded copies (`gmail.modify` cannot delete), 20 each, and refuses ids it never
 *      read as an Aplos copy, so user mail filed under the label is never touched. It stops (throws) between trash
 *      calls once `ctx.signal` aborts. The state channel hands it at most
 *      `COMPACT_BATCH` ids per call.
 *    - `readBack(id, ctx)` downloads one copy the way a round does (60 units), so a writer can check that the copy it
 *      put is readable from Gmail before it trashes anything that copy supersedes.
 *    - `receivedAt(id, ctx)` reads Gmail's receive time for a copy (20 units), and `sentWindow(id)` gives this
 *      device's clock just before the insert that made it went out (after any pacing wait) and just after it
 *      returned: the lease's clock gate brackets the receive time with the two.
 *
 * 2. `WorkflowStateChannel` (`workflow-state.ts`) is what the engine side calls, `sync/lease.ts` (prov-gov) included:
 *    ```ts
 *    read(state, ctx): Promise<{ records; changed; skipped; nextState; costUnits }> // one gated round, opened and merged
 *    ingest(copies, log): Promise<{ changed; skipped }>   // copies from the actor's `onWorkflowCopies`
 *    write(entries: { key; value }[], ctx): Promise<{ remoteId; records }> // stamp, seal the whole view, put
 *    compact(ctx, { ownOnly? }): Promise<number>           // primary (or own copies only): trash up to 25 superseded
 *    view(): WorkflowRecord[]                              // the merged records, sorted by key
 *    ```
 *    Records are `{ key, stamp: { at, gen, device }, value }`. Keys: `thread:<remote thread id>` for thread workflow
 *    (turned into store `WorkflowWrite`s by `workflow-facts.ts`), and the lease's own keys, which the channel merges
 *    like any other and never interprets: the lease protocol (holder, 30-minute renewal, lower-DeviceId tie, pin) is
 *    `sync/lease.ts`'s. Suggested shape: one `lease:<deviceId>` claim per device, `{ until, pinned? }`, renewed with
 *    `write` each round, so lease.ts sees every live claim and applies the tie rule itself; a single shared `lease` key
 *    would let last-writer-wins pick the holder instead of the rule. Sealing uses the engine's data key through the
 *    injected `KeyProvider` (`workflow-seal.ts`); the key is never read from the environment, logged or stored.
 *
 * Not yet exposed as `GmailAdapter.workflow`: the actor host runs every account with a workflow channel as secondary
 * until `sync/lease.ts` grants the lease (`sync/host.ts`), so wiring it before the lease module lands would cap every
 * Gmail account at the secondary budget. The adapter wires it (paced, like its other calls) in the lease PR.
 */

export { APP_LABEL };

/**
 * TODO(live): the insert path the legacy transport used and the emulator serves. Google's documentation and discovery
 * document give `messages.insert` as `POST users/{userId}/messages`, so this path is probably wrong live (a 404 costs a
 * label re-resolve and a second insert). It stays until the emulator (prov-emu's lane) serves the documented path too;
 * the first live probe checks it before the channel ships, and the switch is this constant plus the emulator route.
 */
export const INSERT_PATH = '/messages/insert';

export interface TransportLimits {
  listPage: number;
  /**
   * Pages one round lists before it hands back and resumes next round (200 copies at the default, about 12,000 units
   * with their downloads), so a label full of copies is read over several rounds instead of one huge step.
   */
  listPages: number;
  historyPage: number;
  historyPages: number;
  /** `SyncState.pending` holds at most this many ids. */
  maxPending: number;
  /** Tries a copy whose download fails permanently (not 404) gets before it is given up. */
  partTries: number;
}

export const TRANSPORT_LIMITS: TransportLimits = {
  listPage: 100,
  listPages: 2,
  historyPage: 500,
  historyPages: 20,
  maxPending: 500,
  partTries: 3,
};

/** Bounds on what the transport remembers per process. */
const CAP_SEEN = 50_000;
const CAP_ATTEMPTED = 64;
const CAP_FAILURES = 2_000;
const LANE = 'enrichment' as const;
const LABEL_FIELDS = 'labels(id,name,type)';
const HISTORY_FIELDS =
  'history(id,messages(id),messagesAdded(message(id))),nextPageToken,historyId';
const COPY_FIELDS = 'id,internalDate,raw';

type Seen = 'copy' | 'foreign' | 'gone';

interface GmailLabel {
  id?: string;
  name?: string;
  type?: string;
}

interface HistoryPage {
  history?: {
    id?: string;
    messages?: { id?: string }[];
    messagesAdded?: { message?: { id?: string } }[];
  }[];
  nextPageToken?: string;
  historyId?: string;
}

interface RawMessage {
  id?: string;
  internalDate?: string;
  raw?: string;
}

/** What a round decided to download, the cursor it ends on, and whether this was a complete read. */
interface Changed {
  ids: string[];
  cursor?: string;
  complete: boolean;
}

export interface PutOptions {
  /** The caller may have put this exact copy before (in an earlier process): look for it first. */
  retry?: boolean;
}

const isOurLabel = (l: GmailLabel) =>
  l.type === 'user' &&
  typeof l.id === 'string' &&
  l.name?.toLowerCase() === APP_LABEL.toLowerCase();

const is404 = (error: unknown) => error instanceof ProviderError && error.error.status === 404;

function historyIdsOf(res: HistoryPage, into: Set<string>): string | undefined {
  let last: string | undefined;
  for (const record of res.history ?? []) {
    for (const m of record.messages ?? []) if (m.id) into.add(m.id);
    for (const a of record.messagesAdded ?? []) if (a.message?.id) into.add(a.message.id);
    if (record.id) last = record.id;
  }
  return last;
}

const getRaw = (id: string): GmailRequest => ({
  method: 'gmail.messages.get',
  path: `/messages/${encodeURIComponent(id)}`,
  format: 'raw',
  fields: COPY_FIELDS,
  lane: LANE,
  item: id,
});

/** A downloaded message as a copy; `writtenAt` is Gmail's receive time (`internalDate`), not the writer's clock. */
function copyOf(id: string, message: RawMessage): WorkflowCopy | undefined {
  const raw =
    typeof message.raw === 'string' ? Buffer.from(message.raw, 'base64url').toString('latin1') : '';
  const parsed = parseCopyMessage(raw);
  if (!parsed) return undefined;
  return {
    remoteId: id,
    deviceId: parsed.device,
    writtenAt: Number(message.internalDate ?? 0) || 0,
    data: parsed.data,
  };
}

export class GmailWorkflowTransport implements WorkflowTransport {
  private labelId?: string;
  /** Every id this process downloaded (or learned is gone): the D17 skip list. */
  private readonly seen = new Map<string, Seen>();
  /** False until a full read completed in this process: until then a round lists every copy. */
  private primed = false;
  /** A full read in progress: the cursor taken before it started and where its listing resumes. */
  private listing?: { cursor: string; pageToken?: string };
  /** Message-IDs `put` has sent at least once. */
  private readonly attempted = new Map<string, true>();
  /** The bracket of each insert this process made, by remote id (`sentWindow`). */
  private readonly sent = new Map<string, SentWindow>();
  /** Permanent download failures per id. */
  private readonly failures = new Map<string, number>();
  /**
   * Copies downloaded but not yet handed out. A round that a pause cuts short throws, and its copies are already in
   * `seen`, so they wait here for the next round instead of being skipped for the rest of the process.
   */
  private readonly undelivered: WorkflowCopy[] = [];
  private readonly limits: TransportLimits;

  constructor(
    private readonly deps: GmailDeps,
    private readonly address: string,
    limits: Partial<TransportLimits> = {},
  ) {
    this.limits = { ...TRANSPORT_LIMITS, ...limits };
  }

  async round(
    state: SyncState,
    ctx: AdapterContext,
  ): Promise<{ copies: WorkflowCopy[]; nextState: SyncState; costUnits: number }> {
    const client = new GmailClient(this.deps, ctx);
    const label = await this.findLabel(client);
    if (!label) return { copies: [], nextState: this.next(state, ctx), costUnits: client.spent };
    const changed = await this.changedIds(client, state, label);
    const retry = (state.pending ?? []).filter(id => !this.seen.has(id));
    const failed = await this.fetchCopies(client, [...new Set([...changed.ids, ...retry])], ctx);
    const overflow = failed.length > this.limits.maxPending;
    if (changed.complete && !overflow) this.primed = true;
    const cursor = overflow || !changed.complete ? state.cursor : changed.cursor;
    return {
      copies: this.undelivered.splice(0),
      nextState: this.next(state, ctx, cursor, failed),
      costUnits: client.spent,
    };
  }

  async put(copy: WorkflowCopy, ctx: AdapterContext, options: PutOptions = {}): Promise<string> {
    const client = new GmailClient(this.deps, ctx);
    const label = await this.ensureLabel(client);
    const messageId = copyMessageId(copy.data);
    if (options.retry || this.attempted.has(messageId)) {
      const found = await this.findOwn(client, label, messageId);
      if (found) return found;
    }
    remember(this.attempted, messageId, true, CAP_ATTEMPTED);
    const raw = Buffer.from(buildCopyMessage(copy, this.address)).toString('base64url');
    let inserted: { id: string; window?: SentWindow };
    try {
      inserted = await this.insert(client, raw, label, ctx);
    } catch (error) {
      // A 404 was not applied: the label went away. Resolve it once more and try once more.
      if (!is404(error)) throw error;
      this.labelId = undefined;
      inserted = await this.insert(client, raw, await this.ensureLabel(client), ctx);
    }
    if (inserted.window) remember(this.sent, inserted.id, inserted.window, CAP_ATTEMPTED);
    this.see(inserted.id, 'copy');
    return inserted.id;
  }

  /** This device's clock around the insert that made `remoteId` (see the header); undefined when none did. */
  sentWindow(remoteId: string): SentWindow | undefined {
    return this.sent.get(remoteId);
  }

  async compact(remoteIds: string[], ctx: AdapterContext): Promise<void> {
    const client = new GmailClient(this.deps, ctx);
    for (const id of remoteIds) {
      // A quit aborts a compaction between trash calls, so it never holds the lane the dead claim needs.
      ctx.signal.throwIfAborted();
      if (this.seen.get(id) !== 'copy') continue;
      await this.trash(client, id);
    }
  }

  /**
   * Gmail's receive time (`internalDate`) for a copy just put, from a minimal get (20 units): the lease's clock gate
   * compares it with the writer's clock. Undefined when the message is gone or carries none.
   */
  async receivedAt(remoteId: string, ctx: AdapterContext): Promise<number | undefined> {
    const client = new GmailClient(this.deps, ctx);
    try {
      const message = await client.call<RawMessage>({
        method: 'gmail.messages.get',
        path: `/messages/${encodeURIComponent(remoteId)}`,
        format: 'minimal',
        fields: 'id,internalDate',
        lane: LANE,
        item: remoteId,
      });
      const at = Number(message.internalDate ?? 0);
      return at > 0 ? at : undefined;
    } catch (error) {
      if (is404(error)) return undefined;
      throw error;
    }
  }

  /** One copy downloaded by id, without handing it to a round; undefined when it is gone or not an Aplos copy. */
  async readBack(remoteId: string, ctx: AdapterContext): Promise<WorkflowCopy | undefined> {
    const client = new GmailClient(this.deps, ctx);
    try {
      const message = await client.call<RawMessage>(getRaw(remoteId));
      return copyOf(remoteId, message);
    } catch (error) {
      if (is404(error)) return undefined;
      throw error;
    }
  }

  private see(id: string, what: Seen): void {
    remember(this.seen, id, what, CAP_SEEN);
  }

  private next(
    state: SyncState,
    ctx: AdapterContext,
    cursor?: string,
    failed: string[] = [],
  ): SyncState {
    return {
      scope: 'workflow',
      ...(cursor ? { cursor } : {}),
      generation: ctx.generation,
      updatedAt: ctx.clock.now(),
      ...(failed.length ? { pending: failed.slice(0, this.limits.maxPending) } : {}),
      ...(state.phase ? { phase: state.phase } : {}),
    };
  }

  /** One insert, and this device's clock when its request went out (the last try's) and when it returned. */
  private async insert(
    client: GmailClient,
    raw: string,
    label: string,
    ctx: AdapterContext,
  ): Promise<{ id: string; window?: SentWindow }> {
    let from: number | undefined;
    const created = await client.call<{ id?: string }>({
      method: 'gmail.messages.insert',
      path: INSERT_PATH,
      query: { internalDateSource: 'receivedTime' },
      httpMethod: 'POST',
      body: { raw, labelIds: [label] },
      kind: 'write',
      lane: LANE,
      onSend: at => {
        from = at;
      },
    });
    const to = ctx.clock.now();
    if (!created?.id) throw new Error('messages.insert returned no id');
    return { id: created.id, ...(from !== undefined ? { window: { from, to } } : {}) };
  }

  private async findLabel(client: GmailClient): Promise<string | undefined> {
    if (this.labelId) return this.labelId;
    const res = await client.call<{ labels?: GmailLabel[] }>({
      method: 'gmail.labels.list',
      path: '/labels',
      fields: LABEL_FIELDS,
      lane: LANE,
    });
    this.labelId = (res.labels ?? []).find(isOurLabel)?.id;
    return this.labelId;
  }

  private async ensureLabel(client: GmailClient): Promise<string> {
    const found = await this.findLabel(client);
    if (found) return found;
    try {
      const created = await client.call<GmailLabel>({
        method: 'gmail.labels.create',
        path: '/labels',
        httpMethod: 'POST',
        body: { name: APP_LABEL, labelListVisibility: 'labelHide', messageListVisibility: 'hide' },
        kind: 'idempotentWrite',
        lane: LANE,
      });
      if (created?.id) this.labelId = created.id;
    } catch (error) {
      // Another device created it meanwhile.
      if (!(error instanceof ProviderError && error.error.status === 409)) throw error;
    }
    const label = this.labelId ?? (await this.findLabel(client));
    if (!label) throw new Error('The workflow label could not be created');
    return label;
  }

  /** D17 gate: label history since the cursor, or a full list when this process has not read the label yet. */
  private async changedIds(client: GmailClient, state: SyncState, label: string): Promise<Changed> {
    if (!this.primed || !state.cursor) return this.fullList(client, label);
    try {
      return await this.historyIds(client, state.cursor, label);
    } catch (error) {
      if (!is404(error)) throw error;
    }
    // The cursor expired, or the label id is stale (deleted and made again): resolve the label once, then read it all.
    this.labelId = undefined;
    this.listing = undefined;
    this.primed = false;
    const fresh = await this.findLabel(client);
    if (!fresh) return { ids: [], complete: false };
    return this.fullList(client, fresh);
  }

  private async historyIds(client: GmailClient, cursor: string, label: string): Promise<Changed> {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    let latest = cursor;
    let lastRecord: string | undefined;
    for (let page = 0; page < this.limits.historyPages; page++) {
      const res = await client.call<HistoryPage>({
        method: 'gmail.history.list',
        path: '/history',
        query: {
          startHistoryId: cursor,
          labelId: label,
          maxResults: this.limits.historyPage,
          pageToken,
        },
        fields: HISTORY_FIELDS,
        lane: LANE,
      });
      lastRecord = historyIdsOf(res, ids) ?? lastRecord;
      if (res.historyId) latest = res.historyId;
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    // More pages than the cap: the next round reads on from the last record read here.
    if (pageToken) latest = lastRecord ?? cursor;
    return { ids: [...ids].filter(id => !this.seen.has(id)), cursor: latest, complete: true };
  }

  /** D18: every copy under the label, past the first 50. The cursor is taken first, so nothing slips between. */
  private async fullList(client: GmailClient, label: string): Promise<Changed> {
    const listing = this.listing ?? { cursor: await this.profileCursor(client) };
    this.listing = listing;
    const ids: string[] = [];
    for (let page = 0; page < this.limits.listPages; page++) {
      const res = await client.call<{ messages?: { id?: string }[]; nextPageToken?: string }>({
        method: 'gmail.messages.list',
        path: '/messages',
        query: {
          labelIds: [label],
          maxResults: this.limits.listPage,
          pageToken: listing.pageToken,
        },
        fields: 'messages(id),nextPageToken',
        lane: LANE,
      });
      for (const m of res.messages ?? []) if (m.id && !this.seen.has(m.id)) ids.push(m.id);
      listing.pageToken = res.nextPageToken;
      if (!listing.pageToken) break;
    }
    if (listing.pageToken) return { ids, complete: false };
    this.listing = undefined;
    return { ids, cursor: listing.cursor, complete: true };
  }

  private async profileCursor(client: GmailClient): Promise<string> {
    const profile = await client.call<{ historyId?: string }>({
      method: 'gmail.getProfile',
      path: '/profile',
      fields: 'historyId',
      lane: LANE,
    });
    if (!profile.historyId) throw new Error('getProfile returned no historyId');
    return profile.historyId;
  }

  private async fetchCopies(
    client: GmailClient,
    ids: string[],
    ctx: AdapterContext,
  ): Promise<string[]> {
    const failed: string[] = [];
    const size = client.batchSize();
    for (let i = 0; i < ids.length; i += size) {
      const chunk = ids.slice(i, i + size);
      const parts = await client.batch<RawMessage>(chunk.map(getRaw), LANE);
      parts.forEach((part, n) => {
        const id = chunk[n];
        if (part.ok) this.take(id, part.data, ctx);
        else if (this.failedPart(id, part.error, ctx)) failed.push(id);
      });
    }
    return failed;
  }

  /** True when the id should be tried again: transient failures always, permanent ones up to `partTries`. */
  private failedPart(id: string, error: ProviderError, ctx: AdapterContext): boolean {
    if (error.error.status === 404) {
      this.see(id, 'gone');
      return false;
    }
    if (error.error.class !== 'permanent') return true;
    const tries = (this.failures.get(id) ?? 0) + 1;
    if (tries < this.limits.partTries) {
      remember(this.failures, id, tries, CAP_FAILURES);
      return true;
    }
    this.failures.delete(id);
    this.see(id, 'gone');
    logSkipped(ctx.log, 'unreadable');
    return false;
  }

  private take(id: string, message: RawMessage, ctx: AdapterContext): void {
    this.failures.delete(id);
    const copy = copyOf(id, message);
    if (!copy) {
      this.see(id, 'foreign');
      logSkipped(ctx.log, 'foreign');
      return;
    }
    this.see(id, 'copy');
    this.undelivered.push(copy);
  }

  private async findOwn(
    client: GmailClient,
    label: string,
    messageId: string,
  ): Promise<string | undefined> {
    const res = await client.call<{ messages?: { id?: string }[] }>({
      method: 'gmail.messages.list',
      path: '/messages',
      query: { labelIds: [label], q: `rfc822msgid:${messageId}`, maxResults: 1 },
      fields: 'messages(id)',
      lane: LANE,
    });
    const id = res.messages?.[0]?.id;
    if (id) this.see(id, 'copy');
    return id;
  }

  private async trash(client: GmailClient, id: string): Promise<void> {
    try {
      await client.call({
        method: 'gmail.messages.trash',
        path: `/messages/${encodeURIComponent(id)}/trash`,
        httpMethod: 'POST',
        kind: 'idempotentWrite',
        lane: LANE,
        item: id,
      });
    } catch (error) {
      if (!is404(error)) throw error;
    }
    this.see(id, 'gone');
  }
}
