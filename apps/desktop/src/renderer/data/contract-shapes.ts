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
/** Opaque state token, `{dbEpoch, seq}` encoded by the engine (ARCH 3.5). Never parse it; to order states, compare the plain `seq` numbers that frames and receipts carry beside it (`StateSeq`). provisional: replaced by import from @aplos/contract at the freeze */
export type StateToken = string;
/** The `seq` half of a state token as a plain number (ARCH 3.5 `changes.seq`). Ordered within one `dbEpoch`; a `dbEpoch` change always arrives as a `reset` frame, which drops every overlay. provisional: replaced by import from @aplos/contract at the freeze */
export type StateSeq = number;
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
/** Calendar id (one account can hold several calendars). provisional: replaced by import from @aplos/contract at the freeze */
export type CalendarId = string;
/** Event id. provisional: replaced by import from @aplos/contract at the freeze */
export type EventId = string;
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
  /** Remote images for this render; blocked by default. The engine loads them anyway for senders in `Settings.mail.imageAllowSenders`. */
  readonly imagePolicy: ImagePolicy;
  /** ⌘F query; the engine injects marks. */
  readonly findQuery?: string;
  /** O in the reader: render quoted history open instead of collapsed in `<details>` (DESIGN 7.5, plan 30 8.1 item 4 `toggleQuotes`). Absent means collapsed. */
  readonly showQuotes?: boolean;
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
/** Mailbox roles a list can show; `done` is the Done place (DESIGN 7.4). Open string enum. `drafts` is not a valid role: drafts are not threads (ARCH 7.4), so the Drafts list is the `drafts` view spec. provisional: replaced by import from @aplos/contract at the freeze */
export type MailboxRole =
  | 'all'
  | 'done'
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

/** Drafts, newest edit first: local drafts plus other devices' drafts (ARCH 7.4), including new messages with no thread. Rows are `DraftRow`s, not thread rows. provisional: replaced by import from @aplos/contract at the freeze */
export interface DraftsViewSpec {
  readonly kind: 'drafts';
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
  | DraftsViewSpec
  | ThreadViewSpec;

/** Specs whose rows are thread rows: every list a thread action or a selector can target. provisional: replaced by import from @aplos/contract at the freeze */
export type ThreadListSpec = Exclude<ViewSpec, ThreadViewSpec | DraftsViewSpec>;

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

/** `window` push frame (ARCH 9.2) plus the fields this surface asks for (`seq`, `offset`, `groups`). provisional: replaced by import from @aplos/contract at the freeze */
export interface WindowFrame {
  /** Window id from `View/watch`. */
  readonly windowId: WindowId;
  /** State the window reflects. */
  readonly state: StateToken;
  /** `seq` of `state` as a number. Frames are coalesced and can skip states, so an overlay drops once `seq >= receipt.appliedSeq`, never on token equality. Ask of this surface. */
  readonly seq: StateSeq;
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

/** One row type's changed ids inside a `state` frame. provisional: replaced by import from @aplos/contract at the freeze */
export interface StateFrameChange {
  /** Row type. */
  readonly type: RowType;
  /** Ids whose rows changed; the client refetches the cached ones with `T/get`. */
  readonly ids: readonly string[];
}

/** `state` push frame (ARCH 9.2, coalesced 50-250 ms): row changes outside windows, including the Counts and Settings singletons. Ask: it carries `seq`. provisional: replaced by import from @aplos/contract at the freeze */
export interface StateFrame {
  /** State after these changes. */
  readonly state: StateToken;
  /** `seq` of `state` as a number, ordered within one `dbEpoch`. */
  readonly seq: StateSeq;
  /** Changed rows by type. */
  readonly changed: readonly StateFrameChange[];
}

/** `parked` push frame (plan 10 E1 item 4, ARCH 2 crash guard): the engine stopped after repeated exits, a full disk or a damaged store, and waits for Try again. Main sends it when the engine itself cannot. provisional: replaced by import from @aplos/contract at the freeze */
export interface ParkedFrame {
  /** The engine's plain sentence, for example "Your disk is full."; null when it has none. */
  readonly reason: string | null;
  /** When it parked. */
  readonly since: EpochMs;
}

/** `Diagnostics/preview` result: the content-free bundle as the owner sees it before copying (ARCH 11). provisional: replaced by import from @aplos/contract at the freeze */
export interface DiagnosticsPreview {
  /** The bundle as plain text; no mail content, addresses or keys. */
  readonly text: string;
  /** When it was built. */
  readonly generatedAt: EpochMs;
}

/** `reset` push frame: windows must reopen (ARCH 9.2, 3.5 `cannotCalculateChanges`). provisional: replaced by import from @aplos/contract at the freeze */
export interface ResetFrame {
  /** Why, for logs only. */
  readonly reason: string;
}

/** Why a connect or reconnect ended, for the copy (open enum; gap list P2, P11). provisional: replaced by import from @aplos/contract at the freeze */
export type ConnectReasonCode = 'wrongAccount' | 'scopeMissing' | 'denied' | 'timeout' | 'cancelled' | (string & {});

/** `connect` push frame: one account connect, reconnect or permission grant in the browser ("Waiting for Google in your browser…"; gap list P1, P2). provisional: replaced by import from @aplos/contract at the freeze */
export interface ConnectFrame {
  /** The flow; the same id as `AccountFlow.requestId`. */
  readonly requestId: RequestId;
  /** A new account, the weekly reconnect, or granting a missing permission. */
  readonly mode: 'new' | 'reconnect' | 'grant';
  /** Where the flow is; a late `connected` after the owner moved on only updates the accounts list (DESIGN 7.11 [F9]). */
  readonly state: 'waiting' | 'connected' | 'failed' | 'cancelled';
  /** The account once known; always set for reconnect and grant. */
  readonly accountId: AccountId | null;
  /** Machine reason when failed or cancelled. */
  readonly reasonCode: ConnectReasonCode | null;
  /** The engine's plain sentence, if any. */
  readonly message: string | null;
}

/** One event inside a `progress` frame: Ask's step, text, citation and proposal events, plus pause, finish and failure. provisional: replaced by import from @aplos/contract at the freeze */
export type ProgressEvent =
  | AskFrame
  /** The run waits on a rate limit ("Waiting for Groq, about 20 s"; remote search "quotaPaused"). */
  | { readonly kind: 'paused'; readonly resumeAt: EpochMs | null }
  /** The run finished. */
  | { readonly kind: 'done' }
  /** The run failed; `error.message` is the sentence to show. */
  | { readonly kind: 'error'; readonly error: ContractError };

/** `progress` push frame: one event of a streamed run, Ask now and remote search once it lands (gap list E27, E52). Ephemeral and never logged (ARCH 9.2). provisional: replaced by import from @aplos/contract at the freeze */
export interface ProgressFrame {
  /** The run; the same id as `AskRun.requestId`. */
  readonly runId: RequestId;
  /** Which kind of run. */
  readonly channel: 'ask' | 'search';
  /** Order within the run, from 0; a gap means a frame was coalesced away. */
  readonly seq: number;
  /** What happened. */
  readonly event: ProgressEvent;
}

/** `clock` push frame: the fixture clock was set or advanced (`APLOS_NOW`, `Fixture/control` clock; test builds only; gap list E3). provisional: replaced by import from @aplos/contract at the freeze */
export interface ClockFrame {
  /** The engine's now. */
  readonly now: EpochMs;
  /** True while the fixture holds the clock still (the harness's 2026-10-29T10:00). */
  readonly frozen: boolean;
}

/** The push frames screens subscribe to with `useFrames`, by frame kind. provisional: replaced by import from @aplos/contract at the freeze */
export interface FrameMap {
  /** Ask (and later remote search) run progress. */
  progress: ProgressFrame;
  /** Account connect, reconnect and grant flows. */
  connect: ConnectFrame;
  /** `Setup/status` pushed while setup runs (first sync, onboarding, Add account). */
  setup: SetupStatus;
  /** The fixture clock (test builds only). */
  clock: ClockFrame;
}

/** A frame kind `useFrames` accepts. provisional: replaced by import from @aplos/contract at the freeze */
export type FrameKind = keyof FrameMap;

// ---------------------------------------------------------------------------
// Operations, receipts and thread actions (ARCH 9.1-9.2, plan 10 E3, DESIGN 5 rule 11)
// ---------------------------------------------------------------------------

/** `receipt` returned by every command (ARCH 9.2). provisional: replaced by import from @aplos/contract at the freeze */
export interface Receipt {
  /** The operation this receipt confirms (for `Operation/undo`, the inverse operation's id). */
  readonly opId: OpId;
  /** State the write committed at. */
  readonly appliedState: StateToken;
  /** `seq` of `appliedState`; the overlay drops once a window frame has `seq >= appliedSeq` (frames can skip states). Ask of this surface. */
  readonly appliedSeq: StateSeq;
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
  /** Put the thread in `lane` (absolute, so a retry is idempotent). The toast's "Always do this for [sender]" sends this with the lane the thread already moved to and `alsoForSender: true`, which only adds the sender rule (DESIGN 7.13). */
  | { readonly kind: 'setLane'; readonly lane: Lane; readonly alsoForSender: boolean }
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

/** A whole view, or one group of it, as a `Thread/act` target beyond the 200-row window (DESIGN 7.2 "→ → to mark everything done" and "Clear from Home"; DESIGN 7.4 ⌘A). The engine resolves it at the state the owner saw, so rows that arrive later are not swept up. provisional: replaced by import from @aplos/contract at the freeze */
export interface ThreadSelector {
  /** The list. */
  readonly spec: ThreadListSpec;
  /** One group key from the window's `groups` (for example `fromLater`, or a sender address in `home.low`); absent means the whole view. */
  readonly group?: string;
}

/** What `Thread/act` targets: explicit ids, or a selector. provisional: replaced by import from @aplos/contract at the freeze */
export type ThreadTarget = readonly ThreadId[] | ThreadSelector;

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
  /** Home: Do now (including Back from Later) plus Important updates (DESIGN decision 19). */
  readonly home: number;
  /** Later items whose date has arrived. */
  readonly laterDue: number;
  /** Drafts. */
  readonly drafts: number;
  /** Threads the owner moved off Home today (Done, Later, Trash, Spam; owner's local day; undo subtracts): "You handled 12 emails." on inbox zero (DESIGN 7.14). Ask of this surface. */
  readonly handledToday: number;
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
  /** The message this draft replies to or forwards; null for a new message. */
  readonly source: DraftSource | null;
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
  /** Attachment ids (uploads from `api.attachment.put`, or the source message's attachments on forward). */
  readonly attachments: readonly AttachmentId[];
  /** Last local edit; Drafts shows it. */
  readonly updatedAt: EpochMs;
  /** True after another device changed it: show "keep mine, take theirs, keep both" (ARCH 7.4). */
  readonly changedElsewhere: boolean;
}

/** How a draft relates to an existing message (DESIGN 7.5-7.6): reply threading and forwarded attachments are explicit, never guessed from the subject. provisional: replaced by import from @aplos/contract at the freeze */
export interface DraftSource {
  /** The message replied to or forwarded. */
  readonly messageId: MessageId;
  /** Reply, reply all, or forward (the ⋯ menu). */
  readonly mode: 'reply' | 'replyAll' | 'forward';
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
  /** The message replied to or forwarded; set on create. On `forward` the engine copies the source's attachments into the draft, and their ids appear in `DraftRow.attachments`. */
  readonly source?: DraftSource;
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
  /** Attachment ids from `api.attachment.put` or the source message; replaces the list on update. */
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

/** Options for `Submission/set {action: send}`. provisional: replaced by import from @aplos/contract at the freeze */
export interface SendOptions {
  /** ⌘⇧Return: mark the thread Done in the same operation, so one receipt and one notice cover both (DESIGN 7.6, 7.13). Undoing the send also undoes the Done. */
  readonly markDone?: boolean;
}

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
  /** When it was queued; with `notBefore` this gives the UndoTray drain bar its length (DESIGN 7.6), whatever `undoSeconds` says now. */
  readonly queuedAt: EpochMs;
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

/** Row density (DESIGN 4.4): rows 48 / 40 / 34 px; same names as ui/props.ts `Density`. provisional: replaced by import from @aplos/contract at the freeze */
export type Density = 'roomy' | 'comfortable' | 'compact';

/** One remapped key as stored: a chord spec string ("meta+k") or `{chord, phase}`; the same shape as commands/types.ts `KeymapEntry`. provisional: replaced by import from @aplos/contract at the freeze */
export type UiKeymapEntry = string | { readonly chord: string; readonly phase?: 'tap' | 'hold' };

/** The Ask dock's remembered state (DESIGN 4.4 "Ask dock", 7.7, decision 9). provisional: replaced by import from @aplos/contract at the freeze */
export interface UiDockSettings {
  /** Open; closed on first run, then remembered. Default false. */
  readonly open: boolean;
  /** Last tab. Default 'ask'. */
  readonly tab: 'ask' | 'today';
  /** Width in px, 300-440. Default 360 (the shell draws 320 under a 1180 px window until the owner resizes). */
  readonly width: number;
}

/**
 * The renderer's `ui` settings object (plan 30 8.1 item 8; gap list U11, S9, A14, A15, C14).
 * F1 (eng-contract) owns the Settings schema; these are the fields and defaults the screens
 * need (`UI_SETTINGS_DEFAULTS` in index.ts). commands' `keyPrefsFromUi` reads singleKeys,
 * holdMs, swipeDirection and keymap. provisional: replaced by import from @aplos/contract at the freeze
 */
export interface UiSettings {
  /** Light, dark, or match the system (Settings → General). Default 'system'. */
  readonly theme: 'light' | 'dark' | 'system';
  /** Row density. Default 'comfortable'. */
  readonly density: Density;
  /** Where keycaps show: 'tooltip' = tooltips and badges while ⌘ is held (default); 'always' = "Show all key hints" (DESIGN 5 rule 17, decision 8). */
  readonly keyHints: 'tooltip' | 'always';
  /** Single-key shortcuts on (WCAG 2.1.4, DESIGN 11.4). Default true. */
  readonly singleKeys: boolean;
  /** Tap versus hold threshold in ms, one for every hold key. Default 250 (plan 30 4.2). */
  readonly holdMs: number;
  /** The Ask dock. */
  readonly dock: UiDockSettings;
  /** Remapped keys by command id (matches commands/types.ts `CommandId`); a listed id loses its default keys, absent ids keep them. Default {}. */
  readonly keymap: Readonly<Record<CommandId, readonly UiKeymapEntry[]>>;
  /** Minimised sidebar (☰ mode, DESIGN 7.1). Default false. */
  readonly sidebarMinimised: boolean;
  /** Arrow triage sides on Home and one by one: 'rightDone' = → Done, ← Later (default, DESIGN 8); 'rightLater' swaps them. */
  readonly swipeDirection: 'rightDone' | 'rightLater';
  /** The developer toggle: model names, scores and rank sources shown (DESIGN 9 rule 4). Default false. */
  readonly devDetails: boolean;
  /** The account switcher's last scope: an account id, 'all' (All accounts), or null before the first choice. Default null. */
  readonly lastAccount: AccountId | 'all' | null;
  /** Palette memory: recent command and setting-entry ids, newest first, at most 20; boosted, never above an exact match (DESIGN 7.9). */
  readonly palette: { readonly recents: readonly string[] };
  /** Calendar: first weekday, 0 Sunday or 1 Monday; null follows the macOS locale (gap list decision 15). Default null. */
  readonly calendar: { readonly weekStart: 0 | 1 | null };
  /** One-time hints already shown: the first-launch "Hold ⌘ to see keys." toast (DESIGN 7.13). Default false. */
  readonly seen: { readonly holdCommandHint: boolean };
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
    /** Sender addresses whose remote images always load ("Load images from this sender", DESIGN 7.5; plan 30 8.1 item 4). */
    readonly imageAllowSenders: readonly string[];
  };
  /** AI configuration. */
  readonly ai: {
    /** Provider and model per feature. */
    readonly features: Readonly<Record<AiFeature, AiFeatureChoice>>;
    /** Known providers. */
    readonly providers: readonly AiProviderInfo[];
    /** Daily background token cap (ARCH 8.4). */
    readonly dailyTokenCap: number;
    /** The stored consent record, or null when never given or revoked (plan 30 8.1 item 6). */
    readonly consent: AiConsent | null;
    /** Consent text version the engine currently requires. Consent counts as given only when `consent.version` equals it and its provider and model match the Summaries choice; otherwise background summaries pause ("Background summaries are paused until you agree to the new provider."). */
    readonly consentVersion: number;
  };
}

/** A versioned AI consent record (plan 30 8.1 item 6, ARCH 8.3). provisional: replaced by import from @aplos/contract at the freeze */
export interface AiConsent {
  /** Provider agreed to. */
  readonly providerId: string;
  /** Model agreed to. */
  readonly model: string;
  /** Consent text version agreed to. */
  readonly version: number;
  /** When the owner chose Allow. */
  readonly grantedAt: EpochMs;
}

/** What Allow sends (`Consent/set`); null revokes. provisional: replaced by import from @aplos/contract at the freeze */
export type AiConsentGrant = { readonly providerId: string; readonly model: string; readonly version: number } | null;

/** One calendar event as Today and Home's "Next:" line show it; the minimal frozen shape, extended additively by `ui-calendar` (plan 30 4.1 view specs). provisional: replaced by import from @aplos/contract at the freeze */
export interface EventRow {
  /** Event id (one occurrence for recurring events). */
  readonly id: EventId;
  /** Row revision. */
  readonly rev: number;
  /** Owning account. */
  readonly accountId: AccountId;
  /** Calendar it belongs to. */
  readonly calendarId: CalendarId;
  /** Title as written. */
  readonly title: string;
  /** Start instant; for all-day events, local midnight of the first day. */
  readonly start: EpochMs;
  /** End instant, exclusive; for all-day events, local midnight after the last day. */
  readonly end: EpochMs;
  /** All-day event. */
  readonly allDay: boolean;
  /** Location text, or null. */
  readonly location: string | null;
  /** The owner's reply, or null when the owner organises it or was not invited. */
  readonly response: 'accepted' | 'tentative' | 'declined' | 'needsAction' | null;
}

/** `Event/query` arguments. provisional: replaced by import from @aplos/contract at the freeze */
export interface AgendaQuery {
  /** Range start, inclusive. */
  readonly from: EpochMs;
  /** Range end, exclusive. */
  readonly to: EpochMs;
  /** Only these calendars; absent means every visible calendar. */
  readonly calendarIds?: readonly CalendarId[];
}

/** A partial `ui` update: nested objects (dock, palette, calendar, seen) merge; `keymap` replaces the whole map so an entry can be removed. provisional: replaced by import from @aplos/contract at the freeze */
export type UiSettingsPatch = Partial<Omit<UiSettings, 'dock' | 'palette' | 'calendar' | 'seen'>> & {
  readonly dock?: Partial<UiDockSettings>;
  readonly palette?: Partial<UiSettings['palette']>;
  readonly calendar?: Partial<UiSettings['calendar']>;
  readonly seen?: Partial<UiSettings['seen']>;
};

/** A partial settings update; nested objects merge. provisional: replaced by import from @aplos/contract at the freeze */
export interface SettingsPatch {
  /** Fields of `ui` to change. */
  readonly ui?: UiSettingsPatch;
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
  Event: EventRow;
}

/** A cacheable row type name. provisional: replaced by import from @aplos/contract at the freeze */
export type RowType = keyof RowTypeMap;
