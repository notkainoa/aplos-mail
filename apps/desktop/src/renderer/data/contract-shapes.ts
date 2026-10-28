/**
 * Provisional wire types for the renderer data layer (F9, plan 30 section 4.1).
 *
 * The Engine thread is writing the real contract (F1, `packages/contract`) and its typed
 * client (F2) in parallel. Until they freeze, the data surface in `./index.ts` is typed
 * against the shapes below. They mirror ARCH 9, plan 10 4.1 and E3-E6, and plan 30 4.1
 * and 8.1, using the field names those plans already use.
 *
 * Swap rule: every type here is provisional and is replaced by an import from
 * `@aplos/contract` at the freeze. The swap is mechanical: delete the declaration and
 * re-export the contract type under the same name. Where F1 picks a different field
 * name, the data layer (U2) adapts it; screens keep reading the names below.
 *
 * Wire rules followed here (ARCH 9.3): discriminated unions of named objects, no tuples,
 * no Date, Map or BigInt. Instants are epoch milliseconds; calendar days are
 * `YYYY-MM-DD` strings.
 */

// ---------------------------------------------------------------------------
// Scalars and ids
// ---------------------------------------------------------------------------

/** An instant in epoch milliseconds. provisional: replaced by import from @aplos/contract at the freeze */
export type EpochMs = number;
/** A calendar day, `YYYY-MM-DD`, in the owner's time zone. provisional: replaced by import from @aplos/contract at the freeze */
export type IsoDay = string;
/** Opaque state token, `{dbEpoch, seq}` encoded by the engine (ARCH 3.5). Compare only by equality or via the engine. provisional: replaced by import from @aplos/contract at the freeze */
export type StateToken = string;
/** Account id; never the literal `all`. provisional: replaced by import from @aplos/contract at the freeze */
export type AccountId = string;
/** Thread id. provisional: replaced by import from @aplos/contract at the freeze */
export type ThreadId = string;
/** Message id. provisional: replaced by import from @aplos/contract at the freeze */
export type MessageId = string;
/** Draft id (stable across saves). provisional: replaced by import from @aplos/contract at the freeze */
export type DraftId = string;
/** Submission id (one send attempt chain, ARCH 7.1). provisional: replaced by import from @aplos/contract at the freeze */
export type SubmissionId = string;
/** Client-created operation id; also the idempotency key (ARCH 9.1). provisional: replaced by import from @aplos/contract at the freeze */
export type OpId = string;
/** Engine window id returned by `View/watch`. provisional: replaced by import from @aplos/contract at the freeze */
export type WindowId = string;
/** Label or folder id (labels and folders share one table, ARCH 3.2). provisional: replaced by import from @aplos/contract at the freeze */
export type LabelId = string;
/** Attachment id, fetched through the blob route. provisional: replaced by import from @aplos/contract at the freeze */
export type AttachmentId = string;
/** Id of a streaming request (`Ask/run`, connect flows) used to match `progress` frames. provisional: replaced by import from @aplos/contract at the freeze */
export type RequestId = string;

/** A person as shown in lists and the reader. provisional: replaced by import from @aplos/contract at the freeze */
export interface Person {
  /** Display name; the engine falls back to the address when the mail has none. */
  readonly name: string;
  /** Email address, shown on hover only (DESIGN 7.5). */
  readonly address: string;
}

// ---------------------------------------------------------------------------
// Errors (ARCH 9.1, research engine-contract-rpc-stack 5.1)
// ---------------------------------------------------------------------------

/** Contract error type; an open string enum. provisional: replaced by import from @aplos/contract at the freeze */
export type ContractErrorType =
  | 'invalidArguments'
  | 'notFound'
  | 'stateMismatch'
  | 'cannotCalculateChanges'
  | 'tooManyChanges'
  | 'unsupported'
  | 'authRequired'
  | 'quotaPaused'
  | 'unavailable'
  | (string & {});

/** Error body of a failed call. provisional: replaced by import from @aplos/contract at the freeze */
export interface ContractError {
  /** Machine type, for branching only. */
  readonly type: ContractErrorType;
  /** The human sentence the UI shows as written (plan 10 7.2, DESIGN 10). */
  readonly message: string;
  /** Present on throttling errors. */
  readonly retryAfterMs?: number;
}

// ---------------------------------------------------------------------------
// Thread row (ARCH 3.2 thread_workflow, plan 30 4.1, plan 10 4.1 `partial`)
// ---------------------------------------------------------------------------

/** Home lane (ARCH 8.2): Do now, Important updates, Low importance. provisional: replaced by import from @aplos/contract at the freeze */
export type Lane = 'do' | 'update' | 'low';
/** Ordering inside a lane (ARCH 8.2). provisional: replaced by import from @aplos/contract at the freeze */
export type Importance = 'important' | 'normal';
/** Where a due date came from, in order of trust (DESIGN 7.2). provisional: replaced by import from @aplos/contract at the freeze */
export type DueSource = 'user' | 'structured' | 'ai';
/** Who placed the thread in its lane; "Why it's here" reads it. provisional: replaced by import from @aplos/contract at the freeze */
export type RankSource = 'heuristic' | 'ai' | 'rule' | 'user';
/** App workflow status (ARCH 3.2 thread_workflow.status). provisional: replaced by import from @aplos/contract at the freeze */
export type WorkflowStatus = 'new' | 'done' | 'later';

/** Preset suggested-action kinds (ARCH 8.5); an open string enum. provisional: replaced by import from @aplos/contract at the freeze */
export type SuggestedActionKind =
  | 'reply'
  | 'replyAll'
  | 'nudge'
  | 'addToCalendar'
  | 'openLink'
  | 'viewAttachment'
  | 'remind'
  | 'done'
  | (string & {});

/** The one suggestion Space runs (DESIGN 7.2, 9 rule 2). provisional: replaced by import from @aplos/contract at the freeze */
export interface SuggestedAction {
  /** Preset kind; the command registry maps it to a command. */
  readonly kind: SuggestedActionKind;
  /** Literal verb shown on the filled button, for example "View invoice". */
  readonly label: string;
  /** Icon name from the app's icon set (reply, calendar, link, paperclip, cart, phone, clock); never an AI glyph. */
  readonly icon: string;
}

/** The serif summary line and its provenance (DESIGN 7.2, 9 rules 1 and 5). provisional: replaced by import from @aplos/contract at the freeze */
export interface ThreadSummary {
  /** The summary text; at most two lines on Home. */
  readonly text: string;
  /** Provider display name for the hover line, for example "Groq". */
  readonly by: string;
  /** True for Ollama or LM Studio, so hover says "on this Mac". */
  readonly onThisMac: boolean;
}

/** A body-free list row for a thread (ARCH 9.1). Rows never carry a snippet; lists show the summary, or the subject without AI. provisional: replaced by import from @aplos/contract at the freeze */
export interface ThreadRow {
  /** Thread id. */
  readonly id: ThreadId;
  /** Row revision; an unchanged rev keeps object identity in the row cache. */
  readonly rev: number;
  /** Owning account. */
  readonly accountId: AccountId;
  /** Subject; shown in place of the summary when there is no summary. */
  readonly subject: string;
  /** The serif summary, or null with AI off, not consented or not yet run. */
  readonly summary: ThreadSummary | null;
  /** True while a summary job for this thread is queued or running (DESIGN 7.5 "breathe"). */
  readonly summaryPending: boolean;
  /** Sender of the newest inbound message (the row's sender column). */
  readonly from: Person;
  /** Up to six participants, newest first (reader "to you and Mina Cho"). */
  readonly participants: readonly Person[];
  /** True when any message is unread. */
  readonly unread: boolean;
  /** Home lane. */
  readonly lane: Lane;
  /** Ordering inside the lane. */
  readonly importance: Importance;
  /** Due day, or null when undated. */
  readonly dueDate: IsoDay | null;
  /** Source of `dueDate`; null when undated. An `ai` date shows "from the email" on hover. */
  readonly dueSource: DueSource | null;
  /** Who set the lane. */
  readonly rankSource: RankSource;
  /** Workflow status. */
  readonly status: WorkflowStatus;
  /** A Later item whose date has arrived; sits at the bottom of Do now under "Back from Later". */
  readonly fromLater: boolean;
  /** The suggestion Space runs, or null (the row then offers Done). */
  readonly suggestedAction: SuggestedAction | null;
  /** True while the row was built from one metadata message and its message count is unknown (plan 10 4.1). Never show "1 message" then. */
  readonly partial: boolean;
  /** Message count; not shown while `partial`. */
  readonly messageCount: number;
  /** Newest message time; the row's date column. */
  readonly lastMessageAt: EpochMs;
  /** Label ids, including system roles. */
  readonly labels: readonly LabelId[];
  /** Bookmarked (B). */
  readonly bookmarked: boolean;
  /** When the thread returns from Later; null for Someday or when not in Later. */
  readonly laterAt: EpochMs | null;
  /** When the thread was marked Done; the Done place's "Done 9:41 AM" stamp. */
  readonly doneAt: EpochMs | null;
  /** Follow up: time of the owner's last unanswered message, or null when not waiting. */
  readonly waitingSince: EpochMs | null;
  /** True when a follow-up nudge suggestion is ready for this thread (fetch it with `api.thread.followup`). */
  readonly hasNudge: boolean;
  /** True when any message has a listed attachment. */
  readonly hasAttachments: boolean;
  /** True when the newest message offers List-Unsubscribe. */
  readonly canUnsubscribe: boolean;
}

// ---------------------------------------------------------------------------
// Messages, bodies and the mail frame (ARCH 9.1, 10; plan 30 4.4 and 8.1 item 4)
// ---------------------------------------------------------------------------

/** Lazy-body marker for a message (ARCH 9.1). provisional: replaced by import from @aplos/contract at the freeze */
export type BodyState = 'absent' | 'fetching' | 'present' | 'evicted';

/** Attachment metadata on a message. provisional: replaced by import from @aplos/contract at the freeze */
export interface AttachmentRef {
  /** Attachment id for the blob route. */
  readonly id: AttachmentId;
  /** File name as sent. */
  readonly name: string;
  /** MIME type. */
  readonly mime: string;
  /** Size in bytes. */
  readonly size: number;
  /** Local state; `failed` turns the chip `--stamp-ink` (DESIGN 7.5). */
  readonly state: 'absent' | 'fetching' | 'present' | 'evicted' | 'failed';
}

/** One message in a thread view. provisional: replaced by import from @aplos/contract at the freeze */
export interface MessageRow {
  /** Message id. */
  readonly id: MessageId;
  /** Row revision. */
  readonly rev: number;
  /** Owning account. */
  readonly accountId: AccountId;
  /** Parent thread. */
  readonly threadId: ThreadId;
  /** Sender. */
  readonly from: Person;
  /** To recipients. */
  readonly to: readonly Person[];
  /** Cc recipients. */
  readonly cc: readonly Person[];
  /** Sent time. */
  readonly date: EpochMs;
  /** Short plain preview for collapsed 36 px one-liners in the reader (message-level only). */
  readonly snippet: string;
  /** Unread. */
  readonly unread: boolean;
  /** Sent by the owner. */
  readonly fromMe: boolean;
  /** Lazy-body marker. */
  readonly bodyState: BodyState;
  /** Listed attachments. */
  readonly attachments: readonly AttachmentRef[];
}

/** Body format: plain text renders as escaped host DOM; html renders in the mail frame (ARCH 10). provisional: replaced by import from @aplos/contract at the freeze */
export type BodyKind = 'text' | 'html';

/** A quoted-history range inside a plain-text body. provisional: replaced by import from @aplos/contract at the freeze */
export interface QuotedRange {
  /** Start offset in `text`. */
  readonly start: number;
  /** End offset in `text`, exclusive. */
  readonly end: number;
}

/** `MessageBody/get` result. For `html` bodies the reader asks `Mail/frame` for the URL; `text` is the plain alternative. provisional: replaced by import from @aplos/contract at the freeze */
export interface MessageBody {
  /** Message id. */
  readonly messageId: MessageId;
  /** Which renderer the reader uses. */
  readonly bodyKind: BodyKind;
  /** Plain text, or the plain alternative of an html body; null when none exists. */
  readonly text: string | null;
  /** Quoted history in `text`, collapsed until O. */
  readonly quotedRanges: readonly QuotedRange[];
}

/** Remote image policy for one render (ARCH 10). provisional: replaced by import from @aplos/contract at the freeze */
export type ImagePolicy = 'blocked' | 'allowed';

/** `Mail/frame` arguments (plan 30 8.1 item 4). provisional: replaced by import from @aplos/contract at the freeze */
export interface MailFrameRequest {
  /** The message to render. */
  readonly messageId: MessageId;
  /** Remote images; blocked by default. */
  readonly imagePolicy: ImagePolicy;
  /** ⌘F query; the engine injects marks. */
  readonly findQuery?: string;
}

/** `Mail/frame` result: a single-render token URL plus host-chrome facts (plan 10 E4). provisional: replaced by import from @aplos/contract at the freeze */
export interface MailFrameRef {
  /** `aplos-mail://m/<token>`; release it with `Mail/frame.release`. */
  readonly url: string;
  /** When the token stops resolving. */
  readonly expiresAt: EpochMs;
  /** Body format. */
  readonly bodyKind: BodyKind;
  /** "N trackers removed" in host chrome. */
  readonly trackersRemoved: number;
  /** Shows "Load images from this sender" when true. */
  readonly hasRemoteImages: boolean;
  /** Number of quoted blocks wrapped in `<details>`. */
  readonly quotedCount: number;
  /** Sanitised document for the same-origin `srcdoc` dev path. Only the stand-in engine sets it; never present from the real engine (ARCH 10 "Stopgap"). */
  readonly srcdoc?: string;
}

// ---------------------------------------------------------------------------
// View specs and windows (ARCH 9.2, plan 30 4.1 table, plan 10 E3)
// ---------------------------------------------------------------------------

/** Home sections in display order (DESIGN 7.2); Low importance is its own view. provisional: replaced by import from @aplos/contract at the freeze */
export type HomeSection = 'do' | 'update' | 'follow';
/** Group keys of the `home` window, in order; `fromLater` is the Back from Later block at the bottom of Do now. provisional: replaced by import from @aplos/contract at the freeze */
export type HomeGroupKey = 'do' | 'fromLater' | 'update' | 'follow';
/** Group keys of the `later` window, in order (DESIGN 7.3). provisional: replaced by import from @aplos/contract at the freeze */
export type LaterBucket = 'overdue' | 'today' | 'week' | 'someday';
/** Mailbox roles a list can show; `done` is the Done place (DESIGN 7.4). Open string enum. provisional: replaced by import from @aplos/contract at the freeze */
export type MailboxRole =
  | 'all'
  | 'done'
  | 'drafts'
  | 'sent'
  | 'trash'
  | 'spam'
  | 'inbox'
  | 'starred'
  | 'important'
  | (string & {});

/** A mailbox by role or by label id. provisional: replaced by import from @aplos/contract at the freeze */
export type MailboxRef =
  | { readonly role: MailboxRole }
  | { readonly labelId: LabelId };

/** One parsed search operator, shown as a removable pill (DESIGN 7.9). provisional: replaced by import from @aplos/contract at the freeze */
export type SearchOperator =
  | { readonly op: 'from'; readonly value: string }
  | { readonly op: 'to'; readonly value: string }
  | { readonly op: 'subject'; readonly value: string }
  | { readonly op: 'has'; readonly value: 'attachment' }
  | { readonly op: 'before'; readonly value: IsoDay }
  | { readonly op: 'after'; readonly value: IsoDay }
  | { readonly op: 'in'; readonly value: MailboxRole };

/** Home: Do now (with Back from Later at its bottom), Important updates, Follow up; one window grouped by section. provisional: replaced by import from @aplos/contract at the freeze */
export interface HomeViewSpec {
  readonly kind: 'home';
  /** One account, or absent for All accounts. */
  readonly accountId?: AccountId;
}

/** Low importance, ordered and grouped by sender (the band and its sheet). provisional: replaced by import from @aplos/contract at the freeze */
export interface HomeLowViewSpec {
  readonly kind: 'home.low';
  /** One account, or absent for All accounts. */
  readonly accountId?: AccountId;
}

/** Later, grouped overdue, today, week, someday. provisional: replaced by import from @aplos/contract at the freeze */
export interface LaterViewSpec {
  readonly kind: 'later';
  /** One account, or absent for All accounts. */
  readonly accountId?: AccountId;
}

/** Bookmarks (the other half of the Later page). provisional: replaced by import from @aplos/contract at the freeze */
export interface BookmarksViewSpec {
  readonly kind: 'bookmarks';
  /** One account, or absent for All accounts. */
  readonly accountId?: AccountId;
}

/** A keyset list by role or label; Done is `{role: 'done'}` (`in:done`). provisional: replaced by import from @aplos/contract at the freeze */
export interface MailboxViewSpec {
  readonly kind: 'mailbox';
  /** Which mailbox. */
  readonly mailbox: MailboxRef;
  /** One account, or absent for All accounts. */
  readonly accountId?: AccountId;
}

/** Search; `local` runs as you type, `remote` only on Return (ARCH 3.4). provisional: replaced by import from @aplos/contract at the freeze */
export interface SearchViewSpec {
  readonly kind: 'search';
  /** Free text left after operators are parsed out. */
  readonly query: string;
  /** Parsed operators. */
  readonly operators: readonly SearchOperator[];
  /** Local index or provider search. */
  readonly scope: 'local' | 'remote';
  /** One account, or absent for All accounts. */
  readonly accountId?: AccountId;
}

/** A thread's messages, oldest first, for the reader. provisional: replaced by import from @aplos/contract at the freeze */
export interface ThreadViewSpec {
  readonly kind: 'thread';
  /** The thread to open. */
  readonly threadId: ThreadId;
}

/** Every view the screens watch (plan 30 4.1 "View specs the UI requires"). provisional: replaced by import from @aplos/contract at the freeze */
export type ViewSpec =
  | HomeViewSpec
  | HomeLowViewSpec
  | LaterViewSpec
  | BookmarksViewSpec
  | MailboxViewSpec
  | SearchViewSpec
  | ThreadViewSpec;

/** A contiguous group inside a window's whole ordering: Home sections, Later buckets, Low senders. provisional: replaced by import from @aplos/contract at the freeze */
export interface WindowGroup {
  /** `HomeGroupKey` for home, `LaterBucket` for later, the sender address for home.low. */
  readonly key: string;
  /** Display label where the engine owns it (the sender name for home.low); absent otherwise. */
  readonly label?: string;
  /** Rows in the group across the whole view, not just the window. */
  readonly count: number;
  /** Index of the group's first row in the whole view. */
  readonly start: number;
}

/** `window` push frame (ARCH 9.2) plus the fields this surface asks for (`offset`, `groups`). provisional: replaced by import from @aplos/contract at the freeze */
export interface WindowFrame {
  /** Window id from `View/watch`. */
  readonly windowId: WindowId;
  /** State the window reflects; overlays drop once a window reaches a receipt's `appliedState`. */
  readonly state: StateToken;
  /** Ordered ids in the window, at most 200. */
  readonly ids: readonly string[];
  /** Rows in the whole view. */
  readonly total: number;
  /** Ids whose rows changed since the previous frame; the client refetches only these and unknown ids. */
  readonly changed: readonly string[];
  /** Index of `ids[0]` in the whole view (approximate under keyset paging). Ask of this surface. */
  readonly offset: number;
  /** Groups for grouped views, in order; empty for ungrouped views. Ask of this surface. */
  readonly groups: readonly WindowGroup[];
}

/** `reset` push frame: windows must reopen (ARCH 9.2, 3.5 `cannotCalculateChanges`). provisional: replaced by import from @aplos/contract at the freeze */
export interface ResetFrame {
  /** Why, for logs only. */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Operations, receipts and thread actions (ARCH 9.1-9.2, plan 10 E3, DESIGN 5 rule 11)
// ---------------------------------------------------------------------------

/** `receipt` returned by every command (ARCH 9.2). provisional: replaced by import from @aplos/contract at the freeze */
export interface Receipt {
  /** The operation this receipt confirms (for `Operation/undo`, the inverse operation's id). */
  readonly opId: OpId;
  /** The overlay drops once a window frame reaches this state. */
  readonly appliedState: StateToken;
}

/** Operation lifecycle as screens see it: pending until the receipt, confirmed after it, failed on rejection. provisional: replaced by import from @aplos/contract at the freeze */
export type OperationState = 'pending' | 'confirmed' | 'failed';

/** Provider-side progress of a confirmed operation (engine Operation row); drives "Saved here · will sync" (DESIGN 7.13). provisional: replaced by import from @aplos/contract at the freeze */
export type OperationRemoteState = 'queued' | 'syncing' | 'synced' | 'failed' | 'conflict';

/** Engine `Operation` row (research 5.3). provisional: replaced by import from @aplos/contract at the freeze */
export interface OperationRow {
  /** Operation id. */
  readonly id: OpId;
  /** Row revision. */
  readonly rev: number;
  /** Action kind, for toast wording. */
  readonly kind: string;
  /** Target ids. */
  readonly targets: readonly string[];
  /** Provider-side progress. */
  readonly remote: OperationRemoteState;
  /** The error when `remote` is failed or conflict. */
  readonly error: ContractError | null;
}

/** Later target: an instant, or null for Someday (DESIGN 7.3 DatePresets resolve to instants in the UI). provisional: replaced by import from @aplos/contract at the freeze */
export type LaterAt = EpochMs | null;

/** One `Thread/act` action (ARCH 9.1, DESIGN 8 keyboard map). provisional: replaced by import from @aplos/contract at the freeze */
export type ThreadAction =
  /** E: Done; leaves Home, even for mail that still needs a reply (DESIGN decision 6). */
  | { readonly kind: 'done' }
  /** L: Later until an instant, or Someday. */
  | { readonly kind: 'later'; readonly at: LaterAt }
  /** #: Trash. */
  | { readonly kind: 'trash' }
  /** Mark as spam. */
  | { readonly kind: 'spam' }
  /** U: read. */
  | { readonly kind: 'read' }
  /** U: unread. */
  | { readonly kind: 'unread' }
  /** B: bookmark on. */
  | { readonly kind: 'bookmark' }
  /** B: bookmark off. */
  | { readonly kind: 'unbookmark' }
  /** ⌥↑: one lane up; `alsoForSender` writes a deterministic sender rule ("Always do this for [sender]"). */
  | { readonly kind: 'laneUp'; readonly alsoForSender: boolean }
  /** ⌥↓: one lane down; `alsoForSender` as for laneUp. */
  | { readonly kind: 'laneDown'; readonly alsoForSender: boolean }
  /** Restore from Trash or Spam. */
  | { readonly kind: 'restore' }
  /** H in the Done place: back to Home. */
  | { readonly kind: 'moveToHome' }
  /** D: set or clear the owner's due date (source becomes `user`). */
  | { readonly kind: 'setDue'; readonly date: IsoDay | null }
  /** R after Done on Follow up: remind if no reply by `at`, or after the nudge period when null. */
  | { readonly kind: 'remindIfNoReply'; readonly at: EpochMs | null }
  /** "Clear from Home" on Back from Later: returns those items to Later without a new date. */
  | { readonly kind: 'clearFromHome' };

// ---------------------------------------------------------------------------
// Accounts and the status vocabulary (ARCH 6.4, 6.3; DESIGN 7.1 status table)
// ---------------------------------------------------------------------------

/** Why an account is paused (ARCH 6.3 classes that pause); open string enum. provisional: replaced by import from @aplos/contract at the freeze */
export type PausedReason = 'throttle' | 'daily' | 'antiAbuse' | (string & {});

/** One status vocabulary for retry policy and the UI (ARCH 6.4). Only offline and paused resume by themselves. provisional: replaced by import from @aplos/contract at the freeze */
export type AccountStatus =
  /** "Starting…" after 150 ms. */
  | { readonly state: 'starting' }
  /** Nothing in the slot; "Synced 2 min ago" on hover. */
  | { readonly state: 'ok'; readonly syncedAt: EpochMs | null }
  /** "Syncing…" after 150 ms. */
  | { readonly state: 'syncing' }
  /** "Importing n of m"; `firstWindow` is true while reading the newest ~50 (first-sync "Reading your newest mail"). */
  | { readonly state: 'backfilling'; readonly n: number; readonly m: number; readonly firstWindow: boolean }
  /** "Google asked us to slow down. Resuming at 2:14 PM." / daily limit copy; `until` null when unknown. */
  | { readonly state: 'paused'; readonly until: EpochMs | null; readonly reason: PausedReason }
  /** Token already expired: Reconnect. */
  | { readonly state: 'needsReauth' }
  /** A scope is missing: Reconnect with full re-consent. */
  | { readonly state: 'needsPermission' }
  /** Blocked by the organisation's administrator. */
  | { readonly state: 'needsAdmin' }
  /** Provider sign-in not configured in this build. */
  | { readonly state: 'misconfigured' }
  /** "Offline · 2 changes waiting". */
  | { readonly state: 'offline'; readonly changesWaiting: number }
  /** "Sync hit a problem."; `message` is the engine's sentence for View details. */
  | { readonly state: 'error'; readonly message: string };

/** Account state name, for switches. provisional: replaced by import from @aplos/contract at the freeze */
export type AccountState = AccountStatus['state'];

/** Mail provider kind; open string enum (round 1 is Gmail only). provisional: replaced by import from @aplos/contract at the freeze */
export type ProviderKind = 'gmail' | 'graph' | 'imap' | 'jmap' | 'demo' | (string & {});

/** Account capability flags (ARCH 3.2 accounts.capabilities). provisional: replaced by import from @aplos/contract at the freeze */
export interface AccountCapabilities {
  /** Labels rather than folders. */
  readonly labels: boolean;
  /** Server drafts sync. */
  readonly drafts: boolean;
  /** Provider search exists ("Search all mail on Google"). */
  readonly serverSearch: boolean;
  /** Calendar connected. */
  readonly calendar: boolean;
  /** Provider-side filters for sender rules. */
  readonly filters: boolean;
  /** Push rather than polling. */
  readonly push: boolean;
}

/** An account row with status and the reconnect fact. provisional: replaced by import from @aplos/contract at the freeze */
export interface AccountRow {
  /** Account id. */
  readonly id: AccountId;
  /** Row revision. */
  readonly rev: number;
  /** Provider kind. */
  readonly provider: ProviderKind;
  /** The address. */
  readonly address: string;
  /** The one name used everywhere (DESIGN 7.10). */
  readonly displayName: string;
  /** Index into the account colour tokens (DESIGN 4.2); the dot shows only with two or more accounts. */
  readonly colorIndex: number;
  /** Demo account: "Demo mail. Remove it in Settings." */
  readonly isDemo: boolean;
  /** Sync status (ARCH 6.4). */
  readonly status: AccountStatus;
  /** Google Testing-mode token grant time plus 7 days; warn a day ahead. Absent for other providers (ARCH 6.4, roadmap N3). */
  readonly reconnectBy: EpochMs | null;
  /** End of the first window (`baseline_done_at`); inbox zero shows only with status ok and this set (plan 30 4.5 row 10). */
  readonly baselineDoneAt: EpochMs | null;
  /** "Use this account's mail for AI" (ARCH 8.3). */
  readonly aiAllowed: boolean;
  /** Capability flags. */
  readonly capabilities: AccountCapabilities;
}

// ---------------------------------------------------------------------------
// Session, counts and setup (ARCH 9.5; plan 30 8.1 items 9, 11, 12)
// ---------------------------------------------------------------------------

/** `Session/get` (ARCH 9.5, plan 10 E3, 4.1 `hasAccounts`). provisional: replaced by import from @aplos/contract at the freeze */
export interface Session {
  /** Contract major; the data layer refuses an incompatible one. */
  readonly apiVersion: number;
  /** App version. */
  readonly appVersion: string;
  /** Store schema version. */
  readonly schemaVersion: number;
  /** Database epoch; changes only on creation, reset or restore. */
  readonly dbEpoch: string;
  /** Feature flags; a missing or false flag shows "Not available yet". Keys are F1's. */
  readonly capabilities: Readonly<Record<string, boolean>>;
  /** Whether any account exists (onboarding versus mail window). */
  readonly hasAccounts: boolean;
}

/** Sidebar counts singleton (plan 30 4.1 "Folder counts"). provisional: replaced by import from @aplos/contract at the freeze */
export interface Counts {
  /** Unread threads in All mail. */
  readonly unread: number;
  /** Home: Do now plus Important updates (DESIGN decision 19). */
  readonly home: number;
  /** Later items whose date has arrived. */
  readonly laterDue: number;
  /** Drafts. */
  readonly drafts: number;
}

/** Per-account first-sync progress for the first-sync screen (plan 10 4.1, plan 30 8.1 item 12). provisional: replaced by import from @aplos/contract at the freeze */
export interface SetupAccountStatus {
  /** Account id. */
  readonly accountId: AccountId;
  /** Checkpoint state. */
  readonly state: 'connecting' | 'finding' | 'reading' | 'sorting' | 'ready' | 'paused' | 'partial' | 'failed' | 'notConnected';
  /** First window: `found` is an estimate only when the provider gives one; `total` is the window target (~50), never the mailbox size. */
  readonly firstWindow: { readonly found?: number; readonly read: number; readonly total: number };
  /** Sorting pass; absent without stored consent and a provider. */
  readonly ai?: { readonly sorted: number; readonly total: number; readonly capped: boolean; readonly failed: number };
  /** Backfill; never gates anything. */
  readonly backfill: { readonly read: number; readonly target: number };
  /** Resume time when paused. */
  readonly pausedUntil?: EpochMs;
  /** Weekly reconnect fact. */
  readonly reconnectBy?: EpochMs;
  /** Machine reason; the plain sentence comes from `message`. */
  readonly reasonCode: string | null;
  /** The engine's plain sentence for the reason, if any. */
  readonly message: string | null;
}

/** `Setup/status`. provisional: replaced by import from @aplos/contract at the freeze */
export interface SetupStatus {
  /** One row per account being set up. */
  readonly accounts: readonly SetupAccountStatus[];
}

// ---------------------------------------------------------------------------
// Drafts and submissions (ARCH 7.1-7.4, plan 10 E6)
// ---------------------------------------------------------------------------

/** A local draft (compare-and-set by revision). provisional: replaced by import from @aplos/contract at the freeze */
export interface DraftRow {
  /** Draft id. */
  readonly id: DraftId;
  /** Row revision. */
  readonly rev: number;
  /** Sending account. */
  readonly accountId: AccountId;
  /** Thread for replies; null for a new message. */
  readonly threadId: ThreadId | null;
  /** Compare-and-set revision. */
  readonly revision: number;
  /** To. */
  readonly to: readonly Person[];
  /** Cc. */
  readonly cc: readonly Person[];
  /** Bcc. */
  readonly bcc: readonly Person[];
  /** Subject. */
  readonly subject: string;
  /** Body HTML as composed. */
  readonly html: string;
  /** Attachment ids. */
  readonly attachments: readonly AttachmentId[];
  /** Last local edit; Drafts shows it. */
  readonly updatedAt: EpochMs;
  /** True after another device changed it: show "keep mine, take theirs, keep both" (ARCH 7.4). */
  readonly changedElsewhere: boolean;
}

/** What a save sends; `baseRevision` makes it compare-and-set. provisional: replaced by import from @aplos/contract at the freeze */
export interface DraftInput {
  /** Existing draft id, or absent to create one. */
  readonly id?: DraftId;
  /** Revision this edit is based on; absent on create. */
  readonly baseRevision?: number;
  /** Sending account. */
  readonly accountId: AccountId;
  /** Thread for replies. */
  readonly threadId?: ThreadId | null;
  /** To. */
  readonly to: readonly Person[];
  /** Cc. */
  readonly cc?: readonly Person[];
  /** Bcc. */
  readonly bcc?: readonly Person[];
  /** Subject. */
  readonly subject: string;
  /** Body HTML. */
  readonly html: string;
  /** Attachment ids. */
  readonly attachments?: readonly AttachmentId[];
}

/** Save result; a stale `baseRevision` rejects with `stateMismatch`. provisional: replaced by import from @aplos/contract at the freeze */
export interface DraftSaveResult {
  /** Draft id (new on create). */
  readonly id: DraftId;
  /** New revision. */
  readonly revision: number;
  /** Receipt for the save. */
  readonly receipt: Receipt;
}

/** Submission states (ARCH 7.1-7.3). provisional: replaced by import from @aplos/contract at the freeze */
export type SubmissionState = 'queued' | 'sending' | 'sent' | 'uncertain' | 'failed' | 'cancelled' | 'suspended';

/** One send (undo-send and send-later are one `notBefore` mechanism, ARCH 7.2). provisional: replaced by import from @aplos/contract at the freeze */
export interface SubmissionRow {
  /** Submission id. */
  readonly id: SubmissionId;
  /** Row revision. */
  readonly rev: number;
  /** The draft it sends. */
  readonly draftId: DraftId;
  /** Sending account. */
  readonly accountId: AccountId;
  /** Thread the message lands in, for the UndoTray placement. */
  readonly threadId: ThreadId | null;
  /** Recipients, for "Sending to Jordan in 8 s". */
  readonly to: readonly Person[];
  /** Earliest send time (undo window end or the scheduled time). */
  readonly notBefore: EpochMs;
  /** State. */
  readonly state: SubmissionState;
  /** The engine's sentence for failed, uncertain or suspended. */
  readonly error: ContractError | null;
  /** For send-limit failures: "Couldn't send until 2:14 PM." */
  readonly errorUntil: EpochMs | null;
}

// ---------------------------------------------------------------------------
// AI: Ask, follow-up nudges, why-it's-here, drafts, polish, voice (ARCH 8, plan 30 8.1 item 7)
// ---------------------------------------------------------------------------

/** One Ask citation (plan 30 8.1 item 7). provisional: replaced by import from @aplos/contract at the freeze */
export interface Citation {
  /** The `[n]` chip number. */
  readonly n: number;
  /** Source message. */
  readonly messageId: MessageId;
  /** The quoted sentence shown on hover. */
  readonly quote: string;
}

/** A proposal card's payload (DESIGN 7.7); nothing applies without confirmation. provisional: replaced by import from @aplos/contract at the freeze */
export interface AskProposal {
  /** Proposal id to confirm or dismiss. */
  readonly id: string;
  /** Proposal kind, for example `addEvent`; open string. */
  readonly kind: string;
  /** Consequence line, for example "Add to Calendar · Thu 14:00–14:30 · Work". */
  readonly consequence: string;
}

/** `Ask/run` arguments. provisional: replaced by import from @aplos/contract at the freeze */
export interface AskRequest {
  /** The question as typed. */
  readonly question: string;
  /** Continue a conversation, or absent for a new chat. */
  readonly conversationId?: string;
  /** ⌘Return: search all mail on the provider as well. */
  readonly searchAllMail?: boolean;
}

/** `progress` frames of one Ask run; ephemeral and never logged (ARCH 9.2). provisional: replaced by import from @aplos/contract at the freeze */
export type AskFrame =
  /** The one steady step line, for example "Reading 14 emails from Jordan". */
  | { readonly kind: 'step'; readonly text: string }
  /** Appended answer text. */
  | { readonly kind: 'text'; readonly text: string }
  /** A citation became available. */
  | { readonly kind: 'citation'; readonly citation: Citation }
  /** A proposal card. */
  | { readonly kind: 'proposal'; readonly proposal: AskProposal };

/** Final Ask answer. provisional: replaced by import from @aplos/contract at the freeze */
export interface AskAnswer {
  /** Conversation the answer belongs to. */
  readonly conversationId: string;
  /** Full answer prose. */
  readonly text: string;
  /** Citations; empty means the answer says "No source in your mail". */
  readonly citations: readonly Citation[];
  /** Proposals awaiting confirmation. */
  readonly proposals: readonly AskProposal[];
}

/** A follow-up nudge kept as a local suggestion, never a synced draft (DESIGN 7.2). provisional: replaced by import from @aplos/contract at the freeze */
export interface FollowupSuggestion {
  /** Thread it belongs to. */
  readonly threadId: ThreadId;
  /** The suggested text, shown dim with Tab keep, Esc dismiss. */
  readonly text: string;
}

/** "Why it's here": one sentence and a quote (DESIGN 9 rule 4). provisional: replaced by import from @aplos/contract at the freeze */
export interface WhyItsHere {
  /** One plain sentence. */
  readonly sentence: string;
  /** A quote from the mail, or null. */
  readonly quote: string | null;
  /** Who placed it. */
  readonly rankSource: RankSource;
}

/** Interactive AI requests the composer and reader make (`Ai/request`). provisional: replaced by import from @aplos/contract at the freeze */
export type AiRequest =
  /** Draft a reply or message into the composer as a dim suggestion. */
  | { readonly kind: 'draft'; readonly draftId: DraftId; readonly threadId: ThreadId | null; readonly hint?: string }
  /** Polish: suggested edits shown as a diff, never applied by themselves. */
  | { readonly kind: 'polish'; readonly draftId: DraftId; readonly text: string }
  /** Re-run a thread's summary; the result arrives as a row change. */
  | { readonly kind: 'summary'; readonly threadId: ThreadId };

/** One Polish change. provisional: replaced by import from @aplos/contract at the freeze */
export interface PolishChange {
  /** Start offset in the submitted text. */
  readonly start: number;
  /** End offset, exclusive. */
  readonly end: number;
  /** Replacement text. */
  readonly replacement: string;
}

/** Result of `Ai/request` per kind. provisional: replaced by import from @aplos/contract at the freeze */
export type AiResult =
  | { readonly kind: 'draft'; readonly text: string }
  | { readonly kind: 'polish'; readonly changes: readonly PolishChange[] }
  | { readonly kind: 'summary'; readonly receipt: Receipt };

/** Speech-to-text result (Voice feature). provisional: replaced by import from @aplos/contract at the freeze */
export interface Transcript {
  /** Recognised text. */
  readonly text: string;
}

// ---------------------------------------------------------------------------
// Settings (plan 30 8.1 item 8; the `ui` object is F9's input to F1)
// ---------------------------------------------------------------------------

/** Command id; matches commands/types.ts (declared locally until that file lands; not exported). */
type CommandId = string;

/** Row density (DESIGN 4.4). provisional: replaced by import from @aplos/contract at the freeze */
export type Density = 'compact' | 'default' | 'roomy';

/** The renderer's `ui` settings object (plan 30 8.1 item 8). provisional: replaced by import from @aplos/contract at the freeze */
export interface UiSettings {
  /** Row density. */
  readonly density: Density;
  /** Light, dark, or match the system. */
  readonly appearance: 'light' | 'dark' | 'system';
  /** "Show all key hints" mode (DESIGN 5 rule 17). */
  readonly showAllKeyHints: boolean;
  /** Single-key shortcuts on or off (WCAG 2.1.4). */
  readonly singleKeyShortcuts: boolean;
  /** Ask dock open; closed on first run and remembered (DESIGN decision 9). */
  readonly dockOpen: boolean;
  /** Last dock tab. */
  readonly dockTab: 'ask' | 'today';
  /** Minimised sidebar (☰ mode). */
  readonly sidebarMinimised: boolean;
  /** Tap versus hold threshold, default 250 ms (plan 30 4.2). */
  readonly holdThresholdMs: number;
  /** Arrow triage sides on Home and one by one. */
  readonly swipeDirection: 'rightDone' | 'rightLater';
  /** Remapped bindings: command id (matches commands/types.ts `CommandId`) to key strings; absent ids use defaults. */
  readonly keymap: Readonly<Record<CommandId, readonly string[]>>;
}

/** AI features with a provider and model each (AGENTS.md, DESIGN 7.10). provisional: replaced by import from @aplos/contract at the freeze */
export type AiFeature = 'ask' | 'summaries' | 'drafts' | 'plans' | 'voice';

/** Provider and model choice for one feature. provisional: replaced by import from @aplos/contract at the freeze */
export interface AiFeatureChoice {
  /** Provider id, for example `groq`; null when unset. */
  readonly provider: string | null;
  /** Model id; null when unset. */
  readonly model: string | null;
}

/** One AI provider as Settings → AI shows it. Key characters never appear. provisional: replaced by import from @aplos/contract at the freeze */
export interface AiProviderInfo {
  /** Provider id. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** Hosted, or on this Mac and custom. */
  readonly group: 'hosted' | 'local';
  /** Where the key comes from; the env var name shows as "From environment: GROQ_API_KEY". */
  readonly keySource: { readonly kind: 'env'; readonly envVar: string } | { readonly kind: 'keychain' } | { readonly kind: 'none' };
  /** Editable address for local and custom servers. */
  readonly address: string | null;
  /** Can do speech-to-text (Voice lists only these). */
  readonly speechToText: boolean;
  /** Provider may train on inputs; mail never goes to it (ARCH 8.3). */
  readonly trainsOnInputs: boolean;
}

/** Settings singleton; the screens read these fields, F1 owns the full schema. provisional: replaced by import from @aplos/contract at the freeze */
export interface Settings {
  /** The `ui` object. */
  readonly ui: UiSettings;
  /** Mail behaviour. */
  readonly mail: {
    /** Undo-send seconds: 0, 5, 8, 10, 20 or 30 (DESIGN 7.10). */
    readonly undoSeconds: number;
    /** Follow-up nudge period in days (DESIGN 7.2, default 3). */
    readonly nudgeDays: number;
  };
  /** AI configuration. */
  readonly ai: {
    /** Provider and model per feature. */
    readonly features: Readonly<Record<AiFeature, AiFeatureChoice>>;
    /** Known providers. */
    readonly providers: readonly AiProviderInfo[];
    /** Daily background token cap (ARCH 8.4). */
    readonly dailyTokenCap: number;
  };
}

/** A partial settings update; nested objects merge. provisional: replaced by import from @aplos/contract at the freeze */
export interface SettingsPatch {
  /** Fields of `ui` to change. */
  readonly ui?: Partial<UiSettings>;
  /** Fields of `mail` to change. */
  readonly mail?: Partial<Settings['mail']>;
  /** Per-feature provider and model changes. */
  readonly aiFeatures?: Partial<Record<AiFeature, AiFeatureChoice>>;
  /** Daily background token cap. */
  readonly dailyTokenCap?: number;
}

// ---------------------------------------------------------------------------
// Row types the cache holds
// ---------------------------------------------------------------------------

/** Row types held in the renderer cache, by contract type name. provisional: replaced by import from @aplos/contract at the freeze */
export interface RowTypeMap {
  Thread: ThreadRow;
  Message: MessageRow;
  Account: AccountRow;
  Draft: DraftRow;
  Submission: SubmissionRow;
  Operation: OperationRow;
}

/** A cacheable row type name. provisional: replaced by import from @aplos/contract at the freeze */
export type RowType = keyof RowTypeMap;
