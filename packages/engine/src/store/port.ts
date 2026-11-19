import type { AccountStatus } from '@aplos/contract';
import type { LaneFor } from '../ports/content';
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
  /**
   * Trims the change log (ARCH 3.5): raises the floor to keep at most `maxRows` rows (50,000) and nothing older than
   * `maxAgeMs` (30 days, on the store's clock), whole commits only, in one transaction. The floor never moves down.
   */
  compact(options?: CompactOptions): CompactResult;
  /** A short synchronous read for views, the importer and diagnostics. Never return a promise or a live iterator. */
  read<T>(fn: (q: StoreReader) => T): T;
  close(): void;
}

export interface StoreReader {
  /** The codec the store was opened with, for reads that must undo what commits wrote (bodies). */
  readonly bodyCodec?: BodyCodec;
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

/**
 * Every write a commit can carry (FR-10). Two kinds of writer share one transaction:
 * - **Store kinds** (`CoreWrite`, applied by `commit.ts`) for the mailbox, calendar and provider-bookkeeping tables:
 *   facts from more than one lane (the provider actor commits them from `StepResult`, `eng-views` enqueues ops) or
 *   facts the store itself must interpret (rollups, pending-op replay, sweeps, the change log).
 * - **Lane kinds** (`ExtensionWrite`), applied by the owning lane's `CommitExtension` (seam 2) for the tables one lane
 *   owns: drafts, submissions and notifications (`eng-time`), jobs, consent, summaries, AI usage and Ask history
 *   (`eng-ai`), sender rules (`eng-views`), settings (`eng-contract`), clients and the audit log (`eng-host`). Their
 *   names are reserved in `LANE_WRITE_KINDS`; their shapes live in the lane's own file. `RemoteDraftWrite` is the one
 *   lane kind whose shape is frozen here, because the provider actor writes it and `eng-time` applies it.
 */
export type StoreWrite = CoreWrite | RemoteDraftWrite | ExtensionWrite;

export type CoreWrite =
  | AccountWrite
  | AccountRemoveWrite
  | FileRemovedWrite
  | FolderWrite
  | FolderDeleteWrite
  | MessageWrite
  | MessageDeleteWrite
  | PlacementsWrite
  | FlagsWrite
  | ThreadWrite
  | ThreadDeleteWrite
  | ThreadMergeWrite
  | WorkflowWrite
  | SyncStateWrite
  | SweepWrite
  | MetaWrite
  | OpWrite
  | OpSettleWrite
  | BodyWrite
  | AttachmentsWrite
  | AttachmentStateWrite
  | GovernorWrite
  | ProviderMemoryWrite
  | SyncFailureWrite
  | CalendarWrite
  | CalendarDeleteWrite
  | EventWrite
  | EventDeleteWrite
  | EventSweepWrite
  | EventHiddenWrite
  | FtsIndexWrite;

/**
 * Lane write kinds, added by declaration merging from the lane's own file, e.g. in `outbox/store.ts`:
 * `declare module '../store/port' { interface ExtensionWrites { submission: SubmissionWrite } }`. The key is the kind.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- filled by declaration merging from each lane's file
export interface ExtensionWrites {}
export type ExtensionWrite = ExtensionWrites[keyof ExtensionWrites];

export interface Address {
  address: string;
  name?: string;
}
/** One message's place in a folder. `uid` is the IMAP UID in that folder; absent elsewhere. */
export interface FolderRef {
  folder: string;
  uid?: number;
}
/**
 * Which messages a delta touches: one message, every non-draft message of a thread (thread-level actions), or the
 * message holding `uid` in `folder` (IMAP CONDSTORE `FETCH FLAGS` and `VANISHED` give only a UID).
 */
export type MessageTarget =
  { remoteId: string } | { remoteThreadId: string } | { folder: string; uid: number };

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
  /** Capability flags, plus string-valued facts such as `threading` (FR-35). */
  capabilities?: Record<string, boolean | string>;
  grantedScopes?: string[] | null;
  status?: AccountStatus;
  /** The copy key for the current status (F1 `AccountHealth.reasonCode`); `status.reason` stays the provider's own code. */
  reasonCode?: string | null;
  baselineDoneAt?: number | null;
  /**
   * When the account's calendar list was first committed, even an empty one (`Account.calendarListedAt`). First write
   * wins: a later value never moves it.
   */
  calendarListedAt?: number;
  tokenGrantedAt?: number | null;
  refreshExpiresAt?: number | null;
  remoteSubject?: string | null;
  oauthClient?: string | null;
  aiAllowed?: boolean;
  primaryLeaseUntil?: number | null;
  primaryLeaseDevice?: string | null;
  /** `Account.colorTag`: a colour token name, 1 to 40 characters on one line. `null` goes back to the hash colour. */
  colorTag?: string | null;
  /** `Account.notifications`, the per-account switch; a new account starts on. */
  notifications?: boolean;
  /**
   * `accounts.settings`: a plain JSON object (at most 16 KB serialized) of per-account preferences. A present value
   * replaces the whole object; absent keeps it.
   */
  settings?: Record<string, unknown>;
}

/**
 * Removes the account and everything it owns in one transaction (`Account/disconnect`): folders, threads, messages,
 * bodies, attachments, FTS rows, placements, workflow, ops, drafts, submissions, sync and governor state, correspondents,
 * calendars and events. Other accounts are untouched. Attachment files are queued in `file_removals` for the host
 * (`FileRemovedWrite` clears them). Refused with `notFound` for an unknown account and with `conflict` while one of its
 * submissions is `sending` or `uncertain`. Later writes of the same commit that name the account are refused with
 * `notFound`.
 */
export interface AccountRemoveWrite {
  kind: 'accountRemove';
  accountId: string;
}
/**
 * The host removed these attachment files after an `accountRemove`: drops their `file_removals` rows. No change row.
 * The host's drain of the queue must skip any path an `attachments` row still references (a reconnect re-downloads
 * into the same path; an `attachmentState` write that stores a path also takes it off the queue).
 */
export interface FileRemovedWrite {
  kind: 'fileRemoved';
  paths: string[];
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

/**
 * Upsert of one folder or label. A `uidValidity` that differs from the stored non-null one (IMAP `UIDVALIDITY` changed)
 * clears every `message_folders.uid` of the folder in the same transaction; the adapter's full resync then re-stamps
 * the UIDs and sweeps without UID bounds. Placements, flags and messages stay. `uidValidity` is a patch (R2G-1): absent
 * keeps the stored value (a folder list without STATUS), `null` clears it, and only a present, different value clears
 * the UIDs.
 */
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
  /**
   * `ListHeaders.authenticated`, stored as `messages.list_auth` (1, 0, NULL). Only the boolean `true` or `false` is
   * kept, and only with `listUnsubscribe`; anything else (absent, `'true'`, `1`, no `listUnsubscribe`) is stored as
   * NULL, unknown. Replaced on every message write, like `list_unsub`.
   */
  listAuthenticated?: boolean;
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

/**
 * Header threading (IMAP, F3 `StepResult.threadMerges`): a bridging message joins threads. Every message of each `from`
 * thread moves into `into`; emptied threads are deleted with their workflow, so `into`'s workflow wins. When `into` is
 * not stored yet, the first stored `from` thread is renamed to it and keeps its workflow.
 */
export interface ThreadMergeWrite {
  kind: 'threadMerge';
  accountId: string;
  from: string[];
  into: string;
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

/** Indexes these messages if they have no search index row yet (the start-up backlog pass, `fts.ts`). */
export interface FtsIndexWrite {
  kind: 'ftsIndex';
  ids: number[];
}

/** Engine-owned key/values (`import_state`, `imported_from`, `consent_version`). `null` deletes. Reserved keys refuse. */
export interface MetaWrite {
  kind: 'meta';
  key: string;
  value: string | null;
}

// ---------------------------------------------------------------- ops (ARCH 4.3)

/** A local edit an op carries, as the store applies it. Workflow edits are local truth already and need no replay. */
export type OpEffect =
  | { kind: 'placements'; target: MessageTarget; add: FolderRef[]; remove: string[] }
  | { kind: 'flags'; target: MessageTarget; seen?: boolean; flagged?: boolean; answered?: boolean };

/**
 * Enqueues a provider write (ARCH 4.3) and applies its local `effect` in the same commit, so the edit and its op cannot
 * part. While the op is `queued` or `inflight`, every `sync` commit re-applies `effect` to the messages that commit
 * touched (replay), so a page the provider produced before it saw the op cannot bring an archived thread back. Only
 * messages already stored when the op was enqueued are replayed over: a reply arriving later is provider truth.
 */
export interface OpWrite {
  kind: 'op';
  /** `ops.op_id`, the contract `OpId`. Re-enqueuing a known opId is refused. */
  opId: string;
  accountId: string;
  /** What the provider lane drains: `archive`, `label`, `flag`, `trash`, `draftSave`, ... (open). */
  opKind: string;
  /** Contract ids the op acts on, for the queue inspector and `Operation.targets`. */
  targets: string[];
  /** Provider-lane JSON, opaque to the store. */
  payload: string;
  /** The state before the edit, opaque JSON, for undo and conflict display. */
  base?: string;
  effect: OpEffect[];
  /**
   * The scope of the method that made the op (`ops.scope`, NOT NULL), which undo, retry and discard require again: the
   * contract's `Operation.scope` and `QueueItem.scope` are read from it (FR-3). Required, so the check fails closed: a
   * commit carrying an op without one is refused (R2H-2). Engine-internal ops name the scope of the method they serve.
   */
  scope: string;
}

/** Open op states. `synced` and `cancelled` are terminal: the row is deleted and replay stops. */
export type OpState = 'queued' | 'inflight' | 'failed' | 'conflict';
/**
 * Moves an op (`prov-gov` drains, `eng-views` undoes and retries). `failed` and `conflict` stop replay, so the next sync
 * commit shows provider truth ("the row returns to its place", DESIGN 5 rule 11) while the row stays for Retry.
 */
export interface OpSettleWrite {
  kind: 'opSettle';
  opId: string;
  state: OpState | 'synced' | 'cancelled';
  attempts?: number;
  nextAt?: number | null;
  /** A reason code, never provider text with content. */
  lastError?: string | null;
}

// ---------------------------------------------------------------- bodies and attachments (ARCH 3.3)

/** The provider-original body record, unsanitized; sanitized on every read. */
export interface BodyRecord {
  text?: string;
  html?: string;
  /** Content-ID → attachment `remotePart`. */
  cidMap?: Record<string, string>;
  /** UTF-16 offsets into `text` of quoted history. */
  quotedRanges?: { start: number; end: number }[];
}
/** Stores a message's body record (open, prefetch); clears the `evicted` bit and queues the message for re-indexing. */
export interface BodyWrite {
  kind: 'body';
  accountId: string;
  remoteId: string;
  body: BodyRecord;
}
/**
 * Synchronous compression, injected by the host (`node:zlib` cannot be imported here). `codec` is `bodies.codec`:
 * 0 raw, 1 zstd-3, 2 gzip. Without one the store writes codec 0.
 */
export interface BodyCodec {
  encode(data: Uint8Array): { codec: number; data: Uint8Array };
  decode(codec: number, data: Uint8Array): Uint8Array;
}

/**
 * The attachment files under `attachments/.noindex/` (ARCH 3.3), implemented by the host (`apps/desktop/src/host/files.ts`,
 * store-3; seam 4) because the neutral engine cannot import `node:fs`. Bytes never go in a row or over IPC. File I/O runs
 * outside `commit`: fetch, `write`, then commit `attachmentState` `present` with the returned path; evict by committing
 * `evicted` first, then `remove`. Paths are relative to the attachments folder and chosen by the host.
 */
export interface AttachmentFiles {
  /** Writes the bytes atomically (temp file, then rename) and returns the relative path. */
  write(accountId: string, remoteId: string, remotePart: string, data: Uint8Array): Promise<string>;
  /** Undefined when the file is gone (evicted, or removed behind the app's back). */
  read(path: string): Promise<Uint8Array | undefined>;
  /** Idempotent. */
  remove(path: string): Promise<void>;
  /** Bytes under the folder, for the retention cap (store-5). */
  usage(): Promise<number>;
}

export interface AttachmentFacts {
  /** Gmail attachmentId, IMAP section, Graph or JMAP blob id. */
  remotePart: string;
  name?: string;
  mime?: string;
  size?: number;
  cid?: string;
  inline: boolean;
}
/** A message's complete attachment list; parts no longer listed are removed, kept parts keep their file state. */
export interface AttachmentsWrite {
  kind: 'attachments';
  accountId: string;
  remoteId: string;
  list: AttachmentFacts[];
}
/** The file behind one attachment (`attachments/.noindex/`); bytes never go in a row. */
export interface AttachmentStateWrite {
  kind: 'attachmentState';
  accountId: string;
  remoteId: string;
  remotePart: string;
  state: 'absent' | 'fetching' | 'present' | 'evicted';
  /** Relative to the attachments folder; `null` clears it. */
  path?: string | null;
}

// ---------------------------------------------------------------- provider bookkeeping (prov-gov, prov-*)

export interface GovernorFields {
  target: number | null;
  cooldownUntil: number | null;
  reason: string | null;
  dailyBlockUntil: number | null;
  cooldownStep: number;
  lastRefusalAt: number | null;
  cls: string | null;
  inFlightLimit: number | null;
  batchSize: number | null;
  windowSpent: number | null;
  windowAt: number | null;
  sendBlockedUntil: number | null;
  blockedCls: string | null;
  blockedSince: number | null;
}
/** Patch of one budget's persisted governor state; `accountId` `'*'` is project-wide. No change row. */
export interface GovernorWrite {
  kind: 'governor';
  accountId: string;
  budget: string;
  patch: Partial<GovernorFields>;
}
/** `provider_memory` (F3 `StepResult.memory`); `null` deletes a key. No change row. */
export interface ProviderMemoryWrite {
  kind: 'providerMemory';
  accountId: string;
  values: Record<string, string | null>;
}
/** A quarantined poison item (F3 `StepResult.quarantine`), or `failure: null` once it synced. No change row. */
export interface SyncFailureWrite {
  kind: 'syncFailure';
  accountId: string;
  item: string;
  failure: { attempts: number; nextRetryAt: number; lastReason?: string } | null;
}

// ---------------------------------------------------------------- calendars (prov-cal)

/** Upsert of one calendar (F3 `CalendarFacts`). `selected` absent keeps the stored choice. */
export interface CalendarWrite {
  kind: 'calendar';
  accountId: string;
  remoteId: string;
  name: string;
  color?: string;
  primary?: boolean;
  hidden: boolean;
  selected?: boolean;
  readOnly: boolean;
  timeZone?: string;
  changeTag?: string;
}
/** The calendar is gone at the server; its events go with it. */
export interface CalendarDeleteWrite {
  kind: 'calendarDelete';
  accountId: string;
  remoteId: string;
}
/** One stored row of an event resource: a master, an override (`recurrenceId` set) or a single event. */
export interface EventRow {
  /**
   * The original start of an override (`events.recurrence_id`) in the canonical `RECURRENCE_ID_FORMAT` form of
   * `ports/calendar.ts`: UTC `YYYYMMDDTHHMMSSZ`, `YYYYMMDD` all-day, `YYYYMMDDTHHMMSS` floating. Absent (or '') for
   * masters and single events. Any other form is refused (FR-20), so one occurrence never gets two rows.
   */
  recurrenceId?: string;
  masterRemoteId?: string;
  status: 'confirmed' | 'tentative' | 'cancelled' | (string & {});
  etag?: string;
  /** Masters only. */
  recurrence?: { rrule?: string[]; rdate?: string[]; exdate?: string[] };
  startUtc?: number;
  endUtc?: number;
  allDay: boolean;
  /** As F3 `EventFacts.raw` maps them: provider JSON in `data`, CalDAV ICS in `ics`. */
  data: string;
  ics?: string;
}
/**
 * One event resource's full row set (F3 `CalendarStepResult.upserts` grouped by `remoteId`): stored rows of that
 * resource not in `rows` are deleted. `seenGen` stamps every row for the resync sweep.
 */
export interface EventWrite {
  kind: 'event';
  accountId: string;
  calendarRemoteId: string;
  remoteId: string;
  rows: EventRow[];
  seenGen?: number;
}
/** Removes every row of the resource (master and overrides). Idempotent. */
export interface EventDeleteWrite {
  kind: 'eventDelete';
  accountId: string;
  calendarRemoteId: string;
  remoteId: string;
}
/**
 * The calendar resync sweep (F3 `CalendarStepResult.scopeCovered`): removes rows with `seen_gen IS NOT NULL AND
 * seen_gen < generation`, inside `from <= start_utc < to` when set.
 */
export interface EventSweepWrite {
  kind: 'eventSweep';
  accountId: string;
  calendarRemoteId: string;
  generation: number;
  from?: number;
  to?: number;
}

/**
 * Event/hide (R2G-4): hides an event in Aplos only, or shows it again; never sent to the provider. Stored in
 * `event_hidden`, apart from `events`, because an unedited occurrence has no `events` row and a provider refresh rewrites
 * the rows it does have. No `recurrenceId` hides the whole resource (a single event, or a series with every occurrence);
 * a canonical `recurrenceId` hides that one occurrence, with or without an override row. The resource must be stored.
 * Writes the resource's `Event` change row. Deleting the resource or its calendar drops its hidden rows.
 */
export interface EventHiddenWrite {
  kind: 'eventHidden';
  accountId: string;
  calendarRemoteId: string;
  remoteId: string;
  recurrenceId?: string;
  hidden: boolean;
}

// ---------------------------------------------------------------- lane kinds

/**
 * A draft another device or the provider's own app changed (F3 `RemoteDraftFact`, D9). The provider actor writes it;
 * `eng-time`'s extension applies it to `drafts` (and its "keep mine or take theirs" state). A commit carrying one with
 * no extension registered for it fails.
 */
export interface RemoteDraftWrite {
  kind: 'remoteDraft';
  accountId: string;
  remoteDraftId: string;
  remoteMessageId: string;
  remoteThreadId?: string;
  internetId?: string;
  changedAt: number;
  removed?: boolean;
  /** Metadata so a phone draft can show in Drafts; the body is fetched lazily. */
  message?: Omit<MessageWrite, 'kind' | 'accountId'>;
  /**
   * The draft's body as the provider delivered it (`RemoteDraftFact.html`/`text`). Preferred over `message.html`: when
   * present the draft is complete (editable in place, usable by take theirs and keep both). `html` wins over `text`.
   * Absent: snippet-only, as before.
   */
  html?: string;
  text?: string;
  /**
   * Remote message ids this fact replaces (`RemoteDraftFact.supersedes`). When they include the id the draft row holds
   * (or one it wrote) and `internetId` is its own upload's, the fact is the echo of that upload and advances the row's
   * message id; when `internetId` is not its own, it is another device's edit of our base.
   */
  supersedes?: string[];
}

/**
 * Reserved lane kinds and their owners. An extension may register only the kinds reserved for its lane, or new kinds
 * no one holds (additive); a store kind is never claimable.
 */
export const LANE_WRITE_KINDS = {
  remoteDraft: 'eng-time',
  draft: 'eng-time',
  draftDelete: 'eng-time',
  submission: 'eng-time',
  notification: 'eng-time',
  job: 'eng-ai',
  consent: 'eng-ai',
  summary: 'eng-ai',
  plan: 'eng-ai',
  aiUsage: 'eng-ai',
  conversation: 'eng-ai',
  senderRule: 'eng-views',
  settings: 'eng-contract',
  client: 'eng-host',
  audit: 'eng-host',
} as const satisfies Record<string, string>;

/**
 * What an extension sees inside the commit transaction. There is no way to start, commit or nest a transaction, and no
 * reference outlives `apply`: every row it writes lands, or rolls back, with the rest of the commit.
 */
export interface CommitExtensionTx {
  readonly origin: CommitOrigin;
  readonly step?: SyncStepOrigin;
  /** The seq this commit lands at once it writes any change row (rev stamps). */
  readonly seq: number;
  now(): number;
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number };
  get<R extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): R | undefined;
  all<R extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): R[];
  /** Records a change row; only for the extension's own `changeTypes`. `id` is the contract id. */
  mark(type: ChangeType, id: string, op: 'u' | 'd'): void;
  /** Internal rowids for foreign keys to messages and threads; never put them on the wire. */
  messageRowId(accountId: string, remoteId: string): number | undefined;
  threadRowId(accountId: string, remoteThreadId: string): number | undefined;
  /** A lane table that is part of a store type changed (a summary on the Thread row): bumps rev, writes its change row. */
  touchThread(accountId: string, remoteThreadId: string): void;
  touchMessage(accountId: string, remoteId: string): void;
}

/** Seam 2 (phase 1 plan section 2): a lane's writer for its own tables, run inside `store.commit`. */
export interface CommitExtension {
  /** The owning lane (`eng-time`, ...), checked against `LANE_WRITE_KINDS`. */
  lane: string;
  kinds: readonly string[];
  /** Change types this extension may write (`Draft`, `Submission`, ...); any other `mark` fails the commit. */
  changeTypes: readonly ChangeType[];
  apply(write: { kind: string }, tx: CommitExtensionTx): void;
  /**
   * The ingest hook point (seam 2): runs once per commit that wrote a `message`, after the writes, op replay, rollups
   * and the store's own ingest (correspondents, `laneFor`), inside the same transaction and with the same `tx` rules.
   * `eng-time`'s notification outbox (time-5) writes `notifications` rows here; the store never decides what notifies.
   */
  ingest?(batch: IngestBatch, tx: CommitExtensionTx): void;
}

// ---------------------------------------------------------------- ingest (seam 2)

/** One message a `message` write stored in this commit, as ingest hooks see it after rollups. */
export interface IngestedMessage {
  accountId: string;
  remoteId: string;
  remoteThreadId: string;
  /** `messages.id`, only for a lane table's foreign key (`notifications.message_id`); never on the wire. */
  rowId: number;
  /** First stored by this commit; false when the write updated a known row. */
  added: boolean;
  /** `sync`, `search` (a server-search hit) or `local`. */
  origin: 'sync' | 'search' | 'local';
  internalDate: number;
  flags: MessageFlags;
  /** The message's folders (remote ids) and their roles, as stored after the commit. */
  folders: string[];
  roles: FolderRole[];
}

export interface IngestBatch {
  origin: CommitOrigin;
  step?: SyncStepOrigin;
  /** Messages a `message` write stored, still present at the end of the commit; rowid (date) order. */
  messages: readonly IngestedMessage[];
}

/**
 * What the store runs at ingest besides the lanes' `CommitExtension.ingest` (given to `openStore`):
 * - `laneFor` (`eng-ai`, `ai/lanes.ts`) runs for every thread that gained or changed a message, or got a body, in the
 *   commit. Its result is stored with `rank_source='heuristic'` and only over a heuristic rank: `ai`, `rule` and `user`
 *   are never overridden. Its `due` is stored with `due_source='structured'` unless the user or the AI set a date.
 *   Without one, threads keep the schema defaults until `eng-ai` re-ranks them.
 * Correspondents are not a hook: the store counts them itself in every commit (`correspondents.ts`).
 */
export interface IngestHooks {
  laneFor?: LaneFor;
}

// ---------------------------------------------------------------- change log

export interface Change {
  seq: number;
  type: ChangeType;
  id: string;
  op: 'u' | 'd' | '*';
}
/** Contract type names. The store writes Account, Folder, Thread, Message, Calendar and Event; extensions add theirs. */
export type ChangeType =
  'Account' | 'Folder' | 'Thread' | 'Message' | 'Calendar' | 'Event' | (string & {});

export type ChangesSince =
  | { status: 'ok'; fromSeq: number; toSeq: number; hasMore: boolean; changes: Change[] }
  /** The seq is below the compaction floor or not from this database: re-open windows from a snapshot. */
  | { status: 'cannotCalculateChanges'; floorSeq: number; seq: number };

export interface CompactOptions {
  /** Change rows to keep at most; defaults to 50,000. */
  maxRows?: number;
  /** Commits older than this are dropped from the log; defaults to 30 days. */
  maxAgeMs?: number;
}
export interface CompactResult {
  /** The floor after compaction: `changesSince` below it returns `cannotCalculateChanges`. */
  floorSeq: number;
  /** `changes` rows deleted. */
  deleted: number;
}

// ---------------------------------------------------------------- errors

/** `conflict`: the store's state refuses the write (an account with a message sending cannot be removed). */
export type StoreErrorCode = 'notFound' | 'invalid' | 'conflict';
export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
  ) {
    super(message);
  }
}
