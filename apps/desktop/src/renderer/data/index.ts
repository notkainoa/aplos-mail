/**
 * The renderer data surface (F9, frozen on day 3; plan 30 section 4.1 and U2).
 *
 * Screens read mail only through these hooks and `api`. After the freeze, changes are
 * additive only: new members may be added, nothing is renamed or removed.
 *
 * Every implementation below throws `NotImplementedError`. Lane `ui-shell` builds them in
 * U2 (days 4-8) as `client.ts`, `rows.ts`, `windows.ts`, `optimistic.ts` and `session.ts`
 * behind this file, first against the stand-in engine (F6), then against the real engine
 * by one flag (WP5.6).
 *
 * Not here: transport selection (MessagePort in Electron, tokenised HTTP and SSE in the
 * browser preview). That lives in `renderer/bridge.ts`, owned by `ui-shell`, and this
 * surface never exposes it.
 *
 * This file imports nothing from today's renderer, `shared/live`, `AppState` or
 * `engine/*`, and no React: hooks are typed as plain functions so the signatures can be
 * checked without a DOM.
 */

import type {
  AccountId,
  AccountRow,
  AccountStatus,
  AgendaQuery,
  AiConsentGrant,
  AiRequest,
  AiResult,
  AskAnswer,
  AskFrame,
  AskRequest,
  AttachmentId,
  AttachmentRef,
  ContractError,
  Counts,
  DiagnosticsPreview,
  DraftId,
  DraftInput,
  DraftRow,
  DraftSaveResult,
  DraftsViewSpec,
  EpochMs,
  EventRow,
  FrameKind,
  FrameMap,
  HomeGroupKey,
  HomeSection,
  MailFrameRef,
  MailFrameRequest,
  MessageBody,
  MessageId,
  MessageRow,
  OpId,
  OperationRemoteState,
  OperationState,
  ProviderKind,
  Receipt,
  RequestId,
  RowType,
  RowTypeMap,
  SendOptions,
  Session,
  SetupStatus,
  Settings,
  SettingsPatch,
  StateToken,
  SubmissionId,
  ThreadAction,
  ThreadId,
  ThreadRow,
  ThreadSelector,
  ThreadTarget,
  ThreadViewSpec,
  Transcript,
  UiSettings,
  ViewSpec,
  WhyItsHere,
  FollowupSuggestion,
  WindowGroup,
} from './contract-shapes';

export type * from './contract-shapes';

// ---------------------------------------------------------------------------
// Lane marker and the not-implemented error
// ---------------------------------------------------------------------------

/** The lane that implements this surface (roadmap 2.3). */
export const DATA_LANE = 'ui-shell' as const;

/** Thrown by every stub until `ui-shell` lands U2; names the member and the lane. */
export class NotImplementedError extends Error {
  /** Stable code for tests and logs. */
  readonly code = 'NOT_IMPLEMENTED' as const;
  /** Owning lane, always `ui-shell`. */
  readonly lane = DATA_LANE;
  /** The member that was called, for example `api.thread.act`. */
  readonly member: string;

  constructor(member: string) {
    super(`renderer/data: ${member} is not implemented yet. Lane ${DATA_LANE} builds it in U2 (days 4-8).`);
    this.name = 'NotImplementedError';
    this.member = member;
  }
}

function notImplemented(member: string): never {
  throw new NotImplementedError(member);
}

// ---------------------------------------------------------------------------
// Timing constants the data layer owns
// ---------------------------------------------------------------------------

/** Hold timing (DESIGN 5 rule 6, plan 30 4.3 holdGate): release 450 ms after the last key, cap 1200 ms. Mirrors DESIGN; `ui-shell` reads them from ui/generated/motion.ts once it exists. */
export const HOLD_TIMING = {
  /** Release this long after the last triage key or when the pointer leaves the list. */
  releaseAfterLastKeyMs: 450,
  /** A hold never lasts longer than this. */
  capMs: 1200,
} as const;

/** Prefetch-on-intent delays (DESIGN 5 rule 9). */
export const PREFETCH_TIMING = {
  /** Keyboard focus resting this long prefetches the body and both neighbours. */
  focusMs: 80,
  /** Pointer hover resting this long does the same. */
  hoverMs: 120,
} as const;

/** Most rows one window holds (ARCH 9.2). */
export const WINDOW_MAX_ROWS = 200;

// ---------------------------------------------------------------------------
// Operations: optimistic overlay, receipts, undo (DESIGN 5 rules 1 and 11)
// ---------------------------------------------------------------------------

/** What every optimistic command returns: the overlay is already applied when this returns (key-to-state within 8 ms, DESIGN 5 rule 1). */
export interface ActResult {
  /** Client-created operation id; use it with `useOperation` and `api.operation.undo`. */
  readonly opId: OpId;
  /** Resolves when the engine commits; rejects with `OperationFailedError` after the overlay has rolled back and the row shows its inline error. */
  readonly receipt: Promise<Receipt>;
}

/** Rejection value of `ActResult.receipt`. */
export class OperationFailedError extends Error {
  /** The failed operation. */
  readonly opId: OpId;
  /** The engine's error; `error.message` is the sentence to show. */
  readonly error: ContractError;

  constructor(opId: OpId, error: ContractError) {
    super(error.message);
    this.name = 'OperationFailedError';
    this.opId = opId;
    this.error = error;
  }
}

/** One operation as screens and toasts see it (DESIGN 7.13 "wording follows the op queue"). */
export interface OperationView {
  /** Operation id. */
  readonly opId: OpId;
  /** pending until the receipt, confirmed after it, failed on rejection. */
  readonly state: OperationState;
  /** Provider-side progress once confirmed ("Saved here · will sync" while queued offline); null while pending. */
  readonly remote: OperationRemoteState | null;
  /** The action, for toast wording; null for non-thread operations. */
  readonly action: ThreadAction | null;
  /** Target ids. For a selector target: empty while pending, the ids the engine resolved once confirmed. */
  readonly targets: readonly string[];
  /** The selector when the operation targeted a whole view or group; null for explicit ids. */
  readonly selector: ThreadSelector | null;
  /** Set when failed; `message` is shown as written. */
  readonly error: ContractError | null;
  /** True when `api.operation.undo` applies (confirmed or pending, not already undone). */
  readonly undoable: boolean;
  /** Re-sends the same operation with a new op id; the overlay re-applies at once. */
  retry(): ActResult;
}

/** An inline row error after a rejected write: the row is back in place with "Couldn't move to Later." and Retry (DESIGN 7.15). */
export interface RowFailure {
  /** The failed operation. */
  readonly opId: OpId;
  /** The action that failed, for the sentence. */
  readonly action: ThreadAction;
  /** The engine's sentence. */
  readonly message: string;
  /** Retry the same action. */
  retry(): ActResult;
  /** Clear the inline error without retrying. */
  dismiss(): void;
}

/** Observe one operation; undefined once it is forgotten (after its toast closes). */
export function useOperation(opId: OpId | undefined): OperationView | undefined {
  void opId;
  return notImplemented('useOperation');
}

// ---------------------------------------------------------------------------
// Views (ARCH 9.2 windows; plan 30 4.1 windows.ts)
// ---------------------------------------------------------------------------

/** Row type a spec yields: messages for the thread view, draft rows for Drafts, thread rows for every other view. */
export type RowForSpec<S extends ViewSpec> = S extends ThreadViewSpec ? MessageRow : S extends DraftsViewSpec ? DraftRow : ThreadRow;

/** `opening` before the first frame; `live` while frames apply; `reset` while reopening after a reset or `cannotCalculateChanges` (the previous ids stay on screen); `failed` when the view cannot open or stopped (remote search `quotaPaused` or `unavailable`, a thread that is gone): show `error.message` as an ErrorLine (DESIGN 7.15). */
export type ViewStatus = 'opening' | 'live' | 'reset' | 'failed';

/** A range of indices in the whole view, end exclusive; the data layer turns it into a keyset `View/move` anchor. */
export interface ViewRange {
  /** First index wanted. */
  readonly start: number;
  /** One past the last index wanted. */
  readonly end: number;
}

/** Options for `useView`. */
export interface UseViewOptions {
  /** Engine half of holding still (plan 30 4.1): rows around the cursor that a re-rank must not move. Non-empty also freezes the rendered order and queues frames until it empties again. Pass `HoldController.heldIds`. A change to `holdIds` never re-watches: the data layer sends `View/hold {windowId, ids}` or `View/release` on the open window and pings activity while it is non-empty, so status stays `live` and the offset is kept. */
  readonly holdIds?: readonly string[];
}

/** A watched window with the optimistic overlay applied. */
export interface ViewResult<R> {
  /** Ordered ids in the window as rendered: overlay applied, held order kept during a hold. */
  readonly ids: readonly string[];
  /** Index of `ids[0]` in the whole view. */
  readonly offset: number;
  /** Rows in the whole view, overlay applied. */
  readonly total: number;
  /** Rows by id from the row cache; an id may be missing while its row is fetched. */
  readonly rows: ReadonlyMap<string, R>;
  /** Groups for grouped views (home, later, home.low), counts overlay applied; empty otherwise. */
  readonly groups: readonly WindowGroup[];
  /** State token of the last applied frame; null while opening. */
  readonly state: StateToken | null;
  /** Window lifecycle. */
  readonly status: ViewStatus;
  /** Why the view failed; null unless `status` is `failed`. A thread view whose thread is gone fails with type `notFound`. */
  readonly error: ContractError | null;
  /** Rows whose last write was rejected, by id (DESIGN 5 rule 11). */
  readonly failures: ReadonlyMap<string, RowFailure>;
  /** Scroll the window; call with the virtualised list's visible range plus overscan. */
  move(range: ViewRange): void;
}

/** Watch one view (`View/watch`, `View/move`, `View/unwatch`, `View/hold`, `View/release`). Re-watches only when the spec changes by value, never for a `holdIds` change. */
export function useView<S extends ViewSpec>(spec: S, opts?: UseViewOptions): ViewResult<RowForSpec<S>> {
  void spec;
  void opts;
  return notImplemented('useView');
}

/** One Home section with its rows and counts (DESIGN 7.2). */
export interface HomeSectionView {
  /** Section key, in display order. */
  readonly key: HomeSection;
  /** Ids in this section within the current window, in order. For `do`, excludes the Back from Later block, whose ids are in `fromLater.ids` (render them after these). */
  readonly ids: readonly ThreadId[];
  /** Rows in the section across the whole view, the number beside the label. For `do`, includes Back from Later (DESIGN 7.2: it is a sub-label inside Do now); `fromLater.count` is the block alone. */
  readonly count: number;
  /** Index of the section's first row in the whole view (Tab and ⇧Tab jump here). */
  readonly start: number;
  /** Whether the label renders: count above 0, or emptied while a hold is active, in which case it shows 0 until the hold releases (DESIGN 5 rule 6). */
  readonly visible: boolean;
  /** `do` only: the Back from Later block at its bottom; null for other sections or when empty and not held. */
  readonly fromLater: HomeBlockView | null;
  /** Rows that arrived during a hold and wait to `arrive` ("2 new" beside the Do now label). */
  readonly waiting: number;
}

/** A sub-block inside a section (Back from Later). */
export interface HomeBlockView {
  /** Group key of the block. */
  readonly key: Extract<HomeGroupKey, 'fromLater'>;
  /** Ids in the block within the window. */
  readonly ids: readonly ThreadId[];
  /** Rows in the block across the view. */
  readonly count: number;
  /** Index of the block's first row in the whole view. */
  readonly start: number;
  /** Whether the sub-label renders (same rule as sections). */
  readonly visible: boolean;
}

/** The Low importance band (DESIGN 7.2): one line, up to three sender names, "and N more", a plain count. */
export interface LowBandView {
  /** Low-importance threads in the scope. */
  readonly count: number;
  /** Up to three sender names, most recent first. */
  readonly names: readonly string[];
  /** Senders beyond `names` ("and N more"). */
  readonly moreSenders: number;
}

/** Options for `useHome`. */
export interface UseHomeOptions {
  /** One account, or absent for All accounts. */
  readonly accountId?: AccountId;
  /** Engine half of holding still; pass `HoldController.heldIds`. */
  readonly holdIds?: readonly string[];
}

/** Home as sections: the `home` view plus the `home.low` band, section-aware. */
export interface HomeView {
  /** Do now, Important updates, Follow up, always all three in order; render those with `visible`. */
  readonly sections: readonly HomeSectionView[];
  /** The Low importance band; count 0 hides it. */
  readonly low: LowBandView;
  /** Rows by id (thread rows). */
  readonly rows: ReadonlyMap<ThreadId, ThreadRow>;
  /** Rows whose last write was rejected. */
  readonly failures: ReadonlyMap<ThreadId, RowFailure>;
  /** Do now plus Important updates plus Follow up across the view (inbox zero when 0 and the band is empty). */
  readonly total: number;
  /** Lifecycle of the underlying `home` window. */
  readonly status: ViewStatus;
  /** Why it failed; null unless `status` is `failed`. */
  readonly error: ContractError | null;
  /** Scroll the underlying `home` window. */
  move(range: ViewRange): void;
}

/** Home's section-aware helper over `useView({kind: 'home'})` and `useView({kind: 'home.low'})`. */
export function useHome(opts?: UseHomeOptions): HomeView {
  void opts;
  return notImplemented('useHome');
}

// ---------------------------------------------------------------------------
// Rows (plan 30 4.1 rows.ts)
// ---------------------------------------------------------------------------

/** One cached row by type and id; undefined until known and also when gone (use `useRowState` to tell them apart). Referentially stable while `rev` is unchanged, so it is safe in memo deps. */
export function useRow<T extends RowType>(type: T, id: string | undefined): RowTypeMap[T] | undefined {
  void type;
  void id;
  return notImplemented('useRow');
}

/** A row lookup that can say the row is gone (the reader open on a thread that was deleted or moved elsewhere). */
export interface RowState<R> {
  /** The row once known; stable while `rev` is unchanged. */
  readonly row: R | undefined;
  /** loading until the first answer; ready with a row; notFound once `T/get` reports the id in `notFound` or the row is destroyed. */
  readonly status: 'loading' | 'ready' | 'notFound';
}

/** One cached row with its lookup status, for screens that must show "This email is no longer here." instead of waiting forever. */
export function useRowState<T extends RowType>(type: T, id: string | undefined): RowState<RowTypeMap[T]> {
  void type;
  void id;
  return notImplemented('useRowState');
}

// ---------------------------------------------------------------------------
// Holding still, renderer half (DESIGN 5 rule 6; plan 30 4.1 and 4.3)
// ---------------------------------------------------------------------------

/** Why a hold started: a triage burst, or the pointer resting over the list. */
export type HoldReason = 'keys' | 'pointer';

/** Called when a hold releases; the motion lane runs `close` (FLIP from fixed row heights) here. */
export type HoldReleaseListener = (released: { readonly ids: readonly string[]; readonly reason: HoldReason }) => void;

/** One list's hold. Methods are synchronous and safe inside a keydown handler. */
export interface HoldController {
  /** Start or refresh a hold pinning `ids` (the rows around the cursor); restarts the 450 ms release timer within the 1200 ms cap. */
  begin(reason: HoldReason, ids: readonly string[]): void;
  /** Push the release back on another key, optionally adding ids; never past the cap. */
  extend(ids?: readonly string[]): void;
  /** Release now (pointer left the list, Esc, navigation). */
  release(): void;
  /** True while held. */
  readonly isHeld: boolean;
  /** Ids to pass as `holdIds` to `useView` or `useHome`; empty when not held. Changing them sends `View/hold` or `View/release`, never a re-watch. */
  readonly heldIds: readonly string[];
  /** Current reason, or null. */
  readonly reason: HoldReason | null;
  /** Subscribe to releases; returns an unsubscribe function. */
  onRelease(listener: HoldReleaseListener): () => void;
}

/** The hold controller for one list, keyed by a scope name such as `home` or `later`. */
export function useHold(scope: string): HoldController {
  void scope;
  return notImplemented('useHold');
}

// ---------------------------------------------------------------------------
// Prefetch on intent (DESIGN 5 rule 9)
// ---------------------------------------------------------------------------

/** Handle for one prefetch request. */
export interface PrefetchHandle {
  /** Cancel; harmless after completion. */
  cancel(): void;
}

/** Intent tracker for one list: applies the 80 ms focus and 120 ms hover delays and cancels the previous request on move. */
export interface PrefetchIntent {
  /** Keyboard focus rests on a thread (after 80 ms); `neighbours` are the rows above and below. */
  focus(threadId: ThreadId, neighbours: readonly ThreadId[]): void;
  /** Pointer rests on a thread (after 120 ms); `neighbours` as for `focus`. */
  hover(threadId: ThreadId, neighbours: readonly ThreadId[]): void;
  /** Cancel any pending or running prefetch. */
  cancel(): void;
}

/** Prefetch on intent for a list. */
export function usePrefetchIntent(): PrefetchIntent {
  return notImplemented('usePrefetchIntent');
}

// ---------------------------------------------------------------------------
// Message bodies (DESIGN 5 rules 9-10, 7.5)
// ---------------------------------------------------------------------------

/** A body request's state; the reader keeps the previous letter on screen until `ready` (double buffer). */
export interface BodyResult {
  /** idle with no id, loading, ready, or failed ("Couldn't load this email · Try again"). */
  readonly status: 'idle' | 'loading' | 'ready' | 'failed';
  /** True once loading passes 1.5 s: show the 12 px loading line (DESIGN 5 rule 10). */
  readonly slow: boolean;
  /** The body when ready; html bodies then ask `api.mail.frame` for the frame URL. */
  readonly body: MessageBody | undefined;
  /** Set when failed. */
  readonly error: ContractError | null;
  /** Try again. */
  retry(): void;
}

/** Load one message body (`MessageBody/get`), served from the engine's LRU after a prefetch. */
export function useMessageBody(messageId: MessageId | undefined): BodyResult {
  void messageId;
  return notImplemented('useMessageBody');
}

// ---------------------------------------------------------------------------
// Session, accounts, status slot, counts, setup, settings (ARCH 6.4, 9.5)
// ---------------------------------------------------------------------------

/** The session singleton; undefined until `Session/get` answers. Whether the engine is still coming or gone is `useConnection`'s job. */
export function useSession(): Session | undefined {
  return notImplemented('useSession');
}

/** The data layer's link to the engine: `connecting` until `Session/get` answers (and while reconnecting), `ready`, `unreachable` when the transport is gone and does not come back (FatalScreen "Aplos can't reach its mail engine.", DESIGN 7.15), `parked` after a `parked` frame (FatalScreen with Try again and Export diagnostics, plan 30 4.5 #3). */
export type ConnectionState = 'connecting' | 'ready' | 'unreachable' | 'parked';

/** Connection state for the FatalScreen and the status slot. */
export interface ConnectionView {
  /** Current state. */
  readonly state: ConnectionState;
  /** The parked frame's sentence, or a plain transport sentence when unreachable; null otherwise. */
  readonly reason: string | null;
}

/** Whether the engine is reachable, connecting or parked. Transport details stay in `bridge.ts`. */
export function useConnection(): ConnectionView {
  return notImplemented('useConnection');
}

/** All accounts, in sidebar order, with status and `reconnectBy`. */
export function useAccounts(): readonly AccountRow[] {
  return notImplemented('useAccounts');
}

/** What the status slot shows (DESIGN 7.1 table). */
export interface StatusSlotState {
  /** The account the line is about; null when no account exists. */
  readonly account: AccountRow | null;
  /** The status to render. */
  readonly status: AccountStatus;
  /** True when `account.reconnectBy` falls within 24 hours: "Gmail will ask you to reconnect tomorrow at 9:00 AM." */
  readonly reconnectSoon: boolean;
  /** True when the account is the demo account and nothing more urgent applies. */
  readonly demo: boolean;
}

/** The one status line for a scope, most urgent first: misconfigured, needsReauth, needsPermission, needsAdmin, error, paused, offline, reconnect soon, backfilling, syncing, starting, demo, ok. Undefined with no accounts. */
export function useStatus(accountId?: AccountId): StatusSlotState | undefined {
  void accountId;
  return notImplemented('useStatus');
}

/** Sidebar counts for a scope. */
export interface CountsView {
  /** The counts. */
  readonly counts: Counts;
  /** True while any account in scope is in its first sync (no `baselineDoneAt`): counts hide (DESIGN 7.1). */
  readonly hidden: boolean;
}

/** Sidebar counts: Home is Do now (with Back from Later) plus Important updates, Later is due now, Drafts; plus `handledToday` for inbox zero. */
export function useCounts(accountId?: AccountId): CountsView {
  void accountId;
  return notImplemented('useCounts');
}

/** Events in a range, live, for Today and Home's inbox-zero "Next: Design review at 2:00 PM" (DESIGN 7.14). */
export interface AgendaView {
  /** Events ordered by start, all-day first within a day. */
  readonly events: readonly EventRow[];
  /** loading until the first answer, then ready; failed with `error` set. */
  readonly status: 'loading' | 'ready' | 'failed';
  /** Set when failed. */
  readonly error: ContractError | null;
}

/** Watch events in a range (`Event/query`, refreshed by `state` frames for type Event). The calendar grid, Event/set and Event/rsvp are additive for `ui-calendar`. */
export function useAgenda(query: AgendaQuery): AgendaView {
  void query;
  return notImplemented('useAgenda');
}

/** First-sync progress (`Setup/status`), live; undefined until known. */
export function useSetupStatus(): SetupStatus | undefined {
  return notImplemented('useSetupStatus');
}

/** The settings singleton, live; undefined until known. */
export function useSettings(): Settings | undefined {
  return notImplemented('useSettings');
}

/** The `ui` object's defaults (gap list U11): F1's documented defaults (schemas/settings.ts), what a fresh install and the stand-in engine start with. */
export const UI_SETTINGS_DEFAULTS: UiSettings = {
  theme: 'system',
  density: 'default',
  keyHints: 'tooltip',
  singleKeys: true,
  holdMs: 250,
  dock: { open: false, tab: 'ask' },
  keymap: {},
  sidebarMinimised: false,
  swipe: true,
  swipeDirection: 'doneRight',
  zen: false,
  sendSound: true,
  devDetails: false,
  lastAccount: 'all',
  palette: { recents: [] },
  calendar: {},
};

// ---------------------------------------------------------------------------
// Push frames: streamed progress, connect flows, the engine clock
// ---------------------------------------------------------------------------

/** The fields `useFrames` can filter each frame kind by; other fields are not filterable. */
export interface FrameFilterFields {
  /** Run progress: one run, one source ('ask', 'search'), or one Ask turn. */
  progress: 'runId' | 'source' | 'turnId';
  /** Connect flows: one flow (`connectId` = `AccountFlow.requestId`), one account, or one mode. */
  connect: 'connectId' | 'accountId' | 'mode';
  /** The clock is one stream; no filter. */
  clock: never;
}

/** Only frames whose listed fields equal these values. Compared by value, so an inline object literal never resubscribes. */
export type FrameFilter<K extends FrameKind> = Partial<Pick<FrameMap[K], FrameFilterFields[K] & keyof FrameMap[K]>>;

/** Options for `useFrames`. */
export interface UseFramesOptions {
  /** Keep at most this many frames, dropping the oldest. Default 200. */
  readonly max?: number;
}

/** The matching frames of one kind. */
export interface FramesView<F> {
  /** Matching frames in arrival order: since the hook mounted, or since the run started when the filter names a live run (`runId` or `connectId`). */
  readonly frames: readonly F[];
  /** The newest matching frame; undefined until one arrives. */
  readonly last: F | undefined;
}

/** Subscribe to push frames of one kind (Ask `progress`, `connect` for "Waiting for Google in your browser…", `clock`; first sync is `useSetupStatus`), batched per animation frame (DESIGN 5 rule 13). Changing the filter's values restarts the buffer. */
export function useFrames<K extends FrameKind>(kind: K, filter?: FrameFilter<K>, opts?: UseFramesOptions): FramesView<FrameMap[K]> {
  void kind;
  void filter;
  void opts;
  return notImplemented('useFrames');
}

// ---------------------------------------------------------------------------
// The clock (DESIGN 5 rule 15; gap list U9, E3)
// ---------------------------------------------------------------------------

/** How often `useNow` re-renders: every second (a countdown) or on each minute boundary (the now-line, "Synced 2 min ago"). */
export type NowGranularity = 'second' | 'minute';

/** Options for `useNow`. */
export interface UseNowOptions {
  /** Tick rate. */
  readonly granularity: NowGranularity;
}

/** A source of now; the harness injects a frozen one with `setClock`. */
export interface Clock {
  /** Epoch milliseconds. */
  now(): EpochMs;
}

/** The harness's frozen wall-clock time, local to `HARNESS_TIME_ZONE` with the en-US locale (ui/README "Times are ISO strings"). */
export const HARNESS_NOW_LOCAL = '2026-10-29T10:00:00' as const;

/** The harness's time zone: it runs with `TZ=America/Los_Angeles`, so `HARNESS_NOW_LOCAL` is 2026-10-29T10:00:00-07:00 and fixture epochs render the same on every machine. */
export const HARNESS_TIME_ZONE = 'America/Los_Angeles' as const;

/** The harness's frozen now as epoch ms (`HARNESS_NOW_LOCAL` in `HARNESS_TIME_ZONE`, PDT). */
export const HARNESS_NOW_MS: EpochMs = Date.UTC(2026, 9, 29, 17, 0, 0);

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Epoch ms to the local calendar day, "2026-10-29", for props typed `IsoDate` (MiniMonth `today`). Local, never UTC, so the day does not flip at 5 PM in Pacific time. */
export function toIsoDate(ms: EpochMs): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Epoch ms to local wall-clock time with its offset, "2026-10-29T10:00:00-07:00", for props typed `IsoDateTime` (CalendarGrid `now`). Never `toISOString()`, which is UTC. */
export function toIsoDateTime(ms: EpochMs): string {
  const d = new Date(ms);
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return `${toIsoDate(ms)}T${time}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/**
 * The one renderer clock, as epoch ms truncated to the granularity. Every label that
 * depends on now (Today, the now-line, "reconnect within 24 hours", "Resuming at 2:14 PM")
 * reads this, never `Date.now()`. Source, first that applies: a clock injected with
 * `setClock`; the engine's fixture clock (`Session/get` now plus `clock` events, test
 * builds only); `Date.now()`. Props take ISO strings: convert with `toIsoDateTime` and
 * `toIsoDate`. Ticks pause while the window is hidden and catch up at
 * once when it shows again (DESIGN 5 rule 15).
 */
export function useNow(opts: UseNowOptions): EpochMs {
  void opts;
  return notImplemented('useNow');
}

/** Now from the same source as `useNow`, for event handlers (no subscription). */
export function getNow(): EpochMs {
  return notImplemented('getNow');
}

/** Injects the clock `useNow` and `getNow` read (the harness's frozen 2026-10-29T10:00, unit tests); null restores the default source. */
export function setClock(clock: Clock | null): void {
  void clock;
  notImplemented('setClock');
}

// ---------------------------------------------------------------------------
// One undo stack for engine operations and local changes (gap list U7)
// ---------------------------------------------------------------------------

/** A change outside the engine that Z can undo: a settings write, a remap ("Done is now L · Undo Z"). */
export interface LocalUndo {
  /** The toast text before "· Undo Z", in DESIGN 10's voice, e.g. "Done is now L". */
  readonly label: string;
  /** Puts the previous state back (usually `api.settings.set` with the old value); a rejection is reported like a failed write. */
  undo(): void | Promise<void>;
}

/** One entry on the undo stack, newest last. */
export type UndoEntry =
  /** An engine operation, pushed by the data layer whenever an undoable write is issued (`api.thread.act`); the toast words it from `useOperation(opId)`. */
  | { readonly kind: 'operation'; readonly id: string; readonly opId: OpId }
  /** A local change pushed by a screen; the toast shows `label`. */
  | { readonly kind: 'local'; readonly id: string; readonly label: string };

/** What Z did. */
export type UndoOutcome =
  /** Undid an engine operation through `api.operation.undo` (an inverse operation; the overlay applies at once). */
  | { readonly kind: 'operation'; readonly opId: OpId; readonly result: ActResult }
  /** Ran a local undo. */
  | { readonly kind: 'local'; readonly label: string; readonly done: Promise<void> };

/** A pushed local entry. */
export interface UndoHandle {
  /** Entry id. */
  readonly id: string;
  /** Drop the entry without undoing (the change was superseded). */
  forget(): void;
}

/** The one stack Z reads, so Z undoes the most recent change of either kind (DESIGN 5 rule 11, 7.13). `api.operation.undoLast` covers engine operations only; the shell's `app.undo` calls `undoStack.undoLast()`. */
export interface UndoStack {
  /** Push a local change; engine operations join by themselves. */
  push(entry: LocalUndo): UndoHandle;
  /** Z: undo the newest entry, skipping operations that can no longer be undone; null when nothing can be. */
  undoLast(): UndoOutcome | null;
  /** The newest entry that can still be undone; null when none. */
  peek(): UndoEntry | null;
}

/** The app's undo stack. Every method throws `NotImplementedError` until U2. */
export const undoStack: UndoStack = {
  push: () => notImplemented('undoStack.push'),
  undoLast: () => notImplemented('undoStack.undoLast'),
  peek: () => notImplemented('undoStack.peek'),
};

/** The newest undoable entry, live, for the toast and its "· Undo Z". */
export function useUndoTop(): UndoEntry | null {
  return notImplemented('useUndoTop');
}

// ---------------------------------------------------------------------------
// The command surface
// ---------------------------------------------------------------------------

/** A started submission. */
export interface SubmissionReceipt {
  /** Submission id; watch it with `useRow('Submission', id)` for the UndoTray. */
  readonly submissionId: SubmissionId;
  /** Receipt of the queueing. */
  readonly receipt: Receipt;
}

/** An account connect or reconnect flow in the browser ("Waiting for Google in your browser…"). */
export interface AccountFlow {
  /** Flow id. */
  readonly requestId: RequestId;
  /** Resolves with the account once connected; rejects with `OperationFailedError` on refusal or cancel. */
  readonly done: Promise<AccountRow>;
  /** Cancel the flow (the sheet's Cancel). */
  cancel(): void;
}

/** A running Ask request with its `progress` frames. */
export interface AskRun {
  /** Request id. */
  readonly requestId: RequestId;
  /** Subscribe to frames in order; returns an unsubscribe function. Late subscribers get frames from the start. */
  subscribe(listener: (frame: AskFrame) => void): () => void;
  /** Resolves with the final answer; rejects with `OperationFailedError` ("Groq didn't answer."). */
  readonly answer: Promise<AskAnswer>;
  /** Stop the run (Esc). */
  cancel(): void;
}

/** Arguments for connecting a new account. */
export interface ConnectRequest {
  /** Provider; round 1 is Gmail only. */
  readonly provider: ProviderKind;
  /** Address typed by the owner, passed to the provider as `login_hint`. */
  readonly loginHint?: string;
}

/** The typed command surface the screens call. Methods map one to one onto contract methods (see `CONTRACT_METHODS`); the F2 client drops in under the data layer. */
export interface DataApi {
  /** Thread commands. */
  readonly thread: {
    /** Act on threads with the optimistic overlay applied synchronously (`Thread/act`). A selector target (a whole view or one group, past the 200-row window) overlays the rows in open windows and the group counts at once; the receipt covers every resolved row. */
    act(target: ThreadTarget, action: ThreadAction): ActResult;
    /** "Why it's here" for one thread. */
    why(threadId: ThreadId): Promise<WhyItsHere>;
    /** The follow-up nudge suggestion, or null with AI off, not consented or not ready. */
    followup(threadId: ThreadId): Promise<FollowupSuggestion | null>;
    /** Unsubscribe through List-Unsubscribe (`Unsubscribe/run`). */
    unsubscribe(threadId: ThreadId): Promise<Receipt>;
  };
  /** Operation commands. */
  readonly operation: {
    /** Undo by applying the inverse operation (`Operation/undo`); the overlay applies at once. */
    undo(opId: OpId): ActResult;
    /** Undo the most recent undoable operation (Z); null when there is none. */
    undoLast(): ActResult | null;
  };
  /** Sending (undo-send and send-later are one mechanism, ARCH 7.2). */
  readonly submission: {
    /** Send after the undo window; `{markDone: true}` is ⌘⇧Return (one operation, one notice). */
    send(draftId: DraftId, opts?: SendOptions): Promise<SubmissionReceipt>;
    /** Schedule a send; `opts` as for `send`. */
    sendLater(draftId: DraftId, at: EpochMs, opts?: SendOptions): Promise<SubmissionReceipt>;
    /** Undo before `notBefore`; the draft comes back. */
    undo(submissionId: SubmissionId): Promise<Receipt>;
    /** Send now: skip the undo window, "Send now" on suspended, "Send anyway" on uncertain, "Try again" on failed. */
    sendNow(submissionId: SubmissionId): Promise<Receipt>;
    /** Reschedule a queued or suspended send. */
    reschedule(submissionId: SubmissionId, at: EpochMs): Promise<Receipt>;
  };
  /** Drafts (compare-and-set by revision, ARCH 7.4). */
  readonly draft: {
    /** Save; rejects with `stateMismatch` on a stale base revision. */
    save(input: DraftInput): Promise<DraftSaveResult>;
    /** Discard a draft. */
    discard(draftId: DraftId): Promise<Receipt>;
    /** Resolve "This draft changed on another device." */
    resolveConflict(draftId: DraftId, choice: 'keepMine' | 'takeTheirs' | 'keepBoth'): Promise<Receipt>;
  };
  /** Message bodies. */
  readonly body: {
    /** One body. */
    get(messageId: MessageId): Promise<MessageBody>;
    /** Warm the engine's LRU of 12 rendered bodies for these threads (thread-granular, ARCH AM-1: list rows carry thread ids, not message ids); cancel on move. */
    prefetch(threadIds: readonly ThreadId[]): PrefetchHandle;
  };
  /** The sandboxed mail frame (ARCH 10). */
  readonly mail: {
    /** A single-render frame URL plus host-chrome facts. */
    frame(req: MailFrameRequest): Promise<MailFrameRef>;
    /** Free a frame token when the reader replaces it. */
    releaseFrame(url: string): Promise<void>;
    /** "Load images from this sender": adds the address to `Settings.mail.imageAllowSenders` (no read-modify-write race); re-request the frame afterwards. Removal is a `settings.set` of the list. */
    allowImagesFrom(address: string): Promise<Receipt>;
  };
  /** Attachments over the blob route (never base64). */
  readonly attachment: {
    /** Fetch the bytes. */
    get(attachmentId: AttachmentId): Promise<Blob>;
    /** Upload a file for a draft (Attach a file, ⌘⇧A, DESIGN 7.6); bytes move as a transferable or the blob route, never base64; over 25 MB rejects with `invalidArguments`. Put the returned id in `DraftInput.attachments`. */
    put(data: Blob | ArrayBuffer, name: string, mime: string): Promise<AttachmentRef>;
  };
  /** Sync control. */
  readonly sync: {
    /** "Retry now" on a pause, or a manual refresh; absent account means all. */
    request(accountId?: AccountId): Promise<void>;
  };
  /** Accounts. */
  readonly account: {
    /** Connect a new account (onboarding, Settings → Add account). */
    connect(req: ConnectRequest): AccountFlow;
    /** Weekly reconnect with `login_hint`; no resync, queued changes kept (roadmap N3). */
    reconnect(accountId: AccountId): AccountFlow;
    /** Cancel a flow by id when its `AccountFlow` handle is gone (a reopened sheet found it with `useFrames('connect', {accountId})`); resolves false when it already ended. */
    cancelConnect(requestId: RequestId): Promise<boolean>;
    /** "Use this account's mail for AI" (ARCH 8.3, plan 30 8.1 item 6). */
    setAiAllowed(accountId: AccountId, allowed: boolean): Promise<Receipt>;
  };
  /** First-sync session (`Setup/*`); the UI calls `end` on every window close. */
  readonly setup: {
    /** Begin a setup session. */
    begin(): Promise<void>;
    /** End it; idempotent. */
    end(): Promise<void>;
    /** First sync's "Try again" for one account (`notConnected`, `failed` or `partial`, DESIGN 7.12); idempotent, resumes from the checkpoint. */
    retry(accountId: AccountId): Promise<void>;
  };
  /** Demo mail on request (plan 30 8.1 item 11). */
  readonly demo: {
    /** Load demo mail. */
    load(): Promise<Receipt>;
    /** Reset demo mail. */
    reset(): Promise<Receipt>;
    /** Remove demo mail. */
    remove(): Promise<Receipt>;
  };
  /** Settings. */
  readonly settings: {
    /** Read the singleton (prefer `useSettings` in components). */
    get(): Promise<Settings>;
    /** Change fields. */
    set(patch: SettingsPatch): Promise<Receipt>;
  };
  /** Ask (DESIGN 7.7). */
  readonly ask: {
    /** Run a question; frames stream through the returned handle. */
    run(req: AskRequest): AskRun;
  };
  /** Interactive AI. */
  readonly ai: {
    /** Draft, polish or re-summarise. */
    request<R extends AiRequest>(req: R): Promise<Extract<AiResult, { kind: R['kind'] }>>;
    /** Speech to text; audio moves as a transferable buffer or blob, never base64. */
    transcribe(audio: Blob | ArrayBuffer, mime: string): Promise<Transcript>;
    /** Record Allow on the consent card (or null to revoke in Settings); "Not now" records nothing. */
    setConsent(grant: AiConsentGrant): Promise<Receipt>;
  };
  /** The engine process, through main (it works when the engine cannot answer). */
  readonly engine: {
    /** "Restart engine" on the unreachable FatalScreen and "Try again" when parked; resolves once the restart begins, and `useConnection` reports the outcome. */
    restart(): Promise<void>;
  };
  /** The content-free diagnostics bundle (ARCH 11). */
  readonly diagnostics: {
    /** The bundle text for the preview Dialog (Help → Export diagnostics). */
    preview(): Promise<DiagnosticsPreview>;
    /** "Copy diagnostics": copies the bundle to the clipboard; when the engine is unreachable or parked, main builds a host-only bundle instead. */
    copy(): Promise<void>;
  };
}

/** Dotted name of every `api` method, for example `thread.act`. */
export type ApiMethodName = {
  [G in keyof DataApi]: `${G & string}.${keyof DataApi[G] & string}`;
}[keyof DataApi];

/** How a method reaches the engine: a plain call, a call wrapped by the optimistic overlay, a streamed call, data-layer only, or a native method served by main. */
export type ContractCallKind = 'call' | 'overlay' | 'stream' | 'local' | 'native';

/** One row of the method mapping the F2 client must satisfy. */
export interface ContractMethodRef {
  /** Contract wire method (for example `Thread/act`), or the blob route for binary data. */
  readonly method: string;
  /** How it is called. */
  readonly kind: ContractCallKind;
  /** `planned`: named in plan 10 or ARCH; `ask`: this surface asks F1 to add or confirm it. */
  readonly source: 'planned' | 'ask';
  /** Arguments or notes the contract must support. */
  readonly needs: string;
}

/** The expected mapping from `api` method to contract method, checked complete at compile time. The freeze reviewer checks F1 against it. */
export const CONTRACT_METHODS = {
  'thread.act': { method: 'Thread/act', kind: 'overlay', source: 'planned', needs: '{opId, ids | query: {spec, group?, atState}, action}; every ThreadAction kind incl. setLane; returns receipt {opId, appliedState, appliedSeq}; ask: query targets and setLane' },
  'thread.why': { method: 'Thread/why', kind: 'call', source: 'ask', needs: '{threadId} -> {sentence, quote, rankSource}' },
  'thread.followup': { method: 'Thread/followup', kind: 'call', source: 'ask', needs: '{threadId} -> {threadId, text} | null; eng-ai followup job output' },
  'thread.unsubscribe': { method: 'Unsubscribe/run', kind: 'call', source: 'planned', needs: '{threadId} -> receipt' },
  'operation.undo': { method: 'Operation/undo', kind: 'overlay', source: 'planned', needs: '{opId} -> receipt whose opId is the inverse operation' },
  'operation.undoLast': { method: 'Operation/undo', kind: 'local', source: 'planned', needs: 'data layer tracks the last undoable opId' },
  'submission.send': { method: 'Submission/set', kind: 'call', source: 'planned', needs: '{action: send, draftId, markDone?} -> {submissionId, receipt}; notBefore = now + undoSeconds; row has queuedAt; ask: markDone in the same operation' },
  'submission.sendLater': { method: 'Submission/set', kind: 'call', source: 'planned', needs: '{action: send, draftId, notBefore, markDone?}' },
  'submission.undo': { method: 'Submission/set', kind: 'call', source: 'planned', needs: '{action: undo, submissionId}' },
  'submission.sendNow': { method: 'Submission/set', kind: 'call', source: 'ask', needs: '{action: sendNow, submissionId}; valid for queued, suspended, uncertain, failed' },
  'submission.reschedule': { method: 'Submission/set', kind: 'call', source: 'ask', needs: '{action: reschedule, submissionId, notBefore}' },
  'draft.save': { method: 'Draft/set', kind: 'call', source: 'planned', needs: 'create or update with baseRevision (ifInState); stateMismatch on conflict; ask: source {messageId, mode} on create, forward copies attachments' },
  'draft.discard': { method: 'Draft/set', kind: 'call', source: 'planned', needs: 'destroy' },
  'draft.resolveConflict': { method: 'Draft/set', kind: 'call', source: 'ask', needs: '{draftId, resolve: keepMine|takeTheirs|keepBoth}; Draft/changed frame sets changedElsewhere' },
  'body.get': { method: 'MessageBody/get', kind: 'call', source: 'planned', needs: '{messageId} -> {bodyKind, text, quotedRanges}' },
  'body.prefetch': { method: 'MessageBody/prefetch', kind: 'call', source: 'ask', needs: '{threadIds} (thread-granular, ARCH AM-1) with cancel (a requestId, or a second call with an empty list)' },
  'mail.frame': { method: 'Mail/frame', kind: 'call', source: 'planned', needs: '{messageId, imagePolicy, findQuery, showQuotes?} -> {url, expiresAt, bodyKind, trackersRemoved, hasRemoteImages, quotedCount}; honours imageAllowSenders; srcdoc from the stand-in only' },
  'mail.releaseFrame': { method: 'Mail/frame.release', kind: 'call', source: 'planned', needs: '{url}' },
  'mail.allowImagesFrom': { method: 'Mail/allowImagesFrom', kind: 'call', source: 'ask', needs: '{address} -> receipt; appends to Settings.mail.imageAllowSenders (name is eng-contract\'s call)' },
  'attachment.get': { method: 'GET /v1/blob/:id', kind: 'call', source: 'planned', needs: 'transferable ArrayBuffer on MessagePort, blob route on HTTP; never base64' },
  'attachment.put': { method: 'Blob/put (PUT /v1/blob)', kind: 'call', source: 'ask', needs: '{data, name, mime} -> AttachmentRef {id, name, mime, size, state}; 25 MB cap; transferable on MessagePort; never base64' },
  'sync.request': { method: 'Sync/request', kind: 'call', source: 'planned', needs: '{accountId?}; also clears a throttle pause for Retry now' },
  'account.connect': { method: 'Account/connect', kind: 'stream', source: 'planned', needs: '{provider, loginHint?} -> requestId; progress frames; cancel' },
  'account.reconnect': { method: 'Account/reconnect', kind: 'stream', source: 'planned', needs: '{accountId} with login_hint, no resync, queued changes kept; cancel' },
  'account.cancelConnect': { method: 'Account/cancelConnect', kind: 'call', source: 'planned', needs: '{connectId} -> {cancelled}; a late answer is then ignored (F1 f1-gaps)' },
  'account.setAiAllowed': { method: 'Account/set', kind: 'call', source: 'ask', needs: '{accountId, aiAllowed} -> receipt; plan 10 freeze row 6 names per-account aiAllowed, the verb is eng-contract\'s call' },
  'setup.begin': { method: 'Setup/begin', kind: 'call', source: 'planned', needs: '{}' },
  'setup.end': { method: 'Setup/end', kind: 'call', source: 'planned', needs: '{}; idempotent' },
  'setup.retry': { method: 'Setup/retry', kind: 'call', source: 'ask', needs: '{accountId}; idempotent, resumes from the checkpoint (F5); name is eng-contract\'s call' },
  'demo.load': { method: 'Demo/load', kind: 'call', source: 'planned', needs: 'idempotent; demo accounts only' },
  'demo.reset': { method: 'Demo/reset', kind: 'call', source: 'planned', needs: 'idempotent; demo accounts only' },
  'demo.remove': { method: 'Demo/remove', kind: 'call', source: 'planned', needs: 'idempotent; demo accounts only' },
  'settings.get': { method: 'Settings/get', kind: 'call', source: 'planned', needs: 'Settings with the ui object' },
  'settings.set': { method: 'Settings/set', kind: 'call', source: 'planned', needs: 'per section, the fields given replace those fields; object-valued fields (dock, keymap, palette, calendar) are replaced whole -> receipt' },
  'ask.run': { method: 'Ask/run', kind: 'stream', source: 'planned', needs: 'progress frames step {id, text, state, count?}|text|citation (message {n, messageId, threadId, quote, fromName?, date?, subject?} or event {n, eventId, title, start})|proposal|done|error; cancel' },
  'ai.request': { method: 'Ai/request', kind: 'call', source: 'planned', needs: 'kinds draft, polish, summary' },
  'ai.transcribe': { method: 'Blob/put + Ai/request', kind: 'call', source: 'ask', needs: 'audio as a transferable buffer, then {kind: transcribe, blobId} -> {text}' },
  'ai.setConsent': { method: 'Consent/set', kind: 'call', source: 'planned', needs: '{providerId, model, version} | null -> receipt; Settings.ai.consent and consentVersion carry the record (plan 10 freeze row 6 Consent/*; the verb is eng-contract\'s call)' },
  'engine.restart': { method: 'native engine.restart (main native-methods.ts)', kind: 'native', source: 'ask', needs: 'restarts or un-parks the engine utilityProcess; works when the engine cannot answer' },
  'diagnostics.preview': { method: 'Diagnostics/preview', kind: 'call', source: 'planned', needs: '{} -> {text, generatedAt}; content-free' },
  'diagnostics.copy': { method: 'Diagnostics/preview, native fallback through main', kind: 'native', source: 'ask', needs: 'clipboard write of the bundle; main builds a host-only bundle when the engine is unreachable or parked' },
} as const satisfies Record<ApiMethodName, ContractMethodRef>;

/** What the hooks need from the contract besides `api`, for the freeze reviewer. */
export const CONTRACT_HOOK_NEEDS = {
  useView: 'View/watch {spec, holdIds?} -> window {windowId, state, seq, ids, total, changed, offset, groups}; View/move {windowId, anchor}; View/unwatch; reset frame; a failed window carries a ContractError; drafts spec yields Draft rows; Thread/get, Message/get and Draft/get for unknown or changed ids',
  useHome: 'home spec with groups do, fromLater, update, follow; home.low spec with groups by sender (label = name)',
  useRow: 'T/get {ids} -> {state, list, notFound}; state frames per type',
  useRowState: 'as useRow; notFound ids and destroyed rows report notFound',
  useOperation: 'receipts; Operation rows in state frames for remote progress',
  useHold: 'View/hold {windowId, ids}, View/release {windowId} and an activity ping on the open window (holds expire about 2 s after the last activity); never a re-watch',
  usePrefetchIntent: 'MessageBody/prefetch {threadIds} with cancel',
  useMessageBody: 'MessageBody/get',
  useSession: 'Session/get {apiVersion, appVersion, schemaVersion, dbEpoch, capabilities, hasAccounts}',
  useConnection: 'the parked push frame {reason, since}, sent by main when the engine cannot; transport state from bridge.ts',
  useAccounts: 'Account/get and state frames; status per ARCH 6.4; reconnectBy, baselineDoneAt, isDemo',
  useStatus: 'as useAccounts',
  useCounts: 'Counts singleton {unread, home, laterDue, drafts, handledToday} per scope, in state frames; home includes Back from Later',
  useAgenda: 'Event/query {from, to, calendarIds?} -> EventRow[]; state frames for type Event',
  useSetupStatus: 'Setup/status per plan 10 4.1, pushed while setup runs',
  useSettings: 'Settings/get and state frames; Settings.ui per F1 UiSettings (theme, density, keyHints, singleKeys, holdMs, dock, keymap, sidebarMinimised, swipe, swipeDirection, zen, sendSound, devDetails, lastAccount, palette.recents, calendar.weekStart)',
  useFrames: 'F1 push frames progress {runId, source, kind, step, delta, turnId, citation, proposal, problem}, connect {connectId, mode, state, accountId?, reasonCode?} and the host frame clock event {type: clock, now}; a live run replays from its start',
  useNow: 'Session/get.now and the host clock event when the fixture sets the clock (test builds only, APLOS_NOW); Date.now() otherwise',
  useUndoTop: 'none beyond Operation/undo and OperationView.undoable; local entries never reach the engine',
} as const;

/** The command surface. Every method throws `NotImplementedError` until U2. */
export const api: DataApi = {
  thread: {
    act: () => notImplemented('api.thread.act'),
    why: () => notImplemented('api.thread.why'),
    followup: () => notImplemented('api.thread.followup'),
    unsubscribe: () => notImplemented('api.thread.unsubscribe'),
  },
  operation: {
    undo: () => notImplemented('api.operation.undo'),
    undoLast: () => notImplemented('api.operation.undoLast'),
  },
  submission: {
    send: () => notImplemented('api.submission.send'),
    sendLater: () => notImplemented('api.submission.sendLater'),
    undo: () => notImplemented('api.submission.undo'),
    sendNow: () => notImplemented('api.submission.sendNow'),
    reschedule: () => notImplemented('api.submission.reschedule'),
  },
  draft: {
    save: () => notImplemented('api.draft.save'),
    discard: () => notImplemented('api.draft.discard'),
    resolveConflict: () => notImplemented('api.draft.resolveConflict'),
  },
  body: {
    get: () => notImplemented('api.body.get'),
    prefetch: () => notImplemented('api.body.prefetch'),
  },
  mail: {
    frame: () => notImplemented('api.mail.frame'),
    releaseFrame: () => notImplemented('api.mail.releaseFrame'),
    allowImagesFrom: () => notImplemented('api.mail.allowImagesFrom'),
  },
  attachment: {
    get: () => notImplemented('api.attachment.get'),
    put: () => notImplemented('api.attachment.put'),
  },
  sync: {
    request: () => notImplemented('api.sync.request'),
  },
  account: {
    connect: () => notImplemented('api.account.connect'),
    reconnect: () => notImplemented('api.account.reconnect'),
    cancelConnect: () => notImplemented('api.account.cancelConnect'),
    setAiAllowed: () => notImplemented('api.account.setAiAllowed'),
  },
  setup: {
    begin: () => notImplemented('api.setup.begin'),
    end: () => notImplemented('api.setup.end'),
    retry: () => notImplemented('api.setup.retry'),
  },
  demo: {
    load: () => notImplemented('api.demo.load'),
    reset: () => notImplemented('api.demo.reset'),
    remove: () => notImplemented('api.demo.remove'),
  },
  settings: {
    get: () => notImplemented('api.settings.get'),
    set: () => notImplemented('api.settings.set'),
  },
  ask: {
    run: () => notImplemented('api.ask.run'),
  },
  ai: {
    request: () => notImplemented('api.ai.request'),
    transcribe: () => notImplemented('api.ai.transcribe'),
    setConsent: () => notImplemented('api.ai.setConsent'),
  },
  engine: {
    restart: () => notImplemented('api.engine.restart'),
  },
  diagnostics: {
    preview: () => notImplemented('api.diagnostics.preview'),
    copy: () => notImplemented('api.diagnostics.copy'),
  },
};
