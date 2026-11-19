/**
 * The wire types the renderer data surface uses, straight from the engine contract (F1, `@aplos/contract`).
 *
 * Every type here is a type-only re-export or a thin alias of a contract type, under the contract's own name. Nothing
 * here declares a shape of its own: when the contract changes, these change with it. Types the contract exports only
 * as a zod schema (no `type` beside the `const`) are inferred with `z.infer`. Types that are the UI's own (Home's
 * section keys, the row cache map, the streams `useFrames` serves, the overlay's lifecycle) live in `./ui-types.ts`.
 *
 * Everything is type-only, so importing this file costs the renderer bundle nothing (no zod at runtime).
 *
 * Wire rules (ARCH 9.3, enforced by the contract): discriminated unions of named objects, no tuples, no Date, Map or
 * BigInt. Instants are epoch milliseconds; calendar days are `YYYY-MM-DD` strings. Outputs use open string enums, so
 * a newer engine can add a value: switch with a default branch.
 */
import type * as z from 'zod/mini';
import type * as C from '@aplos/contract';

// ---------------------------------------------------------------------------
// Scalars and ids (schemas/common.ts)
// ---------------------------------------------------------------------------

/** An instant in epoch milliseconds. */
export type EpochMs = z.infer<typeof C.EpochMs>;
/** A non-negative integer (counts, `seq`, revisions). */
export type Count = z.infer<typeof C.Count>;
/** A calendar day with no time zone, `YYYY-MM-DD` (due dates, all-day events). */
export type LocalDate = z.infer<typeof C.LocalDate>;
/** An opaque contract id (`accountId:remoteId` for threads, ARCH 3.1). Never parse one. */
export type Id = z.infer<typeof C.Id>;
/** A client-made operation id, also the HTTP `Idempotency-Key`; replaying it never applies twice. */
export type OpId = z.infer<typeof C.OpId>;

/** Thin alias of `Id` for an account; never the literal `all`. */
export type AccountId = Id;
/** Thin alias of `Id` for a thread. */
export type ThreadId = Id;
/** Thin alias of `Id` for a message. */
export type MessageId = Id;
/** Thin alias of `Id` for a draft (stable across saves). */
export type DraftId = Id;
/** Thin alias of `Id` for a submission. */
export type SubmissionId = Id;
/** Thin alias of `Id` for an event or one occurrence. */
export type EventId = Id;
/** Thin alias of `Id` for a window from `View/watch`. */
export type WindowId = Id;

export type {
  /** An address with an optional display name. */
  Address,
  /** The change-log position `{dbEpoch, seq, sig?}` (ARCH 3.5): compare `seq` only within one `dbEpoch`. */
  State,
  /** What every command returns: `{opId, appliedState, undoUntil?, undoable?}`. */
  Receipt,
} from '@aplos/contract';

// ---------------------------------------------------------------------------
// Errors and the status vocabulary (errors.ts, status.ts)
// ---------------------------------------------------------------------------

export type {
  /** The `error` of a failed reply: `{type, message, path?, retryAfterMs?, resumeAt?, reasonCode?}`; show `message`. */
  ErrorBody,
  /** Why a call failed (open on the wire): `validation`, `notFound`, `stateMismatch`, `paused`, `unavailable`, ... */
  ErrorType,
  /** Stable copy keys for account states, setup rows and error replies (DESIGN 7.15 maps them to sentences). */
  ReasonCode,
  /** One status vocabulary (ARCH 6.4): `starting`, `ok`, `syncing`, `backfilling`, `paused`, `needsReauth`, ... */
  AccountStatus,
  /** `AccountStatus['state']`. */
  AccountState,
  /** `{status, reasonCode?, reconnectBy?, lastSyncAt?}` beside each account. */
  AccountHealth,
} from '@aplos/contract';

// ---------------------------------------------------------------------------
// Threads, messages, bodies and the mail frame (schemas/mail.ts)
// ---------------------------------------------------------------------------

/** Home's lanes: `do`, `update`, `low` (open). */
export type Lane = z.infer<typeof C.Lane>;
/** `important` or `normal` inside a lane (open). */
export type Importance = z.infer<typeof C.Importance>;
/** Who placed a thread in its lane: `heuristic`, `ai`, `rule`, `user` (open). */
export type RankSource = z.infer<typeof C.RankSource>;
/** Where a due date came from, in trust order: `user`, `structured`, `ai` (open). */
export type DueSource = z.infer<typeof C.DueSource>;
/** `ThreadRow.rank`: lane, importance, source, due band. */
export type Rank = z.infer<typeof C.Rank>;
/** `ThreadRow.summary`: `{state, text?, provider?, model?, local?, action?}`; `state: 'pending'` breathes. */
export type SummaryRef = z.infer<typeof C.SummaryRef>;
/** One of a thread row's participants (up to six). */
export type Participant = z.infer<typeof C.Participant>;
/** Attachment metadata on a message. */
export type AttachmentMeta = z.infer<typeof C.AttachmentMeta>;

export type {
  /** App-owned workflow facts on a thread: status, Later, due date, reminder, bookmark, reply state, Home visibility. */
  WorkflowState,
  /** The one preset next step Space runs; its icon comes from `kind`. */
  SuggestedAction,
  /** A body-free list row (ARCH 9.1). */
  ThreadRow,
  /** One message in a thread view (headers and attachments, no body). */
  Message,
  /** `MessageBody/get`: the plain-text rendering and its quoted ranges. */
  MessageBody,
  /** `Mail/frame`: a single-render `aplos-mail://m/<token>` URL plus host-chrome facts (`srcdoc` from the stand-in only). */
  MailFrame,
  /** Every `Thread/act` action, discriminated by `type`. */
  ThreadAction,
  /** A whole view or one of its sections at the state the owner saw, as a `Thread/act` target. */
  ThreadSelector,
  /** A command's lifecycle after its receipt (`applied`, `queued`, `syncing`, `synced`, `failed`, `conflict`, `cancelled`). */
  Operation,
  /** Parsed search: free text plus structured operators. */
  SearchQuery,
  /** What a window shows, discriminated by `kind`. */
  ViewSpec,
  /** "Why it's here": one sentence, a quote, the lane and who placed it. */
  WhyItsHere,
  /** The body of every `window` frame and of `View/watch`, `View/move` and `View/query` answers. */
  WindowBody,
} from '@aplos/contract';

/** The row type a window's ids refer to (open): `Thread`, `Message`, `Draft`, `Submission`, `Event`, `Plan`, `Conversation`, `SenderGroup`. */
export type RowType = z.infer<typeof C.RowType>;
/** A Low importance sender, the `lowSenders` window's row. */
export type SenderGroup = z.infer<typeof C.SenderGroup>;
/** A labelled run of a view, counted across the whole view: Home sections, Later groups, Low senders. */
export type WindowSection = z.infer<typeof C.WindowSection>;
/** Where a window should start: an absolute position, or relative to a known row. */
export type WindowAnchor = z.infer<typeof C.WindowAnchor>;

// ---------------------------------------------------------------------------
// Accounts, folders and counts (schemas/account.ts)
// ---------------------------------------------------------------------------

/** Mail adapter kind (open): `google`, `microsoft`, `imap`, `jmap`, `demo`. */
export type ProviderKind = z.infer<typeof C.ProviderKind>;
/** One block of sidebar numbers (all accounts, or one). */
export type CountsBlock = z.infer<typeof C.CountsBlock>;
/** A connect, reconnect or grant flow's mode (open): `new`, `reconnect`, `grantPermissions`. */
export type ConnectMode = z.infer<typeof C.ConnectMode>;
/** Where a connect flow is (open): `waiting`, `connected`, `failed`, `cancelled`. */
export type ConnectState = z.infer<typeof C.ConnectState>;

export type {
  /** An account with health, capabilities, lease and identities. */
  Account,
  /** What the account's host supports. */
  AccountCapabilities,
  /** A label or folder with its unread thread count. */
  Folder,
  /** Sidebar counts: `{all, accounts, folders}`. */
  Counts,
} from '@aplos/contract';

// ---------------------------------------------------------------------------
// Session and setup (schemas/session.ts)
// ---------------------------------------------------------------------------

/** First-sync progress for one account. */
export type SetupAccount = z.infer<typeof C.SetupAccount>;

export type {
  /** `Session/get`: versions, state, engine state, capabilities, `hasAccounts`, the engine clock. */
  Session,
  /** `Setup/status`: per-account rows, `done`, `partial`, `errors`. */
  SetupStatus,
  /** The content-free diagnostics bundle; the renderer formats it for the preview. */
  DiagnosticsBundle,
} from '@aplos/contract';

// ---------------------------------------------------------------------------
// Drafts and submissions (schemas/compose.ts)
// ---------------------------------------------------------------------------

/** An attachment on a draft: an upload (`blobId`) or a forwarded part (`source`). */
export type DraftAttachment = z.infer<typeof C.DraftAttachment>;
/** The send state machine (open): `queued`, `scheduled`, `sending`, `sent`, `uncertain`, `failed`, `cancelled`, `suspended`. */
export type SubmissionState = z.infer<typeof C.SubmissionState>;

export type {
  /** The fields a client writes with `Draft/set` (mode, reply-to message, recipients, html, attachments, signature). */
  DraftFields,
  /** A local or remote draft, compare-and-set by `revision`; `conflict` when another device changed it. */
  Draft,
  /** One send (undo-send and send later are one `notBefore` mechanism). */
  Submission,
  /** One `Submission/set` intent: `send`, `undo`, `sendNow`, `reschedule`, `sendAnyway`, `retry`. */
  SubmissionAction,
} from '@aplos/contract';

// ---------------------------------------------------------------------------
// Calendar (schemas/calendar.ts)
// ---------------------------------------------------------------------------

/** An RSVP answer (open): `needsAction`, `accepted`, `declined`, `tentative`. */
export type RsvpResponse = z.infer<typeof C.RsvpResponse>;

export type {
  /** A point or day in time: `utc`, `date` or `floating`; never a `Date`. */
  EventTime,
  /** One event or one occurrence of a series. */
  Event,
  /** A calendar with Aplos-side visibility and colour. */
  Calendar,
  /** A date or meeting found in mail, waiting to be confirmed or dismissed. */
  Plan,
} from '@aplos/contract';

// ---------------------------------------------------------------------------
// AI, Ask and consent (schemas/ai.ts)
// ---------------------------------------------------------------------------

/** The features with a provider and model each (open): `ask`, `summaries`, `drafts`, `plans`, `voice`. */
export type AiFeature = z.infer<typeof C.AiFeature>;
/** An AI provider id (open): `groq`, `openai`, `anthropic`, `gemini`, `openrouter`, `opencode-go`, `ollama`, `lmstudio`, `custom`. */
export type AiProviderId = z.infer<typeof C.AiProviderId>;
/** The Follow up nudge: a local suggestion, never a synced draft. */
export type FollowupSuggestion = z.infer<typeof C.FollowupSuggestion>;
/** One step of a run: the steady line and the fold's count. */
export type AskStep = z.infer<typeof C.AskStep>;

export type {
  /** `{provider, model}`. */
  ModelRef,
  /** A row of Settings → AI's provider table; never a key or any of its characters. */
  AiProvider,
  /** The versioned background-AI consent record (`Consent/get|grant|revoke`). */
  Consent,
  /** A citation: a message or a calendar event. */
  Citation,
  /** Something Ask prepared that happens only when accepted: `reply`, `addEvent`, `triage`. */
  Proposal,
  /** One stored Ask question and answer. */
  AskTurn,
  /** Ask history: a conversation of turns. */
  Conversation,
} from '@aplos/contract';

// ---------------------------------------------------------------------------
// Settings (schemas/settings.ts)
// ---------------------------------------------------------------------------

/** The renderer's own preferences, `Settings.ui`; defaults in `UI_SETTINGS_DEFAULTS` (index.ts). */
export type UiSettings = z.infer<typeof C.UiSettings>;
/** One remapped key: `{chord, phase?: 'tap' | 'hold'}`. */
export type KeyBinding = z.infer<typeof C.KeyBinding>;
/** `Settings.mail`. */
export type MailSettings = z.infer<typeof C.MailSettings>;
/** `Settings.ai`: a provider and model per feature, non-secret provider settings, background switch, daily cap. */
export type AiSettings = z.infer<typeof C.AiSettings>;

export type {
  /** The settings singleton: `ui`, `mail`, `notifications`, `host`, `retention`, `calendar`, `ai`. */
  Settings,
  /** A patch per section: the fields given replace those fields; object-valued fields are replaced whole. */
  SettingsPatch,
} from '@aplos/contract';

// ---------------------------------------------------------------------------
// Push frames (wire.ts)
// ---------------------------------------------------------------------------

/** A type a `state` frame reports (open): `Session`, `Account`, `Counts`, `Thread`, `Settings`, `Setup`, `Consent`, ... */
export type ChangeType = z.infer<typeof C.ChangeType>;

export type {
  /** Every push frame, discriminated by `frame`. */
  Frame,
  /** Host-channel events (`parked`, `clock`, `appearance`, ...), delivered in a `host` frame. */
  HostEvent,
  /** Events main sends a window itself (`engine` reachability, `closeRequested`, `shown`), in a `desktop` frame. */
  DesktopEvent,
} from '@aplos/contract';

/** Thin alias: the `window` frame, `{frame, dbEpoch, seq, ...WindowBody}`. */
export type WindowFrame = Extract<C.Frame, { frame: 'window' }>;
/** Thin alias: the `state` frame, `{frame, dbEpoch, seq, types}` (per type, the newest `seq` that touched it). */
export type StateFrame = Extract<C.Frame, { frame: 'state' }>;
/** Thin alias: the `reset` frame; every window reopens. */
export type ResetFrame = Extract<C.Frame, { frame: 'reset' }>;
/** Thin alias: the `progress` frame of a run (Ask, remote search, polish, transcription, setup). */
export type ProgressFrame = Extract<C.Frame, { frame: 'progress' }>;
/** Thin alias: the `connect` frame of an account connect, reconnect or grant. */
export type ConnectFrame = Extract<C.Frame, { frame: 'connect' }>;
/** Thin alias: the `operation` frame, an operation's state after its receipt. */
export type OperationFrame = Extract<C.Frame, { frame: 'operation' }>;
/** Thin alias: the `Draft/changed` frame. */
export type DraftChangedFrame = Extract<C.Frame, { frame: 'Draft/changed' }>;
/** Thin alias: the host event `{type: 'clock', now}`: the engine's clock jumped (a test clock, or a wake). */
export type ClockEvent = Extract<C.HostEvent, { type: 'clock' }>;
/** Thin alias: the host event `{type: 'parked', reasonCode, message, canRetry, at}`. */
export type ParkedEvent = Extract<C.HostEvent, { type: 'parked' }>;
/** Thin alias: main's desktop event `{type: 'engine', state, reasonCode?, message?, canRetry?, at}`. */
export type EngineEvent = Extract<C.DesktopEvent, { type: 'engine' }>;

// ---------------------------------------------------------------------------
// The method registry's type helpers (registry/index.ts)
// ---------------------------------------------------------------------------

export type {
  /** Every contract method name, `Type/verb`. */
  MethodName,
  /** Methods main serves (`Engine/restart`, `Diagnostics/copy`, `Window/*`, ...). */
  DesktopMethodName,
  /** A method's arguments. */
  Input,
  /** A method's result. */
  Output,
} from '@aplos/contract';
