import { transaction, type SqlDatabase, type SqlStatement, type SqlValue } from './sql';
import { encodeBody } from './bodies';
import { governor, providerMemory, syncFailure } from './bookkeeping';
import { calendar, calendarDelete, event, eventDelete, eventSweep } from './calendar';
import type { WriteScope } from './scope';
import {
  StoreError,
  type AccountWrite,
  type AttachmentStateWrite,
  type AttachmentsWrite,
  type BodyCodec,
  type BodyWrite,
  type ChangeType,
  type CommitExtension,
  type CommitExtensionTx,
  type OpEffect,
  type OpSettleWrite,
  type OpWrite,
  type ThreadMergeWrite,
  type CommitInput,
  type CommitResult,
  type FlagsWrite,
  type FolderDeleteWrite,
  type FolderRef,
  type FolderWrite,
  type MessageDeleteWrite,
  type MessageTarget,
  type MessageWrite,
  type MetaWrite,
  type PlacementsWrite,
  type StoreWrite,
  type SweepWrite,
  type SyncStateWrite,
  type ThreadDeleteWrite,
  type ThreadWrite,
  type WorkflowFields,
  type WorkflowWrite,
} from './port';

/** `messages.flags` bits (schema 0001). */
export const FLAG = { seen: 1, flagged: 2, answered: 4, draft: 8, fromMe: 16, attach: 32 } as const;
/** `messages.hdr` bits. */
export const HDR = {
  bulk: 1,
  list: 2,
  autoSubmitted: 4,
  noreply: 8,
  directToMe: 16,
  ccMe: 32,
} as const;
/** `messages.parts` bits. */
export const PART = { meta: 1, text: 2, html: 4, fts: 8, attachListed: 16, evicted: 32 } as const;

/** Keys only the store itself writes. */
export const RESERVED_META = new Set([
  'db_epoch',
  'seq',
  'change_floor_seq',
  'install_salt',
  'created_at',
]);
const ID_SLOTS = 4096,
  MAX_SECONDS = 2 ** 32,
  MAX_PENDING = 500;
const USER_FLAGS = FLAG.seen | FLAG.flagged | FLAG.answered;
const ORIGINS = new Set<string>(['sync', 'local', 'import', 'system']);

export interface CommitContext {
  db: SqlDatabase;
  dbEpoch: string;
  now: () => number;
  /** Cached prepare. */
  stmt: (sql: string) => SqlStatement;
  /** Lane writers by kind (seam 2), validated by `registerExtensions`. */
  extensions?: ReadonlyMap<string, CommitExtension>;
  bodyCodec?: BodyCodec;
}

/** The kinds `commit.ts` applies itself; no extension may claim one. */
export const CORE_WRITE_KINDS: ReadonlySet<string> = new Set([
  'account',
  'folder',
  'folderDelete',
  'message',
  'messageDelete',
  'placements',
  'flags',
  'thread',
  'threadDelete',
  'threadMerge',
  'workflow',
  'syncState',
  'sweep',
  'meta',
  'op',
  'opSettle',
  'body',
  'attachments',
  'attachmentState',
  'governor',
  'providerMemory',
  'syncFailure',
  'calendar',
  'calendarDelete',
  'event',
  'eventDelete',
  'eventSweep',
]);
/** Op states whose effect is still replayed over sync (ARCH 4.3). */
const REPLAYED_OPS = `state IN ('queued', 'inflight')`;

/**
 * The commit (F4): every write in one transaction, then pending ops replayed over the sync facts (ARCH 4.3), then thread
 * rollups and folder lists recomputed from the messages, one `changes` row per changed item, `seq` bumped once. Lane
 * kinds run in their extension inside the same transaction. A replayed `opId` is a no-op. Still to come in Phase 1
 * (store-1 to store-4): FTS, ingest hooks, compaction, without changing `CommitInput`.
 */
export function applyCommit(ctx: CommitContext, input: CommitInput): CommitResult {
  if (typeof input?.opId !== 'string' || !input.opId)
    throw new StoreError('invalid', 'A commit needs an opId');
  if (!ORIGINS.has(input.origin))
    throw new StoreError('invalid', `Unknown commit origin ${input.origin}`);
  if (!Array.isArray(input.writes))
    throw new StoreError('invalid', 'A commit needs a writes array');
  return transaction(ctx.db, () => {
    const prior = ctx
      .stmt('SELECT seq FROM commits WHERE op_id = ?')
      .get<{ seq: number }>(input.opId);
    if (prior) return { seq: prior.seq, dbEpoch: ctx.dbEpoch, replayed: true, changed: 0 };
    const current = Number(ctx.stmt("SELECT value FROM meta WHERE key = 'seq'").get()?.value ?? 0);
    const run = new CommitRun(ctx, input, current + 1);
    for (const write of input.writes) run.apply(write);
    run.replayOps();
    run.rollups();
    const changed = run.writeChanges();
    const seq = changed > 0 ? current + 1 : current;
    if (changed > 0) ctx.stmt("UPDATE meta SET value = ? WHERE key = 'seq'").run(String(seq));
    ctx
      .stmt('INSERT INTO commits(op_id, seq, origin, at) VALUES(?, ?, ?, ?)')
      .run(input.opId, seq, input.origin, ctx.now());
    return { seq, dbEpoch: ctx.dbEpoch, replayed: false, changed };
  });
}

interface MessageRow {
  id: number;
  thread_id: number;
  remote_id: string;
  flags: number;
  local_seq: number | null;
  first_seen_seq: number;
  [k: string]: number | string | null;
}
const MESSAGE_COLS = 'm.id, m.thread_id, m.remote_id, m.flags, m.local_seq, m.first_seen_seq';

class CommitRun implements WriteScope {
  private readonly touched = new Set<number>();
  /** Messages this commit wrote, per account: what pending ops are replayed over. */
  private readonly touchedMessages = new Map<string, Set<number>>();
  private readonly changes = new Map<string, { type: string; id: string; op: 'u' | 'd' | '*' }>();
  private readonly txs = new Map<CommitExtension, CommitExtensionTx>();
  private readonly coarse: boolean;
  readonly local: boolean;

  constructor(
    private readonly ctx: CommitContext,
    private readonly input: CommitInput,
    readonly seq: number,
  ) {
    this.coarse = input.changes === 'coarse';
    this.local = input.origin === 'local';
  }

  q(sql: string) {
    return this.ctx.stmt(sql);
  }
  now() {
    return this.ctx.now();
  }

  apply(w: StoreWrite) {
    switch (w.kind) {
      case 'account':
        return this.account(w);
      case 'folder':
        return this.folder(w);
      case 'folderDelete':
        return this.folderDelete(w);
      case 'message':
        return this.message(w);
      case 'messageDelete':
        return this.messageDelete(w);
      case 'placements':
        return this.placements(w);
      case 'flags':
        return this.flags(w);
      case 'thread':
        return this.thread(w);
      case 'threadDelete':
        return this.threadDelete(w);
      case 'workflow':
        return this.workflow(w);
      case 'syncState':
        return this.syncState(w);
      case 'sweep':
        return this.sweep(w);
      case 'meta':
        return this.meta(w);
      case 'threadMerge':
        return this.threadMerge(w);
      case 'op':
        return this.op(w);
      case 'opSettle':
        return this.opSettle(w);
      case 'body':
        return this.body(w);
      case 'attachments':
        return this.attachments(w);
      case 'attachmentState':
        return this.attachmentState(w);
      case 'governor':
        return governor(this, w);
      case 'providerMemory':
        return providerMemory(this, w);
      case 'syncFailure':
        return syncFailure(this, w);
      case 'calendar':
        return calendar(this, w);
      case 'calendarDelete':
        return calendarDelete(this, w);
      case 'event':
        return event(this, w);
      case 'eventDelete':
        return eventDelete(this, w);
      case 'eventSweep':
        return eventSweep(this, w);
      default:
        return this.extension(w as { kind: string });
    }
  }

  /** Lane kinds (seam 2): the registered extension applies them inside this transaction. */
  private extension(w: { kind: string }) {
    const ext = typeof w?.kind === 'string' ? this.ctx.extensions?.get(w.kind) : undefined;
    if (!ext)
      throw new StoreError(
        'invalid',
        `No writer for write kind ${String((w as { kind?: unknown })?.kind)}`,
      );
    let tx = this.txs.get(ext);
    if (!tx) this.txs.set(ext, (tx = this.extensionTx(ext)));
    ext.apply(w, tx);
  }

  private extensionTx(ext: CommitExtension): CommitExtensionTx {
    const allowed = new Set<string>(ext.changeTypes);
    const rowId = (sql: string, accountId: string, remoteId: string) =>
      this.q(sql).get<{ id: number }>(accountId, remoteId)?.id;
    return {
      origin: this.input.origin,
      step: this.input.step,
      seq: this.seq,
      now: () => this.now(),
      run: (sql, ...params) => this.q(sql).run(...params),
      get: (sql, ...params) => this.q(sql).get(...params),
      all: (sql, ...params) => this.q(sql).all(...params),
      mark: (type, id, op) => {
        if (!allowed.has(type))
          throw new StoreError('invalid', `${ext.lane} may not write ${type} change rows`);
        this.markId(type, id, op);
      },
      messageRowId: (accountId, remoteId) =>
        rowId(
          'SELECT id FROM messages WHERE account_id = ? AND remote_id = ?',
          accountId,
          remoteId,
        ),
      threadRowId: (accountId, remoteThreadId) =>
        rowId(
          'SELECT id FROM threads WHERE account_id = ? AND remote_id = ?',
          accountId,
          remoteThreadId,
        ),
      touchThread: (accountId, remoteThreadId) => {
        const id = rowId(
          'SELECT id FROM threads WHERE account_id = ? AND remote_id = ?',
          accountId,
          remoteThreadId,
        );
        if (id === undefined) return this.missing(`Thread ${remoteThreadId}`);
        this.q('UPDATE threads SET rev = ? WHERE id = ?').run(this.seq, id);
        this.mark('Thread', accountId, remoteThreadId, 'u');
      },
      touchMessage: (accountId, remoteId) => {
        const m = this.messageRow(accountId, remoteId);
        if (!m) return this.missing(`Message ${remoteId}`);
        this.q('UPDATE messages SET rev = ? WHERE id = ?').run(this.seq, m.id);
        this.mark('Message', accountId, remoteId, 'u');
      },
    };
  }

  /** Records a change; a later `d` wins over `u`, a re-created item goes back to `u`. Coarse mode folds per account. */
  mark(type: ChangeType, accountId: string, remoteId: string | null, op: 'u' | 'd') {
    if (this.coarse && (type === 'Thread' || type === 'Message')) {
      this.changes.set(`${type}\0${accountId}`, { type, id: accountId, op: '*' });
      return;
    }
    this.markId(type, remoteId === null ? accountId : `${accountId}:${remoteId}`, op);
  }
  /** A change row by contract id, for extensions (which may not mark store types). */
  markId(type: ChangeType, id: string, op: 'u' | 'd') {
    this.changes.set(`${type}\0${id}`, { type, id, op });
  }

  /** Sync facts about an item the store does not track are dropped; a local edit of a missing item is an error. */
  missing(what: string) {
    if (this.local) throw new StoreError('notFound', `${what} is not in the store`);
  }

  private fenced(localSeq: number | null) {
    const fence = this.input.fenceSeq;
    return (
      this.input.origin === 'sync' && fence !== undefined && localSeq !== null && localSeq > fence
    );
  }

  // ------------------------------------------------------------ accounts and folders

  private account(w: AccountWrite) {
    const now = this.ctx.now();
    const cols: Record<string, SqlValue> = {};
    const set = (col: string, value: SqlValue | boolean | undefined) => {
      if (value !== undefined) cols[col] = typeof value === 'boolean' ? Number(value) : value;
    };
    set('provider', w.provider);
    set('address', w.address);
    set('display_name', w.displayName);
    if (w.capabilities !== undefined) set('capabilities', JSON.stringify(w.capabilities));
    if (w.grantedScopes !== undefined)
      set('granted_scopes', w.grantedScopes === null ? null : JSON.stringify(w.grantedScopes));
    if (w.status) {
      const { state, ...rest } = w.status as { state: string; reason?: string; until?: number };
      const { reason, until, ...detail } = rest;
      set('status', state);
      set('status_reason', reason ?? null);
      set('resume_at', state === 'paused' ? (until ?? null) : null);
      set('status_detail', Object.keys(detail).length ? JSON.stringify(detail) : null);
    }
    set('status_reason_code', w.reasonCode);
    set('baseline_done_at', w.baselineDoneAt);
    set('token_granted_at', w.tokenGrantedAt);
    set('refresh_expires_at', w.refreshExpiresAt);
    set('remote_subject', w.remoteSubject);
    set('oauth_client', w.oauthClient);
    set('ai_allowed', w.aiAllowed);
    set('primary_lease_until', w.primaryLeaseUntil);
    set('primary_lease_device', w.primaryLeaseDevice);
    const exists = this.q('SELECT 1 FROM accounts WHERE id = ?').get(w.id);
    if (exists) {
      const keys = Object.keys(cols);
      this.q(
        `UPDATE accounts SET ${keys.map(k => `${k} = ?`).join(', ')}${keys.length ? ', ' : ''}updated_at = ? WHERE id = ?`,
      ).run(...keys.map(k => cols[k]), now, w.id);
    } else {
      if (!w.provider || !w.address || !w.capabilities)
        throw new StoreError('invalid', 'A new account needs provider, address and capabilities');
      cols.status ??= 'starting';
      const keys = Object.keys(cols);
      this.q(
        `INSERT INTO accounts(id, ${keys.join(', ')}, created_at, updated_at) VALUES(?, ${keys.map(() => '?').join(', ')}, ?, ?)`,
      ).run(w.id, ...keys.map(k => cols[k]), now, now);
    }
    this.mark('Account', w.id, null, 'u');
  }

  private folder(w: FolderWrite) {
    const before = this.q(
      'SELECT id, role, uidvalidity FROM folders WHERE account_id = ? AND remote_id = ?',
    ).get<{ id: number; role: string | null; uidvalidity: number | null }>(w.accountId, w.remoteId);
    // A new UIDVALIDITY voids every UID stored for the folder (FR-31): the resync re-stamps them, and an old UID left in
    // place would collide with a relisted message's new one on `mf_uid` and fail every page of the reset.
    if (
      before?.uidvalidity != null &&
      w.uidValidity != null &&
      before.uidvalidity !== w.uidValidity
    )
      this.q('UPDATE message_folders SET uid = NULL WHERE folder_id = ?').run(before.id);
    this.q(
      `INSERT INTO folders(account_id, remote_id, name, role, kind, sync_scope, uidvalidity, hidden) VALUES(?, ?, ?, ?, ?, COALESCE(?, 'lazy'), ?, ?)
      ON CONFLICT(account_id, remote_id) DO UPDATE SET name = excluded.name, role = excluded.role, kind = excluded.kind,
        sync_scope = COALESCE(?, sync_scope), uidvalidity = excluded.uidvalidity, hidden = excluded.hidden`,
    ).run(
      w.accountId,
      w.remoteId,
      w.name,
      w.role ?? null,
      w.folderKind,
      w.syncScope ?? null,
      w.uidValidity ?? null,
      Number(w.hidden ?? false),
      w.syncScope ?? null,
    );
    // A role change (a label becoming Trash) changes which threads the folder lists.
    if (before && before.role !== (w.role ?? null)) this.touchFolderThreads(before.id);
    this.mark('Folder', w.accountId, w.remoteId, 'u');
  }

  private folderDelete(w: FolderDeleteWrite) {
    const row = this.q('SELECT id FROM folders WHERE account_id = ? AND remote_id = ?').get<{
      id: number;
    }>(w.accountId, w.remoteId);
    if (!row) return;
    this.touchFolderThreads(row.id);
    // The cascade drops the placements, which changes each placed message's labels (FR-15).
    for (const m of this.q(
      'SELECT m.id, m.remote_id FROM message_folders mf JOIN messages m ON m.id = mf.message_id WHERE mf.folder_id = ?',
    ).all<{ id: number; remote_id: string }>(row.id)) {
      this.q('UPDATE messages SET rev = ? WHERE id = ?').run(this.seq, m.id);
      this.mark('Message', w.accountId, m.remote_id, 'u');
    }
    this.q('DELETE FROM folders WHERE id = ?').run(row.id);
    this.mark('Folder', w.accountId, w.remoteId, 'd');
  }

  private touchFolderThreads(folderId: number) {
    for (const r of this.q(
      'SELECT DISTINCT m.thread_id AS t FROM message_folders mf JOIN messages m ON m.id = mf.message_id WHERE mf.folder_id = ?',
    ).all<{ t: number }>(folderId))
      this.touched.add(r.t);
  }

  /** A folder named in a message before the folder list arrived gets a placeholder row the next list fills in. */
  private folderId(accountId: string, remoteId: string): number {
    const row = this.q('SELECT id FROM folders WHERE account_id = ? AND remote_id = ?').get<{
      id: number;
    }>(accountId, remoteId);
    if (row) return row.id;
    const id = this.q(
      "INSERT INTO folders(account_id, remote_id, name, kind) VALUES(?, ?, ?, 'unknown') RETURNING id",
    ).get<{ id: number }>(accountId, remoteId, remoteId)!.id;
    this.mark('Folder', accountId, remoteId, 'u');
    return id;
  }

  // ------------------------------------------------------------ messages

  private threadId(accountId: string, remoteThreadId: string, lastDate: number): number {
    const row = this.q('SELECT id FROM threads WHERE account_id = ? AND remote_id = ?').get<{
      id: number;
    }>(accountId, remoteThreadId);
    if (row) return row.id;
    const id = this.q(
      `INSERT INTO threads(account_id, remote_id, last_date, msg_count, unread_count, flagged, has_attach, rev)
      VALUES(?, ?, ?, 0, 0, 0, 0, ?) RETURNING id`,
    ).get<{ id: number }>(accountId, remoteThreadId, lastDate, this.seq)!.id;
    // Every thread has a workflow row, so Home's index covers it without an outer join.
    this.q(
      "INSERT INTO thread_workflow(thread_id, account_id, sync_key, status, last_date) VALUES(?, ?, ?, 'new', ?)",
    ).run(id, accountId, remoteThreadId, lastDate);
    return id;
  }

  /**
   * Date-ordered rowid (ARCH 3.1, plan 10 E2 item 3): seconds * 4096 + n, seconds clamped to [0, 2^32]. A full second
   * carries into the next one and continues after the highest id there, so a carried id never repeats one issued.
   */
  private allocateId(internalDate: number): number {
    let seconds = Math.min(Math.max(Math.floor(internalDate / 1000), 0), MAX_SECONDS);
    for (;;) {
      const base = seconds * ID_SLOTS;
      const top = this.q('SELECT max(id) AS m FROM messages WHERE id >= ? AND id < ?').get<{
        m: number | null;
      }>(base, base + ID_SLOTS)?.m;
      const next = top === null || top === undefined ? base : top + 1;
      if (next < base + ID_SLOTS) return next;
      seconds++;
    }
  }

  private message(w: MessageWrite) {
    if (!w.accountId || !w.remoteId || !w.remoteThreadId)
      throw new StoreError('invalid', 'A message needs accountId, remoteId and remoteThreadId');
    if (!Number.isFinite(w.internalDate) || !Number.isFinite(w.date))
      throw new StoreError('invalid', `Message ${w.remoteId} has no valid date`);
    const origin =
      w.origin ??
      (this.input.step === 'search'
        ? 'search'
        : this.local || this.input.origin === 'import'
          ? 'local'
          : 'sync');
    const threadId = this.threadId(w.accountId, w.remoteThreadId, w.internalDate);
    const existing = this.messageRow(w.accountId, w.remoteId);
    const fenced = existing !== undefined && this.fenced(existing.local_seq);
    let flags =
      (w.flags.seen ? FLAG.seen : 0) |
      (w.flags.flagged ? FLAG.flagged : 0) |
      (w.flags.answered ? FLAG.answered : 0) |
      (w.flags.draft ? FLAG.draft : 0) |
      (w.flags.fromMe ? FLAG.fromMe : 0) |
      (w.hasAttachments ? FLAG.attach : 0);
    if (fenced) flags = (flags & ~USER_FLAGS) | (existing.flags & USER_FLAGS);
    const h = w.hdr ?? {};
    const hdr =
      (h.bulk ? HDR.bulk : 0) |
      (h.list ? HDR.list : 0) |
      (h.autoSubmitted ? HDR.autoSubmitted : 0) |
      (h.noreply ? HDR.noreply : 0) |
      (h.directToMe ? HDR.directToMe : 0) |
      (h.ccMe ? HDR.ccMe : 0);
    const localSeq = this.local ? this.seq : (existing?.local_seq ?? null);
    const fields: SqlValue[] = [
      threadId,
      w.internetId ?? null,
      w.inReplyTo ?? null,
      w.refs ? JSON.stringify(w.refs) : null,
      w.from?.address ?? null,
      w.from?.name ?? null,
      JSON.stringify(w.to ?? []),
      JSON.stringify(w.cc ?? []),
      w.bcc?.length ? JSON.stringify(w.bcc) : null,
      w.replyTo?.length ? JSON.stringify(w.replyTo) : null,
      w.subject ?? null,
      w.snippet ?? null,
      w.date,
      w.internalDate,
      w.size ?? null,
      flags,
      hdr,
      w.listUnsubscribe ? JSON.stringify(w.listUnsubscribe) : null,
    ];
    let id: number;
    if (existing) {
      id = existing.id;
      // A search hit never downgrades a synced row; a sync adopts a search or local row.
      this.q(
        `UPDATE messages SET thread_id = ?, internet_id = ?, in_reply_to = ?, refs = ?, from_addr = ?, from_name = ?,
        to_json = ?, cc_json = ?, bcc_json = ?, reply_to = ?, subject = ?, snippet = ?, date = ?, internal_date = ?, size = ?,
        flags = ?, hdr = ?, list_unsub = ?, origin = CASE WHEN ? = 'search' THEN origin ELSE ? END, rev = ?, local_seq = ?
        WHERE id = ?`,
      ).run(...fields, origin, origin, this.seq, localSeq, id);
      if (existing.thread_id !== threadId) this.touched.add(existing.thread_id);
    } else {
      id = this.allocateId(w.internalDate);
      this.q(
        `INSERT INTO messages(thread_id, internet_id, in_reply_to, refs, from_addr, from_name, to_json, cc_json, bcc_json,
        reply_to, subject, snippet, date, internal_date, size, flags, hdr, list_unsub, id, account_id, remote_id, origin,
        first_seen_seq, rev, local_seq) VALUES(${fields.map(() => '?').join(', ')}, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(...fields, id, w.accountId, w.remoteId, origin, this.seq, this.seq, localSeq);
    }
    if (w.folders && !fenced) this.replacePlacements(id, w.accountId, w.folders, w.seenGen);
    this.touched.add(threadId);
    this.touchedMessage(w.accountId, id);
    this.mark('Message', w.accountId, w.remoteId, 'u');
  }

  messageRow(accountId: string, remoteId: string): MessageRow | undefined {
    return this.q(
      `SELECT ${MESSAGE_COLS} FROM messages m WHERE m.account_id = ? AND m.remote_id = ?`,
    ).get<MessageRow>(accountId, remoteId);
  }

  private touchedMessage(accountId: string, id: number) {
    let set = this.touchedMessages.get(accountId);
    if (!set) this.touchedMessages.set(accountId, (set = new Set()));
    set.add(id);
  }

  private replacePlacements(
    messageId: number,
    accountId: string,
    refs: FolderRef[],
    seenGen: number | undefined,
  ) {
    const ids = refs.map(r => ({ folderId: this.folderId(accountId, r.folder), uid: r.uid }));
    this.q(
      'DELETE FROM message_folders WHERE message_id = ? AND folder_id NOT IN (SELECT value FROM json_each(?))',
    ).run(messageId, JSON.stringify(ids.map(i => i.folderId)));
    for (const { folderId, uid } of ids) this.place(messageId, folderId, uid, seenGen);
  }

  /** A stamp only rises: a page of an older round committed late must not lower a newer round's stamp and get swept. */
  private place(
    messageId: number,
    folderId: number,
    uid: number | undefined,
    seenGen: number | undefined,
  ) {
    this.q(
      `INSERT INTO message_folders(message_id, folder_id, uid, seen_gen) VALUES(?, ?, ?, ?)
      ON CONFLICT(message_id, folder_id) DO UPDATE SET uid = COALESCE(excluded.uid, uid),
        seen_gen = CASE WHEN seen_gen IS NULL THEN excluded.seen_gen ELSE max(seen_gen, COALESCE(excluded.seen_gen, seen_gen)) END`,
    ).run(messageId, folderId, uid ?? null, seenGen ?? null);
  }

  private targets(accountId: string, target: MessageTarget): MessageRow[] {
    let rows: MessageRow[], what: string;
    if ('remoteId' in target) {
      const row = this.messageRow(accountId, target.remoteId);
      rows = row ? [row] : [];
      what = `Message ${target.remoteId}`;
    } else if ('remoteThreadId' in target) {
      rows = this.q(
        `SELECT ${MESSAGE_COLS} FROM messages m JOIN threads t ON t.id = m.thread_id
        WHERE t.account_id = ? AND t.remote_id = ? AND (m.flags & ${FLAG.draft}) = 0`,
      ).all<MessageRow>(accountId, target.remoteThreadId);
      what = `Thread ${target.remoteThreadId}`;
    } else {
      rows = this.q(
        `SELECT ${MESSAGE_COLS} FROM message_folders mf JOIN folders f ON f.id = mf.folder_id
          JOIN messages m ON m.id = mf.message_id WHERE f.account_id = ? AND f.remote_id = ? AND mf.uid = ?`,
      ).all<MessageRow>(accountId, target.folder, target.uid);
      what = `UID ${target.uid} in ${target.folder}`;
    }
    if (!rows.length) this.missing(what);
    return rows;
  }

  /** Marks a message changed by a delta: new rev, and the fence seq for local edits. */
  private touchMessage(accountId: string, m: MessageRow) {
    this.q('UPDATE messages SET rev = ?, local_seq = ? WHERE id = ?').run(
      this.seq,
      this.local ? this.seq : m.local_seq,
      m.id,
    );
    this.touched.add(m.thread_id);
    this.touchedMessage(accountId, m.id);
    this.mark('Message', accountId, m.remote_id, 'u');
  }

  private placements(w: PlacementsWrite) {
    for (const m of this.targets(w.accountId, w.target)) {
      if (this.fenced(m.local_seq)) continue;
      this.movePlacements(w.accountId, m.id, w.add, w.remove, w.seenGen);
      this.touchMessage(w.accountId, m);
    }
  }

  private movePlacements(
    accountId: string,
    messageId: number,
    add: FolderRef[],
    remove: string[],
    seenGen: number | undefined,
  ) {
    for (const ref of add)
      this.place(messageId, this.folderId(accountId, ref.folder), ref.uid, seenGen);
    for (const folder of remove)
      this.q(
        'DELETE FROM message_folders WHERE message_id = ? AND folder_id = (SELECT id FROM folders WHERE account_id = ? AND remote_id = ?)',
      ).run(messageId, accountId, folder);
  }

  private flags(w: FlagsWrite) {
    const [set, clear] = flagBits(w);
    for (const m of this.targets(w.accountId, w.target)) {
      if (this.fenced(m.local_seq)) continue;
      this.q('UPDATE messages SET flags = (flags & ~?) | ? WHERE id = ?').run(clear, set, m.id);
      this.touchMessage(w.accountId, m);
    }
  }

  private messageDelete(w: MessageDeleteWrite) {
    const m = this.q(
      'SELECT id, thread_id, parts FROM messages WHERE account_id = ? AND remote_id = ?',
    ).get<{ id: number; thread_id: number; parts: number }>(w.accountId, w.remoteId);
    if (!m) return; // deletions are idempotent
    if (m.parts & PART.fts) this.q('DELETE FROM messages_fts WHERE rowid = ?').run(m.id);
    this.q('DELETE FROM messages WHERE id = ?').run(m.id);
    this.touched.add(m.thread_id);
    this.mark('Message', w.accountId, w.remoteId, 'd');
  }

  // ------------------------------------------------------------ threads and workflow

  private thread(w: ThreadWrite) {
    const row = this.q('SELECT id FROM threads WHERE account_id = ? AND remote_id = ?').get<{
      id: number;
    }>(w.accountId, w.remoteThreadId);
    if (!row) return this.missing(`Thread ${w.remoteThreadId}`);
    if (w.complete !== undefined)
      this.q('UPDATE threads SET complete = ? WHERE id = ?').run(Number(w.complete), row.id);
    if (w.remoteCount !== undefined)
      this.q('UPDATE threads SET remote_count = ? WHERE id = ?').run(w.remoteCount, row.id);
    this.touched.add(row.id);
  }

  private threadDelete(w: ThreadDeleteWrite) {
    const row = this.q('SELECT id FROM threads WHERE account_id = ? AND remote_id = ?').get<{
      id: number;
    }>(w.accountId, w.remoteThreadId);
    if (!row) return;
    for (const m of this.q('SELECT id, remote_id, parts FROM messages WHERE thread_id = ?').all<{
      id: number;
      remote_id: string;
      parts: number;
    }>(row.id)) {
      if (m.parts & PART.fts) this.q('DELETE FROM messages_fts WHERE rowid = ?').run(m.id);
      this.mark('Message', w.accountId, m.remote_id, 'd');
    }
    this.markListChanges(this.lists(row.id), new Map());
    this.q('DELETE FROM threads WHERE id = ?').run(row.id); // cascades messages, placements, workflow, lists
    this.touched.delete(row.id);
    this.mark('Thread', w.accountId, w.remoteThreadId, 'd');
  }

  private workflow(w: WorkflowWrite) {
    const row = this.q('SELECT id FROM threads WHERE account_id = ? AND remote_id = ?').get<{
      id: number;
    }>(w.accountId, w.remoteThreadId);
    if (!row) return this.missing(`Thread ${w.remoteThreadId}`);
    const keys = Object.keys(w.patch) as (keyof WorkflowFields)[];
    if (!keys.length) return;
    const values = keys.map(k => {
      if (!(k in WORKFLOW_COLUMNS)) throw new StoreError('invalid', `Unknown workflow field ${k}`);
      const v = w.patch[k];
      return typeof v === 'boolean' ? Number(v) : ((v ?? null) as SqlValue);
    });
    this.q(
      `UPDATE thread_workflow SET ${keys.map(k => `${WORKFLOW_COLUMNS[k]} = ?`).join(', ')} WHERE thread_id = ?`,
    ).run(...values, row.id);
    // Workflow is part of the contract's Thread row, so the thread's rev moves with it.
    this.q('UPDATE threads SET rev = ? WHERE id = ?').run(this.seq, row.id);
    this.mark('Thread', w.accountId, w.remoteThreadId, 'u');
  }

  private threadMerge(w: ThreadMergeWrite) {
    const find = (remoteId: string) =>
      this.q('SELECT id FROM threads WHERE account_id = ? AND remote_id = ?').get<{ id: number }>(
        w.accountId,
        remoteId,
      )?.id;
    const from = w.from.filter(r => r !== w.into);
    let into = find(w.into);
    if (into === undefined) {
      const first = from.find(r => find(r) !== undefined);
      if (first === undefined) return this.missing(`Thread ${w.into}`);
      into = find(first)!;
      this.q('UPDATE threads SET remote_id = ? WHERE id = ?').run(w.into, into);
      this.q('UPDATE thread_workflow SET sync_key = ? WHERE thread_id = ?').run(w.into, into);
      this.mark('Thread', w.accountId, first, 'd');
      // Its messages now name a different contract thread id.
      for (const m of this.q(
        `SELECT ${MESSAGE_COLS} FROM messages m WHERE m.thread_id = ?`,
      ).all<MessageRow>(into))
        this.touchMessage(w.accountId, m);
    }
    for (const remoteId of from) {
      const id = find(remoteId);
      if (id === undefined || id === into) continue;
      for (const m of this.q(
        `SELECT ${MESSAGE_COLS} FROM messages m WHERE m.thread_id = ?`,
      ).all<MessageRow>(id)) {
        this.q('UPDATE messages SET thread_id = ? WHERE id = ?').run(into, m.id);
        this.touchMessage(w.accountId, { ...m, thread_id: into });
      }
      this.touched.add(id); // emptied: the rollup deletes it and marks it
    }
    this.touched.add(into);
  }

  // ------------------------------------------------------------ ops (ARCH 4.3)

  private op(w: OpWrite) {
    if (!w.opId || !w.accountId || !w.opKind)
      throw new StoreError('invalid', 'An op needs opId, accountId and opKind');
    if (!Array.isArray(w.effect))
      throw new StoreError('invalid', `Op ${w.opId} needs an effect array`);
    if (this.q('SELECT 1 FROM ops WHERE op_id = ?').get(w.opId))
      throw new StoreError('invalid', `Op ${w.opId} is already queued`);
    for (const e of w.effect) this.applyEffect(w.accountId, e, undefined);
    this.q(
      `INSERT INTO ops(op_id, account_id, kind, target, payload, base, effect, state, created_seq)
      VALUES(?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    ).run(
      w.opId,
      w.accountId,
      w.opKind,
      JSON.stringify(w.targets ?? []),
      w.payload,
      w.base ?? null,
      w.effect.length ? JSON.stringify(w.effect) : null,
      this.seq,
    );
    this.mark('Account', w.accountId, null, 'u'); // Account.pendingChanges
  }

  private opSettle(w: OpSettleWrite) {
    const row = this.q('SELECT seq, account_id FROM ops WHERE op_id = ?').get<{
      seq: number;
      account_id: string;
    }>(w.opId);
    if (!row) return this.missing(`Op ${w.opId}`);
    if (w.state === 'synced' || w.state === 'cancelled')
      this.q('DELETE FROM ops WHERE seq = ?').run(row.seq);
    else {
      const cols: Record<string, SqlValue> = { state: w.state };
      if (w.attempts !== undefined) cols.attempts = w.attempts;
      if (w.nextAt !== undefined) cols.next_at = w.nextAt;
      if (w.lastError !== undefined) cols.last_error = w.lastError;
      const keys = Object.keys(cols);
      this.q(`UPDATE ops SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE seq = ?`).run(
        ...keys.map(k => cols[k]),
        row.seq,
      );
    }
    this.mark('Account', row.account_id, null, 'u');
  }

  /**
   * One op effect. `only` set: a replay over a sync commit, limited to the messages it wrote that were already stored
   * when the op was enqueued, ignoring the fence and leaving `local_seq` alone. Unset: the op's own local edit.
   */
  private applyEffect(
    accountId: string,
    e: OpEffect,
    only: { ids: Set<number>; createdSeq: number } | undefined,
  ) {
    if (!only) {
      if (e.kind === 'placements')
        return this.placements({
          kind: 'placements',
          accountId,
          target: e.target,
          add: e.add,
          remove: e.remove,
        });
      if (e.kind === 'flags') return this.flags({ ...e, kind: 'flags', accountId });
      throw new StoreError('invalid', `Unknown op effect ${(e as { kind?: unknown }).kind}`);
    }
    for (const m of this.targets(accountId, e.target)) {
      if (!only.ids.has(m.id) || m.first_seen_seq > only.createdSeq) continue;
      if (e.kind === 'placements') this.movePlacements(accountId, m.id, e.add, e.remove, undefined);
      else if (e.kind === 'flags') {
        const [set, clear] = flagBits(e);
        this.q('UPDATE messages SET flags = (flags & ~?) | ? WHERE id = ?').run(clear, set, m.id);
      }
      this.touched.add(m.thread_id);
    }
  }

  /** ARCH 4.3 replay: provider facts first, then every still-pending op over the messages this sync commit wrote. */
  replayOps() {
    if (this.input.origin !== 'sync') return;
    for (const [accountId, ids] of this.touchedMessages) {
      const ops = this.q(
        `SELECT effect, created_seq FROM ops WHERE account_id = ? AND ${REPLAYED_OPS} AND effect IS NOT NULL ORDER BY seq`,
      ).all<{ effect: string; created_seq: number }>(accountId);
      for (const op of ops)
        for (const e of JSON.parse(op.effect) as OpEffect[])
          this.applyEffect(accountId, e, { ids, createdSeq: op.created_seq });
    }
  }

  // ------------------------------------------------------------ bodies and attachments (ARCH 3.3)

  private body(w: BodyWrite) {
    const m = this.messageRow(w.accountId, w.remoteId);
    if (!m) return this.missing(`Message ${w.remoteId}`);
    const { rawSize, codec, data } = encodeBody(w.body, this.ctx.bodyCodec);
    this.q(
      `INSERT INTO bodies(message_id, codec, raw_size, data) VALUES(?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET codec = excluded.codec, raw_size = excluded.raw_size, data = excluded.data`,
    ).run(m.id, codec, rawSize, data);
    const parts = this.q('SELECT parts FROM messages WHERE id = ?').get<{ parts: number }>(
      m.id,
    )!.parts;
    // The body changes what search indexes: drop the row and the bit, and the paced indexer picks it up again.
    if (parts & PART.fts) this.q('DELETE FROM messages_fts WHERE rowid = ?').run(m.id);
    const next =
      (parts & ~(PART.text | PART.html | PART.fts | PART.evicted)) |
      (w.body.text !== undefined ? PART.text : 0) |
      (w.body.html !== undefined ? PART.html : 0);
    this.q('UPDATE messages SET parts = ?, rev = ? WHERE id = ?').run(next, this.seq, m.id);
    this.mark('Message', w.accountId, w.remoteId, 'u'); // Message.bodyState
  }

  private attachments(w: AttachmentsWrite) {
    const m = this.messageRow(w.accountId, w.remoteId);
    if (!m) return this.missing(`Message ${w.remoteId}`);
    this.q(
      'DELETE FROM attachments WHERE message_id = ? AND remote_part NOT IN (SELECT value FROM json_each(?))',
    ).run(m.id, JSON.stringify(w.list.map(a => a.remotePart)));
    const upsert = this.q(
      `INSERT INTO attachments(message_id, remote_part, name, mime, size, cid, inline, state) VALUES(?, ?, ?, ?, ?, ?, ?, 'absent')
      ON CONFLICT(message_id, remote_part) DO UPDATE SET name = excluded.name, mime = excluded.mime, size = excluded.size,
        cid = excluded.cid, inline = excluded.inline`,
    );
    for (const a of w.list)
      upsert.run(
        m.id,
        a.remotePart,
        a.name ?? null,
        a.mime ?? null,
        a.size ?? null,
        a.cid ?? null,
        Number(a.inline),
      );
    this.q('UPDATE messages SET parts = parts | ?, rev = ? WHERE id = ?').run(
      PART.attachListed,
      this.seq,
      m.id,
    );
    this.mark('Message', w.accountId, w.remoteId, 'u'); // Message.attachments
  }

  private attachmentState(w: AttachmentStateWrite) {
    const m = this.messageRow(w.accountId, w.remoteId);
    if (!m) return this.missing(`Message ${w.remoteId}`);
    const done = this.q(
      `UPDATE attachments SET state = ?, path = CASE WHEN ? THEN ? ELSE path END WHERE message_id = ? AND remote_part = ?`,
    ).run(w.state, Number(w.path !== undefined), w.path ?? null, m.id, w.remotePart).changes;
    if (!done) return this.missing(`Attachment ${w.remotePart} of ${w.remoteId}`);
    this.q('UPDATE messages SET rev = ? WHERE id = ?').run(this.seq, m.id);
    this.mark('Message', w.accountId, w.remoteId, 'u');
  }

  // ------------------------------------------------------------ bookkeeping

  private syncState(w: SyncStateWrite) {
    if (w.pending && w.pending.length > MAX_PENDING)
      throw new StoreError('invalid', `sync_state.pending holds at most ${MAX_PENDING} ids`);
    this.q(
      `INSERT INTO sync_state(account_id, scope, cursor, page_token, phase, oldest_loaded, generation, pending, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, scope) DO UPDATE SET cursor = excluded.cursor,
        page_token = excluded.page_token, phase = excluded.phase, oldest_loaded = excluded.oldest_loaded,
        generation = excluded.generation, pending = excluded.pending, updated_at = excluded.updated_at`,
    ).run(
      w.accountId,
      w.scope,
      w.cursor ?? null,
      w.pageToken ?? null,
      w.phase ?? null,
      w.oldestLoaded ?? null,
      w.generation,
      w.pending?.length ? JSON.stringify(w.pending) : null,
      this.ctx.now(),
    );
  }

  /** Placements the covering round did not re-stamp, inside its bound; NULL stamps (history, open, search) stay. */
  private sweep(w: SweepWrite) {
    if (!Number.isInteger(w.generation))
      throw new StoreError('invalid', 'A sweep needs an integer generation');
    const folder = this.q('SELECT id FROM folders WHERE account_id = ? AND remote_id = ?').get<{
      id: number;
    }>(w.accountId, w.folder);
    if (!folder) return;
    const gone = this.q(
      `SELECT ${MESSAGE_COLS} FROM message_folders mf JOIN messages m ON m.id = mf.message_id
      WHERE mf.folder_id = ?1 AND mf.seen_gen IS NOT NULL AND mf.seen_gen < ?2
        AND (?3 IS NULL OR m.internal_date > ?3) AND (?4 IS NULL OR m.internal_date < ?4)
        AND (?5 IS NULL OR mf.uid >= ?5) AND (?6 IS NULL OR mf.uid <= ?6)`,
    ).all<MessageRow>(
      folder.id,
      w.generation,
      w.since ?? null,
      w.until ?? null,
      w.uidFrom ?? null,
      w.uidTo ?? null,
    );
    const remove = this.q('DELETE FROM message_folders WHERE message_id = ? AND folder_id = ?');
    for (const m of gone) {
      if (this.fenced(m.local_seq)) continue;
      remove.run(m.id, folder.id);
      this.touchMessage(w.accountId, m);
    }
  }

  private meta(w: MetaWrite) {
    if (RESERVED_META.has(w.key))
      throw new StoreError('invalid', `meta.${w.key} is written by the store only`);
    if (w.value === null) this.q('DELETE FROM meta WHERE key = ?').run(w.key);
    else
      this.q(
        'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(w.key, w.value);
  }

  // ------------------------------------------------------------ rollups and the change log

  /**
   * Recomputes every touched thread from its messages (ARCH 3.2): drafts never count, a thread without messages is
   * deleted, and folder lists come from messages not in Trash or Spam, except for the Trash and Spam lists themselves.
   */
  rollups() {
    for (const threadId of this.touched) {
      const t = this.q('SELECT account_id, remote_id FROM threads WHERE id = ?').get<{
        account_id: string;
        remote_id: string;
      }>(threadId);
      if (!t) continue;
      const a = this.q(
        `SELECT count(*) AS total,
          coalesce(sum((flags & 8) = 0), 0) AS n, coalesce(sum((flags & 9) = 0), 0) AS unread,
          coalesce(max((flags & 10) = 2), 0) AS flagged, coalesce(max((flags & 40) = 32), 0) AS attach,
          min(CASE WHEN (flags & 8) = 0 THEN internal_date END) AS first,
          coalesce(max(CASE WHEN (flags & 8) = 0 THEN internal_date END), max(internal_date)) AS last,
          max(CASE WHEN (flags & 24) = 0 THEN internal_date END) AS inbound
        FROM messages WHERE thread_id = ?`,
      ).get<Record<string, number | null>>(threadId)!;
      if (!a.total) {
        this.markListChanges(this.lists(threadId), new Map());
        this.q('DELETE FROM threads WHERE id = ?').run(threadId);
        this.mark('Thread', t.account_id, t.remote_id, 'd');
        continue;
      }
      const text = this.q(
        `SELECT
          (SELECT subject FROM messages WHERE thread_id = ?1 AND (flags & 8) = 0 AND subject IS NOT NULL ORDER BY internal_date, id LIMIT 1) AS subject,
          (SELECT snippet FROM messages WHERE thread_id = ?1 AND (flags & 8) = 0 ORDER BY internal_date DESC, id DESC LIMIT 1) AS snippet,
          (SELECT list_unsub FROM messages WHERE thread_id = ?1 AND (flags & 8) = 0 AND list_unsub IS NOT NULL ORDER BY internal_date DESC, id DESC LIMIT 1) AS unsub,
          (SELECT json_group_array(json_object('address', a, 'name', n)) FROM (
             SELECT from_addr AS a, max(from_name) AS n, max(internal_date) AS d FROM messages
             WHERE thread_id = ?1 AND (flags & 8) = 0 AND from_addr IS NOT NULL GROUP BY from_addr ORDER BY d DESC LIMIT 6)) AS people`,
      ).get<Record<string, string | null>>(threadId)!;
      const last = a.last!;
      this.q(
        `UPDATE threads SET subject = ?, snippet = ?, participants = ?, first_date = ?, last_date = ?, last_inbound_date = ?,
          msg_count = ?, unread_count = ?, flagged = ?, has_attach = ?, list_unsub = ?, rev = ? WHERE id = ?`,
      ).run(
        text.subject,
        text.snippet,
        text.people,
        a.first,
        last,
        a.inbound,
        a.n,
        a.unread,
        a.flagged,
        a.attach,
        text.unsub,
        this.seq,
        threadId,
      );
      this.q('UPDATE thread_workflow SET last_date = ? WHERE thread_id = ?').run(last, threadId);
      const before = this.lists(threadId);
      this.q('DELETE FROM thread_folders WHERE thread_id = ?').run(threadId);
      this.q(
        `INSERT INTO thread_folders(folder_id, last_date, thread_id, unread)
        SELECT mf.folder_id, ?1, ?2, sum((m.flags & 1) = 0)
        FROM messages m JOIN message_folders mf ON mf.message_id = m.id JOIN folders f ON f.id = mf.folder_id
        WHERE m.thread_id = ?2 AND (m.flags & 8) = 0 AND m.origin <> 'search'
          AND (f.role IN ('trash', 'spam') OR NOT EXISTS (SELECT 1 FROM message_folders x JOIN folders y ON y.id = x.folder_id
            WHERE x.message_id = m.id AND y.role IN ('trash', 'spam')))
        GROUP BY mf.folder_id`,
      ).run(last, threadId);
      this.markListChanges(before, this.lists(threadId));
      this.mark('Thread', t.account_id, t.remote_id, 'u');
    }
  }

  /** The thread's folder lists: folder id → whether the thread counts as unread there. */
  private lists(threadId: number): Map<number, boolean> {
    return new Map(
      this.q('SELECT folder_id, unread FROM thread_folders WHERE thread_id = ?')
        .all<{ folder_id: number; unread: number }>(threadId)
        .map(r => [r.folder_id, r.unread > 0]),
    );
  }

  /**
   * Folder rows are derived too (FR-15): `Folder.total` and `Folder.unread` count the threads listed there, so a folder
   * whose list gained or lost a thread, or where the thread turned read or unread, gets a change row.
   */
  private markListChanges(before: Map<number, boolean>, after: Map<number, boolean>) {
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      if (before.get(id) === after.get(id)) continue;
      const f = this.q('SELECT account_id, remote_id FROM folders WHERE id = ?').get<{
        account_id: string;
        remote_id: string;
      }>(id);
      if (f) this.mark('Folder', f.account_id, f.remote_id, 'u');
    }
  }

  writeChanges(): number {
    const insert = this.q('INSERT INTO changes(seq, type, id, op) VALUES(?, ?, ?, ?)');
    for (const c of this.changes.values()) insert.run(this.seq, c.type, c.id, c.op);
    return this.changes.size;
  }
}

function flagBits(w: { seen?: boolean; flagged?: boolean; answered?: boolean }): [number, number] {
  let set = 0,
    clear = 0;
  const bit = (on: boolean | undefined, flag: number) => {
    if (on === true) set |= flag;
    else if (on === false) clear |= flag;
  };
  bit(w.seen, FLAG.seen);
  bit(w.flagged, FLAG.flagged);
  bit(w.answered, FLAG.answered);
  return [set, clear];
}

const WORKFLOW_COLUMNS: Record<keyof WorkflowFields, string> = {
  status: 'status',
  laterUntil: 'later_until',
  dueDate: 'due_date',
  dueSource: 'due_source',
  reminderAt: 'reminder_at',
  reminderFiredAt: 'reminder_fired_at',
  bookmarked: 'bookmarked',
  replyStatus: 'reply_status',
  todo: 'todo',
  hiddenFromHome: 'hidden_from_home',
  lane: 'lane',
  importance: 'importance',
  rankSource: 'rank_source',
  rankedAt: 'ranked_at',
  dueBand: 'due_band',
  editedAt: 'edited_at',
  editDevice: 'edit_device',
  editGen: 'edit_gen',
};
