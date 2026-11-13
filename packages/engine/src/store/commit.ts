import { transaction, type SqlDatabase, type SqlStatement } from './sql';
import { governor, providerMemory, syncFailure } from './bookkeeping';
import { calendar, calendarDelete, event, eventDelete, eventHidden, eventSweep } from './calendar';
import { account, folder, folderDelete } from './commit-folders';
import { accountRemove, fileRemoved } from './commit-account-remove';
import { message, messageDelete, placements, flags } from './commit-messages';
import { thread, threadDelete, threadMerge, workflow } from './commit-threads';
import { op, opSettle, applyEffect } from './commit-ops';
import { body, attachments, attachmentState } from './commit-bodies';
import { syncState, sweep, meta } from './commit-sync';
import { ingest } from './ingest';
import type { WriteScope } from './scope';
import {
  StoreError,
  type BodyCodec,
  type IngestHooks,
  ChangeType,
  CommitExtension,
  CommitExtensionTx,
  CommitInput,
  CommitResult,
  OpEffect,
  StoreWrite,
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
  'lane_backfill',
]);
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
  /** `laneFor` and other store-run ingest hooks (seam 2). */
  ingest?: IngestHooks;
}

/** The kinds `commit.ts` applies itself; no extension may claim one. */
export const CORE_WRITE_KINDS: ReadonlySet<string> = new Set([
  'account',
  'accountRemove',
  'fileRemoved',
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
  'eventHidden',
]);

/** Op states whose effect is still replayed over sync (ARCH 4.3). */
const REPLAYED_OPS = `state IN ('queued', 'inflight')`;

/** The change types `Counts/get` can move on; a commit touching one marks `Counts` in the `state` frame (frames.ts). */
export const COUNTS_TYPES = new Set<string>([
  'Thread',
  'Message',
  'Folder',
  'Draft',
  'Submission',
  'Account',
  'Settings',
]);

/**
 * The commit (F4): every write in one transaction, then pending ops replayed over the sync facts (ARCH 4.3), then thread
 * rollups and folder lists recomputed from the messages, one `changes` row per changed item, `seq` bumped once. Lane
 * kinds run in their extension inside the same transaction, and ingest (correspondents, `laneFor`, the lanes' `ingest`
 * hooks) runs after the rollups. A replayed `opId` is a no-op. Still to come in Phase 1 (store-4): FTS, without
 * changing `CommitInput`.
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
    ingest(run);
    const changed = run.writeChanges();
    const seq = changed > 0 ? current + 1 : current;
    if (changed > 0) ctx.stmt("UPDATE meta SET value = ? WHERE key = 'seq'").run(String(seq));
    ctx
      .stmt('INSERT INTO commits(op_id, seq, origin, at) VALUES(?, ?, ?, ?)')
      .run(input.opId, seq, input.origin, ctx.now());
    return { seq, dbEpoch: ctx.dbEpoch, replayed: false, changed };
  });
}

export interface MessageRow {
  id: number;
  thread_id: number;
  remote_id: string;
  flags: number;
  local_seq: number | null;
  first_seen_seq: number;
  [k: string]: number | string | null;
}
export const MESSAGE_COLS =
  'm.id, m.thread_id, m.remote_id, m.flags, m.local_seq, m.first_seen_seq';

export class CommitRun implements WriteScope {
  readonly touched = new Set<number>();
  /** Messages a `message` write stored in this commit → whether this commit first inserted them (ingest). */
  readonly ingested = new Map<number, boolean>();
  /** Messages a `body` write stored in this commit: their threads re-run `laneFor`. */
  readonly bodied = new Set<number>();
  /** Accounts an `accountRemove` deleted in this commit: a later write naming one is refused, not left to a raw FK error. */
  readonly removedAccounts = new Set<string>();
  /** Messages this commit wrote, per account: what pending ops are replayed over. */
  private readonly touchedMessages = new Map<string, Set<number>>();
  private readonly changes = new Map<string, { type: string; id: string; op: 'u' | 'd' | '*' }>();
  private readonly txs = new Map<CommitExtension, CommitExtensionTx>();
  private readonly coarse: boolean;
  readonly local: boolean;

  constructor(
    readonly ctx: CommitContext,
    readonly input: CommitInput,
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
    this.refuseRemoved(w);
    const handler = WRITE_HANDLERS.get(w.kind);
    if (handler) return handler(this, w as never);
    return this.extension(w as { kind: string });
  }

  private refuseRemoved(w: StoreWrite) {
    const named = w as { kind?: unknown; accountId?: unknown; id?: unknown };
    const id = named.kind === 'account' ? named.id : named.accountId;
    if (typeof id === 'string' && this.removedAccounts.has(id))
      throw new StoreError('notFound', `Account ${id} was removed earlier in this commit`);
  }

  /** Lane kinds (seam 2): the registered extension applies them inside this transaction. */
  private extension(w: { kind: string }) {
    const ext = typeof w?.kind === 'string' ? this.ctx.extensions?.get(w.kind) : undefined;
    if (!ext)
      throw new StoreError(
        'invalid',
        `No writer for write kind ${String((w as { kind?: unknown })?.kind)}`,
      );
    ext.apply(w, this.txFor(ext));
  }

  /** One `CommitExtensionTx` per extension and commit, shared by `apply` and `ingest`. */
  txFor(ext: CommitExtension): CommitExtensionTx {
    let tx = this.txs.get(ext);
    if (!tx) this.txs.set(ext, (tx = this.extensionTx(ext)));
    return tx;
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
  markId(type: ChangeType, id: string, op: 'u' | 'd' | '*') {
    this.changes.set(`${type}\0${id}`, { type, id, op });
  }

  /** Sync facts about an item the store does not track are dropped; a local edit of a missing item is an error. */
  missing(what: string) {
    if (this.local) throw new StoreError('notFound', `${what} is not in the store`);
  }

  fenced(localSeq: number | null) {
    const fence = this.input.fenceSeq;
    return (
      this.input.origin === 'sync' && fence !== undefined && localSeq !== null && localSeq > fence
    );
  }

  messageRow(accountId: string, remoteId: string): MessageRow | undefined {
    return this.q(
      `SELECT ${MESSAGE_COLS} FROM messages m WHERE m.account_id = ? AND m.remote_id = ?`,
    ).get<MessageRow>(accountId, remoteId);
  }

  /** Marks a message changed by a delta: new rev, and the fence seq for local edits. */
  touchMessage(accountId: string, m: MessageRow) {
    this.q('UPDATE messages SET rev = ?, local_seq = ? WHERE id = ?').run(
      this.seq,
      this.local ? this.seq : m.local_seq,
      m.id,
    );
    this.touched.add(m.thread_id);
    this.touchedMessage(accountId, m.id);
    this.mark('Message', accountId, m.remote_id, 'u');
  }

  touchedMessage(accountId: string, id: number) {
    let set = this.touchedMessages.get(accountId);
    if (!set) this.touchedMessages.set(accountId, (set = new Set()));
    set.add(id);
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
          applyEffect(this, accountId, e, { ids, createdSeq: op.created_seq });
    }
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
  lists(threadId: number): Map<number, boolean> {
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
  markListChanges(before: Map<number, boolean>, after: Map<number, boolean>) {
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

/**
 * The core write dispatch (seam 2): every kind names the function that applies it, in the sibling file holding that
 * group of tables. The extension-lane writers live in their own modules already; extensions apply the rest.
 */
type Handler = (run: CommitRun, w: never) => void;
const WRITE_HANDLERS: ReadonlyMap<string, Handler> = new Map<string, Handler>([
  ['account', account],
  ['accountRemove', accountRemove],
  ['fileRemoved', fileRemoved],
  ['folder', folder],
  ['folderDelete', folderDelete],
  ['message', message],
  ['messageDelete', messageDelete],
  ['placements', placements],
  ['flags', flags],
  ['thread', thread],
  ['threadDelete', threadDelete],
  ['threadMerge', threadMerge],
  ['workflow', workflow],
  ['op', op],
  ['opSettle', opSettle],
  ['body', body],
  ['attachments', attachments],
  ['attachmentState', attachmentState],
  ['syncState', syncState],
  ['sweep', sweep],
  ['meta', meta],
  ['governor', governor],
  ['providerMemory', providerMemory],
  ['syncFailure', syncFailure],
  ['calendar', calendar],
  ['calendarDelete', calendarDelete],
  ['event', event],
  ['eventDelete', eventDelete],
  ['eventSweep', eventSweep],
  ['eventHidden', eventHidden],
]);
