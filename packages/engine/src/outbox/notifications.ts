import type { NotificationItem } from '@aplos/contract';
import type { Logger } from '../diag/log';
import type { Clock, DeadlineRegistry, DeadlineSource, Timer } from '../ports/time';
import type { EngineFrame } from '../runtime/frames';
import { FLAG } from '../store';
import type {
  CommitExtensionTx,
  IngestBatch,
  IngestedMessage,
  StorePort,
  StoreReader,
} from '../store';
import { readCounts } from '../views/counts';

/**
 * The notification outbox (ARCH 7.6). `notifications` is a durable table keyed by message. The ingest hook below writes a
 * `pending` row inside the sync commit for each new inbound Inbox message after the silent baseline; main claims rows
 * through `Notification/claim` (a `claimed` row with a lease), posts them, and acknowledges (`posted`, or `dropped`).
 * Row states: `pending` -> `claimed` -> `posted` | `dropped`. A claim nobody acknowledges before its lease ends goes back
 * to `pending`, so a crash between claim and post offers the notification again.
 *
 * The table has no lease column, so `claimed_by` holds `<token>@<lease end, epoch ms>`; `leaseOf` and the SQL below are
 * its only users. A later migration can give it a column.
 */

/** A claim not acknowledged within this long is offered again. */
export const CLAIM_LEASE_MS = 60_000;
/** Posted and dropped rows are kept this long, then deleted. */
export const KEEP_DONE_MS = 30 * 24 * 3_600_000;
/** The Dock badge is recomputed at most this often after commits. */
export const BADGE_DEBOUNCE_MS = 250;
/** Most notifications one claim returns when the caller does not say. */
export const DEFAULT_CLAIM = 20;

const TITLE_MAX = 500;
const BODY_MAX = 1_000;
const MAIL_PREFIX = 'mail:';

export type AckState = 'posted' | 'dropped';

export type NotificationWrite =
  | { kind: 'notification'; op: 'claim'; token: string; max: number; now: number; leaseMs: number }
  | { kind: 'notification'; op: 'ack'; keys: string[]; state: AckState }
  | { kind: 'notification'; op: 'expire'; now: number };

declare module '../store/port' {
  interface ExtensionWrites {
    notification: NotificationWrite;
  }
}

// ------------------------------------------------------------------ the ingest hook

interface AccountGate {
  baselineDone: boolean;
  on: boolean;
}

function gateOf(tx: CommitExtensionTx, accountId: string): AccountGate {
  const row = tx.get<{ baseline_done_at: number | null; notifications: number }>(
    'SELECT baseline_done_at, notifications FROM accounts WHERE id = ?',
    accountId,
  );
  return { baselineDone: row?.baseline_done_at != null, on: row?.notifications === 1 };
}

/** Only an incremental pass after the baseline brings new mail; backfill, resync, prefetch and search never notify. */
function batchNotifies(batch: IngestBatch): boolean {
  return batch.origin === 'sync' && batch.step === 'incremental';
}

function inboxOnly(m: IngestedMessage): boolean {
  const roles: readonly string[] = Array.isArray(m.roles) ? m.roles : [];
  return roles.includes('inbox') && !roles.includes('spam') && !roles.includes('trash');
}

function qualifies(m: IngestedMessage, gate: AccountGate): boolean {
  if (!gate.baselineDone || !gate.on) return false;
  if (m.origin !== 'sync' || m.added !== true) return false;
  if (!m.flags || m.flags.seen || m.flags.draft || m.flags.fromMe) return false;
  return inboxOnly(m);
}

function insertRow(tx: CommitExtensionTx, m: IngestedMessage): number {
  const result = tx.run(
    "INSERT OR IGNORE INTO notifications(message_id, state, created_at) VALUES(?, 'pending', ?)",
    m.rowId,
    tx.now(),
  );
  return result.changes;
}

type Gates = Map<string, AccountGate>;

/** One message: never throws, so one odd message cannot block its batch or the account's sync. */
function noteMessage(tx: CommitExtensionTx, gates: Gates, m: IngestedMessage): number {
  try {
    if (!gates.has(m.accountId)) gates.set(m.accountId, gateOf(tx, m.accountId));
    return qualifies(m, gates.get(m.accountId)!) ? insertRow(tx, m) : 0;
  } catch {
    return 0;
  }
}

/**
 * `CommitExtension.ingest`: a throw here would roll back the sync commit and block the account on every retry, so
 * nothing escapes. A re-delivered batch writes nothing twice (`message_id` is the key and `added` is false).
 */
export function ingestNotifications(batch: IngestBatch, tx: CommitExtensionTx): void {
  try {
    if (!batchNotifies(batch)) return;
    const gates: Gates = new Map();
    let written = 0;
    for (const m of batch.messages) written += noteMessage(tx, gates, m);
    if (written > 0) signalWritten();
  } catch {
    // Missing a notification is the lesser harm.
  }
}

// ------------------------------------------------------------------ the writer (claim, ack, expire)

const LEASE_END = "CAST(substr(claimed_by, instr(claimed_by, '@') + 1) AS INTEGER)";

function expire(tx: CommitExtensionTx, now: number) {
  tx.run(
    `UPDATE notifications SET state = 'pending', claimed_by = NULL
     WHERE state = 'claimed' AND (claimed_by IS NULL OR ${LEASE_END} <= ?)`,
    now,
  );
  tx.run(
    "DELETE FROM notifications WHERE state IN ('posted', 'dropped') AND created_at < ?",
    now - KEEP_DONE_MS,
  );
}

/** Mail that was read, or left the Inbox, before main claimed it is not worth a banner. */
function dropStale(tx: CommitExtensionTx) {
  tx.run(
    `UPDATE notifications SET state = 'dropped'
     WHERE state = 'pending' AND NOT EXISTS (
       SELECT 1 FROM messages m
       WHERE m.id = notifications.message_id AND (m.flags & ${FLAG.seen}) = 0 AND EXISTS (
         SELECT 1 FROM message_folders mf JOIN folders f ON f.id = mf.folder_id
         WHERE mf.message_id = m.id AND f.role = 'inbox'))`,
  );
}

export const leaseOf = (token: string, until: number) => `${token}@${until}`;

function claim(tx: CommitExtensionTx, w: Extract<NotificationWrite, { op: 'claim' }>) {
  expire(tx, w.now);
  dropStale(tx);
  tx.run(
    `UPDATE notifications SET state = 'claimed', claimed_by = ?
     WHERE message_id IN (
       SELECT message_id FROM notifications WHERE state = 'pending' ORDER BY created_at, message_id LIMIT ?)`,
    leaseOf(w.token, w.now + w.leaseMs),
    w.max,
  );
}

/** Idempotent: a row already `posted` or `dropped` stays as it is, an unknown key matches nothing. */
function ack(tx: CommitExtensionTx, w: Extract<NotificationWrite, { op: 'ack' }>) {
  tx.run(
    `UPDATE notifications SET state = ?, claimed_by = NULL
     WHERE state IN ('pending', 'claimed') AND message_id IN (
       SELECT m.id FROM messages m WHERE m.account_id || ':' || m.remote_id IN (SELECT value FROM json_each(?)))`,
    w.state,
    JSON.stringify(w.keys),
  );
}

export function applyNotification(write: { kind: string }, tx: CommitExtensionTx): void {
  const w = write as NotificationWrite;
  if (w.op === 'claim') return claim(tx, w);
  if (w.op === 'ack') return ack(tx, w);
  if (w.op === 'expire') return expire(tx, w.now);
  throw new Error(`Unknown notification write ${String((w as { op?: unknown }).op)}`);
}

// ------------------------------------------------------------------ "rows were written" signal

type Listener = () => void;
const listeners = new Set<Listener>();
let scheduled = false;

/**
 * The hook runs inside a commit that may still roll back, so it only asks for a look: the listeners run after the
 * current synchronous work, read the table, and tell main only what is really there. A spurious look is harmless.
 */
function signalWritten() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A closing store must not break the commit that called us.
      }
    }
  });
}

// ------------------------------------------------------------------ the service

export interface NotificationService {
  /** Up to `max` unposted notifications, now leased to the caller. */
  claim(max?: number): NotificationItem[];
  /** Marks claimed notifications posted (or dropped). Unknown or already finished ids are ignored. */
  ack(ids: readonly string[], state: AckState): void;
  /** Rows waiting for a claim. */
  pending(): number;
  /** Unread Inbox threads: the Dock badge. */
  badge(): number;
  /**
   * Look at the badge again soon (debounced) and send a `badge` host event if the count moved. The ingest hook, claim,
   * ack, start and wake call it; the runtime has no commit listener yet, so a read that changes the count calls it too.
   */
  refreshBadge(): void;
}

export interface NotificationDeps {
  store: StorePort;
  clock: Clock;
  deadlines: DeadlineRegistry;
  log: Logger;
  randomBytes: (n: number) => Uint8Array;
  /** Host events (`notify`, `badge`) go out here. */
  frames?: { emit(frame: EngineFrame): void };
}

export interface NotificationModule {
  service: NotificationService;
  /** Launch: offers rows a crash left unposted and sends the first badge. */
  start(): void;
  stop(): void;
}

interface ClaimedRow {
  message_id: number;
  created_at: number;
  account_id: string;
  remote_id: string;
  thread: string;
  from_name: string | null;
  from_addr: string | null;
  subject: string | null;
  [k: string]: string | number | null;
}

const flat = (s: string | null | undefined, max: number) =>
  [
    ...(s ?? '')
      .replace(/\p{Cc}+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, max)
    .join('');

/** The contract allows a sender and a subject, nothing from the body. */
export function itemOf(row: ClaimedRow): NotificationItem {
  const body = flat(row.subject, BODY_MAX);
  const item: NotificationItem = {
    id: `${MAIL_PREFIX}${row.account_id}:${row.remote_id}`,
    kind: 'mail',
    accountId: row.account_id,
    threadId: `${row.account_id}:${row.thread}`,
    title: flat(row.from_name || row.from_addr, TITLE_MAX) || 'New message',
    at: row.created_at,
  };
  if (body) item.body = body;
  return item;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

function readPending(q: StoreReader): number {
  return q.get<{ n: number }>("SELECT count(*) AS n FROM notifications WHERE state = 'pending'")!.n;
}

function readLeased(q: StoreReader, lease: string): ClaimedRow[] {
  return q.all<ClaimedRow>(
    `SELECT n.message_id, n.created_at, m.account_id, m.remote_id, t.remote_id AS thread,
            m.from_name, m.from_addr, m.subject
     FROM notifications n JOIN messages m ON m.id = n.message_id JOIN threads t ON t.id = m.thread_id
     WHERE n.state = 'claimed' AND n.claimed_by = ? ORDER BY n.created_at, n.message_id`,
    lease,
  );
}

function nextLease(q: StoreReader): number | undefined {
  const row = q.get<{ t: number | null }>(
    `SELECT min(${LEASE_END}) AS t FROM notifications WHERE state = 'claimed' AND claimed_by IS NOT NULL`,
  );
  return row?.t ?? undefined;
}

/** Unread Inbox threads, from the views' own counts so the badge agrees with the sidebar. */
function unreadInbox(q: StoreReader, now: number): number {
  return readCounts(q, { now, zone: 'UTC', followUpDays: 3 }).all.unread;
}

export function createNotifications(deps: NotificationDeps): NotificationModule {
  const { store, clock, frames } = deps;
  let lastBadge: number | undefined;
  let badgeTimer: Timer | undefined;
  let stopped = false;

  const emit = (event: Extract<EngineFrame, { frame: 'host' }>['event']) => {
    try {
      frames?.emit({ frame: 'host', event });
    } catch {
      // A host event is best effort: the rows stay in the table, and the next claim finds them.
    }
  };
  const announcePending = () => {
    const pending = store.read(readPending);
    if (pending > 0) emit({ type: 'notify', pending });
  };
  const sendBadge = () => {
    badgeTimer = undefined;
    if (stopped) return;
    const count = store.read(q => unreadInbox(q, clock.now()));
    if (count === lastBadge) return;
    lastBadge = count;
    emit({ type: 'badge', count });
  };
  const scheduleBadge = () => {
    if (stopped || badgeTimer) return;
    badgeTimer = clock.timer(clock.now() + BADGE_DEBOUNCE_MS, sendBadge);
  };
  const onWritten = () => {
    if (stopped) return;
    announcePending();
    scheduleBadge();
  };

  const commit = (id: string, write: NotificationWrite) =>
    store.commit({
      opId: `notification:${id}:${hex(deps.randomBytes(8))}`,
      origin: 'system',
      writes: [write],
    });

  const service: NotificationService = {
    claim(max = DEFAULT_CLAIM) {
      const token = hex(deps.randomBytes(8));
      const now = clock.now();
      commit('claim', {
        kind: 'notification',
        op: 'claim',
        token,
        max,
        now,
        leaseMs: CLAIM_LEASE_MS,
      });
      deps.deadlines.changed('notifications');
      scheduleBadge();
      const lease = leaseOf(token, now + CLAIM_LEASE_MS);
      return store.read(q => readLeased(q, lease)).map(itemOf);
    },
    ack(ids, state) {
      const keys = ids
        .filter(id => id.startsWith(MAIL_PREFIX))
        .map(id => id.slice(MAIL_PREFIX.length));
      if (!keys.length) return;
      commit('ack', { kind: 'notification', op: 'ack', keys, state });
      deps.deadlines.changed('notifications');
      scheduleBadge();
    },
    pending: () => store.read(readPending),
    badge: () => store.read(q => unreadInbox(q, clock.now())),
    refreshBadge: () => scheduleBadge(),
  };

  const source: DeadlineSource = {
    id: 'notifications',
    next: () => Promise.resolve(store.read(nextLease)),
    async fire(now) {
      commit('expire', { kind: 'notification', op: 'expire', now });
      announcePending();
    },
  };

  listeners.add(onWritten);
  const unregister = deps.deadlines.register(source);

  return {
    service,
    start() {
      announcePending();
      scheduleBadge();
      deps.deadlines.changed('notifications');
    },
    stop() {
      stopped = true;
      listeners.delete(onWritten);
      unregister();
      badgeTimer?.cancel();
    },
  };
}

declare module '../runtime/services' {
  interface EngineServices {
    /** The notification outbox (time-5): `Notification/claim|ack`. */
    notifications: NotificationService;
  }
}
