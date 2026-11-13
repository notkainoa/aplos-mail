import type { ClassifiedError } from '@aplos/contract';
import type { Logger } from '../diag/log';
import type { FolderRole } from '../store/port';
import type { AccountId, ProviderKind, SyncLane } from './base';
import type { CalendarAdapter } from './calendar';
import type { BoundGovernor, BudgetSpec } from './governor';
import type { Clock } from './time';

// The provider adapter port (plan 20 section 3.2, the Providers proposal sections 2-3). Adapters live in
// `apps/desktop/src/host/providers/<name>/`; the neutral account actors (`packages/engine/src/sync/`) reach them only
// through these types. Adapters never retry, never pace, never write the store: every call goes through
// `ctx.governor.run`, and results come back as facts the actor commits in one `store.commit` with their resume tokens.

// ---- facts adapters return ----

export interface Address {
  address: string;
  name?: string;
}

/** One message's place in a folder or label. `uid` is IMAP's per-folder UID (`message_folders.uid`); absent elsewhere. */
export interface Placement {
  folder: string;
  uid?: number;
}

/** The list and automation headers of ARCH 5.1's field mask, verbatim, for `laneFor` and `Unsubscribe/run`. */
export interface ListHeaders {
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
  listId?: string;
  precedence?: string;
  autoSubmitted?: string;
  /**
   * RFC 8058 section 4's precondition for one-click. `true` only when the provider verified a signature on this message
   * that covers both List-Unsubscribe and List-Unsubscribe-Post and aligns with the From domain: a passing DKIM
   * signature whose `h=` lists both headers and whose `d=` aligns with the From domain as DMARC defines it (RFC 7489
   * section 3.1.1: the same domain, or relaxed, the same organizational domain), or an equivalent
   * verdict (a passing ARC chain whose first seal vouches for such a DKIM result, or the provider's own verdict that
   * says exactly that). `true` is allowed ONLY when the From header holds exactly one mailbox and that mailbox's domain
   * is the domain the alignment was computed on: the engine compares From domains from the stored first From address
   * (`methods/unsubscribe.ts`), which must be the very address the verdict covers. A provider that cannot guarantee this
   * (several From mailboxes, an unparseable From) must leave it absent. `false` means the provider checked and it did not hold. Absent means unknown. Absent, `false`
   * and any value that is not the boolean `true` (a string `'true'`, `1`) are all treated as not authenticated: the
   * engine then never offers or performs the one-click POST for this message and never prefers it as a thread's
   * unsubscribe target (`methods/unsubscribe.ts`). It is stored with the message (`messages.list_auth`), so the
   * value a later write omits goes back to unknown.
   */
  authenticated?: boolean;
}

export interface MessageFlags {
  seen: boolean;
  flagged: boolean;
  answered?: boolean;
  draft: boolean;
  fromMe: boolean;
}

export interface AttachmentFacts {
  /** Provider part id: Gmail attachmentId, IMAP body section, JMAP blobId, Graph attachment id. */
  part: string;
  name?: string;
  mime?: string;
  size?: number;
  cid?: string;
  inline: boolean;
}

/**
 * One message as metadata (ARCH 5.1 P1: From, To, Cc, Subject, Date, Message-ID, List-Unsubscribe, Precedence,
 * Auto-Submitted, plus Reply-To, In-Reply-To and References for threading).
 */
export interface MessageFacts {
  /** Gmail message id; IMAP EMAILID or a stable hash; JMAP Email id; Graph immutable id. */
  remoteId: string;
  /** Gmail threadId; JMAP threadId; Graph conversationId; IMAP THREADID or the header root. */
  remoteThreadId: string;
  internetId?: string;
  inReplyTo?: string;
  references?: string[];
  from?: Address;
  to: Address[];
  cc: Address[];
  /**
   * Only when the provider can show a draft's Bcc (a sent or received message carries none). The engine takes a remote
   * draft copy as its own upload only when it can compare Bcc too: absent here means "cannot show", never "empty".
   */
  bcc?: Address[];
  replyTo?: Address[];
  subject?: string;
  /** Entity-decoded (D22). */
  snippet?: string;
  date: number;
  internalDate: number;
  size?: number;
  flags: MessageFlags;
  /**
   * Every folder or label the message is in, by remote id. Gmail: `labelIds` minus UNREAD and STARRED (those are
   * flags) and DRAFT (a flag); CATEGORY_* and IMPORTANT stay, with folder roles that say what they mean.
   */
  placements: Placement[];
  /**
   * Default true: `placements` is the message's complete folder set and replaces the stored one (`MessageWrite.folders`).
   * False when the step saw one folder only (IMAP and Graph per-folder steps): the actor writes `PlacementsWrite` adds
   * instead, so the message's other placements stay.
   */
  placementsComplete?: boolean;
  list: ListHeaders;
  /** Metadata only: the row surfaces as `partial: true` until the thread is opened. */
  partial: boolean;
  /**
   * Messages in the thread as the server counts them, when the call returned it (Gmail `threads.get` metadata). Stored as
   * `threads.remote_count` (`ThreadWrite.remoteCount`); it is what `openThread`'s `knownCount` passes (AM-1).
   */
  threadSize?: number;
  attachments?: AttachmentFacts[];
}

/** Gmail history label changes, applied at zero fetch cost (D13). Folder ids. */
export interface LabelDelta {
  remoteId: string;
  add: string[];
  remove: string[];
}

/** Identified by `remoteId`, or by `folder` + `uid` when the server gave only a UID (IMAP CONDSTORE `FETCH FLAGS`). */
export interface FlagDelta {
  remoteId?: string;
  folder?: string;
  uid?: number;
  seen?: boolean;
  flagged?: boolean;
  answered?: boolean;
}

/**
 * A message entering or leaving one folder: IMAP arrivals and `VANISHED`, JMAP `mailboxIds`, Graph per-folder delta
 * (`@removed` is a placement removal, never a deletion). Identified as `FlagDelta` is.
 */
export interface PlacementDelta {
  remoteId?: string;
  folder: string;
  uid?: number;
  present: boolean;
}

/** A deletion the server stated (Gmail `messagesDeleted`, JMAP `destroyed`). Inferred removals only come from a sweep. */
export interface Removal {
  remoteId: string;
}

/** Defined beside `folders.role` (`store/port.ts`); the `category.*` roles are Gmail's tabs, read by `laneFor`. */
export type { FolderRole };

export interface FolderFacts {
  remoteId: string;
  name: string;
  role?: FolderRole;
  kind: 'label' | 'folder' | 'system';
  hidden?: boolean;
  uidValidity?: number;
  /** The folder is gone at the server. */
  removed?: boolean;
}

/** A draft another device or the provider's own app changed (D9): drafts never become thread rows. */
export interface RemoteDraftFact {
  remoteDraftId: string;
  remoteMessageId: string;
  remoteThreadId?: string;
  internetId?: string;
  changedAt: number;
  removed?: boolean;
  /** Metadata so a phone draft can show in Drafts; the body is fetched lazily. */
  message?: MessageFacts;
  /**
   * The draft's body as the provider delivered it. Optional: when present the engine treats the draft as complete (it can
   * be edited, taken as theirs or kept both); when absent the draft is snippet-only until a fact with a body arrives.
   * `html` is preferred; `text` is used when there is no `html`.
   */
  html?: string;
  text?: string;
  /**
   * Remote message ids this fact replaces: a provider that updates a draft by creating a new message and destroying the
   * old one (JMAP, IMAP; Gmail `drafts.update` gives the draft a new message id). The engine recognises the fact as the
   * echo of its own upload when it supersedes the id it holds and carries its Message-ID, and as another device's edit
   * when it supersedes its base but carries another Message-ID.
   */
  supersedes?: string[];
}

// ---- scopes, state and planning ----

/** `sync_state.scope`. `provider:*` is an escape hatch for a provider-private scope that needs no engine semantics. */
export type ScopeId =
  | 'history'
  | 'window:inbox'
  | 'backfill:inbox'
  | 'sent:recent'
  | 'prefetch'
  | 'workflow'
  | 'calendars'
  | `folder:${string}`
  | `cal:${string}`
  | `provider:${string}`;

/** One `sync_state` row. */
export interface SyncState {
  scope: ScopeId;
  cursor?: string;
  pageToken?: string;
  phase?: string;
  oldestLoaded?: number;
  /**
   * The round this state belongs to, for the bounded sweep. Every scope of every account draws it from one monotonic
   * source, the store's `seq()` when the round's first step starts (`AdapterContext.generation`), so a later round of
   * any scope always has a higher generation than every placement an earlier round stamped. A step that starts a round
   * (no `pageToken`) writes `ctx.generation`; later pages keep the state's value. Never a per-scope counter.
   */
  generation: number;
  updatedAt: number;
  /** Remote ids fetched-but-refused or still to fetch in this step, at most 500: what a paused step resumes with. */
  pending?: string[];
}

/** Cadence inputs: Gmail polls every 15 s focused, 60 s with no window, 5 min on battery with no window (ARCH 5.1). */
export interface PlanEnv {
  now: number;
  focused: boolean;
  windowVisible: boolean;
  onBattery: boolean;
}

export type PlanTrigger = 'first' | 'poll' | 'push' | 'wake' | 'manual' | 'resume' | 'reset';

/**
 * How the store treats a step's facts. Notifications and background AI only for `incremental` after the baseline;
 * one coarse `*` change per `backfill` page; `resync` may be followed by a sweep.
 */
export type StepOrigin =
  'baseline' | 'incremental' | 'backfill' | 'resync' | 'prefetch' | 'workflow';

export interface PlannedStep {
  scope: ScopeId;
  lane: SyncLane;
  origin: StepOrigin;
  /** Epoch ms; the actor registers its earliest `notBefore` as its deadline (`sync:<account>`). */
  notBefore?: number;
  trigger: PlanTrigger;
}

export interface PlanInput {
  account: AdapterAccount;
  states: SyncState[];
  trigger: PlanTrigger;
  env: PlanEnv;
  memory: ReadonlyMap<string, string>;
}

/**
 * Bounds a generation sweep (store `SweepWrite`): it removes placements in `folder` with `seen_gen IS NOT NULL AND
 * seen_gen < generation` inside this range. A NULL `seen_gen` (written by history, open or search) is kept.
 * `since`/`until` are exclusive internal-date bounds, epoch ms, set to the oldest and newest message the round listed
 * (absent `until` for a round that started at the top of the folder); `uidFrom`/`uidTo` are inclusive.
 */
export interface SweepBound {
  folder: string;
  since?: number;
  until?: number;
  uidFrom?: number;
  uidTo?: number;
}

export type ResetReason =
  | 'cursorExpired'
  | 'uidValidityChanged'
  | 'syncTokenInvalid'
  | 'cannotCalculateChanges'
  | 'changeCapExceeded'
  | 'windowRolled';

export interface Quarantine {
  item: string;
  error: ClassifiedError;
}

/** The failures a step really clears: `clearedFailures` minus every item the same step quarantines (quarantine wins). */
export function effectiveClearedFailures(
  step: Pick<StepResult, 'clearedFailures' | 'quarantine'>,
): string[] {
  const quarantined = new Set((step.quarantine ?? []).map(q => q.item));
  return (step.clearedFailures ?? []).filter(item => !quarantined.has(item));
}

/** Everything one bounded step learned, committed by the actor in one transaction with every `nextStates` row. */
export interface StepResult {
  upserts?: MessageFacts[];
  labelDeltas?: LabelDelta[];
  flagDeltas?: FlagDelta[];
  placements?: PlacementDelta[];
  removals?: Removal[];
  folders?: FolderFacts[];
  drafts?: RemoteDraftFact[];
  /** IMAP header threading: a bridging message joins threads. */
  threadMerges?: { from: string[]; into: string }[];
  /** Every scope this step moves (e.g. finish `window:inbox` and seed `backfill:inbox`). */
  nextStates: SyncState[];
  /** False when a pause cut the step short: the partial facts commit and `pending` holds the rest. */
  done: boolean;
  /**
   * Set only when the scope's round listed everything inside `bound`; never on a partial answer (`MESSAGELIMIT`, a
   * limited-mode host). Every id the round listed inside the bound must have come back stamped, as an upsert or as a
   * `PlacementDelta { present: true }` for `bound.folder`, fetched or not: the Gmail window returns one for every id
   * `messages.list` gave, so older Inbox messages of a thread whose newest message alone was fetched are not swept.
   * The actor commits it as a store `sweep` write in the same transaction as this step.
   */
  scopeCovered?: { scope: ScopeId; generation: number; bound: SweepBound };
  /** Informational (log and reason code); the next `plan()` emits the resync steps. */
  reset?: ResetReason;
  /** The first window (newest ~50 Inbox threads) is committed: set `baseline_done_at` (AM-4). */
  baselineReached?: boolean;
  /** `found` feeds `AccountRuntime.firstWindow.found` when the provider estimates it. */
  progress?: { read: number; total?: number; found?: number };
  /** `provider_memory` writes; null deletes. */
  memory?: Record<string, string | null>;
  quarantine?: Quarantine[];
  /**
   * Clears the `sync_failures` rows of items that synced after a retry (`item` as in `Quarantine.item`). The store write is
   * `SyncFailureWrite { failure: null }`; an item named here and in `quarantine` stays quarantined. The rule is
   * `effectiveClearedFailures`; the fact writer must call it rather than reading this field directly.
   */
  clearedFailures?: string[];
  costUnits: number;
}

// ---- context ----

export interface Capabilities {
  labels: boolean;
  folders: boolean;
  drafts: boolean;
  serverSearch: boolean;
  calendar: boolean;
  filters: boolean;
  push: boolean;
  sendAs: boolean;
  unsubscribeHeaders: boolean;
  /** The host has an importance marker Aplos can set (Gmail IMPORTANT); F1 `AccountCapabilities.importance`. */
  importance?: boolean;
  threading: 'native' | 'headers';
  /** The host may show partial folders (Yahoo limited mode): the actor ignores `scopeCovered` there. */
  partialView?: boolean;
}

export interface AdapterAccount {
  id: AccountId;
  provider: ProviderKind;
  address: string;
  grantedScopes: string[];
  capabilities: Capabilities;
}

/** Read-only store views an adapter may consult. Implemented by `eng-store` over `StorePort`; never writes. */
export interface KnownLookup {
  /** The INBOX-gain rule (D3): which of these threads this device already has. */
  knownThreads(remoteThreadIds: string[]): Promise<ReadonlySet<string>>;
  knownMessages(remoteIds: string[]): Promise<ReadonlySet<string>>;
  /** Drafts are recognised by draft id, not message id (D9). */
  trackedDraftIds(remoteDraftIds: string[]): Promise<ReadonlySet<string>>;
  /**
   * Remote message id to remote draft id, for the copies this device wrote (`drafts.remote_message_id`). A Gmail DRAFT
   * history record carries only a message id: one found here is Aplos's own save; one absent from it, on a tracked
   * draft, is an edit made elsewhere (ARCH 7.4).
   */
  draftsByMessageId(remoteMessageIds: string[]): Promise<ReadonlyMap<string, string>>;
  threadMessages(remoteThreadId: string): Promise<{ remoteId: string; placements: Placement[] }[]>;
  /** Current placements, for ops on placement providers (IMAP `UID MOVE` needs the source UID). */
  placements(remoteIds: string[]): Promise<ReadonlyMap<string, Placement[]>>;
  /** IMAP bounded expunge check: the UIDs this device holds in a range. */
  folderUids(folder: string, uidFrom: number, uidTo: number): Promise<number[]>;
  /** CalDAV resync keeping unchanged ETags. */
  eventEtags(calendarRemoteId: string, remoteIds: string[]): Promise<ReadonlyMap<string, string>>;
}

/** Built by the actor for each call. */
export interface AdapterContext {
  account: AdapterAccount;
  /** The only way to reach the network. */
  governor: BoundGovernor;
  clock: Clock;
  /** F7 catalog ids only; never content. */
  log: Logger;
  /** Aborted by actor stop and `close()` only; pauses arrive through the per-request `RequestIo.signal`. */
  signal: AbortSignal;
  lookup: KnownLookup;
  /** `provider_memory` as committed; a step's writes go in `StepResult.memory`. */
  memory: ReadonlyMap<string, string>;
  /** The store's `seq()` when this call started: the generation a step that starts a new round writes (`SyncState.generation`). */
  generation: number;
}

// ---- connect ----

export interface HostPort {
  host: string;
  port: number;
  security: 'tls' | 'starttls';
}

export interface ConnectRequest {
  mode: 'new' | 'reconnect' | 'grantPermissions';
  /** Reconnect: preselects the same Google account (`prompt=select_account`, never forced consent, D21). */
  loginHint?: string;
  /** Reconnect: the identity's `sub`; a different one is refused (`auth`, reason `wrongAccount`, D25). */
  expectedSubject?: string;
  address?: string;
  /**
   * `grantPermissions` only: the one explicit opt-in to a permission beyond reading (`Account/grantPermissions`
   * `enable`). `calendarWrite` adds Google's `calendar.events` scope to that sign-in and nothing else. A flow never
   * asks for it otherwise, and `new` and `reconnect` ignore it, so editing access can only come from this one tap.
   */
  enable?: 'calendarWrite';
  preset?: 'gmail' | 'outlook' | 'icloud' | 'fastmail' | 'yahoo' | 'generic';
  server?: { imap?: HostPort; smtp?: HostPort; jmapSession?: string; caldav?: string };
  /**
   * Vault reference of an app password or API token; never the secret. A `reconnect` of an app-password or API-token
   * account (iCloud, generic IMAP, Fastmail) carries the NEW secret's reference, stored by the host before the call.
   * A reconnect stages under a FRESH ref, never the one its account already uses (not `refFor(accountId)`): the engine
   * never discards for an account with a committed row (`AccountActorHost.discardCredential`), so a late or refused
   * attempt cannot delete a live credential, and the host removes the superseded ref after the engine commits the new one.
   */
  secretRef?: string;
  /** A second secret for the calendar half when the provider needs one (Fastmail: an API token for JMAP, an app password for CalDAV). */
  calendarSecretRef?: string;
  /**
   * `Account/cancelConnect` aborts this: the host stops its browser or loopback flow and `connect` rejects (the host's
   * `ConnectContext.signal` follows it), so a cancelled attempt never lingers and a reconnect cannot start a parallel
   * flow. A host must store nothing after the signal aborts. A result that still arrives after the abort is discarded
   * by the engine for a first-time connect (`AccountActorHost.discardCredential`; an existing account's credential is
   * kept) and `connect` rejects with the abort reason.
   */
  signal?: AbortSignal;
}

/**
 * The engine assigns the account id before connecting, so connect-time calls are governed like any other, except that
 * `governor` ignores the account's `auth` block (a reconnect is how it ends) while honouring cooldowns, daily stops and
 * `config` blocks.
 */
export interface ConnectContext {
  accountId: AccountId;
  governor: BoundGovernor;
  clock: Clock;
  log: Logger;
  signal: AbortSignal;
}

export interface ConnectResult {
  /** Google: from the `id_token`, so connect and reconnect make no Gmail call and work during a Gmail daily stop. */
  identity: { subject: string; address: string; displayName?: string };
  /** The token response's `scope` (D5). Connect refuses without the core mail scope: `permission`, reason `missingRequiredScope`. */
  grantedScopes: string[];
  capabilities: Capabilities;
  /**
   * OAuth only. `refreshExpiresAt` is the earliest the refresh token stops working: min(grant + 7 days for a Google client
   * in Testing mode, `refresh_token_expires_in` when sent), folded in by the host's OAuth config. It becomes `reconnectBy`.
   * `client` is the OAuth client id the grant belongs to (`accounts.oauth_client`, D21).
   */
  grant?: { grantedAt: number; refreshExpiresAt?: number; client?: string };
  /**
   * Vault reference of the stored token bundle (refresh token + client id, D21) or of the app password. A reconnect
   * returns a fresh ref, not the account's current one (see `ConnectRequest.secretRef`).
   */
  credentialRef: string;
  /** Initial `provider_memory`: limits learned at connect (JMAP session, IMAP host table), capabilities detail. */
  memory?: Record<string, string>;
}

// ---- open, attachments, search, push ----

export interface ThreadOpenRef {
  remoteThreadId: string;
  /** AM-1: `messages.get` full (60) only when exactly 1 is known; otherwise `threads.get` full (120). */
  knownCount?: number;
}

/** The provider-original body record (ARCH 3.3), unsanitized; `cidMap` is Content-ID to attachment `part`. */
export interface ProviderBody {
  text?: string;
  html?: string;
  cidMap: Record<string, string>;
}

export interface OpenedThread {
  messages: (MessageFacts & { body: ProviderBody })[];
  /** Locally known messages the thread no longer has. */
  removed?: string[];
  costUnits: number;
}

export interface AttachmentRef {
  remoteMessageId: string;
  part: string;
}

export interface ServerSearch {
  text: string;
  folder?: string;
  limit: number;
  pageToken?: string;
}
/** Ranked; the store keeps the rows with `origin='search'`. */
export interface SearchResult {
  upserts: MessageFacts[];
  remoteThreadIds: string[];
  nextPageToken?: string;
  /** True when the provider could only return part of the matches (a cap, a timeout, a limited-mode host). */
  partial?: boolean;
  costUnits: number;
}

/** One page of a `lazy` folder's listing (`ProviderAdapter.listFolder`); committed as `origin='sync'`. */
export interface FolderList {
  upserts: MessageFacts[];
  /** Present while the folder has more to list: the next open continues from here; absent re-reads the head. */
  nextPageToken?: string;
}

/** Data-free push hint (ARCH 4.2 rule 8): it only triggers the normal checkpointed pull. */
export type Hint = { kind: 'changed'; scope?: ScopeId } | { kind: 'alive' };

// ---- ops ----

/**
 * One local change to one message, as `Thread/act` recorded it in `ops` and the store replays it (ARCH 4.3).
 * `folders` covers labels and moves alike: Gmail archive is remove INBOX; an IMAP move is add B, remove A.
 */
export type OpChange =
  | { kind: 'folders'; add: string[]; remove: string[] }
  | { kind: 'flags'; seen?: boolean; flagged?: boolean; answered?: boolean }
  | { kind: 'trash' }
  | { kind: 'untrash' };

export interface PendingOp {
  opId: string;
  seq: number;
  remoteId: string;
  change: OpChange;
}

/** One provider call covering several ops (Gmail: identical add/remove sets, one `batchModify` per 1,000 ids). `body` is the adapter's own. */
export interface CoalescedOp {
  opIds: string[];
  method: string;
  cost: number;
  body: unknown;
}

export interface OpOutcome {
  opId: string;
  /**
   * `notFound` drops the op (ARCH 4.3); `failed` holds back that account's later ops. A `write` whose reply was lost is
   * `failed` with `error.uncertain: true`: never re-sent, the actor holds the op until the next incremental pass shows
   * whether it landed (then drops it, or applies it again).
   */
  result: 'applied' | 'notFound' | 'failed';
  error?: ClassifiedError;
  /** IMAP `UID MOVE` / COPYUID: the message's new placements. */
  placements?: PlacementDelta[];
}

// ---- drafts and sends (adapter side; the engine calls them through DraftSyncPort and SendPort) ----

export interface DraftUpload {
  draftId: string;
  revision: number;
  /** Content fingerprint; the engine skips an upload when it matches the last synced one. */
  fingerprint: string;
  /** Per-revision Message-ID: IMAP deletes the previous copy by it without UIDPLUS, and an uncertain create is recognised by it. */
  internetId: string;
  mime: Uint8Array;
  remoteDraftId?: string;
  remoteThreadId?: string;
  /**
   * The remote message id of the copy this device last synced (`drafts.remote_message_id`). The adapter checks it
   * before replacing the copy (Gmail `drafts.get` message id, IMAP and JMAP the current id); a different one is
   * `conflict`, so a 5 s idle save never overwrites a phone edit that history has not reported yet.
   */
  baseRemoteMessageId?: string;
  /**
   * Only on a create (no `remoteDraftId`): the Message-IDs of this draft's earlier creates that were never answered (a
   * newer revision replaced the attempt, and the reply may have been lost after the copy landed). Before creating, look
   * for a draft carrying one of them. REPLACE it with this upload (the result names its `remoteDraftId`) ONLY when all
   * three hold: it is still a draft, its Message-ID is listed here, AND its canonical bytes equal an upload this adapter
   * recorded under that Message-ID. A listed Message-ID alone proves nothing: a provider may keep a draft's Message-ID
   * across edits, so a copy another device edited carries it too. Otherwise answer `conflict` naming `remoteDraftId`,
   * `remoteMessageId` and `remoteInternetId` of the copy, write nothing and never delete it. An adapter that cannot
   * record or compare uploads (for example after a restart) simply answers `conflict`: nothing is lost, the owner
   * chooses. Optional and additive: an adapter that ignores the field keeps today's behaviour (a duplicate remote draft
   * can remain until the owner removes it, never a loss). The engine stops offering the ids once the create is answered
   * in any way, including `conflict` and `gone`.
   */
  supersedes?: string[];
  /** Graph's `changeKey` of the last synced copy, sent as the precondition where the message id does not change on edit. */
  baseChangeKey?: string;
}

export type DraftSaveResult =
  | {
      kind: 'saved';
      remoteDraftId: string;
      remoteMessageId: string;
      revision: number;
      changeKey?: string;
      /**
       * The Message-ID the provider now shows for the copy it just stored, when it is not `DraftUpload.internetId` (Gmail
       * assigns its own to a draft; one `drafts.get` metadata read). The engine remembers it next to the upload's, so
       * history reporting the copy under it with the content of this upload is recognised as the echo of our own write.
       * Optional and additive: an adapter that keeps our Message-ID, or did not read it, leaves it out.
       */
      copyInternetId?: string;
    }
  /** The remote draft no longer exists (deleted or sent from another device): the engine decides, never recreates blindly. */
  | { kind: 'gone' }
  /**
   * The remote copy changed since `baseRemoteMessageId`: nothing was written; the engine asks "keep mine, take theirs, or
   * keep both".
   *
   * On the CREATE path (the upload carried no `remoteDraftId`) a conflict means the provider found an existing copy
   * carrying this upload's Message-ID (an earlier create whose reply was lost did land) whose bytes differ, or, for an upload
   * that lists `supersedes`, a copy under one of those Message-IDs that the adapter cannot prove is its own. Name it:
   * `remoteDraftId` (and `remoteMessageId`) of that copy, and `remoteInternetId`, the Message-ID the copy carries. The
   * engine adopts the copy only when `remoteInternetId` equals `DraftUpload.internetId`: it then stores the ids on the
   * draft row, so keep mine replaces that copy instead of creating a second draft, and remembers the upload's Message-ID
   * as its own. It never adopts a copy it cannot prove is its own, and the copy's bytes differ, so it never deletes it:
   * it is another device's version until the owner chooses (a discard forgets it). Optional: an adapter that cannot name
   * or prove the copy leaves the fields out (the ordinary conflict, nothing adopted). Ignored on the update path.
   */
  | {
      kind: 'conflict';
      remoteMessageId?: string;
      remoteDraftId?: string;
      /** The Message-ID header of the copy named by `remoteDraftId`, as the provider read it. */
      remoteInternetId?: string;
    };

export interface SubmissionPayload {
  submissionId: string;
  /** The stable Message-ID, never regenerated (`submissions.internet_id`). */
  internetId: string;
  /** The exact bytes; kept until `sent` is confirmed. */
  mime: Uint8Array;
  /** SMTP envelope; `rcpt` includes Bcc. */
  envelope: { from: string; rcpt: string[] };
  remoteThreadId?: string;
  /**
   * The synced remote draft (Gmail: `drafts.send`, so the copy on other devices disappears). Used only when
   * `sendsRemoteDraft` holds; it never decides what is sent.
   */
  remoteDraftId?: string;
  /**
   * Precondition for sending the remote draft, like `DraftUpload.baseRemoteMessageId`: the remote message id Aplos
   * uploaded for the pinned revision. Set only when the synced copy is that revision; unset means send `mime`.
   */
  baseRemoteMessageId?: string;
  /** Graph's `changeKey` of that copy, where the message id does not change on edit. */
  baseChangeKey?: string;
}

/**
 * The frozen send rule (ARCH 7.1, FR-7): may the adapter send the remote draft instead of the pinned `mime`? Only
 * when the remote draft is provably the pinned revision: the payload names it with a precondition, and the copy the
 * adapter just read (Gmail `drafts.get`) still has that message id and, when given, that `changeKey`. A phone edit
 * changes the id (or the key), so it is never what leaves; `current` undefined means the draft is gone.
 */
export function sendsRemoteDraft(
  submission: SubmissionPayload,
  current: { remoteMessageId: string; changeKey?: string } | undefined,
): boolean {
  return (
    submission.remoteDraftId !== undefined &&
    submission.baseRemoteMessageId !== undefined &&
    current?.remoteMessageId === submission.baseRemoteMessageId &&
    (submission.baseChangeKey === undefined || current.changeKey === submission.baseChangeKey)
  );
}

export interface SendReceipt {
  remoteMessageId?: string;
  remoteThreadId?: string;
  acceptedAt: number;
  /** `drafts.send` removed the remote draft. */
  draftConsumed?: boolean;
}

export type FindSentResult =
  | { kind: 'found'; remoteMessageId: string; remoteThreadId?: string }
  /** Not found yet; search indexes lag, so the engine re-checks once after 60 s before asking the user. */
  | { kind: 'absent'; checkedAt: number };

// ---- workflow channel and filters ----

/** One encrypted copy of the workflow blob (Done, Later, the lease), as stored at the provider (D17, D18). */
export interface WorkflowCopy {
  remoteId?: string;
  deviceId: string;
  writtenAt: number;
  data: string;
}

/** Implemented per provider (Gmail: hidden label + `messages.insert`); the actor runs it as the `workflow` scope in `enrichment`. */
export interface WorkflowChannel {
  /** One gated round: a cheap change check first (Gmail history on the app label, 2 units); reads only copies not seen before. */
  round(
    state: SyncState,
    ctx: AdapterContext,
  ): Promise<{ copies: WorkflowCopy[]; nextState: SyncState; costUnits: number }>;
  /** Writes one copy (`write`; checks for its own copy first, ARCH 6.3). Returns its remote id. */
  put(copy: WorkflowCopy, ctx: AdapterContext): Promise<string>;
  /** Removes superseded copies (Gmail moves them to Trash: `gmail.modify` cannot delete). */
  compact(remoteIds: string[], ctx: AdapterContext): Promise<void>;
}

export interface SenderRule {
  addressOrDomain: string;
  action: 'block' | 'skipInbox';
}
export interface RemoteRule extends SenderRule {
  remoteId: string;
}

/** Gmail filters, Graph `messageRules`; so block and skip-Inbox act while the Mac sleeps. Edits are delete-and-recreate. */
export interface RulesAdapter {
  list(ctx: AdapterContext): Promise<RemoteRule[]>;
  create(rule: SenderRule, ctx: AdapterContext): Promise<string>;
  delete(remoteId: string, ctx: AdapterContext): Promise<void>;
}

// ---- the adapter ----

/**
 * One provider's adapter for one account. Implemented by `prov-gmail` / `prov-gmail-write` (google), later `prov-graph`,
 * `prov-imap`, `prov-jmap`; created and called only by the account actor (`prov-gov`). One instance per account, so it
 * can own that account's connections (IMAP's two) and `close()` releases exactly those.
 */
export interface ProviderAdapter {
  readonly kind: ProviderKind;
  /** Pure: the steps to run now from committed state, trigger and environment, with cadence in `notBefore`. Role policy is the actor's. */
  plan(input: PlanInput): PlannedStep[];
  /**
   * One bounded step: one page, one history page or one folder chunk. On a mid-step `PausedError` it returns what it
   * already has with `done: false`, no `scopeCovered`, and the rest in `pending`.
   */
  syncStep(step: PlannedStep, state: SyncState, ctx: AdapterContext): Promise<StepResult>;
  /** `ProviderPort.openThread`'s adapter half (AM-1). */
  openThread(
    ref: ThreadOpenRef,
    lane: 'interactive' | 'prefetch',
    ctx: AdapterContext,
  ): Promise<OpenedThread>;
  fetchAttachment(ref: AttachmentRef, ctx: AdapterContext): Promise<AsyncIterable<Uint8Array>>;
  /** Pure: merges pending ops into provider calls. */
  coalesce(ops: PendingOp[]): CoalescedOp[];
  /**
   * One outcome per op id. Runs `idempotentWrite` where the provider has one (Gmail `batchModify`, JMAP `Email/set`
   * patches, flag stores), re-sent on transient; `write` for moves that are not (Graph `/move`, IMAP `UID MOVE`), never re-sent.
   */
  apply(op: CoalescedOp, ctx: AdapterContext): Promise<OpOutcome[]>;
  /**
   * Create when `remoteDraftId` is absent, else replace that copy, after checking `baseRemoteMessageId` when set. The
   * adapter picks each request's kind: an in-place update by id (Gmail `drafts.update`, Graph PATCH) is
   * `idempotentWrite`; a create, and an update that is a create plus destroy (IMAP `APPEND` then delete, JMAP
   * `Email/set`), is `write` and never re-sent, and an uncertain create is recognised by `DraftUpload.internetId`.
   * A target that is no longer a draft (sent from another device: no `$draft` keyword, not in Drafts, a sent message on
   * a provider where the draft and the sent message are one entity) is `gone`: it is never replaced, and a JMAP
   * replace (create then destroy) must not destroy it, or it would delete sent mail. `DraftUpload.mime` never carries
   * Bcc: the engine keeps Bcc out of draft copies, so an adapter that sends a copy itself sends it without Bcc.
   */
  saveDraft?(draft: DraftUpload, ctx: AdapterContext): Promise<DraftSaveResult>;
  /**
   * Idempotent: an absent draft is success. It must also do nothing when the target is no longer a draft (no `$draft`
   * keyword, not in Drafts): a send that used the remote draft (`SendReceipt.draftConsumed`) can leave the same entity
   * as the sent message (JMAP keeps the `Email` id), and deleting it would delete the sent mail.
   *
   * `expectedMessageId` (optional, additive): the message id the engine last wrote or adopted for this draft. When given,
   * delete ONLY IF the draft still holds it (Gmail: the draft's `message.id` equals it; JMAP: the `Email` id; Graph: the
   * message `id`). If the draft holds a different one (it was edited or replaced on another device, or became a sent
   * message) do NOTHING and resolve: the owner's discard must not destroy a newer version or a sent mail. A missing draft
   * is success. When it is omitted the engine knows no id (a copy it never read a message id for): the engine's call is the
   * old unguarded one, but an adapter may and should refuse to delete without a guard when the delete cannot be undone
   * (Gmail does nothing and the copy stays, which history then reports as another device's draft: an orphan, never a
   * loss). Either way it resolves.
   */
  deleteDraft?(
    remoteDraftId: string,
    ctx: AdapterContext,
    expectedMessageId?: string,
  ): Promise<void>;
  /**
   * Never retried (`kind: 'send'`). Throws `NotSentError` or `PausedError` only with proof; anything else means uncertain.
   * When one call makes several requests (iCloud: SMTP, then an `APPEND` to Sent), it may let `PausedError` or
   * `NotSentError` escape only if no earlier request in the call could have delivered the mail; after SMTP accepted the
   * message, a failed `APPEND` still resolves (the receipt), it never throws.
   * It sends the pinned `submission.mime` unless `sendsRemoteDraft` holds for the remote copy it just read (FR-7).
   */
  send(submission: SubmissionPayload, ctx: AdapterContext): Promise<SendReceipt>;
  /** Searches Sent by Message-ID: Gmail `rfc822msgid:`, IMAP `HEADER Message-ID`, Graph `internetMessageId`, JMAP `Email/query`. */
  findSent(internetId: string, since: number, ctx: AdapterContext): Promise<FindSentResult>;
  /** Server search, on Enter only (D2). */
  search?(query: ServerSearch, ctx: AdapterContext): Promise<SearchResult>;
  /**
   * One page of a `lazy` folder's listing, newest first (`ProviderPort.listFolder`): the folder's remote id, the
   * page token the last open left (undefined asks for the head page). Only the page's unknown messages are fetched;
   * each upsert carries its complete folder set, so a STARRED page lands as `flagged`, a SPAM page as placements.
   */
  listFolder?(
    folder: string,
    pageToken: string | undefined,
    ctx: AdapterContext,
  ): Promise<FolderList>;
  /** IDLE, EventSource; Gmail has none. Ends when `ctx.signal` aborts. The actor iterates it only on the primary device (IMAP's second connection). */
  watch?(ctx: AdapterContext): AsyncIterable<Hint>;
  workflow?: WorkflowChannel;
  rules?: RulesAdapter;
  calendar?: CalendarAdapter;
  close(): Promise<void>;
}

/**
 * One provider kind: connect before an account exists, budgets, and an adapter per account. Implemented next to each
 * adapter in `host/providers/<name>/` (the host's OAuth flow, vault and HTTP client are closed over here, never passed
 * through the engine); injected into the engine at start as `ProviderFactory[]` and called by the actor host.
 */
export interface ProviderFactory {
  readonly kind: ProviderKind;
  connect(req: ConnectRequest, ctx: ConnectContext): Promise<ConnectResult>;
  /** Static for Gmail; from `provider_memory` (JMAP session, IMAP host table) elsewhere. Includes the calendar's budget. */
  budgets(account: AdapterAccount, memory: ReadonlyMap<string, string>): BudgetSpec[];
  open(account: AdapterAccount): ProviderAdapter;
  /**
   * Deletes a credential this factory's `connect` stored (or `ConnectRequest.secretRef` named) when the engine refuses
   * the result. The factory owns the vault, so only it can; a ref that is not stored is not an error. A factory without
   * this method cannot be discarded from: the host fails closed and rejects rather than keep an orphaned credential.
   */
  discardCredential?(ref: string): Promise<void>;
}
