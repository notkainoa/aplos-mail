/**
 * Runs the reducer's effects against `renderer/data` and `renderer/shell`. One write is one `opId`, so its toast
 * (id = opId, an `app.undo` action and no `onAction`) makes the shell undo that write and nothing else (review1 3;
 * `runToastAction` in `shell/store-toast.ts` calls `api.operation.undo({opId})`). Every write joins the one undo
 * stack by itself, so Z keeps undoing the newest change and the lane pushes no entry of its own. An Undo pressed
 * before the write has returned is not lost: the data layer records the operation when it is issued and
 * `Operation/undo` lands behind the write on the one connection (review1 plausible).
 *
 * No React: the container binds the ports to `api.*` and the state setters; tests drive it with the real data layer
 * and stand-in toasts.
 */
import type { EventChange } from '@aplos/contract';
import {
  api,
  type ActResult,
  type ErrorBody,
  type OperationView,
  type Receipt,
  type State,
} from '../../data';
import { toErrorBody } from '../../data/client';
import {
  dismissToast,
  openSheet,
  openThread,
  pushToast,
  updateToast,
  type PushedToast,
} from '../../shell';
import { getToasts, subscribeToasts } from '../../shell/store-toast';
import type { CommandId, EventScope } from '../../ui/props';
import {
  rsvpMessage,
  type CalendarEffect,
  type EditorDraft,
  type OptimisticChange,
  type ToastPlan,
} from './calendar.model';
import { CALENDAR_ACCESS_COPY, EDITING_COPY } from './accountCalendarState';
import { undoFailureMessage, writeFailureOf, type WriteFailure } from './writeErrors';

/** The contract calls an effect may make, bound by the container (or a test). */
export interface EffectPorts {
  eventSet(args: {
    readonly opId: string;
    readonly change: EventChange;
    /** `notify: true` asks the engine to hold the write for undo — sent only when guests are emailed. */
    readonly notify?: boolean;
  }): Promise<{ readonly receipt: Receipt }>;
  eventRsvp(args: {
    readonly opId: string;
    readonly id: string;
    readonly response: 'accepted' | 'tentative' | 'declined';
    readonly scope: EventScope;
  }): Promise<Receipt>;
  calendarSet(args: {
    readonly opId: string;
    readonly id: string;
    readonly shown: boolean;
  }): Promise<{ readonly receipt: Receipt }>;
  planConfirm(args: {
    readonly opId: string;
    readonly id: string;
    readonly calendarId?: string;
  }): Promise<{ readonly receipt: Receipt }>;
  planDismiss(args: { readonly opId: string; readonly ids: string[] }): Promise<Receipt>;
  eventHide(args: {
    readonly opId: string;
    readonly ids: string[];
    readonly hidden: boolean;
  }): Promise<Receipt>;
  /** `Account/grantPermissions {accountId, enable:'calendarWrite'}`: opens the same connect sheet; the account's `grantedScopes` gains the write scope when it finishes. */
  enableEditing(accountId: string): Promise<void>;
  /** Opens the same sign-in sheet the sidebar's Sign in again opens (`openSheet('reconnect', {mode:'reconnect'})`). */
  reconnect(accountId: string): void;
  /** `Operation/undo {opId}`: a write toast's own Undo verb; absent = the live `api`. */
  operationUndo?(opId: string): ActResult;
  openThread(threadId: string): void;
  openUrl(url: string): void;
  copyText(text: string): void;
}

/** The state setters an effect needs. */
export interface EffectUi {
  /**
   * Apply the write's optimistic change at once, as its own layer under `writeId` (DESIGN 5 rule
   * 1): two writes can touch one entry (a second drag while the first is still held), and each
   * write's rollback must take only its own layer — never the other write's patch (review15).
   */
  optimistic(change: OptimisticChange, writeId: string): void;
  /** Keep the write's layer until a window reaches the write's applied state. */
  settle(writeId: string, entryIds: readonly string[], at: State | null): void;
  /**
   * Keep the write's layer until a frame strictly newer than the one showing now arrives — the
   * `synced` op frame lands ahead of the throttled window rerun (review15), so settling at the
   * receipt's state would snap the change back for ~250 ms. Bounded: a lost frame drops the layer
   * anyway, so it cannot ghost.
   */
  settleAfterFrame(writeId: string, entryIds: readonly string[]): void;
  /** Drop the write's layer (a refusal, an undo, a forgotten op). */
  rollback(writeId: string, entryIds: readonly string[]): void;
  /** A calendar's `shown` changed locally until `Calendar/get` is re-read. */
  shown(id: string, shown: boolean): void;
  /** The `Calendar/set` write returned: the next get is authoritative. */
  shownSettled(id: string): void;
  /** The write was refused: drop the local `shown` so the real value shows. */
  shownFailed(id: string): void;
  /** Move focus after the change. */
  focus(target: 'grid' | 'rail'): void;
  /**
   * `calendar.conflict` on an editor save: re-open the editor on the newer copy already in the store,
   * carrying `note` as its error line. True when the editor opened; false when the row cannot be
   * edited (locked, gated, gone), so the caller falls back to the notice (review7 5).
   */
  reopenEditor(eventId: string, note: string): boolean;
  /**
   * A times refusal (`event.allDayMismatch`, `event.timesRequired`) on an editor save: re-open the
   * editor on the saved draft itself — typed work kept, `note` as its error line. True when the
   * editor opened; false while another draft owns it, so the caller falls back to the notice.
   */
  restoreEditor(draft: EditorDraft, note: string): boolean;
  /** `calendar.eventGone`: close the detail only when it shows `eventId` — never an unrelated one (review7 4). */
  closeDetail(eventId: string): void;
  /**
   * A write's receipt landed: follow its operation through the provider queue (`operationUpdate`
   * runs on every `OperationView` and window change) until it is done.
   */
  watch(write: WatchedWrite): void;
}

/**
 * What one accepted write's watcher needs (the providers' 2026-11-11 NOTICE: every state lands as
 * an `operation` frame — `queued` → `syncing` → `synced` | `failed` | `cancelled`).
 */
export interface WatchedWrite {
  /** The write's operation id; also its Undo toast's id. */
  readonly opId: string;
  /** Every overlay id the write covers; they settle on `synced` and roll back on `failed`/`cancelled`. */
  readonly entryIds: readonly string[];
  /** The receipt's `appliedState`: `synced` settles the overlay against a window frame at it. */
  readonly at: State | null;
  /**
   * The write was held (its receipt's hold still open): the receipt settle was skipped — the hold's
   * own commit never moves `seq`, so `appliedState` is already reached and settling there would
   * snap the change back for the whole undo window. `synced` settles every entry instead.
   */
  readonly held: boolean;
  /** Overlay ids the write added (a held create's tmp entries): the real rows replace them on sight. */
  readonly addedIds: readonly string[];
  /** The write's fallback sentence when its operation fails (a reasonCode's own line wins). */
  readonly failure?: string;
  /** An editor save's event id: `calendar.conflict` re-opens the editor on the newer copy. */
  readonly reopenEditorId?: string;
  /** An editor save's draft: a times refusal re-opens the editor on it, typed work intact. */
  readonly draft?: EditorDraft;
  /** The entry the write was about: `calendar.eventGone` closes the detail only when it shows this id. */
  readonly goneEventId?: string;
  /** The account the write went to: `permission.calendarWrite` offers Enable editing on it. */
  readonly accountId?: string;
  /**
   * The engine's hold target (`targetOf` in holds.ts) while the write is held: a second held write
   * on it is refused at once, and the mark is freed when the operation reaches a terminal state.
   */
  readonly target?: string;
  /**
   * Set on a re-watch after `Operation/retry`: the previous terminal row still answers
   * `Operation/get` until the next flush, so the identical view object means "nothing newer yet" —
   * keep watching; never re-show the failure the owner just retried (the operation view is memoized,
   * so a genuinely newer frame is always a different object).
   */
  readonly since?: OperationView;
}

const newOpId = (): string => crypto.randomUUID();

/**
 * A write toast's Undo verb: `keysFrom` shows the Z keycap while the click stays the lane's own —
 * the undo goes to `Operation/undo {opId}` and a `conflict` answer (the hold is over, the change
 * already went) becomes the plain 'already been sent' notice (review12). Pressing Z is the shell's
 * own undo path, unchanged.
 */
function undoVerb(ports: EffectPorts, opId: string): Pick<PushedToast, 'actions' | 'onAction'> {
  return {
    actions: [{ id: 'undo', label: 'Undo', keysFrom: 'app.undo' as CommandId }],
    onAction: actionId => {
      if (actionId !== 'undo') return;
      undoWrite(ports, opId);
    },
  };
}

/** `Operation/undo {opId}`; a refusal lands as its own notice after the Undo toast closes. */
function undoWrite(ports: EffectPorts, opId: string): void {
  try {
    const undo = ports.operationUndo?.(opId) ?? api.operation.undo({ opId });
    undo.receipt.then(undefined, error => pushUndoFailed(opId, error));
  } catch (error) {
    pushUndoFailed(opId, error);
  }
}

function pushUndoFailed(opId: string, error: unknown): void {
  pushToast({
    id: `${opId}:undo-failed`,
    kind: 'info',
    message: undoFailureMessage(error),
    undoable: false,
  });
}

/**
 * A write-through receipt (`undoable:false`, the providers' 2026-11-10 shape 9: no hold, no undo window
 * yet): the Undo toast pushed on keydown becomes the plain confirmation in place — dismissed and
 * re-pushed, so it loses the Undo action and the 8 s life, like 'Link copied'. One notice per operation
 * still holds (the id is the opId). `message` is the sent wording, as for a hold that ended.
 */
function demoteUndoToast(opId: string, toast: ToastPlan): void {
  dismissToast(opId);
  pushToast({ id: opId, kind: toast.kind, message: toast.message, undoable: false });
}

/** The calm 'Turn on editing' notice with the Enable editing action (shape 3): a notice, not an error banner. */
function editingNotice(ports: EffectPorts, accountId: string | undefined): void {
  pushToast({
    id: `editing:${accountId ?? 'unknown'}`,
    kind: 'info',
    message: EDITING_COPY.notice,
    // No account behind the write: the line alone — never an Enable editing that opens nothing (review7 8).
    ...(accountId === undefined
      ? {}
      : {
          actions: [{ id: 'enable', label: EDITING_COPY.action }],
          onAction: (actionId: string) => {
            if (actionId !== 'enable') return;
            void ports.enableEditing(accountId).then(undefined, error => {
              pushToast({
                id: newOpId(),
                kind: 'info',
                message: toErrorBody(error).message,
                undoable: false,
              });
            });
          },
        }),
    undoable: false,
  });
}

/**
 * The dead-grant notice with the Sign in again action (a `needsReauth` / `auth.expired` write): one
 * line plus the same sign-in the sidebar's account row runs. No account behind the write: the line
 * alone — never a Sign in again that opens nothing.
 */
function reconnectNotice(ports: EffectPorts, accountId: string | undefined): void {
  pushToast({
    id: `reconnect:${accountId ?? 'unknown'}`,
    kind: 'info',
    message: 'Sign in to Google again to change events.',
    ...(accountId === undefined
      ? {}
      : {
          actions: [{ id: 'reconnect', label: CALENDAR_ACCESS_COPY.signIn }],
          onAction: (actionId: string) => {
            if (actionId !== 'reconnect') return;
            ports.reconnect(accountId);
          },
        }),
    undoable: false,
  });
}

/**
 * Delayed retries waiting out a server's `retryAfterMs`: each entry cancels its pending write and its
 * toast watcher, so neither a dismissal nor the screen going away leaves a surprise write to fire
 * later (review7 9). The container calls `cancelPendingRetries` on unmount.
 */
const pendingRetries = new Set<() => void>();

/**
 * The targets of writes the engine still holds (`queued` or `syncing` — holds.ts refuses a second
 * hold on either with `calendar.holdPending`). Mirroring them here lets a second held write fail
 * fast: it submits nothing, and — the real fix — its optimistic layer is never laid over the first
 * write's, so nothing merges and nothing can roll the pair back together (review15).
 */
const heldTargets = new Set<string>();

/** The screen going away cancels every delayed retry still waiting: no write fires behind its back. */
export function cancelPendingRetries(): void {
  for (const disarm of [...pendingRetries]) disarm();
}

/** The screen went away with holds still open: forget them — a stale mark must not refuse writes forever. */
export function releaseHeldWrites(): void {
  heldTargets.clear();
}

/**
 * The refusal toast: Retry only when the mapped failure may still go through (`writeFailureOf`). A
 * 'delayed' retry arms as the notice lands — Retry goes at once, and the notice leaving the stack
 * (dismissed, faded, evicted) or the screen unmounting cancels the pending write (review7 9). The
 * retry runs once: the timer's own firing spends the notice's Retry and takes the notice down with
 * it, so a later click can never duplicate the write (review8 1).
 */
function failureToast(opId: string, failure: WriteFailure, retry: () => void): void {
  const id = `${opId}:failed`;
  let disarm: (() => void) | undefined;
  let spent = false;
  const retryOnce = (): void => {
    if (spent) return;
    spent = true;
    disarm?.();
    dismissToast(id);
    retry();
  };
  if (failure.retry === 'delayed' && failure.retryAfterMs !== undefined) {
    const timer = setTimeout(() => {
      if (disarm === undefined) return; // disarmed before it could fire
      retryOnce();
    }, failure.retryAfterMs);
    const self = (): void => {
      if (disarm === undefined) return;
      disarm = undefined;
      clearTimeout(timer);
      off();
      pendingRetries.delete(self);
    };
    disarm = self;
    const off = subscribeToasts(() => {
      if (!getToasts().some(t => t.id === id)) self();
    });
    pendingRetries.add(self);
  }
  pushToast({
    id,
    kind: 'info',
    message: failure.message,
    ...(failure.retry === 'none' && failure.opRetry !== true
      ? {}
      : { actions: [{ id: 'retry', label: 'Retry' }] }),
    undoable: false,
    onAction: actionId => {
      if (actionId !== 'retry') return;
      retryOnce();
    },
  });
}

/**
 * The toast for a failure the provider reported on an ACCEPTED write: `persistent` — a Retry the
 * owner must still find after looking away (~4 s is too easy to miss for a change they believe is
 * in) — and its Retry, when one is honest, is the operation's own `Operation/retry` on the same
 * opId, manual only. Nothing here arms a timer: a `retryAfterMs` at this level means "try later",
 * never an auto-fired re-send of a write that emails guests without a click (review15).
 */
function opFailureToast(opId: string, failure: WriteFailure, retryOp: () => void): void {
  let spent = false;
  pushToast({
    id: `${opId}:failed`,
    kind: 'info',
    message: failure.message,
    ...(failure.retry === 'none' && failure.opRetry !== true
      ? {}
      : { actions: [{ id: 'retry', label: 'Retry' }] }),
    undoable: false,
    persistent: true,
    onAction: actionId => {
      if (actionId !== 'retry' || spent) return;
      spent = true;
      retryOp();
    },
  });
}

/** What one write's `call` reports once its receipt lands. */
interface WriteOutcome {
  /** The applied state the overlay settles against. */
  readonly at: State | null;
  /** `undoUntil` in the future: a held write guests are not told about yet. */
  readonly held: boolean;
  /**
   * `receipt.undoable !== false`: an operation exists to follow — `Operation/undo` answering the id
   * means the engine journaled one (a hold or a thread op). A plain accepted write has none:
   * `Operation/get` answers notFound and a watch on it would never end.
   */
  readonly undoable: boolean;
}

/** What a write failure's follow-ups read, on the WriteSpec at submit time or its WatchedWrite after. */
interface FailureContext {
  /** An editor save's event id: on `calendar.conflict` the editor re-opens on the newer copy. */
  readonly reopenEditorId?: string;
  /** An editor save's draft: a times refusal re-opens the editor on it, typed work intact. */
  readonly draft?: EditorDraft;
  /** The entry the write was about: `calendar.eventGone` closes the detail only when it shows this id. */
  readonly goneEventId?: string;
  /** The account the write went to: `permission.calendarWrite` offers Enable editing on it. */
  readonly accountId?: string;
}

/** What a refusal needs that the effect knows at submit time: the WriteSpec minus the write itself. */
interface RefusalSpec extends FailureContext {
  readonly opId: string;
  /** The refusal sentence; absent = a quiet dismissal (a plan's "Not now"). */
  readonly failure?: string;
  /** A blind retry could duplicate the write or re-notify guests (a create, an RSVP): unknown codes get none. */
  readonly blindRetryUnsafe?: boolean;
}

interface WriteSpec extends RefusalSpec {
  /** Every overlay id the write covers (a series time shift patches a whole family); they settle and roll back together. */
  readonly entryIds: readonly string[];
  /** Overlay ids the write added (a create's tmp entries): a held one has no real row until the send confirms. */
  readonly addedIds: readonly string[];
  /** The overlay stays until a window reaches this state; `held` says the receipt's hold is still open. */
  readonly call: () => Promise<WriteOutcome>;
  /** The engine's hold target (holds.ts `targetOf`): a second held write on it is refused while this one waits. */
  readonly target?: string;
}

/**
 * The follow-ups a write failure runs, shared between the submit-time refusal (`writeFailed`) and
 * the operation watch's `failed`: the conflict's re-opened editor or the saved draft's restore, the
 * grant notices (Enable editing, Sign in again), and the gone event's closed detail. True when one
 * of them already carries the sentence — the caller then adds no toast of its own (review7 5).
 */
function failureHandled(
  source: FailureContext,
  failure: WriteFailure,
  ui: EffectUi,
  ports: EffectPorts,
): boolean {
  const reopened =
    failure.reopenEditor === true &&
    source.reopenEditorId !== undefined &&
    ui.reopenEditor(source.reopenEditorId, failure.message);
  const restored =
    failure.keepDraft === true &&
    source.draft !== undefined &&
    ui.restoreEditor(source.draft, failure.message);
  if (failure.enableEditing) editingNotice(ports, source.accountId);
  else if (failure.reconnect) reconnectNotice(ports, source.accountId);
  if (failure.closeDetail && source.goneEventId !== undefined) ui.closeDetail(source.goneEventId);
  return failure.enableEditing === true || failure.reconnect === true || reopened || restored;
}

/** Runs one write's mapped failure: notice, Enable editing when the grant lacks the scope, then the code's own follow-up. */
function writeFailed(
  spec: WriteSpec,
  ui: EffectUi,
  ports: EffectPorts,
  error: unknown,
  retry: () => void,
): void {
  ui.rollback(spec.opId, spec.entryIds);
  dismissToast(spec.opId);
  if (!spec.failure) return;
  const failure = writeFailureOf(error, spec.failure, spec.blindRetryUnsafe === true);
  // `opRetry` names the OPERATION's own `Operation/retry` — a submit-time refusal accepted
  // nothing, so there is no operation to retry and the sentence carries no action rather than
  // a fresh-opId re-send that could notify guests twice (review15).
  if (!failureHandled(spec, failure, ui, ports))
    failureToast(spec.opId, { ...failure, opRetry: false }, retry);
}

/** Every entry an optimistic change covers: its own id and its `more` siblings'. */
function optimisticIds(change: OptimisticChange): string[] {
  return [change.id, ...(change.more ?? []).map(m => m.id)];
}

/** Every tmp entry an optimistic change adds: a held create's event is not committed until the send. */
function addedIdsOf(change: OptimisticChange): string[] {
  return [change, ...(change.more ?? [])].filter(c => c.add !== undefined).map(c => c.id);
}

/** The engine's own body for a second hold on a still-held target (holds.ts `hold`). */
const HOLD_PENDING_BODY: ErrorBody = {
  type: 'conflict',
  message:
    'Your earlier change to this event has not been sent yet. Undo it, or wait a moment and try again.',
  reasonCode: 'calendar.holdPending',
};

/**
 * The event a held write targets, keyed by the local event id — holds.ts keys its own by the same
 * event's remote identity, so a matching id here means the engine would refuse. Only a write that
 * would itself be held can hit `calendar.holdPending`: `notify` unset goes straight to the
 * provider, a create has no event yet, and a plan or a hide never notifies guests.
 */
function heldTargetOf(fx: CalendarEffect): string | null {
  switch (fx.kind) {
    case 'eventSet':
      return fx.notify === true && fx.change.type !== 'create' ? fx.change.id : null;
    case 'rsvp':
      return fx.id;
    default:
      return null;
  }
}

/**
 * The local `calendar.holdPending`: the same sentence the engine would give, nothing submitted and
 * nothing patched. Refusing before the overlay is the point — the second write's layer never lands
 * over the still-held first's, so its dismissal can never roll the pair back (review15).
 */
function refuseHeldWrite(
  spec: RefusalSpec,
  ui: EffectUi,
  ports: EffectPorts,
  retry: () => void,
): void {
  if (spec.failure === undefined) return;
  const failure = writeFailureOf(HOLD_PENDING_BODY, spec.failure, spec.blindRetryUnsafe === true);
  if (!failureHandled(spec, failure, ui, ports)) failureToast(spec.opId, failure, retry);
}

/**
 * Runs one write: overlay now, settle on the applied state, roll back and say so on a refusal. An
 * accepted write — held or not — joins the watches so its operation's frames are answered. A held
 * write skips the receipt settle entirely: its `appliedState` is already reached (the hold's own
 * commit never moves `seq`), so every entry — a create's tmp included — settles at `synced`.
 */
function runWrite(spec: WriteSpec, ui: EffectUi, ports: EffectPorts, retry: () => void): void {
  spec.call().then(
    out => {
      // A held write's receipt `appliedState` is already reached — the hold's own commit never
      // moves `seq` — so settling here would snap the change back for the whole undo window:
      // every held write (not just a create) waits for `synced`, whose commit is in by then.
      if (!out.held) ui.settle(spec.opId, spec.entryIds, out.at);
      // A held write's op is queued: its target refuses a second held write until the op ends.
      if (out.held && spec.target !== undefined) heldTargets.add(spec.target);
      // Watch only a write that HAS an operation: the real engine records none for a plain
      // accepted write (`undoable: false`), so `Operation/get` answers notFound and the watcher
      // (and its useOperation subscription) would leak, never landing a frame.
      if (out.held || out.undoable)
        ui.watch({
          opId: spec.opId,
          entryIds: spec.entryIds,
          at: out.at,
          held: out.held,
          addedIds: spec.addedIds,
          ...(spec.target === undefined ? {} : { target: spec.target }),
          ...(spec.failure === undefined ? {} : { failure: spec.failure }),
          // The operation may still fail after the receipt: the same follow-ups a submit-time
          // refusal runs travel with the watch (`failureHandled`).
          ...(spec.reopenEditorId === undefined ? {} : { reopenEditorId: spec.reopenEditorId }),
          ...(spec.draft === undefined ? {} : { draft: spec.draft }),
          ...(spec.goneEventId === undefined ? {} : { goneEventId: spec.goneEventId }),
          ...(spec.accountId === undefined ? {} : { accountId: spec.accountId }),
        });
    },
    error => writeFailed(spec, ui, ports, error, retry),
  );
}

/**
 * One step of an operation's provider-side life after its write was accepted — the container runs
 * it on every `OperationView` change and every window frame (a held create's tmp entries drop the
 * moment the real rows show, whatever the remote state). `synced` settles the overlay against the
 * window at the receipt's state; `failed` rolls it back and shows the reasonCode sentence, whose
 * Retry is the operation's own `Operation/retry` — never a second write (review12); `cancelled`
 * rolls back quietly, the Undo toast already told the owner. `queued`/`syncing` keep watching.
 */
export function operationUpdate(
  watch: WatchedWrite,
  view: OperationView | undefined,
  ui: EffectUi,
  ports: EffectPorts,
): 'watching' | 'done' {
  // The hold's target blocks a second held write exactly while the engine's record is `queued` or
  // `syncing` (holds.ts): free it on every other state — a `failed` hold blocks nothing, and a
  // retried op re-blocks the moment it queues again.
  if (watch.target !== undefined)
    if (view?.remote === 'queued' || view?.remote === 'syncing') heldTargets.add(watch.target);
    else heldTargets.delete(watch.target);
  if (view === undefined) {
    // The operation record was forgotten while the write still waited (evicted, or the engine
    // never journaled one): roll the overlay back — a held create's tmp entry or a held edit's
    // patch must not ghost the grid forever.
    ui.rollback(watch.opId, watch.entryIds);
    return 'done';
  }
  // A re-watch after `Operation/retry`: the stale terminal row is still what the store answers —
  // ignore it until the operation reports a newer state.
  if (watch.since !== undefined && view === watch.since) return 'watching';
  switch (view.remote) {
    case 'failed':
    case 'conflict': {
      ui.rollback(watch.opId, watch.entryIds);
      // One toast per operation: the Undo toast closes on every terminal state, not only on
      // `cancelled` — a held write that fails or conflicts would otherwise show both at once.
      dismissToast(watch.opId);
      if (watch.failure === undefined) return 'done';
      // `conflict` remote is unreachable on the hold path — the engine records a provider conflict
      // as `failed` + `calendar.conflict` — but if a store ever answers it, it stays terminal and
      // never offers a blind Retry (review7 7): blindRetryUnsafe holds it to the honest sentence.
      const failure = writeFailureOf(view.error, watch.failure, view.remote === 'conflict', true);
      // The same follow-ups a submit-time refusal runs: re-open the editor, keep the draft, close
      // the gone event's detail, offer Enable editing or Sign in again — then the notice only when
      // none of them already carries the sentence.
      if (failureHandled(watch, failure, ui, ports)) return 'done';
      opFailureToast(watch.opId, failure, () => retryOperation(watch, view, ui));
      return 'done';
    }
    case 'cancelled':
      ui.rollback(watch.opId, watch.entryIds);
      dismissToast(watch.opId);
      return 'done';
    case 'synced':
      // Every held write skipped the receipt settle; the send's commit is in by this frame, but
      // the throttled window rerun lands after the op frame — hold the layer until the next
      // window frame so the row never snaps back (review15). A create's tmp entry drops with it.
      if (watch.held) ui.settleAfterFrame(watch.opId, watch.entryIds);
      dismissToast(watch.opId);
      return 'done';
    case 'applied':
      // A local write never leaves the device: nothing more to watch — and its Undo still applies
      // (the inverse restores the before-image), so the toast stays.
      return 'done';
    default:
      return 'watching';
  }
}

/**
 * `Operation/retry {opId}` on a failed hold: the same operation goes at once, so it cannot duplicate
 * the write (a fresh `Event/set` could). The receipt resolving puts the watch back — marked with the
 * stale view it must out-wait, so the failure it just answered does not pop straight back.
 */
function retryOperation(watch: WatchedWrite, view: OperationView, ui: EffectUi): void {
  view.retry().receipt.then(
    () => ui.watch({ ...watch, since: view }),
    error =>
      pushToast({
        id: newOpId(),
        kind: 'info',
        message: toErrorBody(error).message,
        undoable: false,
      }),
  );
}

/**
 * A hold exists: the receipt keeps the write undoable behind an undo window — the clock is not
 * the test (an undo-send of 0 s still queues a hold whose `undoUntil` lands at now, review15). An
 * undoable receipt with no `undoUntil` is a journaled op, not a hold: it settles at its receipt.
 */
const isHeld = (receipt: Receipt): boolean =>
  receipt.undoable !== false && receipt.undoUntil !== undefined;

export function runCalendarEffect(fx: CalendarEffect, ports: EffectPorts, ui: EffectUi): void {
  const retry = () => runCalendarEffect(fx, ports, ui);
  switch (fx.kind) {
    case 'eventSet': {
      const opId = newOpId();
      const target = heldTargetOf(fx);
      const spec: WriteSpec = {
        opId,
        entryIds: optimisticIds(fx.optimistic),
        addedIds: addedIdsOf(fx.optimistic),
        failure: fx.failure,
        reopenEditorId: fx.reopenEditorId,
        draft: fx.draft,
        goneEventId: fx.change.type === 'create' ? undefined : fx.change.id,
        accountId: fx.accountId,
        blindRetryUnsafe: fx.change.type === 'create',
        // The write marks its target while its receipt says held; the mark outlives `target`'s
        // own null — a receipt could report a hold the check did not predict.
        ...(fx.change.type === 'create' ? {} : { target: fx.change.id }),
        call: () =>
          ports
            .eventSet({
              opId,
              change: fx.change,
              // The engine holds only `notify === true` (holdIfNotifying): sent exactly when the
              // change emails other guests, never `false` — unset keeps the provider's own default.
              ...(fx.notify === true ? { notify: true as const } : {}),
            })
            .then(out => {
              const held = isHeld(out.receipt);
              if (out.receipt.undoable === false) {
                if (fx.toast) demoteUndoToast(opId, fx.toast);
              } else if (
                // No hold left (nothing more to tell guests): the toast says it went, like the RSVP's.
                fx.toast?.held !== undefined &&
                !held
              )
                updateToast(opId, { message: fx.toast.message });
              return {
                at: out.receipt.appliedState,
                held,
                undoable: out.receipt.undoable !== false,
              };
            }),
      };
      // The engine refuses a second held write on a still-held target (`calendar.holdPending`, a
      // `queued` or `syncing` record): refuse it here first — the same sentence, nothing submitted,
      // and the earlier write's layer never merges with a doomed patch (review15).
      if (target !== null && heldTargets.has(target)) {
        refuseHeldWrite(spec, ui, ports, retry);
        return;
      }
      ui.optimistic(fx.optimistic, opId);
      if (fx.toast)
        pushToast({
          id: opId,
          kind: fx.toast.kind,
          message: fx.toast.held ?? fx.toast.message,
          ...undoVerb(ports, opId),
          undoable: true,
        });
      runWrite(spec, ui, ports, retry);
      return;
    }
    case 'rsvp': {
      const opId = newOpId();
      const spec: WriteSpec = {
        opId,
        entryIds: [fx.id],
        addedIds: [],
        failure: fx.failure,
        goneEventId: fx.id,
        accountId: fx.accountId,
        blindRetryUnsafe: true,
        target: fx.id,
        call: () =>
          ports
            .eventRsvp({ opId, id: fx.id, response: fx.response, scope: fx.scope })
            .then(receipt => {
              const held = isHeld(receipt);
              if (receipt.undoable === false)
                demoteUndoToast(opId, {
                  kind: 'done',
                  message: rsvpMessage(fx.answer, fx.organizer, 'sent'),
                  undoable: false,
                });
              // No hold (nothing left to tell guests): the toast says it went.
              else if (!held)
                updateToast(opId, { message: rsvpMessage(fx.answer, fx.organizer, 'sent') });
              return {
                at: receipt.appliedState,
                held,
                undoable: receipt.undoable !== false,
              };
            }),
      };
      // An answer emails the organizer, so the engine holds it like any notifying write — and a
      // second answer while the first is still held hits the same `calendar.holdPending` (review15).
      if (heldTargets.has(fx.id)) {
        refuseHeldWrite(spec, ui, ports, retry);
        return;
      }
      ui.optimistic(fx.optimistic, opId);
      pushToast({
        id: opId,
        kind: 'done',
        message: rsvpMessage(fx.answer, fx.organizer, 'held'),
        ...undoVerb(ports, opId),
        undoable: true,
      });
      runWrite(spec, ui, ports, retry);
      return;
    }
    case 'calendarSet': {
      const opId = newOpId();
      ui.shown(fx.id, fx.shown);
      if (fx.toast)
        pushToast({
          id: opId,
          kind: fx.toast.kind,
          message: fx.toast.message,
          ...undoVerb(ports, opId),
          undoable: true,
        });
      ports.calendarSet({ opId, id: fx.id, shown: fx.shown }).then(
        out => {
          if (out.receipt.undoable === false && fx.toast) demoteUndoToast(opId, fx.toast);
          ui.shownSettled(fx.id);
        },
        () => {
          // A refused toggle rolls the local `shown` back at once; the toast offers Retry.
          ui.shownFailed(fx.id);
          dismissToast(opId);
          pushToast({
            id: `${opId}:failed`,
            kind: 'info',
            message: 'Couldn’t change that calendar.',
            actions: [{ id: 'retry', label: 'Retry' }],
            undoable: false,
            onAction: actionId => {
              if (actionId === 'retry') retry();
            },
          });
        },
      );
      return;
    }
    case 'planConfirm': {
      const opId = newOpId();
      ui.optimistic(fx.optimistic, opId);
      runWrite(
        {
          opId,
          entryIds: optimisticIds(fx.optimistic),
          addedIds: addedIdsOf(fx.optimistic),
          call: () =>
            ports
              .planConfirm({
                opId,
                id: fx.planId,
                ...(fx.calendarId ? { calendarId: fx.calendarId } : {}),
              })
              .then(out => ({
                at: out.receipt.appliedState,
                held: isHeld(out.receipt),
                undoable: out.receipt.undoable !== false,
              })),
          failure: 'Couldn’t add it to the calendar.',
          goneEventId: fx.optimistic.id,
          accountId: fx.accountId,
          // Confirming a plan creates the event: a lost answer must not offer a blind Retry (review8 3).
          blindRetryUnsafe: true,
        },
        ui,
        ports,
        retry,
      );
      return;
    }
    case 'planDismiss': {
      const opId = newOpId();
      ui.optimistic(fx.optimistic, opId);
      runWrite(
        {
          opId,
          entryIds: optimisticIds(fx.optimistic),
          addedIds: [],
          call: () =>
            ports.planDismiss({ opId, ids: [fx.planId] }).then(receipt => ({
              at: receipt.appliedState,
              held: isHeld(receipt),
              undoable: receipt.undoable !== false,
            })),
        },
        ui,
        ports,
        retry,
      );
      return;
    }
    case 'eventHide': {
      const opId = newOpId();
      ui.optimistic(fx.optimistic, opId);
      pushToast({
        id: opId,
        kind: fx.toast.kind,
        message: fx.toast.message,
        ...undoVerb(ports, opId),
        undoable: true,
      });
      runWrite(
        {
          opId,
          entryIds: [fx.id],
          addedIds: [],
          call: () =>
            ports.eventHide({ opId, ids: [fx.id], hidden: true }).then(receipt => {
              if (receipt.undoable === false) demoteUndoToast(opId, fx.toast);
              return {
                at: receipt.appliedState,
                held: isHeld(receipt),
                undoable: receipt.undoable !== false,
              };
            }),
          failure: 'Couldn’t hide it.',
          goneEventId: fx.id,
          accountId: fx.accountId,
        },
        ui,
        ports,
        retry,
      );
      return;
    }
    case 'editingNotice':
      editingNotice(ports, fx.accountId);
      return;
    case 'enableEditing':
      void ports.enableEditing(fx.accountId).then(undefined, error => {
        pushToast({
          id: newOpId(),
          kind: 'info',
          message: toErrorBody(error).message,
          undoable: false,
        });
      });
      return;
    case 'openThread':
      ports.openThread(fx.threadId);
      return;
    case 'openUrl':
      ports.openUrl(fx.url);
      return;
    case 'copy':
      ports.copyText(fx.text);
      pushToast({ id: newOpId(), kind: fx.toast.kind, message: fx.toast.message, undoable: false });
      return;
    case 'notice':
      pushToast({ id: newOpId(), kind: 'info', message: fx.message, undoable: false });
      return;
    case 'focus':
      ui.focus(fx.target);
      return;
  }
}

/** The live app's ports: `api.*` plus the shell's openers. */
export function livePorts(): EffectPorts {
  return {
    eventSet: args => api.event.set(args),
    eventRsvp: args => api.event.rsvp(args),
    calendarSet: args => api.calendar.set(args),
    planConfirm: args => api.plan.confirm(args),
    planDismiss: args => api.plan.dismiss(args),
    eventHide: args => api.event.hide(args),
    // The same connect sheet as the read grant, asking for calendar editing too (`enable: 'calendarWrite'` is the only
    // way Aplos ever asks for it); the account's grantedScopes gains the scope when the sheet finishes.
    enableEditing: accountId =>
      api.account.grantPermissions({ accountId, enable: 'calendarWrite' }).then(() => undefined),
    // The same sheet the sidebar's Sign in again opens (CalendarAccounts' 'reconnect' action).
    reconnect: accountId => openSheet('reconnect', { accountId, mode: 'reconnect' }),
    operationUndo: opId => api.operation.undo({ opId }),
    openThread: threadId => openThread(threadId, { from: 'calendar' }),
    // Main opens it through its external() gate (http, https or mailto, no credentials; anything else is refused).
    openUrl: url => {
      void api.shell.open({ url }).catch(() => undefined);
    },
    copyText: text => {
      void navigator.clipboard?.writeText(text).catch(() => undefined);
    },
  };
}
