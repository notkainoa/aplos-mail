/**
 * The renderer data surface (F9, frozen on day 3; plan 30 section 4.1 and U2).
 *
 * Screens read mail only through these hooks and `api`. Every type is the engine contract's (`@aplos/contract`, F1),
 * re-exported from `./contract-shapes.ts`, plus the few UI-side types in `./ui-types.ts`. `api` is the F2 typed
 * client's surface (`@aplos/contract/client`): each member is the client method of the same name, and its type is
 * derived from the client, so the two cannot drift. After the freeze, changes are additive only: new members may be
 * added, nothing is renamed or removed.
 *
 * Every hook, `api` method, the clock and the undo stack forward to the data runtime that `connectDataLayer()`
 * (`./connect.ts`) installs: `client.ts`, `rows.ts`, `windows.ts`, `optimistic.ts`, `session.ts` and the rest of this
 * folder, first on the stand-in engine (F6), then on the real engine by one flag (WP5.6). Until a runtime is installed
 * each throws `DataLayerNotConnectedError`, a `NotImplementedError` naming the member and lane `ui-shell`.
 *
 * Not here: transport selection (MessagePort in Electron, tokenised HTTP and SSE in the browser preview). That lives
 * in `renderer/bridge.ts`, owned by `ui-shell`, and this surface never exposes it. `./standin.ts` boots the stand-in
 * engine in-process for development and tests only.
 *
 * This file imports nothing from today's renderer, `shared/live`, `AppState` or `engine/*`, nothing at runtime from
 * the contract (types only, so no zod), and no React: hooks are typed as plain functions so the signatures can be
 * checked without a DOM.
 */

import type {
  Account,
  AccountId,
  AccountStatus,
  Consent,
  Conversation,
  Count,
  CountsBlock,
  Draft,
  EngineEvent,
  EpochMs,
  ErrorBody,
  Event,
  Id,
  Message,
  MessageBody,
  MessageId,
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
  ViewSpecOf,
} from './ui-types';

import type { DataApi } from './data-api';

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

/** Thrown by every hook and `api` method while no data layer is connected (`connectDataLayer()` in `./connect.ts`). */
export class DataLayerNotConnectedError extends NotImplementedError {
  constructor(member: string) {
    super(member);
    this.name = 'DataLayerNotConnectedError';
    this.message = `renderer/data: ${member} has no data layer connected yet. Lane ${DATA_LANE} connects it with connectDataLayer() (renderer/data/connect.ts).`;
  }
}

/** What `connectDataLayer()` installs: the implementation of every hook, `api`, the clock and the undo stack. */
export interface DataRuntime {
  readonly useOperation: typeof useOperation;
  readonly subscribeOperation: typeof subscribeOperation;
  readonly useView: typeof useView;
  readonly useHome: typeof useHome;
  readonly useRow: typeof useRow;
  readonly useRowState: typeof useRowState;
  readonly useHold: typeof useHold;
  readonly usePrefetchIntent: typeof usePrefetchIntent;
  readonly useMessageBody: typeof useMessageBody;
  readonly useSession: typeof useSession;
  readonly useConnection: typeof useConnection;
  readonly useAccounts: typeof useAccounts;
  readonly useAccountsLoaded: typeof useAccountsLoaded;
  readonly useStatus: typeof useStatus;
  readonly useCounts: typeof useCounts;
  readonly useAgenda: typeof useAgenda;
  readonly useSetupStatus: typeof useSetupStatus;
  readonly useSettings: typeof useSettings;
  readonly useConsent: typeof useConsent;
  readonly useFrames: typeof useFrames;
  readonly useNow: typeof useNow;
  readonly getNow: typeof getNow;
  readonly setClock: typeof setClock;
  readonly undoStack: UndoStack;
  readonly useUndoTop: typeof useUndoTop;
  readonly api: DataApi;
}

let runtime: DataRuntime | null = null;

/** Installs the data runtime (`connectDataLayer()` does this), or removes it with null. */
export function installDataRuntime(next: DataRuntime | null): void {
  runtime = next;
}

function connected(member: string): DataRuntime {
  if (!runtime) throw new DataLayerNotConnectedError(member);
  return runtime;
}

function forward(group: string, verb: string, args: unknown[]): unknown {
  const api = connected(`api.${group}.${verb}`).api as unknown as Record<
    string,
    Record<string, (...a: unknown[]) => unknown>
  >;
  return api[group]![verb]!(...args);
}

// ---------------------------------------------------------------------------
// Timing constants the data layer owns
// ---------------------------------------------------------------------------

/** Hold timing (DESIGN 5 rule 6, plan 30 4.3): release 450 ms after the last key; with the pointer still on the list, wait for it to leave but never past 1200 ms after the last key. `holds.ts` runs on the generated `hold` motion; `layer.test.ts` checks these agree with it. */
export const HOLD_TIMING = {
  /** Release this long after the last triage key (a burst of any length closes once). */
  releaseAfterLastKeyMs: 450,
  /** With the pointer still on the list, a key hold closes this long after the last key; a pointer resting with no key holds until it leaves. */
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
  return connected('useOperation').useOperation(opId);
}

/**
 * Observe one operation without a component (an effect watching its write's provider-side state). The
 * listener runs once with the current view, then on each change; the return unsubscribes.
 */
export function subscribeOperation(
  opId: OpId,
  listener: (view: OperationView | undefined) => void,
): () => void {
  return connected('subscribeOperation').subscribeOperation(opId, listener);
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
  return connected('useView').useView(spec, opts);
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
  /** The Low importance band; at count 0 it still shows while the view has other mail, and opens "No low-importance mail". */
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
  return connected('useHome').useHome(opts);
}

// ---------------------------------------------------------------------------
// Rows (plan 30 4.1 rows.ts)
// ---------------------------------------------------------------------------

/** One cached row by contract type name and id; undefined until known and also when gone (use `useRowState` to tell them apart). Referentially stable while `rev` is unchanged, so it is safe in memo deps. */
export function useRow<T extends CachedRowType>(
  type: T,
  id: Id | undefined,
): RowTypeMap[T] | undefined {
  return connected('useRow').useRow(type, id);
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
  return connected('useRowState').useRowState(type, id);
}

// ---------------------------------------------------------------------------
// Holding still, renderer half (DESIGN 5 rule 6; plan 30 4.1 and 4.3)
// ---------------------------------------------------------------------------

/** What holds the list: a triage burst (also while it waits on the pointer), or the pointer resting over the list alone. */
export type HoldReason = 'keys' | 'pointer';

/** Called when a hold releases; the motion lane runs `close` (FLIP from fixed row heights) here. */
export type HoldReleaseListener = (released: {
  readonly ids: readonly Id[];
  readonly reason: HoldReason;
}) => void;

/** One list's hold. Methods are synchronous and safe inside a keydown handler. */
export interface HoldController {
  /** Start or refresh a hold pinning `ids`. `keys`: the rows around the cursor; restarts the 450 ms release timer (with the pointer still on the list it waits for it, up to 1200 ms after the last key). `pointer`: the row under the pointer; holds until `release()`. */
  begin(reason: HoldReason, ids: readonly Id[]): void;
  /** Another key: push the release back 450 ms, optionally adding ids (begins a key hold when idle). */
  extend(ids?: readonly Id[]): void;
  /** Close now (Esc, navigation, or the pointer that `begin('pointer')` named left the list). A pointer the list reported with `pointerEnter` keeps holding its row until `pointerLeave`. */
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

/**
 * The list's full hold gate: a `HoldController` plus `pointerEnter(ids)` (the row under the pointer; call it on
 * pointerenter and pointermove) and `pointerLeave()`. `useHold` returns one; give the same object to the motion
 * runtime's triage so the engine hold and the close run on one gate.
 */
export type { HoldGate } from './holds';

/** The hold controller for one list, keyed by a scope name such as `home` or `later`. The object is a `HoldGate`. */
export function useHold(scope: string): HoldController {
  return connected('useHold').useHold(scope);
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
  return connected('usePrefetchIntent').usePrefetchIntent();
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
  return connected('useMessageBody').useMessageBody(messageId);
}

// ---------------------------------------------------------------------------
// Session, accounts, status slot, counts, setup, settings, consent (ARCH 6.4, 9.5)
// ---------------------------------------------------------------------------

/** The session singleton (`Session/get`, re-read on a `state` frame for type `Session`); undefined until it answers. Whether the engine is still coming or gone is `useConnection`'s job. */
export function useSession(): Session | undefined {
  return connected('useSession').useSession();
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
  return connected('useConnection').useConnection();
}

/** All accounts (`Account/get`), in sidebar order, each with `health` (status, `reasonCode`, `reconnectBy`, `lastSyncAt`). */
export function useAccounts(): readonly Account[] {
  return connected('useAccounts').useAccounts();
}

/** True once `Account/get` has answered, so an empty `useAccounts()` list means "no accounts" and not "not loaded yet". Additive. */
export function useAccountsLoaded(): boolean {
  return connected('useAccountsLoaded').useAccountsLoaded();
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
  return connected('useStatus').useStatus(accountId);
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
  return connected('useCounts').useCounts(accountId);
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
  return connected('useAgenda').useAgenda(spec);
}

/** First-sync progress (`Setup/status`, re-read on a `state` frame for type `Setup`); undefined until known. */
export function useSetupStatus(): SetupStatus | undefined {
  return connected('useSetupStatus').useSetupStatus();
}

/** The settings singleton (`Settings/get`, re-read on a `state` frame for type `Settings`); undefined until known. */
export function useSettings(): Settings | undefined {
  return connected('useSettings').useSettings();
}

/** The background-AI consent record (`Consent/get`, re-read on a `state` frame for type `Consent`); undefined until known. Consent is not a settings field: `needsReconsent` says whether the card must ask again. */
export function useConsent(): Consent | undefined {
  return connected('useConsent').useConsent();
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
  return connected('useFrames').useFrames(kind, filter, opts);
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
  return connected('useNow').useNow(opts);
}

/** Now from the same source as `useNow`, for event handlers (no subscription). */
export function getNow(): EpochMs {
  return connected('getNow').getNow();
}

/** Injects the clock `useNow` and `getNow` read (the harness's frozen 2026-10-29T10:00, unit tests); null restores the default source. */
export function setClock(clock: Clock | null): void {
  connected('setClock').setClock(clock);
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

/** The app's undo stack; each method throws `DataLayerNotConnectedError` until a data layer is connected. */
export const undoStack: UndoStack = {
  push: entry => connected('undoStack.push').undoStack.push(entry),
  undoLast: () => connected('undoStack.undoLast').undoStack.undoLast(),
  peek: () => connected('undoStack.peek').undoStack.peek(),
};

/** The newest undoable entry, live, for the toast and its "· Undo Z". */
export function useUndoTop(): UndoEntry | null {
  return connected('useUndoTop').useUndoTop();
}

// ---------------------------------------------------------------------------
// The command surface: the F2 typed client's methods, by the client's names
// ---------------------------------------------------------------------------

export type { CommandArgs, RequestArgs, ThreadActArgs, UndoArgs, DataApi } from './data-api';

// The mapping from `api` method to contract method, and what each hook reads from the contract.
export type {
  ApiMethodName,
  ContractMethodOf,
  ContractCallKind,
  ContractMethodRef,
} from './contract-methods';
export { CONTRACT_METHODS, CONTRACT_HOOK_NEEDS } from './contract-methods';

/** The command surface; each method forwards to the connected data layer and throws `DataLayerNotConnectedError` until one is. */
export const api: DataApi = {
  thread: {
    act: ((...args: unknown[]) => forward('thread', 'act', args)) as DataApi['thread']['act'],
    why: ((...args: unknown[]) => forward('thread', 'why', args)) as DataApi['thread']['why'],
    open: ((...args: unknown[]) => forward('thread', 'open', args)) as DataApi['thread']['open'],
  },
  operation: {
    undo: ((...args: unknown[]) =>
      forward('operation', 'undo', args)) as DataApi['operation']['undo'],
    retry: ((...args: unknown[]) =>
      forward('operation', 'retry', args)) as DataApi['operation']['retry'],
  },
  submission: {
    set: ((...args: unknown[]) =>
      forward('submission', 'set', args)) as DataApi['submission']['set'],
  },
  draft: {
    set: ((...args: unknown[]) => forward('draft', 'set', args)) as DataApi['draft']['set'],
    destroy: ((...args: unknown[]) =>
      forward('draft', 'destroy', args)) as DataApi['draft']['destroy'],
    resolve: ((...args: unknown[]) =>
      forward('draft', 'resolve', args)) as DataApi['draft']['resolve'],
  },
  messageBody: {
    get: ((...args: unknown[]) =>
      forward('messageBody', 'get', args)) as DataApi['messageBody']['get'],
    prefetch: ((...args: unknown[]) =>
      forward('messageBody', 'prefetch', args)) as DataApi['messageBody']['prefetch'],
  },
  mail: {
    frame: ((...args: unknown[]) => forward('mail', 'frame', args)) as DataApi['mail']['frame'],
    release: ((...args: unknown[]) =>
      forward('mail', 'release', args)) as DataApi['mail']['release'],
    toggleQuotes: ((...args: unknown[]) =>
      forward('mail', 'toggleQuotes', args)) as DataApi['mail']['toggleQuotes'],
    allowImages: ((...args: unknown[]) =>
      forward('mail', 'allowImages', args)) as DataApi['mail']['allowImages'],
  },
  attachment: {
    get: ((...args: unknown[]) =>
      forward('attachment', 'get', args)) as DataApi['attachment']['get'],
  },
  blob: {
    put: ((...args: unknown[]) => forward('blob', 'put', args)) as DataApi['blob']['put'],
    get: ((...args: unknown[]) => forward('blob', 'get', args)) as DataApi['blob']['get'],
    release: ((...args: unknown[]) =>
      forward('blob', 'release', args)) as DataApi['blob']['release'],
  },
  sync: {
    request: ((...args: unknown[]) =>
      forward('sync', 'request', args)) as DataApi['sync']['request'],
  },
  account: {
    discover: ((...args: unknown[]) =>
      forward('account', 'discover', args)) as DataApi['account']['discover'],
    disconnect: ((...args: unknown[]) =>
      forward('account', 'disconnect', args)) as DataApi['account']['disconnect'],
    lease: ((...args: unknown[]) =>
      forward('account', 'lease', args)) as DataApi['account']['lease'],
    connect: ((...args: unknown[]) =>
      forward('account', 'connect', args)) as DataApi['account']['connect'],
    reconnect: ((...args: unknown[]) =>
      forward('account', 'reconnect', args)) as DataApi['account']['reconnect'],
    grantPermissions: ((...args: unknown[]) =>
      forward('account', 'grantPermissions', args)) as DataApi['account']['grantPermissions'],
    cancelConnect: ((...args: unknown[]) =>
      forward('account', 'cancelConnect', args)) as DataApi['account']['cancelConnect'],
    set: ((...args: unknown[]) => forward('account', 'set', args)) as DataApi['account']['set'],
  },
  setup: {
    begin: ((...args: unknown[]) => forward('setup', 'begin', args)) as DataApi['setup']['begin'],
    end: ((...args: unknown[]) => forward('setup', 'end', args)) as DataApi['setup']['end'],
    retry: ((...args: unknown[]) => forward('setup', 'retry', args)) as DataApi['setup']['retry'],
  },
  demo: {
    load: ((...args: unknown[]) => forward('demo', 'load', args)) as DataApi['demo']['load'],
    reset: ((...args: unknown[]) => forward('demo', 'reset', args)) as DataApi['demo']['reset'],
    remove: ((...args: unknown[]) => forward('demo', 'remove', args)) as DataApi['demo']['remove'],
  },
  settings: {
    get: ((...args: unknown[]) => forward('settings', 'get', args)) as DataApi['settings']['get'],
    set: ((...args: unknown[]) => forward('settings', 'set', args)) as DataApi['settings']['set'],
  },
  ask: {
    decide: ((...args: unknown[]) => forward('ask', 'decide', args)) as DataApi['ask']['decide'],
    suggestions: ((...args: unknown[]) =>
      forward('ask', 'suggestions', args)) as DataApi['ask']['suggestions'],
    run: ((...args: unknown[]) => forward('ask', 'run', args)) as DataApi['ask']['run'],
    cancel: ((...args: unknown[]) => forward('ask', 'cancel', args)) as DataApi['ask']['cancel'],
  },
  search: {
    remote: ((...args: unknown[]) =>
      forward('search', 'remote', args)) as DataApi['search']['remote'],
  },
  ai: {
    providers: ((...args: unknown[]) =>
      forward('ai', 'providers', args)) as DataApi['ai']['providers'],
    models: ((...args: unknown[]) => forward('ai', 'models', args)) as DataApi['ai']['models'],
    status: ((...args: unknown[]) => forward('ai', 'status', args)) as DataApi['ai']['status'],
    usage: ((...args: unknown[]) => forward('ai', 'usage', args)) as DataApi['ai']['usage'],
    setKey: ((...args: unknown[]) => forward('ai', 'setKey', args)) as DataApi['ai']['setKey'],
    removeKey: ((...args: unknown[]) =>
      forward('ai', 'removeKey', args)) as DataApi['ai']['removeKey'],
    testKey: ((...args: unknown[]) => forward('ai', 'testKey', args)) as DataApi['ai']['testKey'],
    request: ((...args: unknown[]) => forward('ai', 'request', args)) as DataApi['ai']['request'],
    draft: ((...args: unknown[]) => forward('ai', 'draft', args)) as DataApi['ai']['draft'],
    polish: ((...args: unknown[]) => forward('ai', 'polish', args)) as DataApi['ai']['polish'],
    transcribe: ((...args: unknown[]) =>
      forward('ai', 'transcribe', args)) as DataApi['ai']['transcribe'],
    followup: ((...args: unknown[]) =>
      forward('ai', 'followup', args)) as DataApi['ai']['followup'],
    dismissFollowup: ((...args: unknown[]) =>
      forward('ai', 'dismissFollowup', args)) as DataApi['ai']['dismissFollowup'],
    cancel: ((...args: unknown[]) => forward('ai', 'cancel', args)) as DataApi['ai']['cancel'],
  },
  unsubscribe: {
    run: ((...args: unknown[]) =>
      forward('unsubscribe', 'run', args)) as DataApi['unsubscribe']['run'],
  },
  consent: {
    get: ((...args: unknown[]) => forward('consent', 'get', args)) as DataApi['consent']['get'],
    grant: ((...args: unknown[]) =>
      forward('consent', 'grant', args)) as DataApi['consent']['grant'],
    revoke: ((...args: unknown[]) =>
      forward('consent', 'revoke', args)) as DataApi['consent']['revoke'],
  },
  engine: {
    restart: ((...args: unknown[]) =>
      forward('engine', 'restart', args)) as DataApi['engine']['restart'],
    recover: ((...args: unknown[]) =>
      forward('engine', 'recover', args)) as DataApi['engine']['recover'],
  },
  diagnostics: {
    preview: ((...args: unknown[]) =>
      forward('diagnostics', 'preview', args)) as DataApi['diagnostics']['preview'],
    copy: ((...args: unknown[]) =>
      forward('diagnostics', 'copy', args)) as DataApi['diagnostics']['copy'],
    export: ((...args: unknown[]) =>
      forward('diagnostics', 'export', args)) as DataApi['diagnostics']['export'],
    verbose: ((...args: unknown[]) =>
      forward('diagnostics', 'verbose', args)) as DataApi['diagnostics']['verbose'],
  },
  contact: {
    suggest: ((...args: unknown[]) =>
      forward('contact', 'suggest', args)) as DataApi['contact']['suggest'],
  },
  data: {
    export: ((...args: unknown[]) => forward('data', 'export', args)) as DataApi['data']['export'],
  },
  workflow: {
    status: ((...args: unknown[]) =>
      forward('workflow', 'status', args)) as DataApi['workflow']['status'],
    enable: ((...args: unknown[]) =>
      forward('workflow', 'enable', args)) as DataApi['workflow']['enable'],
    code: ((...args: unknown[]) =>
      forward('workflow', 'code', args)) as DataApi['workflow']['code'],
    disable: ((...args: unknown[]) =>
      forward('workflow', 'disable', args)) as DataApi['workflow']['disable'],
  },
  file: {
    save: ((...args: unknown[]) => forward('file', 'save', args)) as DataApi['file']['save'],
  },
  conversation: {
    destroy: ((...args: unknown[]) =>
      forward('conversation', 'destroy', args)) as DataApi['conversation']['destroy'],
  },
  event: {
    set: ((...args: unknown[]) => forward('event', 'set', args)) as DataApi['event']['set'],
    hide: ((...args: unknown[]) => forward('event', 'hide', args)) as DataApi['event']['hide'],
    rsvp: ((...args: unknown[]) => forward('event', 'rsvp', args)) as DataApi['event']['rsvp'],
  },
  calendar: {
    get: ((...args: unknown[]) => forward('calendar', 'get', args)) as DataApi['calendar']['get'],
    set: ((...args: unknown[]) => forward('calendar', 'set', args)) as DataApi['calendar']['set'],
  },
  plan: {
    confirm: ((...args: unknown[]) =>
      forward('plan', 'confirm', args)) as DataApi['plan']['confirm'],
    dismiss: ((...args: unknown[]) =>
      forward('plan', 'dismiss', args)) as DataApi['plan']['dismiss'],
  },
  listener: {
    get: ((...args: unknown[]) => forward('listener', 'get', args)) as DataApi['listener']['get'],
    set: ((...args: unknown[]) => forward('listener', 'set', args)) as DataApi['listener']['set'],
  },
  clients: {
    list: ((...args: unknown[]) => forward('clients', 'list', args)) as DataApi['clients']['list'],
    grant: ((...args: unknown[]) =>
      forward('clients', 'grant', args)) as DataApi['clients']['grant'],
    revoke: ((...args: unknown[]) =>
      forward('clients', 'revoke', args)) as DataApi['clients']['revoke'],
    audit: ((...args: unknown[]) =>
      forward('clients', 'audit', args)) as DataApi['clients']['audit'],
  },
  queue: {
    list: ((...args: unknown[]) => forward('queue', 'list', args)) as DataApi['queue']['list'],
    retry: ((...args: unknown[]) => forward('queue', 'retry', args)) as DataApi['queue']['retry'],
    discard: ((...args: unknown[]) =>
      forward('queue', 'discard', args)) as DataApi['queue']['discard'],
  },
  window: {
    openOnboarding: ((...args: unknown[]) =>
      forward('window', 'openOnboarding', args)) as DataApi['window']['openOnboarding'],
    finishOnboarding: ((...args: unknown[]) =>
      forward('window', 'finishOnboarding', args)) as DataApi['window']['finishOnboarding'],
    closeReady: ((...args: unknown[]) =>
      forward('window', 'closeReady', args)) as DataApi['window']['closeReady'],
    closeCancel: ((...args: unknown[]) =>
      forward('window', 'closeCancel', args)) as DataApi['window']['closeCancel'],
  },
  update: {
    status: ((...args: unknown[]) =>
      forward('update', 'status', args)) as DataApi['update']['status'],
    check: ((...args: unknown[]) => forward('update', 'check', args)) as DataApi['update']['check'],
    restart: ((...args: unknown[]) =>
      forward('update', 'restart', args)) as DataApi['update']['restart'],
    later: ((...args: unknown[]) => forward('update', 'later', args)) as DataApi['update']['later'],
  },
  system: {
    login: ((...args: unknown[]) => forward('system', 'login', args)) as DataApi['system']['login'],
    defaultMail: ((...args: unknown[]) =>
      forward('system', 'defaultMail', args)) as DataApi['system']['defaultMail'],
    microphone: ((...args: unknown[]) =>
      forward('system', 'microphone', args)) as DataApi['system']['microphone'],
    notifications: ((...args: unknown[]) =>
      forward('system', 'notifications', args)) as DataApi['system']['notifications'],
    openSettings: ((...args: unknown[]) =>
      forward('system', 'openSettings', args)) as DataApi['system']['openSettings'],
  },
  shell: {
    open: ((...args: unknown[]) => forward('shell', 'open', args)) as DataApi['shell']['open'],
  },
  notification: {
    test: ((...args: unknown[]) =>
      forward('notification', 'test', args)) as DataApi['notification']['test'],
  },
};
