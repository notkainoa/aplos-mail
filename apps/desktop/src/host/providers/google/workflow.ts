import { createHash } from 'node:crypto';
import {
  ProviderError,
  type AdapterContext,
  type Logger,
  type SyncState,
  type WorkflowChannel,
  type WorkflowCopy,
} from '@aplos/engine/ports';
import { GmailClient, type GmailDeps } from './client';
import { isDeviceId } from './workflow-merge';

/**
 * The Gmail workflow channel (plan 20 PV3, D17, D18; ARCH 6.5, 13.1; DECISIONS M29): Done, Later, todos, reminders and
 * the primary-device lease, shared between devices as sealed copies under the hidden "Aplos Mail Data" label. Ported
 * from `src/main/workflow-sync.ts` and the legacy `readAppData`/`writeAppData` in `src/main/google.ts`, without their
 * Electron coupling, and with their two defects fixed:
 * - D17: a round no longer full-fetches every copy. It is gated on `history.list?labelId=<app label>` (2 units) and
 *   downloads only message ids this process has not already read; a copy is immutable, so its id is enough.
 * - D18: the full read (first round of a process, a lost cursor) pages `messages.list` past 50 copies.
 * A stale or duplicate copy can never shadow a newer one, because nothing here picks "the newest copy": every copy ever
 * read is merged per key by a logical clock (`workflow-merge.ts`) and the merged view is kept for the process.
 *
 * Two layers, both per account:
 *
 * 1. `GmailWorkflowTransport` implements the port's `WorkflowChannel` (`ports/provider.ts`) over sealed strings only:
 *    - `round(state, ctx)` returns the copies not read before, the next `workflow` scope state (`cursor` = the label's
 *      history id, `pending` = ids to retry) and the units spent. Costs: no app label yet, 1 unit (`labels.list`, once
 *      per process when found); a round with no label change, 2 units (one `history.list`); a full read, 1 + 1 + 5 per
 *      100 copies + 60 per copy. Throws on a pause or a stop-class refusal, so the actor commits nothing and the next
 *      round resumes from the old cursor, skipping what this process already read.
 *    - `put(copy, ctx)` inserts one copy (`messages.insert`, 25, kind `write`, never re-sent). A repeated `put` of the
 *      same copy first looks for it by its content-derived Message-ID (5), so an uncertain insert lands once.
 *    - `compact(ids, ctx)` trashes superseded copies (`gmail.modify` cannot delete), 20 each, and refuses ids it never
 *      read as an Aplos copy, so user mail filed under the label is never touched.
 *
 * 2. `WorkflowStateChannel` (`workflow-state.ts`) is what the engine side calls, `sync/lease.ts` (prov-gov) included:
 *    ```ts
 *    read(state, ctx): Promise<{ records; changed; skipped; nextState; costUnits }> // one gated round, opened and merged
 *    ingest(copies, log): Promise<{ changed; skipped }>   // copies from the actor's `onWorkflowCopies`
 *    write(entries: { key; value }[], ctx): Promise<{ remoteId; records }> // stamp, seal the whole view, put
 *    compact(ctx): Promise<number>                         // primary only: trash copies the last write supersedes
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

export const APP_LABEL = 'Aplos Mail Data';
export const MARKER_HEADER = 'X-Aplos-Workflow';
export const MARKER_VALUE = '2';
const DEVICE_HEADER = 'X-Aplos-Device';
const BEGIN = '-----BEGIN APLOS WORKFLOW-----';
const END = '-----END APLOS WORKFLOW-----';
/**
 * The insert path the legacy transport used and the emulator serves. Google's discovery document lists
 * `messages.insert` as `POST users/{userId}/messages`; which one live Gmail accepts is an open live check.
 */
export const INSERT_PATH = '/messages/insert';
const LIST_PAGE = 100;
const MAX_LIST_PAGES = 20;
const HISTORY_PAGE = 500;
const MAX_HISTORY_PAGES = 20;
const MAX_PENDING = 500;
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
  history?: { messages?: { id?: string }[]; messagesAdded?: { message?: { id?: string } }[] }[];
  nextPageToken?: string;
  historyId?: string;
}

interface RawMessage {
  id?: string;
  internalDate?: string;
  raw?: string;
}

/** What a round decided to download, and the cursor the round ends on. */
interface Changed {
  ids: string[];
  cursor: string;
}

const isOurLabel = (l: GmailLabel) =>
  l.type === 'user' &&
  typeof l.id === 'string' &&
  l.name?.toLowerCase() === APP_LABEL.toLowerCase();

/** The copy's Message-ID, derived from its sealed bytes (random IV inside), so a re-sent `put` finds its own copy. */
export function copyMessageId(data: string): string {
  return `<wf-${createHash('sha256').update(data).digest('hex').slice(0, 40)}@aplos-mail.invalid>`;
}

const wrap = (text: string) => text.match(/.{1,76}/g)?.join('\r\n') ?? '';

/** The RFC 822 copy: only the label, so it never shows as new mail; the sealed blob armoured in a text body. */
export function buildCopyMessage(copy: WorkflowCopy, address: string): string {
  // Everything that reaches a header or the armour is checked, so no value can end the block or add a header.
  if (!isDeviceId(copy.deviceId)) throw new Error('Invalid device id for a workflow copy');
  if (!/^[\w.-]+$/.test(copy.data)) throw new Error('A workflow copy must be sealed');
  if (!Number.isSafeInteger(copy.writtenAt) || copy.writtenAt < 0)
    throw new Error('Invalid write time for a workflow copy');
  const lines = [
    `From: Aplos Mail <${address}>`,
    `To: ${address}`,
    'Subject: Aplos sync data - do not edit',
    `Date: ${new Date(copy.writtenAt).toUTCString()}`,
    `Message-ID: ${copyMessageId(copy.data)}`,
    'MIME-Version: 1.0',
    `${MARKER_HEADER}: ${MARKER_VALUE}`,
    `${DEVICE_HEADER}: ${copy.deviceId}`,
    'Content-Type: text/plain; charset=us-ascii',
    'Content-Transfer-Encoding: 7bit',
    '',
    'Aplos Mail keeps encrypted Done, Later and reminder data for this account here. Please leave it in place.',
    '',
    BEGIN,
    wrap(copy.data),
    END,
    '',
  ];
  return lines.join('\r\n');
}

function headerMap(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of block.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) out.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return out;
}

/** The sealed blob and device hint of an Aplos copy, or undefined for anything else (user mail, a foreign format). */
export function parseCopyMessage(raw: string): { data: string; device: string } | undefined {
  const split = /\r?\n\r?\n/.exec(raw);
  if (!split) return undefined;
  const headers = headerMap(raw.slice(0, split.index));
  if (headers.get(MARKER_HEADER.toLowerCase()) !== MARKER_VALUE) return undefined;
  const body = raw.slice(split.index + split[0].length);
  const start = body.indexOf(BEGIN);
  const end = body.indexOf(END, start + BEGIN.length);
  if (start === -1 || end === -1) return undefined;
  const data = body.slice(start + BEGIN.length, end).replace(/\s+/g, '');
  if (!data) return undefined;
  return { data, device: headers.get(DEVICE_HEADER.toLowerCase()) ?? '' };
}

/** A copy that is not usable, logged as a refused read with a reason code: no id, no content, no key material. */
export function logSkipped(log: Logger, reason: string): void {
  log.event('sync.gmail.request_refused', {
    error: {
      class: 'permanent',
      provider: 'gmail',
      method: 'gmail.messages.get',
      reason: `workflowCopy.${reason}`,
    },
  });
}

const is404 = (error: unknown) => error instanceof ProviderError && error.error.status === 404;

export class GmailWorkflowTransport implements WorkflowChannel {
  private labelId?: string;
  /** Every id this process downloaded (or learned is gone): the D17 skip list. */
  private readonly seen = new Map<string, Seen>();
  /** False until a full read completed in this process: until then a round lists every copy. */
  private primed = false;
  /** Message-IDs `put` has sent at least once. */
  private readonly attempted = new Set<string>();
  /**
   * Copies downloaded but not yet handed out. A round that a pause cuts short throws, and its copies are already in
   * `seen`, so they wait here for the next round instead of being skipped for the rest of the process.
   */
  private readonly undelivered: WorkflowCopy[] = [];

  constructor(
    private readonly deps: GmailDeps,
    private readonly address: string,
  ) {}

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
    this.primed = true;
    return {
      copies: this.undelivered.splice(0),
      nextState: this.next(state, ctx, changed.cursor, failed),
      costUnits: client.spent,
    };
  }

  async put(copy: WorkflowCopy, ctx: AdapterContext): Promise<string> {
    const client = new GmailClient(this.deps, ctx);
    const label = await this.ensureLabel(client);
    const messageId = copyMessageId(copy.data);
    if (this.attempted.has(messageId)) {
      const found = await this.findOwn(client, label, messageId);
      if (found) return found;
    }
    this.attempted.add(messageId);
    const raw = Buffer.from(buildCopyMessage(copy, this.address)).toString('base64url');
    const created = await client.call<{ id?: string }>({
      method: 'gmail.messages.insert',
      path: INSERT_PATH,
      query: { internalDateSource: 'receivedTime' },
      httpMethod: 'POST',
      body: { raw, labelIds: [label] },
      kind: 'write',
      lane: LANE,
    });
    if (!created?.id) throw new Error('messages.insert returned no id');
    this.seen.set(created.id, 'copy');
    return created.id;
  }

  async compact(remoteIds: string[], ctx: AdapterContext): Promise<void> {
    const client = new GmailClient(this.deps, ctx);
    for (const id of remoteIds) {
      if (this.seen.get(id) !== 'copy') continue;
      await this.trash(client, id);
    }
  }

  /** Whether `id` was read (or written) by this process as an Aplos copy; compaction trusts nothing else. */
  isCopy(id: string): boolean {
    return this.seen.get(id) === 'copy';
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
      ...(failed.length ? { pending: failed.slice(0, MAX_PENDING) } : {}),
      ...(state.phase ? { phase: state.phase } : {}),
    };
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
      if (is404(error)) return this.fullList(client, label);
      throw error;
    }
  }

  private async historyIds(client: GmailClient, cursor: string, label: string): Promise<Changed> {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    let latest = cursor;
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const res = await client.call<HistoryPage>({
        method: 'gmail.history.list',
        path: '/history',
        query: { startHistoryId: cursor, labelId: label, maxResults: HISTORY_PAGE, pageToken },
        fields: HISTORY_FIELDS,
        lane: LANE,
      });
      for (const record of res.history ?? []) {
        for (const m of record.messages ?? []) if (m.id) ids.add(m.id);
        for (const a of record.messagesAdded ?? []) if (a.message?.id) ids.add(a.message.id);
      }
      if (res.historyId) latest = res.historyId;
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    // More pages than the cap: keep the old cursor so the next round reads on; seen ids are skipped.
    if (pageToken) latest = cursor;
    return { ids: [...ids].filter(id => !this.seen.has(id)), cursor: latest };
  }

  /** D18: every copy under the label, past the first 50. The cursor is taken first, so nothing slips between. */
  private async fullList(client: GmailClient, label: string): Promise<Changed> {
    const profile = await client.call<{ historyId?: string }>({
      method: 'gmail.getProfile',
      path: '/profile',
      fields: 'historyId',
      lane: LANE,
    });
    if (!profile.historyId) throw new Error('getProfile returned no historyId');
    const ids: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const res = await client.call<{ messages?: { id?: string }[]; nextPageToken?: string }>({
        method: 'gmail.messages.list',
        path: '/messages',
        query: { labelIds: [label], maxResults: LIST_PAGE, pageToken },
        fields: 'messages(id),nextPageToken',
        lane: LANE,
      });
      for (const m of res.messages ?? []) if (m.id && !this.seen.has(m.id)) ids.push(m.id);
      pageToken = res.nextPageToken;
      if (!pageToken) break;
    }
    return { ids, cursor: profile.historyId };
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
      const parts = await client.batch<RawMessage>(
        chunk.map(id => ({
          method: 'gmail.messages.get',
          path: `/messages/${encodeURIComponent(id)}`,
          format: 'raw',
          fields: COPY_FIELDS,
          lane: LANE,
          item: id,
        })),
        LANE,
      );
      parts.forEach((part, n) => {
        const id = chunk[n];
        if (part.ok) return this.take(id, part.data, ctx);
        if (part.error.error.status === 404 || part.error.error.class === 'permanent')
          return this.seen.set(id, 'gone');
        failed.push(id);
      });
    }
    return failed;
  }

  private take(id: string, message: RawMessage, ctx: AdapterContext): void {
    const raw =
      typeof message.raw === 'string'
        ? Buffer.from(message.raw, 'base64url').toString('latin1')
        : '';
    const parsed = parseCopyMessage(raw);
    if (!parsed) {
      this.seen.set(id, 'foreign');
      logSkipped(ctx.log, 'foreign');
      return;
    }
    this.seen.set(id, 'copy');
    this.undelivered.push({
      remoteId: id,
      deviceId: parsed.device,
      writtenAt: Number(message.internalDate ?? 0) || 0,
      data: parsed.data,
    });
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
    if (id) this.seen.set(id, 'copy');
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
    this.seen.set(id, 'gone');
  }
}
