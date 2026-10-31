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

/**
 * The notification outbox (ARCH 7.6). `notifications` is a durable table keyed by message. The ingest hook below writes a
 * `pending` row inside the sync commit for each new inbound Inbox message after the silent baseline; main claims rows
 * through `Notification/claim` (a `claimed` row with a lease), posts them, and acknowledges (`posted`, or `dropped`).
 * Row states: `pending` -> `claimed` -> `posted` | `dropped`. A claim nobody acknowledges before its lease ends goes back
 * to `pending`, so a crash between claim and post offers the notification again.
 *
 * Delivery is AT LEAST ONCE with a stable id: a row is handed to one claim at a time, but a host that posted and then
 * died before it acknowledged gets the same item again after the lease ends. The id (`mail:<account>:<message>`) is the
 * same each time, so the second post replaces the first banner instead of stacking. A late `ack` after a reclaim is
 * accepted (the ids carry no token), which only stops further offers.
 *
 * The table has no lease column, so `claimed_by` holds `<token>@<lease end, epoch ms>`; `leaseOf` and the SQL below are
 * its only users. A later migration can give it a column.
 */

/** A claim not acknowledged within this long is offered again. */
export const CLAIM_LEASE_MS = 60_000;
/** Mail older than this when it is ingested is not worth a banner (a Mac that was off for days must not flood). */
export const MAX_AGE_MS = 24 * 3_600_000;
/** Most notifications one ingest batch writes; the rest of a burst are dropped silently (the newest are kept). */
export const MAX_PER_BATCH = 20;
/** Where the badge is looked at again when no commit told us (a sync commit that only moved flags or folders). */
export const BADGE_POLL_MS = 60_000;
/** Posted and dropped rows are kept this long, then deleted. */
export const KEEP_DONE_MS = 30 * 24 * 3_600_000;
/** The Dock badge is recomputed at most this often after commits. */
export const BADGE_DEBOUNCE_MS = 250;
/** Most notifications one claim returns when the caller does not say. */
export const DEFAULT_CLAIM = 20;

const TITLE_MAX = 500;
/** The subject goes into an OS banner, which shows a line or two; the contract would allow 1,000. */
const BODY_MAX = 200;
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

function qualifies(m: IngestedMessage, gate: AccountGate, now: number): boolean {
  if (!gate.baselineDone || !gate.on) return false;
  if (m.origin !== 'sync' || m.added !== true) return false;
  if (!m.flags || m.flags.seen || m.flags.draft || m.flags.fromMe) return false;
  if (Number.isFinite(m.internalDate) && now - m.internalDate > MAX_AGE_MS) return false;
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
function qualifying(tx: CommitExtensionTx, gates: Gates, m: IngestedMessage): boolean {
  try {
    if (!gates.has(m.accountId)) gates.set(m.accountId, gateOf(tx, m.accountId));
    return qualifies(m, gates.get(m.accountId)!, tx.now());
  } catch {
    return false;
  }
}

function insertSafely(tx: CommitExtensionTx, m: IngestedMessage): number {
  try {
    return insertRow(tx, m);
  } catch {
    return 0;
  }
}

/**
 * `CommitExtension.ingest`: a throw here would roll back the sync commit and block the account on every retry, so
 * nothing escapes. A re-delivered batch writes nothing twice (`message_id` is the key and `added` is false). Only the
 * newest `MAX_PER_BATCH` qualifying messages of a batch get a row.
 */
export function ingestNotifications(batch: IngestBatch, tx: CommitExtensionTx): void {
  try {
    if (Array.isArray(batch.messages) && batch.messages.length) signalTouched();
    if (!batchNotifies(batch)) return;
    const gates: Gates = new Map();
    const fresh = batch.messages.filter(m => qualifying(tx, gates, m)).slice(-MAX_PER_BATCH);
    let written = 0;
    for (const m of fresh) written += insertSafely(tx, m);
    if (written > 0) signalWritten();
  } catch {
    // Missing a notification is the lesser harm.
  }
}

// ------------------------------------------------------------------ the writer (claim, ack, expire)

const LEASE_END = "CAST(substr(claimed_by, instr(claimed_by, '@') + 1) AS INTEGER)";

/** A lease further ahead than one lease length was written by a clock that has since been set back: it is expired. */
function expire(tx: CommitExtensionTx, now: number) {
  tx.run(
    `UPDATE notifications SET state = 'pending', claimed_by = NULL
     WHERE state = 'claimed' AND (claimed_by IS NULL OR ${LEASE_END} <= ? OR ${LEASE_END} > ?)`,
    now,
    now + CLAIM_LEASE_MS,
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

/** The ack's update, exported so a test can read its plan: it starts at `notifications` and probes `messages` by key. */
export const ACK_SQL = `UPDATE notifications SET state = ?, claimed_by = NULL
  WHERE state IN ('pending', 'claimed') AND EXISTS (
    SELECT 1 FROM messages m
    WHERE m.id = notifications.message_id
      AND m.account_id || ':' || m.remote_id IN (SELECT value FROM json_each(?)))`;

/**
 * Idempotent: a row already `posted` or `dropped` stays as it is, an unknown key matches nothing. The ids carry no
 * claim token, so a late ack of a row that was offered again is accepted: it ends the offers, and the second host's
 * post (same id) at worst replaces the banner.
 */
function ack(tx: CommitExtensionTx, w: Extract<NotificationWrite, { op: 'ack' }>) {
  tx.run(ACK_SQL, w.state, JSON.stringify(w.keys));
}

export function applyNotification(write: { kind: string }, tx: CommitExtensionTx): void {
  const w = write as NotificationWrite;
  if (w.op === 'claim') return claim(tx, w);
  if (w.op === 'ack') return ack(tx, w);
  if (w.op === 'expire') return expire(tx, w.now);
  throw new Error(`Unknown notification write ${String((w as { op?: unknown }).op)}`);
}

// ------------------------------------------------------------------ "rows were written" signal

type Listener = (rows: boolean) => void;
const listeners = new Set<Listener>();
let scheduled = false;
let scheduledRows = false;

/** How many modules listen for ingest signals (a test checks that `stop()` leaves none). */
export const signalListeners = () => listeners.size;

/**
 * The hook runs inside a commit that may still roll back, so it only asks for a look: the listeners run after the
 * current synchronous work, read the table, and tell main only what is really there. A spurious look is harmless.
 * `rows` is true when notification rows were written; false when only mail changed (the badge may have moved).
 */
function signal(rows: boolean) {
  scheduledRows ||= rows;
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    const withRows = scheduledRows;
    scheduled = false;
    scheduledRows = false;
    for (const listener of [...listeners]) {
      try {
        listener(withRows);
      } catch {
        // A closing store must not break the commit that called us.
      }
    }
  });
}

const signalWritten = () => signal(true);
const signalTouched = () => signal(false);

// ------------------------------------------------------------------ the service

export interface NotificationService {
  /** Up to `max` unposted notifications, now leased to the caller (at least once: see the file comment). */
  claim(max?: number): NotificationItem[];
  /** Marks claimed notifications posted (or dropped). Unknown or already finished ids are ignored. */
  ack(ids: readonly string[], state: AckState): void;
  /** Rows waiting for a claim. */
  pending(): number;
  /** Unread Inbox threads: the Dock badge. */
  badge(): number;
  /**
   * Look at the badge again soon (debounced) and send a `badge` host event if the count moved. The ingest hook, claim,
   * ack, start and wake call it. Mail changes that bring no message write (reads, archives and trashing through
   * `Thread/act`, flag and folder facts from a sync) reach it through `deadlines.changed('notifications')`, which the
   * views lane calls after such a commit, and through the source's own 60 s look at the store's `seq`.
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

/**
 * The characters stripped from banner text: soft hyphen, zero-width space, LRM/RLM, bidi embeddings and overrides,
 * word joiner and the invisible operators and isolates (U+2060-2069), BOM, and the tag characters. Not all of `\p{Cf}`:
 * ZWNJ/ZWJ (U+200C/D) and the Arabic number signs (U+0600-0605) are needed to spell Persian, Indic and Arabic text.
 */
const HIDDEN = /[\u00AD\u200B\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF\u{E0000}-\u{E007F}]+/gu;

/**
 * Plain, one-line text for an OS banner: control characters become spaces, `HIDDEN` characters are removed,
 * whitespace collapses. The clamp counts code points, so a surrogate pair is never split.
 */
const flat = (s: string | null | undefined, max: number) =>
  [
    ...(s ?? '')
      .replace(/\p{Cc}+/gu, ' ')
      .replace(HIDDEN, '')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, max)
    .join('')
    .trimEnd();

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

/** The soonest lease end; a lease more than one lease length ahead (clock set back) counts as due now. */
function nextLease(q: StoreReader, now: number): number | undefined {
  const row = q.get<{ t: number | null }>(
    `SELECT min(CASE WHEN ${LEASE_END} > ? THEN ? ELSE ${LEASE_END} END) AS t
     FROM notifications WHERE state = 'claimed' AND claimed_by IS NOT NULL`,
    now + CLAIM_LEASE_MS,
    now,
  );
  return row?.t ?? undefined;
}

/**
 * Unread Inbox threads: the same number as the sidebar's `Counts.all.unread` (views/counts.ts `unreadInbox`: per account
 * the first Inbox folder's threads with `unread > 0`), as one query on the `tf_unread` index (the partial index the
 * planner would not pick on its own) instead of the whole
 * `readCounts` (Home sections, drafts, scheduled, folders). A test holds the two equal.
 */
export const UNREAD_INBOX_SQL = `SELECT count(*) AS n
  FROM (SELECT min(id) AS id FROM folders WHERE role = 'inbox' GROUP BY account_id) inbox
  JOIN thread_folders tf INDEXED BY tf_unread ON tf.folder_id = inbox.id
  WHERE tf.unread > 0`;

function unreadInbox(q: StoreReader): number {
  return q.get<{ n: number }>(UNREAD_INBOX_SQL)?.n ?? 0;
}

export function createNotifications(deps: NotificationDeps): NotificationModule {
  const { store, clock, frames } = deps;
  let lastBadge: number | undefined;
  let lastSeq: number | undefined;
  let lastLook = clock.now();
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
    const count = store.read(unreadInbox);
    if (count === lastBadge) return;
    lastBadge = count;
    emit({ type: 'badge', count });
  };
  const scheduleBadge = () => {
    if (stopped || badgeTimer) return;
    badgeTimer = clock.timer(clock.now() + BADGE_DEBOUNCE_MS, sendBadge);
  };
  const onWritten = (rows: boolean) => {
    if (stopped) return;
    if (rows) announcePending();
    scheduleBadge();
  };
  /** The store moved since the last look (any commit, whoever made it): look at the badge again. */
  const watchSeq = () => {
    lastLook = clock.now();
    const seq = store.seq();
    if (seq === lastSeq) return;
    lastSeq = seq;
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
    badge: () => store.read(unreadInbox),
    refreshBadge: () => scheduleBadge(),
  };

  const soonest = (a: number | undefined, b: number) => (a === undefined ? b : Math.min(a, b));
  const source: DeadlineSource = {
    id: 'notifications',
    // Asked after every `deadlines.changed('notifications')`, so it also notices commits the views lane announces.
    next() {
      if (stopped) return Promise.resolve(undefined);
      watchSeq();
      return Promise.resolve(
        soonest(
          store.read(q => nextLease(q, clock.now())),
          lastLook + BADGE_POLL_MS,
        ),
      );
    },
    async fire(now) {
      if (stopped) return;
      const lease = store.read(q => nextLease(q, now));
      watchSeq();
      if (lease === undefined || lease > now) return;
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
