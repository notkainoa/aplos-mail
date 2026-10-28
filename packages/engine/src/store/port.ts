import type { AccountStatus } from '@aplos/contract';
import type { SqlRow, SqlValue } from './sql';

/**
 * The store port (F4). `commit` is the only write path (plan 10 E2 item 4): one transaction that applies every write,
 * recomputes touched threads' rollups from their messages, writes the `changes` rows and bumps `seq` once.
 *
 * Synchronous by decision: SQLite through `node:sqlite` is synchronous, there is one writer connection, and a commit
 * that awaited halfway could interleave with another or hold the WAL open across I/O (ARCH 3.7). Callers do their
 * network I/O first and hand the store finished facts. A commit of a 500-message page costs tens of milliseconds in
 * the engine's own process, which never blocks a window.
 *
 * Writers address rows by provider ids (`accountId` + remote id); internal rowids never leave the store. Contract ids
 * in `changes` are `accountId:remoteId` (ARCH 3.1). The write union grows additively: round 2 adds kinds (IMAP
 * `{folder, uid}` targets, events), it never changes these.
 */
export interface StorePort {
  /** Stable per database file; changes only when the database is created, reset or restored (ARCH 3.5). */
  readonly dbEpoch: string;
  readonly schemaVersion: number;
  /** The seq of the last commit that changed anything; 0 for a new database. */
  seq(): number;
  commit(input: CommitInput): CommitResult;
  /** Change rows after `seq`, whole commits only, oldest first. Below the compaction floor: re-open windows. */
  changesSince(seq: number, options?: { limit?: number }): ChangesSince;
  /** A short synchronous read for views, the importer and diagnostics. Never return a promise or a live iterator. */
  read<T>(fn: (q: StoreReader) => T): T;
  close(): void;
}

export interface StoreReader {
  get<R extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): R | undefined;
  all<R extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): R[];
  iterate<R extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): IterableIterator<R>;
}

// ---------------------------------------------------------------- commit input

/** Who is writing. `sync` commits can carry a mutation fence; `local` commits mark rows for it. */
export type CommitOrigin = 'sync' | 'local' | 'import' | 'system';
/** Which sync step produced the facts (the port's `StepOrigin`, plus `search`); decides notifications and search rows. */
export type SyncStepOrigin =
  'baseline' | 'incremental' | 'backfill' | 'resync' | 'prefetch' | 'workflow' | 'search';

export interface CommitInput {
  /** Idempotency key. A commit whose opId was already applied changes nothing and returns that commit's seq. */
  opId: string;
  origin: CommitOrigin;
  step?: SyncStepOrigin;
  /**
   * Mutation fence (ARCH 4.3): the seq recorded before the page request went out. In a `sync` commit, a message
   * edited locally after it keeps its local flags and placements; the next incremental pass reconciles.
   */
  fenceSeq?: number;
  /** `coarse` writes one `*` row per type and account instead of a row per item (backfill pages, ARCH 3.5). */
  changes?: 'fine' | 'coarse';
  /** Applied in order. */
  writes: StoreWrite[];
}

export interface CommitResult {
  /** The seq this commit landed at (for a replay: the original commit's seq). Unchanged when nothing was visible. */
  seq: number;
  dbEpoch: string;
  replayed: boolean;
  /** Number of `changes` rows written. */
  changed: number;
}

export type StoreWrite =
  | AccountWrite
  | FolderWrite
  | FolderDeleteWrite
  | MessageWrite
  | MessageDeleteWrite
  | PlacementsWrite
  | FlagsWrite
  | ThreadWrite
  | ThreadDeleteWrite
  | WorkflowWrite
  | SyncStateWrite
  | SweepWrite
  | MetaWrite;

export interface Address {
  address: string;
  name?: string;
}
/** One message's place in a folder. `uid` is the IMAP UID in that folder; absent elsewhere. */
export interface FolderRef {
  folder: string;
  uid?: number;
}
/** Which messages a delta touches: one message, or every non-draft message of a thread (thread-level actions). */
export type MessageTarget = { remoteId: string } | { remoteThreadId: string };

/**
 * Upsert of the account row. Insert needs `provider`, `address` and `capabilities`; afterwards every field is a
 * patch: absent keeps the stored value, `null` clears it.
 */
export interface AccountWrite {
  kind: 'account';
  id: string;
  provider?: string;
  address?: string;
  displayName?: string | null;
  capabilities?: Record<string, boolean>;
  grantedScopes?: string[] | null;
  status?: AccountStatus;
  baselineDoneAt?: number | null;
  tokenGrantedAt?: number | null;
  refreshExpiresAt?: number | null;
  remoteSubject?: string | null;
  oauthClient?: string | null;
  aiAllowed?: boolean;
  primaryLeaseUntil?: number | null;
  primaryLeaseDevice?: string | null;
}

/** What `folders.role` stores (F3 re-exports it); the `category.*` roles are Gmail's tabs, read by `laneFor`. */
export type FolderRole =
  | 'inbox'
  | 'sent'
  | 'drafts'
  | 'trash'
  | 'spam'
  | 'archive'
  | 'starred'
  | 'important'
  | 'all'
  | 'category.personal'
  | 'category.social'
  | 'category.promotions'
  | 'category.updates'
  | 'category.forums';

export interface FolderWrite {
  kind: 'folder';
  accountId: string;
  remoteId: string;
  name: string;
  role?: FolderRole | null;
  folderKind: 'label' | 'folder' | 'system';
  syncScope?: 'live' | 'backfill' | 'lazy' | 'none';
  uidValidity?: number | null;
  hidden?: boolean;
}
export interface FolderDeleteWrite {
  kind: 'folderDelete';
  accountId: string;
  remoteId: string;
}

export interface MessageFlags {
  seen: boolean;
  flagged: boolean;
  answered?: boolean;
  draft: boolean;
  fromMe: boolean;
}
export interface HeaderBits {
  bulk?: boolean;
  list?: boolean;
  autoSubmitted?: boolean;
  noreply?: boolean;
  directToMe?: boolean;
  ccMe?: boolean;
}

/**
 * Upsert of one message's metadata (body-free). The thread is created when unknown. `folders`, when present, is the
 * message's complete folder set (Gmail labelIds minus UNREAD and STARRED) and replaces the stored placements; leave it
 * out when the provider only reports placements one folder at a time (IMAP) and use `placements` writes instead.
 */
export interface MessageWrite {
  kind: 'message';
  accountId: string;
  remoteId: string;
  remoteThreadId: string;
  internetId?: string;
  inReplyTo?: string;
  refs?: string[];
  from?: Address;
  to: Address[];
  cc: Address[];
  bcc?: Address[];
  replyTo?: Address[];
  subject?: string;
  snippet?: string;
  /** `Date:` header, epoch ms. Display only. */
  date: number;
  /** Provider internal date, epoch ms. Orders lists and the date-ordered rowid. */
  internalDate: number;
  size?: number;
  flags: MessageFlags;
  hasAttachments?: boolean;
  hdr?: HeaderBits;
  listUnsubscribe?: { urls: string[]; oneClick?: boolean };
  folders?: FolderRef[];
  /**
   * Generation of the sync round that listed this message (`SyncState.generation`); stamped on its placements for the
   * bounded sweep. A stamp only ever rises; absent keeps the stored stamp, and a new placement without one is NULL,
   * which a sweep never removes (history, open and search writes leave it out).
   */
  seenGen?: number;
  /** Defaults: `search` for `step: 'search'`, `local` for local and import commits, else `sync`. */
  origin?: 'sync' | 'search' | 'local';
}
export interface MessageDeleteWrite {
  kind: 'messageDelete';
  accountId: string;
  remoteId: string;
}

/** Placement delta: Gmail labelsAdded/labelsRemoved at zero fetch, IMAP/JMAP/Graph moves, local label and archive. */
export interface PlacementsWrite {
  kind: 'placements';
  accountId: string;
  target: MessageTarget;
  add: FolderRef[];
  remove: string[];
  seenGen?: number;
}
/** Flag delta (Gmail UNREAD/STARRED, IMAP flags, local read/star). Absent fields stay. */
export interface FlagsWrite {
  kind: 'flags';
  accountId: string;
  target: MessageTarget;
  seen?: boolean;
  flagged?: boolean;
  answered?: boolean;
}

/**
 * Thread-level facts that are not rollups. Rollups always come from the messages. `remoteCount` is the server's own
 * message count (`MessageFacts.threadSize`), kept apart from `msg_count` for `openThread`'s `knownCount`.
 */
export interface ThreadWrite {
  kind: 'thread';
  accountId: string;
  remoteThreadId: string;
  complete?: boolean;
  remoteCount?: number | null;
}
export interface ThreadDeleteWrite {
  kind: 'threadDelete';
  accountId: string;
  remoteThreadId: string;
}

export interface WorkflowFields {
  status: 'new' | 'done' | 'later';
  laterUntil: number | null;
  dueDate: string | null;
  dueSource: 'user' | 'structured' | 'ai' | null;
  reminderAt: number | null;
  reminderFiredAt: number | null;
  bookmarked: boolean | null;
  replyStatus: string | null;
  todo: string | null;
  hiddenFromHome: boolean | null;
  lane: 'do' | 'update' | 'low';
  importance: 'important' | 'normal';
  rankSource: 'heuristic' | 'ai' | 'rule' | 'user';
  rankedAt: number | null;
  dueBand: 0 | 1 | 2 | 3;
  editedAt: number | null;
  editDevice: string | null;
  editGen: number | null;
}
/** Patch of a known thread's workflow row. An unknown thread fails the whole commit. */
export interface WorkflowWrite {
  kind: 'workflow';
  accountId: string;
  remoteThreadId: string;
  patch: Partial<WorkflowFields>;
}

/** The whole `sync_state` row for one scope, committed with the facts it covers (ARCH 4.2 rule 2). */
export interface SyncStateWrite {
  kind: 'syncState';
  accountId: string;
  scope: string;
  cursor?: string;
  pageToken?: string;
  phase?: string;
  oldestLoaded?: number;
  generation: number;
  pending?: string[];
}

/**
 * The bounded generation sweep (F3 `StepResult.scopeCovered`), committed in the same transaction as the step that
 * covered the scope. Removes the placements in `folder` with `seen_gen IS NOT NULL AND seen_gen < generation` whose
 * message is inside the bound: `since < internal_date < until` (exclusive, epoch ms; each absent = open) and
 * `uidFrom <= uid <= uidTo`. Messages are kept (they leave only that folder); fenced messages are skipped.
 */
export interface SweepWrite {
  kind: 'sweep';
  accountId: string;
  folder: string;
  generation: number;
  since?: number;
  until?: number;
  uidFrom?: number;
  uidTo?: number;
}

/** Engine-owned key/values (`import_state`, `imported_from`, `consent_version`). `null` deletes. Reserved keys refuse. */
export interface MetaWrite {
  kind: 'meta';
  key: string;
  value: string | null;
}

// ---------------------------------------------------------------- change log

export interface Change {
  seq: number;
  type: ChangeType;
  id: string;
  op: 'u' | 'd' | '*';
}
/** Contract type names. Open: later lanes add Draft, Submission, Calendar, Event. */
export type ChangeType = 'Account' | 'Folder' | 'Thread' | 'Message' | (string & {});

export type ChangesSince =
  | { status: 'ok'; fromSeq: number; toSeq: number; hasMore: boolean; changes: Change[] }
  /** The seq is below the compaction floor or not from this database: re-open windows from a snapshot. */
  | { status: 'cannotCalculateChanges'; floorSeq: number; seq: number };

// ---------------------------------------------------------------- errors

export type StoreErrorCode = 'notFound' | 'invalid';
export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}
