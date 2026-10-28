/**
 * The renderer data surface (F9, frozen on day 3; plan 30 section 4.1 and U2).
 *
 * Screens read mail only through these hooks and `api`. Every type is the engine contract's (`@aplos/contract`, F1),
 * re-exported from `./contract-shapes.ts`, plus the few UI-side types in `./ui-types.ts`. `api` is the F2 typed
 * client's surface (`@aplos/contract/client`): each member is the client method of the same name, and its type is
 * derived from the client, so the two cannot drift. After the freeze, changes are additive only: new members may be
 * added, nothing is renamed or removed.
 *
 * Every implementation below throws `NotImplementedError`. Lane `ui-shell` builds them in U2 (days 4-8) as
 * `client.ts`, `rows.ts`, `windows.ts`, `optimistic.ts` and `session.ts` behind this file, first against the stand-in
 * engine (F6), then against the real engine by one flag (WP5.6).
 *
 * Not here: transport selection (MessagePort in Electron, tokenised HTTP and SSE in the browser preview). That lives
 * in `renderer/bridge.ts`, owned by `ui-shell`, and this surface never exposes it. `./standin.ts` boots the stand-in
 * engine in-process for development and tests only.
 *
 * This file imports nothing from today's renderer, `shared/live`, `AppState` or `engine/*`, nothing at runtime from
 * the contract (types only, so no zod), and no React: hooks are typed as plain functions so the signatures can be
 * checked without a DOM.
 */

import type { Api as ClientApi } from '@aplos/contract/client';
import type {
  Account,
  AccountId,
  AccountStatus,
  Consent,
  Conversation,
  Count,
  CountsBlock,
  DesktopMethodName,
  Draft,
  EngineEvent,
  EpochMs,
  ErrorBody,
  Event,
  Id,
  Input,
  Message,
  MessageBody,
  MessageId,
  MethodName,
  OpId,
  Operation,
  Plan,
  ReasonCode,
  Receipt,
  RowType,
  SenderGroup,
  Session,
  SetupStatus,
  Settings,
  State,
  Submission,
  ThreadAction,
  ThreadId,
  ThreadRow,
  ThreadSelector,
  UiSettings,
  ViewSpec,
  WindowSection,
} from './contract-shapes';
import type {
  CachedRowType,
  HomeSection,
  KnownValues,
  OperationState,
  RowTypeMap,
  StreamFrameMap,
  StreamKind,
  ThreadListSelector,
  ViewSpecOf,
} from './ui-types';

export type * from './contract-shapes';
export type * from './ui-types';

// ---------------------------------------------------------------------------
// Lane marker and the not-implemented error
// ---------------------------------------------------------------------------

/** The lane that implements this surface (roadmap 2.3). */
export const DATA_LANE = 'ui-shell' as const;

/** Thrown by every stub until `ui-shell` lands U2; names the member and the lane. (The contract's own `NotImplementedError` is what an engine stub throws; this one is the renderer's.) */
export class NotImplementedError extends Error {
  /** Stable code for tests and logs. */
  readonly code = 'NOT_IMPLEMENTED' as const;
  /** Owning lane, always `ui-shell`. */
  readonly lane = DATA_LANE;
  /** The member that was called, for example `api.thread.act`. */
  readonly member: string;

  constructor(member: string) {
    super(
      `renderer/data: ${member} is not implemented yet. Lane ${DATA_LANE} builds it in U2 (days 4-8).`,
    );
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

/** Most rows one window holds (ARCH 9.2; `View/watch.limit` is at most 200). */
export const WINDOW_MAX_ROWS = 200;

// ---------------------------------------------------------------------------
// Operations: optimistic overlay, receipts, undo (DESIGN 5 rules 1 and 11)
// ---------------------------------------------------------------------------

/** What every optimistic command returns: the overlay is already applied when this returns (key-to-state within 8 ms, DESIGN 5 rule 1). */
export interface ActResult {
  /** The operation id (minted by the data layer when the caller gave none); use it with `useOperation` and `api.operation.undo`. */
  readonly opId: OpId;
  /** Resolves with the contract `Receipt` when the engine commits; rejects with `OperationFailedError` after the overlay has rolled back and the row shows its inline error. The overlay drops once a window frame's `state.seq` reaches `receipt.appliedState.seq` within the same `dbEpoch` (frames are coalesced and can skip states, so the comparison is ordered, never equality). */
  readonly receipt: Promise<Receipt>;
}

/** Rejection value of `ActResult.receipt`. */
export class OperationFailedError extends Error {
  /** The failed operation. */
  readonly opId: OpId;
  /** The engine's error body; `error.message` is the sentence to show. */
  readonly error: ErrorBody;

  constructor(opId: OpId, error: ErrorBody) {
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
  /** Provider-side progress once confirmed (`Operation.state` from `operation` frames: "Saved here · will sync" while `queued`); null while pending. */
  readonly remote: Operation['state'] | null;
  /** The action, for toast wording; null for non-thread operations. */
  readonly action: ThreadAction | null;
  /** Target ids. For a selector target: empty while pending, the ids the engine resolved once confirmed (`Operation.targets`). */
  readonly targets: readonly Id[];
  /** The selector when the operation targeted a whole view or section; null for explicit ids. */
  readonly selector: ThreadSelector | null;
  /** Set when failed; `message` is shown as written. */
  readonly error: ErrorBody | null;
  /** True when `api.operation.undo` applies (`Receipt.undoable` is not false, and not already undone). */
  readonly undoable: boolean;
  /** `Receipt.undoUntil`: until when undo cancels a held change instead of sending an inverse (calendar writes that email guests); null otherwise. */
  readonly undoUntil: EpochMs | null;
  /**
   * Retry after a failure; which call it makes depends on where it failed:
   * - `state: 'failed'` (the engine rejected the write, so no operation exists): a fresh `api.thread.act` with the same
   *   action and targets under a new `opId`; the overlay re-applies at once and the result's `opId` is the new one.
   * - `state: 'confirmed'` with `remote: 'failed'` (accepted, then the provider refused it): `api.operation.retry({opId})`
   *   (`Operation/retry`), same `opId`, no overlay; the result's `receipt` is `Operation/retry`'s `Receipt`.
   * Any other state: nothing to retry, so the result's `receipt` rejects with `OperationFailedError` (`type: 'validation'`).
   */
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
  /** Retry the same action: the engine rejected it, so no operation exists and this is a fresh `api.thread.act` under a new `opId` (the overlay re-applies at once). Provider-side failures after a receipt are `OperationView.retry` (`Operation/retry`). */
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

/** The row a spec yields, following the window's `rowType`: messages for `thread`, drafts for `drafts`, submissions for `scheduled`, sender groups for `lowSenders`, events for `events`, plans for `plans`, conversations for `conversations`, thread rows for every other view. */
export type RowForSpec<S extends ViewSpec> =
  S extends ViewSpecOf<'thread'>
    ? Message
    : S extends ViewSpecOf<'drafts'>
      ? Draft
      : S extends ViewSpecOf<'scheduled'>
        ? Submission
        : S extends ViewSpecOf<'lowSenders'>
          ? SenderGroup
          : S extends ViewSpecOf<'events'>
            ? Event
            : S extends ViewSpecOf<'plans'>
              ? Plan
              : S extends ViewSpecOf<'conversations'>
                ? Conversation
                : ThreadRow;

/** `opening` before the first window; `live` while frames apply; `reset` while reopening after a `reset` frame or `cannotCalculateChanges` (the previous ids stay on screen); `failed` when the view cannot open or stopped (`WindowBody.error`: remote search paused or unavailable, a thread that is gone): show `error.message` as an ErrorLine (DESIGN 7.15). */
export type ViewStatus = 'opening' | 'live' | 'reset' | 'failed';

/** A range of indices in the whole view, end exclusive; the data layer turns it into a `View/move` anchor (keyset, never OFFSET). */
export interface ViewRange {
  /** First index wanted. */
  readonly start: number;
  /** One past the last index wanted. */
  readonly end: number;
}

/** Options for `useView`. */
export interface UseViewOptions {
  /** Engine half of holding still (plan 30 4.1): rows around the cursor that a re-rank must not move (`View/watch.holdIds`). Non-empty also freezes the rendered order and queues frames until it empties again. Pass `HoldController.heldIds`. A change to `holdIds` never re-watches: the data layer sends `View/hold {windowId, ids}` (repeating it is the activity ping) or `View/release` on the open window, so status stays `live` and the position is kept. */
  readonly holdIds?: readonly Id[];
}

/** A watched window (`WindowBody`) with the optimistic overlay applied. Field names are the contract's. */
export interface ViewResult<R> {
  /** Ordered ids in the window as rendered: overlay applied, held order kept during a hold. */
  readonly ids: readonly Id[];
  /** `WindowBody.position`: index of `ids[0]` in the whole view (approximate under keyset paging). */
  readonly position: number;
  /** Rows in the whole view, overlay applied. */
  readonly total: number;
  /** Rows by id from the row cache; an id may be missing while its row is fetched with `T/get`. */
  readonly rows: ReadonlyMap<Id, R>;
  /** `WindowBody.sections`: Home sections, Later groups, Low senders, counts overlay applied; empty for ungrouped views. */
  readonly sections: readonly WindowSection[];
  /** `WindowBody.held`: rows the engine kept in place for a hold; empty otherwise. */
  readonly held: readonly Id[];
  /** `WindowBody.rowType`; null while opening. */
  readonly rowType: RowType | null;
  /** State of the last applied window; null while opening. Pass it as `ThreadSelector.atState`. */
  readonly state: State | null;
  /** Window lifecycle. */
  readonly status: ViewStatus;
  /** Why the view failed (`WindowBody.error`, or the call's error); null unless `status` is `failed`. A thread view whose thread is gone fails with type `notFound`. */
  readonly error: ErrorBody | null;
  /** Rows whose last write was rejected, by id (DESIGN 5 rule 11). */
  readonly failures: ReadonlyMap<Id, RowFailure>;
  /** Scroll the window; call with the virtualised list's visible range plus overscan. */
  move(range: ViewRange): void;
}

/** Watch one view (`View/watch`, `View/move`, `View/unwatch`, `View/hold`, `View/release`, `window` and `reset` frames, `T/get` for unknown or changed ids). Re-watches only when the spec changes by value, never for a `holdIds` change. */
export function useView<S extends ViewSpec>(
  spec: S,
  opts?: UseViewOptions,
): ViewResult<RowForSpec<S>> {
  void spec;
  void opts;
  return notImplemented('useView');
}

/** One Home section with its rows and counts (DESIGN 7.2). */
export interface HomeSectionView {
  /** Section key, in display order. */
  readonly key: HomeSection;
  /** Ids in this section within the current window, in order. For `do`, excludes Back from Later, whose ids are in `fromLater.ids` (render them after these). */
  readonly ids: readonly ThreadId[];
  /** Rows in the section across the whole view, the number beside the label. For `do`, the `do` and `fromLater` sections together (DESIGN 7.2: Back from Later is a sub-label inside Do now); `fromLater.count` is the block alone. */
  readonly count: number;
  /** Index of the section's first row in the whole view (Tab and ⇧Tab jump here). */
  readonly start: number;
  /** Whether the label renders: count above 0, or emptied while a hold is active, in which case it shows 0 until the hold releases (DESIGN 5 rule 6). The engine omits empty sections; this flag is the renderer's. */
  readonly visible: boolean;
  /** `do` only: the Back from Later block at its bottom (the window's `fromLater` section); null for other sections or when empty and not held. */
  readonly fromLater: HomeBlockView | null;
  /** Rows that arrived during a hold and wait to `arrive` ("2 new" beside the Do now label). */
  readonly waiting: number;
}

/** A sub-block inside a section (Back from Later). */
export interface HomeBlockView {
  /** Section key of the block. */
  readonly key: 'fromLater';
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
  /** Low-importance threads in the scope (the home window's `low` section `count`). */
  readonly count: number;
  /** Up to three sender names, most recent first (the `low` section's `senders`). */
  readonly names: readonly string[];
  /** Senders beyond `names` ("and N more"): the `lowSenders` window's `total` minus `names.length`. */
  readonly moreSenders: number;
}

/** Options for `useHome`. */
export interface UseHomeOptions {
  /** One account, or absent for All accounts. */
  readonly accountId?: AccountId;
  /** Engine half of holding still; pass `HoldController.heldIds`. */
  readonly holdIds?: readonly Id[];
}

/** Home as sections: the `home` window (sections `do`, `fromLater`, `update`, `low`, `follow`), section-aware. */
export interface HomeView {
  /** Do now, Important updates, Follow up, always all three in order; render those with `visible`. The Low band sits between Important updates and Follow up (DESIGN 7.2). */
  readonly sections: readonly HomeSectionView[];
  /** The Low importance band; count 0 hides it. */
  readonly low: LowBandView;
  /** Rows by id (thread rows). */
  readonly rows: ReadonlyMap<ThreadId, ThreadRow>;
  /** Rows whose last write was rejected. */
  readonly failures: ReadonlyMap<ThreadId, RowFailure>;
  /** Do now plus Important updates plus Follow up across the view (inbox zero when 0 and the band is empty). */
  readonly total: number;
  /** State of the last applied `home` window; null while opening. Selectors ("Clear from Home") pass it as `atState`. */
  readonly state: State | null;
  /** Lifecycle of the underlying `home` window. */
  readonly status: ViewStatus;
  /** Why it failed; null unless `status` is `failed`. */
  readonly error: ErrorBody | null;
  /** Scroll the underlying `home` window. */
  move(range: ViewRange): void;
}

/** Home's section-aware helper over `useView({kind: 'home'})`, plus the `lowSenders` window's total for the band's "and N more". */
export function useHome(opts?: UseHomeOptions): HomeView {
  void opts;
  return notImplemented('useHome');
}

// ---------------------------------------------------------------------------
// Rows (plan 30 4.1 rows.ts)
// ---------------------------------------------------------------------------

/** One cached row by contract type name and id; undefined until known and also when gone (use `useRowState` to tell them apart). Referentially stable while `rev` is unchanged, so it is safe in memo deps. */
export function useRow<T extends CachedRowType>(
  type: T,
  id: Id | undefined,
): RowTypeMap[T] | undefined {
  void type;
  void id;
  return notImplemented('useRow');
}

/** A row lookup that can say the row is gone (the reader open on a thread that was deleted or moved elsewhere). */
export interface RowState<R> {
  /** The row once known; stable while `rev` is unchanged. */
  readonly row: R | undefined;
  /** loading until the first answer; ready with a row; notFound once `T/get` lists the id in `notFound` or the row is destroyed. */
  readonly status: 'loading' | 'ready' | 'notFound';
}

/** One cached row with its lookup status, for screens that must show "This email is no longer here." instead of waiting forever. */
export function useRowState<T extends CachedRowType>(
  type: T,
  id: Id | undefined,
): RowState<RowTypeMap[T]> {
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
export type HoldReleaseListener = (released: {
  readonly ids: readonly Id[];
  readonly reason: HoldReason;
}) => void;

/** One list's hold. Methods are synchronous and safe inside a keydown handler. */
export interface HoldController {
  /** Start or refresh a hold pinning `ids` (the rows around the cursor); restarts the 450 ms release timer within the 1200 ms cap. */
  begin(reason: HoldReason, ids: readonly Id[]): void;
  /** Push the release back on another key, optionally adding ids; never past the cap. */
  extend(ids?: readonly Id[]): void;
  /** Release now (pointer left the list, Esc, navigation). */
  release(): void;
  /** True while held. */
  readonly isHeld: boolean;
  /** Ids to pass as `holdIds` to `useView` or `useHome`; empty when not held. Changing them sends `View/hold` or `View/release`, never a re-watch. */
  readonly heldIds: readonly Id[];
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

/** Intent tracker for one list: applies the 80 ms focus and 120 ms hover delays and cancels the previous request on move (`MessageBody/prefetch {threadIds}`, then `{threadIds, cancel: true}`). */
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
  /** The body when ready; `bodyKind: 'html'` bodies then ask `api.mail.frame` for the frame URL. */
  readonly body: MessageBody | undefined;
  /** Set when failed. */
  readonly error: ErrorBody | null;
  /** Try again. */
  retry(): void;
}

/** Load one message body (`MessageBody/get`), served from the engine's LRU after a prefetch. */
export function useMessageBody(messageId: MessageId | undefined): BodyResult {
  void messageId;
  return notImplemented('useMessageBody');
}

// ---------------------------------------------------------------------------
// Session, accounts, status slot, counts, setup, settings, consent (ARCH 6.4, 9.5)
// ---------------------------------------------------------------------------

/** The session singleton (`Session/get`, re-read on a `state` frame for type `Session`); undefined until it answers. Whether the engine is still coming or gone is `useConnection`'s job. */
export function useSession(): Session | undefined {
  return notImplemented('useSession');
}

/** The data layer's link to the engine: the known values of the contract's `DesktopEvent` `engine` state (an open enum; a state a newer main adds is reported as `unreachable`, which shows the FatalScreen with Restart). `connecting` until `Session/get` answers (and while reconnecting), `ready`, `unreachable` when the transport is gone and does not come back (FatalScreen "Aplos can't reach its mail engine.", DESIGN 7.15), `parked` after a `parked` host event or a `desktop` engine event (FatalScreen with Try again and Export diagnostics, plan 30 4.5 #3). */
export type ConnectionState = KnownValues<EngineEvent['state']>;

/** Connection state for the FatalScreen and the status slot. */
export interface ConnectionView {
  /** Current state. */
  readonly state: ConnectionState;
  /** The engine's or main's plain sentence (`message`), or a plain transport sentence when unreachable; null otherwise. */
  readonly reason: string | null;
  /** The copy key (`reasonCode`, e.g. `crashLoop`); null when none. */
  readonly reasonCode: string | null;
  /** Whether Try again can help (`canRetry`); true unless the engine said otherwise. */
  readonly canRetry: boolean;
}

/** Whether the engine is reachable, connecting or parked. Transport details stay in `bridge.ts`. */
export function useConnection(): ConnectionView {
  return notImplemented('useConnection');
}

/** All accounts (`Account/get`), in sidebar order, each with `health` (status, `reasonCode`, `reconnectBy`, `lastSyncAt`). */
export function useAccounts(): readonly Account[] {
  return notImplemented('useAccounts');
}

/** What the status slot shows (DESIGN 7.1 table). */
export interface StatusSlotState {
  /** The account the line is about; null when no account exists. */
  readonly account: Account | null;
  /** The status to render (`account.health.status`). */
  readonly status: AccountStatus;
  /** The copy key for it (`account.health.reasonCode`); null while ok. The UI maps it to DESIGN 7.15 copy; provider text never reaches the screen. */
  readonly reasonCode: ReasonCode | null;
  /** True when `account.health.reconnectBy` falls within 24 hours: "Gmail will ask you to reconnect tomorrow at 9:00 AM." */
  readonly reconnectSoon: boolean;
  /** True when the account is a demo account (`account.demo`) and nothing more urgent applies. */
  readonly demo: boolean;
}

/** The one status line for a scope, most urgent first: misconfigured, needsReauth, needsPermission, needsAdmin, error, paused, offline, reconnect soon, backfilling, syncing, starting, demo, ok. Undefined with no accounts. An unknown `state` from a newer engine counts as error. */
export function useStatus(accountId?: AccountId): StatusSlotState | undefined {
  void accountId;
  return notImplemented('useStatus');
}

/** Sidebar counts for a scope (`Counts/get`, re-read on a `state` frame for type `Counts`). */
export interface CountsView {
  /** `Counts.all`, or `Counts.accounts[accountId]` for one account: `home` (Do now with Back from Later plus Important updates), `laterDue`, `drafts`, `scheduled`, `unread`, `handledToday`, ... */
  readonly counts: CountsBlock;
  /** `Counts.folders`: unread threads per folder id, for label rows. */
  readonly folders: Readonly<Record<Id, Count>>;
  /** True while any account in scope is in its first sync (no `baselineDoneAt`): counts hide (DESIGN 7.1). */
  readonly hidden: boolean;
}

/** Sidebar counts for one account, or absent for All accounts. */
export function useCounts(accountId?: AccountId): CountsView {
  void accountId;
  return notImplemented('useCounts');
}

/** Events in a range, live, for Today and Home's inbox-zero "Next: Design review at 2:00 PM" (DESIGN 7.14). */
export interface AgendaView {
  /** Events ordered by start, all-day first within a day. `start` and `end` are `EventTime`s (`utc`, `date` or `floating`). */
  readonly events: readonly Event[];
  /** loading until the first answer, then ready; failed with `error` set (`rangeTooLarge` past 62 days). */
  readonly status: 'loading' | 'ready' | 'failed';
  /** Set when failed. */
  readonly error: ErrorBody | null;
}

/** Watch events in a range: an `events` window (`View/watch {spec: {kind: 'events', from, to, calendarIds?, includeDeclined?}}`, not capped at 200 rows; `View/move {range}` to page) plus `Event/get`. The calendar grid, `Event/set` and `Event/rsvp` are additive for `ui-calendar`. */
export function useAgenda(spec: ViewSpecOf<'events'>): AgendaView {
  void spec;
  return notImplemented('useAgenda');
}

/** First-sync progress (`Setup/status`, re-read on a `state` frame for type `Setup`); undefined until known. */
export function useSetupStatus(): SetupStatus | undefined {
  return notImplemented('useSetupStatus');
}

/** The settings singleton (`Settings/get`, re-read on a `state` frame for type `Settings`); undefined until known. */
export function useSettings(): Settings | undefined {
  return notImplemented('useSettings');
}

/** The background-AI consent record (`Consent/get`, re-read on a `state` frame for type `Consent`); undefined until known. Consent is not a settings field: `needsReconsent` says whether the card must ask again. */
export function useConsent(): Consent | undefined {
  return notImplemented('useConsent');
}

/** The `ui` object's defaults: F1's documented defaults (`schemas/settings.ts` field comments), what a fresh install and the stand-in engine start with. */
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

/** The fields `useFrames` can filter each stream by; other fields are not filterable. */
export interface FrameFilterFields {
  /** Run progress: one run (the `runId` of `Ask/run` or `Search/remote`), one source ('ask', 'search'), or one Ask turn. */
  progress: 'runId' | 'source' | 'turnId';
  /** Connect flows: one flow (`Account/connect`'s `connectId`), one account, or one mode. */
  connect: 'connectId' | 'accountId' | 'mode';
  /** The clock is one stream; no filter. */
  clock: never;
}

/** Only frames whose listed fields equal these values. Compared by value, so an inline object literal never resubscribes. */
export type FrameFilter<K extends StreamKind> = Partial<
  Pick<StreamFrameMap[K], FrameFilterFields[K] & keyof StreamFrameMap[K]>
>;

/** Options for `useFrames`. */
export interface UseFramesOptions {
  /** Keep at most this many frames, dropping the oldest. Default 200. */
  readonly max?: number;
}

/** The matching frames of one stream. */
export interface FramesView<F> {
  /** Matching frames in arrival order: since the hook mounted, or since the run started when the filter names a live run (`runId` or `connectId`). */
  readonly frames: readonly F[];
  /** The newest matching frame; undefined until one arrives. */
  readonly last: F | undefined;
}

/** Subscribe to push frames of one stream (Ask `progress`, `connect` for "Waiting for Google in your browser…", `clock`; first sync is `useSetupStatus`), batched per animation frame (DESIGN 5 rule 13). Changing the filter's values restarts the buffer. */
export function useFrames<K extends StreamKind>(
  kind: K,
  filter?: FrameFilter<K>,
  opts?: UseFramesOptions,
): FramesView<StreamFrameMap[K]> {
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
 * `setClock`; the engine's clock (`Session.now` plus `clock` host events, which only jump
 * under a test clock); `Date.now()`. Props take ISO strings: convert with `toIsoDateTime`
 * and `toIsoDate`. Ticks pause while the window is hidden and catch up at once when it
 * shows again (DESIGN 5 rule 15).
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

/** The one stack Z reads, so Z undoes the most recent change of either kind (DESIGN 5 rule 11, 7.13). The shell's `app.undo` calls `undoStack.undoLast()`. */
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
// The command surface: the F2 typed client's methods, by the client's names
// ---------------------------------------------------------------------------

/** A command's arguments with its fresh `opId` optional: the data layer mints one when it is absent. */
export type CommandArgs<M extends MethodName> = Omit<Input<M>, 'opId'> & {
  readonly opId?: OpId;
};

/** An interactive AI request's arguments with its `requestId` optional: the data layer mints one when it is absent. */
export type RequestArgs<M extends MethodName> = Omit<Input<M>, 'requestId'> & {
  readonly requestId?: Id;
};

/** The F2 client's own call type for a method (`api.thread.act` for `Thread/act`). */
type ResolvedCall<M extends MethodName> = M extends `${infer T}/${infer V}`
  ? Uncapitalize<T> extends keyof ClientApi
    ? V extends keyof ClientApi[Uncapitalize<T>]
      ? ClientApi[Uncapitalize<T>][V] extends (...args: never[]) => unknown
        ? ClientApi[Uncapitalize<T>][V]
        : never
      : never
    : never
  : never;

/** The client's call for `M`, with its fresh `opId` minted by the data layer when absent; same result as the client's. */
type Command<M extends MethodName> = (args: CommandArgs<M>) => ReturnType<ResolvedCall<M>>;

/** The client's call for `M`, with its fresh `requestId` minted by the data layer when absent. */
type Request<M extends MethodName> = (args: RequestArgs<M>) => ReturnType<ResolvedCall<M>>;

/** `api.thread.act`'s arguments: `Thread/act` with `opId` optional, and a selector only over thread-row specs. Exactly one of `ids` and `selector`. */
export type ThreadActArgs = Omit<Input<'Thread/act'>, 'opId' | 'selector'> & {
  readonly opId?: OpId;
  readonly selector?: ThreadListSelector;
};

/** `api.operation.undo`'s arguments: `opId` is the operation to undo; `undoOpId`, the inverse's id, is minted by the data layer when absent. */
export type UndoArgs = Omit<Input<'Operation/undo'>, 'undoOpId'> & { readonly undoOpId?: OpId };

/**
 * The typed command surface the screens call. Each group and verb is the F2 client's (`api.<type>.<verb>()` for
 * contract method `Type/verb`), and each member's type is the client's, except that the data layer mints fresh
 * `opId`s and `requestId`s and that the two overlay methods return an `ActResult` synchronously. Reads that have a
 * hook (`View/*`, `T/get`, `Session/get`, `Counts/get`, `Setup/status`) are not here: use the hook.
 */
export interface DataApi {
  /** Threads. */
  readonly thread: {
    /** `Thread/act` with the optimistic overlay applied synchronously: Done, Later, trash, read state, flag, bookmark, due date, reminder, lane, importance, reply state, Home visibility, labels. A `selector` (a whole view or one section past the 200-row window, at the `state` the owner saw) overlays the rows in open windows and the section counts at once; the receipt covers every resolved row. Undoable: joins the undo stack. */
    act(args: ThreadActArgs): ActResult;
    /** `Thread/why`: "Why it's here". */
    readonly why: ClientApi['thread']['why'];
    /** `Thread/open`: the reader opened a thread. Fetches it whole when the row is partial (`complete: false` until then; the full row arrives as a row change) and marks it opened for retention. The reader sends it once per open. */
    readonly open: ClientApi['thread']['open'];
  };
  /** Operations. */
  readonly operation: {
    /** `Operation/undo`: cancel while held (`undoUntil`), else an inverse operation; the overlay applies at once. The receipt's `opId` is the inverse's. */
    undo(args: UndoArgs): ActResult;
    /** `Operation/retry {opId}`: retry an operation the provider refused after its receipt (`Operation.state: 'failed'`). Same `opId`, a `Receipt`, no overlay. An engine-rejected `Thread/act` never created an operation: its Retry is a fresh `thread.act` (`RowFailure.retry`). Prefer `OperationView.retry`, which picks the right one. */
    readonly retry: ClientApi['operation']['retry'];
  };
  /** Sending (`Submission/set`; undo-send and send later are one `notBefore` mechanism, ARCH 7.2). */
  readonly submission: {
    /** One intent per call: `send` (after the undo window, or at `notBefore` for send later; `alsoDone` is ⌘⇧Return, one operation and one notice), `undo`, `sendNow`, `reschedule`, `sendAnyway` (uncertain), `retry` (failed). Watch the result's submission with `useRow('Submission', id)`. */
    readonly set: Command<'Submission/set'>;
  };
  /** Drafts (compare-and-set by `revision`, ARCH 7.4). */
  readonly draft: {
    /** `Draft/set`: create (no `id`) or save with `baseRevision`; rejects with `stateMismatch` on a stale base. `fields.mode` and `replyToMessageId` say reply, reply all or forward; forward copies attachments through `DraftAttachment.source`. */
    readonly set: Command<'Draft/set'>;
    /** `Draft/destroy`: discard; refused while it is sending. */
    readonly destroy: Command<'Draft/destroy'>;
    /** `Draft/resolve`: "This draft changed on another device." keep mine, take theirs, or keep both. */
    readonly resolve: Command<'Draft/resolve'>;
  };
  /** Message bodies. */
  readonly messageBody: {
    /** `MessageBody/get`: one body (prefer `useMessageBody` in components). */
    readonly get: ClientApi['messageBody']['get'];
    /** `MessageBody/prefetch`: warm the engine's body LRU by thread (ARCH AM-1) or message; `cancel: true` cancels. Prefer `usePrefetchIntent`. */
    readonly prefetch: ClientApi['messageBody']['prefetch'];
  };
  /** The sealed mail frame (ARCH 10). */
  readonly mail: {
    /** `Mail/frame`: a single-render frame URL plus host-chrome facts; `imagePolicy: 'block' | 'load'`, `quotesOpen`. The engine applies `mail.imageAllowList`. */
    readonly frame: ClientApi['mail']['frame'];
    /** `Mail/release`: free a frame token when the reader replaces it. */
    readonly release: ClientApi['mail']['release'];
    /** `Mail/toggleQuotes`: O in the reader; returns the re-rendered frame. */
    readonly toggleQuotes: ClientApi['mail']['toggleQuotes'];
    /** `Mail/allowImages`: "Load images from this sender" (an address or `@domain`), or remove it; re-request the frame afterwards. */
    readonly allowImages: Command<'Mail/allowImages'>;
  };
  /** Attachments. */
  readonly attachment: {
    /** `Attachment/get`: makes the bytes available as a blob; then `api.blob.get`. */
    readonly get: ClientApi['attachment']['get'];
  };
  /** Bytes, both ways, never base64: a transferable `Uint8Array` on MessagePort, a blob route over HTTP. */
  readonly blob: {
    /** `Blob/put`: upload (Attach a file, ⌘⇧A; dictation audio), 25 MB at most; pass the buffer in `options.transfer`. Put the `blobId` in a `DraftAttachment` or `Ai/transcribe`. */
    readonly put: ClientApi['blob']['put'];
    /** `Blob/get`: read a blob's bytes. */
    readonly get: ClientApi['blob']['get'];
  };
  /** Sync control. */
  readonly sync: {
    /** `Sync/request`: a manual refresh; `force` is "Retry now" on a throttle pause (once per pause). */
    readonly request: ClientApi['sync']['request'];
  };
  /** Accounts. Flows return a `connectId` at once and report through `connect` frames (`useFrames('connect', {connectId})`). */
  readonly account: {
    /** `Account/connect`: connect a new account (onboarding, Settings → Add account). */
    readonly connect: ClientApi['account']['connect'];
    /** `Account/reconnect`: the weekly reconnect, with `login_hint`; no resync, queued changes kept (roadmap N3). */
    readonly reconnect: ClientApi['account']['reconnect'];
    /** `Account/grantPermissions`: full re-consent for missing scopes (`needsPermission`). */
    readonly grantPermissions: ClientApi['account']['grantPermissions'];
    /** `Account/cancelConnect`: the sheet's Cancel; a late answer is then ignored. */
    readonly cancelConnect: ClientApi['account']['cancelConnect'];
    /** `Account/set`: name, colour, notifications, and "Use this account's mail for AI" (`aiAllowed`). */
    readonly set: Command<'Account/set'>;
  };
  /** First-sync session (`Setup/*`); the UI calls `end` on every window close. */
  readonly setup: {
    /** `Setup/begin {origin}` → `{setupId}`. */
    readonly begin: ClientApi['setup']['begin'];
    /** `Setup/end {setupId?, reason}`; idempotent. */
    readonly end: ClientApi['setup']['end'];
    /** `Setup/retry`: first sync's "Try again" for one account (DESIGN 7.12); idempotent, resumes from the checkpoint. */
    readonly retry: ClientApi['setup']['retry'];
  };
  /** Demo mail on request (plan 30 8.1 item 11). */
  readonly demo: {
    /** `Demo/load`. */
    readonly load: ClientApi['demo']['load'];
    /** `Demo/reset`. */
    readonly reset: ClientApi['demo']['reset'];
    /** `Demo/remove`. */
    readonly remove: ClientApi['demo']['remove'];
  };
  /** Settings. */
  readonly settings: {
    /** `Settings/get` (prefer `useSettings` in components). */
    readonly get: ClientApi['settings']['get'];
    /** `Settings/set`: a patch per section; object-valued fields (`dock`, `keymap`, `palette`, `calendar`, `features`) are replaced whole; `ifInState` makes it compare-and-set. */
    readonly set: Command<'Settings/set'>;
  };
  /** Ask (DESIGN 7.7). Progress streams as `progress` frames (`useFrames('progress', {runId})`); the answer lands in the `Conversation`. */
  readonly ask: {
    /** `Ask/run` → `{runId, conversationId}` at once. `scope.searchAllMail` is ⌘Return. */
    readonly run: ClientApi['ask']['run'];
    /** `Ask/cancel`: Esc; the partial answer is kept and the turn says `stopped`. */
    readonly cancel: ClientApi['ask']['cancel'];
  };
  /** Remote search (DESIGN 7.9): local results come from the open `search` window as the owner types; Return asks the provider once. */
  readonly search: {
    /** `Search/remote {query, accountId?}` → `{runId, receipt}` at once. Progress follows as `progress` frames with `source: 'search'` (`useFrames('progress', {runId})`); the server's results join the open `useView({kind: 'search', query})` window with the same query, and a paused or unavailable provider shows as that window's `error`. */
    readonly remote: Command<'Search/remote'>;
  };
  /** Interactive AI. */
  readonly ai: {
    /** `Ai/request`: queue a summary (or classify, plan, suggest action) for a thread; the result arrives as a row change. */
    readonly request: Command<'Ai/request'>;
    /** `Ai/draft`: write a draft or reply from an instruction, as a suggestion at the caret. */
    readonly draft: Request<'Ai/draft'>;
    /** `Ai/polish`: suggested edits to a draft's html, never applied by themselves; the composer diffs `html` against its own. */
    readonly polish: Request<'Ai/polish'>;
    /** `Ai/transcribe`: speech to text from a blob uploaded with `api.blob.put`. */
    readonly transcribe: Request<'Ai/transcribe'>;
    /** `Ai/followup`: the Follow up nudge for a thread, absent with AI off, without consent or not ready (`ThreadRow.follow.suggestion` says one is ready). */
    readonly followup: ClientApi['ai']['followup'];
    /** `Ai/dismissFollowup`: dismiss the Follow up nudge for a thread. */
    readonly dismissFollowup: Command<'Ai/dismissFollowup'>;
    /** `Ai/cancel {requestId?}`: Esc during `draft`, `polish` or `transcribe`, naming the request's `requestId`; absent cancels every interactive request. Ask's own Esc is `ask.cancel`. */
    readonly cancel: ClientApi['ai']['cancel'];
  };
  /** Unsubscribe. */
  readonly unsubscribe: {
    /** `Unsubscribe/run`: one-click or mailto where offered, else `outcome: 'openLink'` with an https link to review. */
    readonly run: Command<'Unsubscribe/run'>;
  };
  /** Background-AI consent (ARCH 8.3); the record is `Consent`, not a settings field. */
  readonly consent: {
    /** `Consent/get` (prefer `useConsent` in components). */
    readonly get: ClientApi['consent']['get'];
    /** `Consent/grant`: Allow on the consent card, naming the version, provider and model shown. "Not now" records nothing. */
    readonly grant: ClientApi['consent']['grant'];
    /** `Consent/revoke`: Settings → AI; background AI stops. */
    readonly revoke: ClientApi['consent']['revoke'];
  };
  /** The engine process, through main (it answers when the engine cannot). */
  readonly engine: {
    /** `Engine/restart`: "Restart engine" on the unreachable FatalScreen and "Try again" when parked; `useConnection` reports the outcome. */
    readonly restart: ClientApi['engine']['restart'];
  };
  /** The content-free diagnostics bundle (ARCH 11). */
  readonly diagnostics: {
    /** `Diagnostics/preview`: the `DiagnosticsBundle` for the preview Dialog; the renderer formats it. */
    readonly preview: ClientApi['diagnostics']['preview'];
    /** `Diagnostics/copy` (main): copies the engine's bundle, or main's host-only one when the engine is unreachable or parked. */
    readonly copy: ClientApi['diagnostics']['copy'];
  };
}

/** Dotted name of every `api` method, for example `thread.act`. */
export type ApiMethodName = {
  [G in keyof DataApi]: `${G & string}.${keyof DataApi[G] & string}`;
}[keyof DataApi];

/** The contract method an `api` method calls: `thread.act` → `Thread/act`. Never when the contract has no such method, so a renamed or removed method fails the typecheck. */
export type ContractMethodOf<N extends ApiMethodName> = N extends `${infer G}.${infer V}`
  ? `${Capitalize<G>}/${V}` extends MethodName
    ? `${Capitalize<G>}/${V}`
    : never
  : never;

/** How a method reaches the engine: a plain call, a call wrapped by the optimistic overlay, a call that returns an id and streams frames, or a desktop method served by main. */
export type ContractCallKind = 'call' | 'overlay' | 'stream' | 'native';

/** One row of the mapping table: `api` method → contract method. */
export interface ContractMethodRef<N extends ApiMethodName = ApiMethodName> {
  /** The contract method, `Type/verb`; checked against the registry at compile time. */
  readonly method: ContractMethodOf<N>;
  /** How it is called; `native` exactly when the contract's host is main (`DesktopMethodName`). */
  readonly kind: ContractMethodOf<N> extends DesktopMethodName
    ? 'native'
    : Exclude<ContractCallKind, 'native'>;
  /** The GAPS.md rows (`packages/contract/GAPS.md`) that settled what this surface asked of the method; empty when it asked nothing. */
  readonly gaps: readonly string[];
  /** What the data layer adds or relies on. */
  readonly notes: string;
}

/** The mapping from `api` method to contract method, checked complete and correct at compile time. */
export const CONTRACT_METHODS = {
  'thread.act': {
    method: 'Thread/act',
    kind: 'overlay',
    gaps: ['F9-1', 'F9-2', 'F9-3'],
    notes:
      'overlay applied before return; opId minted; ids or a thread-row selector {spec, section?, atState}; joins the undo stack; also the Retry of an engine-rejected write (a fresh call under a new opId)',
  },
  'thread.why': { method: 'Thread/why', kind: 'call', gaps: ['F9-4'], notes: '' },
  'thread.open': {
    method: 'Thread/open',
    kind: 'call',
    gaps: [],
    notes: 'once per reader open; a partial row completes as a row change',
  },
  'operation.undo': {
    method: 'Operation/undo',
    kind: 'overlay',
    gaps: ['F9-7'],
    notes: 'undoOpId minted; the receipt is the inverse operation',
  },
  'operation.retry': {
    method: 'Operation/retry',
    kind: 'call',
    gaps: [],
    notes:
      'provider-side failures after a receipt only (Operation.state failed): same opId, Receipt, no overlay; OperationView.retry calls it when remote is failed',
  },
  'submission.set': {
    method: 'Submission/set',
    kind: 'call',
    gaps: ['F9-8', 'F9-9'],
    notes: 'opId minted; one SubmissionAction per intent; Submission.queuedAt drives the drain bar',
  },
  'draft.set': {
    method: 'Draft/set',
    kind: 'call',
    gaps: ['F9-10', 'F9-40'],
    notes: 'opId minted; compare-and-set on baseRevision',
  },
  'draft.destroy': { method: 'Draft/destroy', kind: 'call', gaps: [], notes: 'opId minted' },
  'draft.resolve': {
    method: 'Draft/resolve',
    kind: 'call',
    gaps: ['F9-11'],
    notes: 'opId minted; the Draft/changed frame sets Draft.conflict',
  },
  'messageBody.get': { method: 'MessageBody/get', kind: 'call', gaps: [], notes: '' },
  'messageBody.prefetch': {
    method: 'MessageBody/prefetch',
    kind: 'call',
    gaps: ['F9-12'],
    notes: 'usePrefetchIntent applies the delays and cancels with {cancel: true}',
  },
  'mail.frame': { method: 'Mail/frame', kind: 'call', gaps: ['F9-13'], notes: '' },
  'mail.release': { method: 'Mail/release', kind: 'call', gaps: [], notes: '' },
  'mail.toggleQuotes': { method: 'Mail/toggleQuotes', kind: 'call', gaps: ['F9-13'], notes: '' },
  'mail.allowImages': {
    method: 'Mail/allowImages',
    kind: 'call',
    gaps: ['F9-14'],
    notes: 'opId minted',
  },
  'attachment.get': { method: 'Attachment/get', kind: 'call', gaps: [], notes: 'then blob.get' },
  'blob.put': {
    method: 'Blob/put',
    kind: 'call',
    gaps: ['F9-15', 'F9-22'],
    notes: 'transferable Uint8Array, never base64',
  },
  'blob.get': { method: 'Blob/get', kind: 'call', gaps: [], notes: '' },
  'sync.request': { method: 'Sync/request', kind: 'call', gaps: ['F9-16'], notes: '' },
  'account.connect': {
    method: 'Account/connect',
    kind: 'stream',
    gaps: ['F9-17'],
    notes: 'connectId, then connect frames',
  },
  'account.reconnect': {
    method: 'Account/reconnect',
    kind: 'stream',
    gaps: ['F9-17'],
    notes: 'connectId, then connect frames',
  },
  'account.grantPermissions': {
    method: 'Account/grantPermissions',
    kind: 'stream',
    gaps: [],
    notes: "the reconnect sheet's 'grant' mode; connectId, then connect frames",
  },
  'account.cancelConnect': {
    method: 'Account/cancelConnect',
    kind: 'call',
    gaps: ['F9-17'],
    notes: '',
  },
  'account.set': { method: 'Account/set', kind: 'call', gaps: ['F9-18'], notes: 'opId minted' },
  'setup.begin': { method: 'Setup/begin', kind: 'call', gaps: [], notes: '' },
  'setup.end': { method: 'Setup/end', kind: 'call', gaps: [], notes: 'idempotent' },
  'setup.retry': { method: 'Setup/retry', kind: 'call', gaps: ['F9-19'], notes: '' },
  'demo.load': { method: 'Demo/load', kind: 'call', gaps: [], notes: '' },
  'demo.reset': { method: 'Demo/reset', kind: 'call', gaps: [], notes: '' },
  'demo.remove': { method: 'Demo/remove', kind: 'call', gaps: [], notes: '' },
  'settings.get': { method: 'Settings/get', kind: 'call', gaps: ['F9-41'], notes: '' },
  'settings.set': {
    method: 'Settings/set',
    kind: 'call',
    gaps: ['F9-41', 'F9-42'],
    notes: 'opId minted; object-valued fields replaced whole',
  },
  'ask.run': {
    method: 'Ask/run',
    kind: 'stream',
    gaps: ['F9-20'],
    notes: 'runId, then progress frames; the turn lands in the Conversation',
  },
  'ask.cancel': { method: 'Ask/cancel', kind: 'call', gaps: [], notes: '' },
  'search.remote': {
    method: 'Search/remote',
    kind: 'stream',
    gaps: [],
    notes:
      "opId minted; runId, then progress frames with source 'search'; results join the open search window with the same query",
  },
  'ai.request': {
    method: 'Ai/request',
    kind: 'call',
    gaps: ['F9-21'],
    notes: 'opId minted; kind summary re-summarises',
  },
  'ai.draft': { method: 'Ai/draft', kind: 'call', gaps: ['F9-21'], notes: 'requestId minted' },
  'ai.polish': {
    method: 'Ai/polish',
    kind: 'call',
    gaps: ['F9-21'],
    notes: 'requestId minted; html plus a change count (change ranges rejected)',
  },
  'ai.transcribe': {
    method: 'Ai/transcribe',
    kind: 'call',
    gaps: ['F9-22'],
    notes: 'requestId minted; audio from blob.put',
  },
  'ai.followup': { method: 'Ai/followup', kind: 'call', gaps: ['F9-5'], notes: '' },
  'ai.dismissFollowup': {
    method: 'Ai/dismissFollowup',
    kind: 'call',
    gaps: [],
    notes: 'opId minted',
  },
  'ai.cancel': {
    method: 'Ai/cancel',
    kind: 'call',
    gaps: [],
    notes: 'the requestId of ai.draft, ai.polish or ai.transcribe; absent cancels all',
  },
  'unsubscribe.run': {
    method: 'Unsubscribe/run',
    kind: 'call',
    gaps: ['F9-6'],
    notes: 'opId minted',
  },
  'consent.get': { method: 'Consent/get', kind: 'call', gaps: ['F9-23', 'F9-43'], notes: '' },
  'consent.grant': { method: 'Consent/grant', kind: 'call', gaps: ['F9-23'], notes: '' },
  'consent.revoke': { method: 'Consent/revoke', kind: 'call', gaps: ['F9-23'], notes: '' },
  'engine.restart': { method: 'Engine/restart', kind: 'native', gaps: ['F9-24'], notes: '' },
  'diagnostics.preview': {
    method: 'Diagnostics/preview',
    kind: 'call',
    gaps: ['F9-26'],
    notes: 'the renderer formats the bundle',
  },
  'diagnostics.copy': {
    method: 'Diagnostics/copy',
    kind: 'native',
    gaps: ['F9-25'],
    notes: '',
  },
} as const satisfies { readonly [N in ApiMethodName]: ContractMethodRef<N> };

/** What the hooks read from the contract, with the GAPS.md rows that settled each ask. */
export const CONTRACT_HOOK_NEEDS = {
  useView:
    'View/watch {spec, holdIds?, anchor?, limit?} -> WindowBody {windowId, state, rowType, ids, position, total, changed?, sections, held?, error?}; View/move, View/unwatch; window and reset frames; T/get for unknown or changed ids (F9-27, F9-28, F9-29, F9-30, F9-44)',
  useHome:
    'home window sections do, fromLater, update, low (count and senders, no ids), follow; the lowSenders window total for "and N more" (F9-30, F9-39)',
  useRow:
    'Thread/get, Message/get, Draft/get, Submission/get, Event/get, Plan/get, Conversation/get, SenderGroup/get, Account/get {ids}, Operation/get {opIds} -> {list, notFound}; state frames per type',
  useRowState: 'as useRow; ids in notFound and destroyed rows report notFound',
  useOperation:
    'Receipt {opId, appliedState, undoUntil?, undoable?}; operation frames carry the Operation (F9-27, F9-32)',
  useHold:
    'View/hold {windowId, ids} (repeating it is the activity ping), View/release {windowId, ids?}; never a re-watch (F9-31)',
  usePrefetchIntent: 'MessageBody/prefetch {threadIds, cancel?} (F9-12)',
  useMessageBody: 'MessageBody/get',
  useSession: 'Session/get; state frames for type Session (F9-33)',
  useConnection:
    'host event parked {reasonCode, message, canRetry, at}; desktop event engine {state, reasonCode?, message?, canRetry?, at} from main when the engine cannot answer (F9-34)',
  useAccounts:
    'Account/get; Account.health {status, reasonCode?, reconnectBy?, lastSyncAt?}, demo, baselineDoneAt, pendingChanges, colorTag (F9-35)',
  useStatus: 'as useAccounts; copy from health.reasonCode, never provider text (F9-35, F9-38)',
  useCounts:
    'Counts/get {all, accounts, folders}; CountsBlock.handledToday; state frames for type Counts; hiding from baselineDoneAt (F9-36)',
  useAgenda:
    'events window {kind: events, from, to, calendarIds?, includeDeclined?} (62 days at most) and Event/get (F9-37)',
  useSetupStatus: 'Setup/status; state frames for type Setup',
  useSettings: 'Settings/get; state frames for type Settings; Settings.ui (F9-41, UI-1 to UI-13)',
  useConsent: 'Consent/get; state frames for type Consent (F9-23, F9-43)',
  useFrames:
    'progress {runId, source, kind, step?, delta?, turnId?, citation?, proposal?, problem?} (F9-20), connect {connectId, mode, state, accountId?, reasonCode?} (F9-17) and the host clock event; a live run replays from its start (renderer-side, U8)',
  useNow: 'Session.now and the host clock event (E3); Date.now() otherwise',
  useUndoTop:
    'none beyond Operation/undo and Receipt.undoable; local entries never reach the engine (U7)',
} as const;

/** The command surface. Every method throws `NotImplementedError` until U2. */
export const api: DataApi = {
  thread: {
    act: () => notImplemented('api.thread.act'),
    why: () => notImplemented('api.thread.why'),
    open: () => notImplemented('api.thread.open'),
  },
  operation: {
    undo: () => notImplemented('api.operation.undo'),
    retry: () => notImplemented('api.operation.retry'),
  },
  submission: {
    set: () => notImplemented('api.submission.set'),
  },
  draft: {
    set: () => notImplemented('api.draft.set'),
    destroy: () => notImplemented('api.draft.destroy'),
    resolve: () => notImplemented('api.draft.resolve'),
  },
  messageBody: {
    get: () => notImplemented('api.messageBody.get'),
    prefetch: () => notImplemented('api.messageBody.prefetch'),
  },
  mail: {
    frame: () => notImplemented('api.mail.frame'),
    release: () => notImplemented('api.mail.release'),
    toggleQuotes: () => notImplemented('api.mail.toggleQuotes'),
    allowImages: () => notImplemented('api.mail.allowImages'),
  },
  attachment: {
    get: () => notImplemented('api.attachment.get'),
  },
  blob: {
    put: () => notImplemented('api.blob.put'),
    get: () => notImplemented('api.blob.get'),
  },
  sync: {
    request: () => notImplemented('api.sync.request'),
  },
  account: {
    connect: () => notImplemented('api.account.connect'),
    reconnect: () => notImplemented('api.account.reconnect'),
    grantPermissions: () => notImplemented('api.account.grantPermissions'),
    cancelConnect: () => notImplemented('api.account.cancelConnect'),
    set: () => notImplemented('api.account.set'),
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
    cancel: () => notImplemented('api.ask.cancel'),
  },
  search: {
    remote: () => notImplemented('api.search.remote'),
  },
  ai: {
    request: () => notImplemented('api.ai.request'),
    draft: () => notImplemented('api.ai.draft'),
    polish: () => notImplemented('api.ai.polish'),
    transcribe: () => notImplemented('api.ai.transcribe'),
    followup: () => notImplemented('api.ai.followup'),
    dismissFollowup: () => notImplemented('api.ai.dismissFollowup'),
    cancel: () => notImplemented('api.ai.cancel'),
  },
  unsubscribe: {
    run: () => notImplemented('api.unsubscribe.run'),
  },
  consent: {
    get: () => notImplemented('api.consent.get'),
    grant: () => notImplemented('api.consent.grant'),
    revoke: () => notImplemented('api.consent.revoke'),
  },
  engine: {
    restart: () => notImplemented('api.engine.restart'),
  },
  diagnostics: {
    preview: () => notImplemented('api.diagnostics.preview'),
    copy: () => notImplemented('api.diagnostics.copy'),
  },
};
