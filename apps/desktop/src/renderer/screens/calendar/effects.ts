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
  subscribeOperation,
  undoStack,
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
import { getToasts, isUndoToast, subscribeToasts } from '../../shell/store-toast';
import type { CommandId, EventScope } from '../../ui/props';
import {
  rsvpMessage,
  type CalendarEffect,
  type EditorDraft,
  type OptimisticChange,
  type ToastPlan,
} from './calendar.model';
import { CALENDAR_ACCESS_COPY, EDITING_COPY } from './accountCalendarState';
import { emitHoldsRefresh } from './FailedHolds';
import { discardHold, releasePendingHolds, retryHold } from './holdEffects';
import { bodyOf, undoFailureMessage, writeFailureOf, type WriteFailure } from './writeErrors';

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
  /**
   * `Operation/retry {opId}`: sends a hold the provider refused after the receipt, under the same op
   * id — never the write again (that would queue a second change beside it).
   */
  operationRetry(args: { readonly opId: string }): Promise<Receipt>;
  /**
   * `Queue/retry {id}`: the engine's own retry for a `cal:` queue item — it sends the failed hold at
   * once through the same op id and refuses an uncertain one (`calendar.checkFirst`).
   */
  queueRetry(args: { readonly id: string }): Promise<unknown>;
  /** `Queue/discard {id}`: drops a failed hold's queue item — the owner said the change stays unsent. */
  queueDiscard(args: { readonly id: string }): Promise<unknown>;
  /**
   * The write's provider-side progress (`operation` frames): the listener runs once with the current
   * view, then on each change; the return unsubscribes. Absent in tests that never see a frame.
   */
  watchOperation?(opId: string, listener: (view: OperationView | undefined) => void): () => void;
  /** `Account/grantPermissions {accountId, enable:'calendarWrite'}`: opens the same connect sheet; the account's `grantedScopes` gains the write scope when it finishes. */
  enableEditing(accountId: string): Promise<void>;
  /** Opens the same sign-in sheet the sidebar's Sign in again opens (`openSheet('reconnect', {mode:'reconnect'})`). */
  reconnect(accountId: string): void;
  openThread(threadId: string): void;
  openUrl(url: string): void;
  copyText(text: string): void;
}

/** The state setters an effect needs. */
export interface EffectUi {
  /** Apply the write's optimistic change at once (DESIGN 5 rule 1), under the write's `writeId`. */
  optimistic(writeId: string, change: OptimisticChange): void;
  /** Keep the write's overlay contribution until a window reaches its applied state. */
  settle(entryId: string, at: State | null, writeId: string): void;
  /**
   * A held write's layer at `synced`: keep it until the events window's NEXT frame — the synced op
   * frame can precede the throttled window rerun that carries the provider state, so dropping at
   * once would snap the entry back for ~250 ms (review16). The container bounds the wait (~2 s).
   */
  settleAfterFrame(entryId: string, writeId: string): void;
  /** Drop the write's overlay contribution (a refusal, an undo) — never another write's. */
  rollback(entryId: string, writeId: string): void;
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
}

const newOpId = (): string => crypto.randomUUID();

/** The toast action that makes the shell undo this write's own operation by its id. */
const UNDO_ACTION: PushedToast['actions'] = [
  { id: 'undo', label: 'Undo', commandId: 'app.undo' as CommandId },
];

/** The `kind`/`message` of a toast; enough to demote an Undo toast to the plain confirmation. */
type ToastWording = Pick<ToastPlan, 'kind' | 'message'>;

/**
 * A write-through receipt (`undoable:false`, the providers' 2026-11-10 shape 9: no hold, no undo window
 * yet): the Undo toast pushed on keydown becomes the plain confirmation in place — dismissed and
 * re-pushed, so it loses the Undo action and the 8 s life, like 'Link copied'. One notice per operation
 * still holds (the id is the opId). `message` is the sent wording, as for a hold that ended. The same
 * demotion lands when a held write leaves `queued` on its operation frame: the window is over.
 */
function demoteUndoToast(opId: string, toast: ToastWording): void {
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
 * Work that must not outlive the screen: delayed retries waiting out a server's `retryAfterMs` (each
 * entry cancels its pending write and its toast watcher, review7 9) and the `operation` watches a
 * confirmed write keeps. The container calls `cancelPendingRetries` on unmount.
 */
const pendingRetries = new Set<() => void>();

/** The screen going away cancels every delayed retry and operation watch still live. */
export function cancelPendingRetries(): void {
  for (const disarm of [...pendingRetries]) disarm();
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
    ...(failure.retry === 'none' ? {} : { actions: [{ id: 'retry', label: 'Retry' }] }),
    undoable: false,
    onAction: actionId => {
      if (actionId !== 'retry') return;
      retryOnce();
    },
  });
}

/**
 * A failure the provider reported AFTER the receipt (the `operation` frame): persistent — the shell
 * keeps a failure the owner must answer, so an async refusal's Retry is not missed. A persistent
 * toast has no close affordance and is never evicted, so every one offers Dismiss — and Retry
 * first when the mapped failure may still go through (review17). The Retry sends `Operation/retry`
 * on the same op id, by hand only: a timer would re-send a notifying write to guests with nobody's
 * click behind it (review16). Dismiss needs no callback of its own: the store closes the toast
 * once `onAction` returns.
 *
 * A grant failure keeps its own verb beside Retry (review18): `reconnect` runs the same sign-in
 * the sidebar's account row does, `enable` asks for the write scope — no account behind the write
 * means the line alone, never an action that opens nothing.
 */
function opFailureToast(
  opId: string,
  failure: WriteFailure,
  ports: EffectPorts,
  accountId?: string,
): void {
  pushToast({
    id: `${opId}:failed`,
    kind: 'info',
    message: failure.message,
    actions: [
      ...(failure.reconnect === true && accountId !== undefined
        ? [{ id: 'reconnect', label: CALENDAR_ACCESS_COPY.signIn }]
        : []),
      ...(failure.enableEditing === true && accountId !== undefined
        ? [{ id: 'enable', label: EDITING_COPY.action }]
        : []),
      ...(failure.retry === 'none' ? [] : [{ id: 'retry', label: 'Retry' }]),
      { id: 'dismiss', label: 'Dismiss' },
    ],
    undoable: false,
    persistent: true,
    onAction: (actionId: string) => {
      if (actionId === 'retry') retryOperation(ports, opId);
      else if (actionId === 'reconnect' && accountId !== undefined) ports.reconnect(accountId);
      else if (actionId === 'enable' && accountId !== undefined)
        void ports.enableEditing(accountId).then(undefined, error => {
          pushToast({
            id: newOpId(),
            kind: 'info',
            message: toErrorBody(error).message,
            undoable: false,
          });
        });
    },
  });
}

/**
 * The writes the owner held (`undoable` and an `undoUntil` on the receipt): for a refused undo, "That
 * change was already sent" is the honest sentence — the engine's `conflict` also covers "cannot be
 * undone", which means something different on writes that were never held. Module scope, like
 * `pendingRetries`: the screen lives as long as the session.
 */
const heldWrites = new Set<string>();

/**
 * The screen's write generation: `releaseHeldWrites` bumps it on unmount, so a receipt (or a
 * rejection) that lands for an older screen's write registers nothing — no settle, no mark, no
 * operation watch nothing would ever cancel (review17).
 */
let writesEpoch = 0;

/**
 * The event ids a hold still guards, each marked by its write's op id: a hold-candidate write
 * (`notify: true`, or an RSVP which notifies by default) marks its target at SUBMIT — a second
 * press inside one round trip fails fast rather than submitting two full writes that interleave
 * in the engine's hold queue and tell guests twice (review17). A refused second write answers
 * `calendar.holdPending` before the optimistic change, so nothing is ever merged over the
 * still-held first write's layer (review16). The mark frees on the write's rejection, on a
 * receipt that came back unheld, and on the hold's terminal op state — and only the owning op
 * may free it: a stale release must never unguard a newer write's live mark. Module scope, like
 * `pendingRetries`: the screen lives as long as the session; `releaseHeldWrites` clears it on
 * unmount.
 */
const heldTargets = new Map<string, string>();

/** Free `target`'s mark only while `opId` still owns it — a late release frees nothing of another's. */
function unmarkHeldTarget(target: string | undefined, opId: string): void {
  if (target !== undefined && heldTargets.get(target) === opId) heldTargets.delete(target);
}

/**
 * The event ids an open operation-failure toast was raised for: submitting a newer write on the
 * same event retires the stale toast and disarms its Retry — re-sending the OLD change on top of
 * the new one would skip the clash check (a stale delete could remove the newer-edited event)
 * (review17). Entries leave when the watch resolves the failure or when a newer write retires it;
 * `releaseHeldWrites` clears the map on unmount.
 */
const failedOps = new Map<string, Set<string>>();

/** Op ids whose failure toast a newer write retired: their Retry must answer nothing. */
const staleRetries = new Set<string>();

/**
 * Whether a newer write on the event already retired this op's failure (review21): its hold row
 * shows Discard alone — a retry would re-send the older change over the newer one.
 */
export function isStaleRetry(opId: string): boolean {
  return staleRetries.has(opId);
}

function rememberFailedOp(spec: WriteSpec): void {
  if (spec.goneEventId === undefined) return;
  const ids = failedOps.get(spec.goneEventId) ?? new Set<string>();
  ids.add(spec.opId);
  failedOps.set(spec.goneEventId, ids);
}

function forgetFailedOp(spec: WriteSpec): void {
  if (spec.goneEventId === undefined) return;
  const ids = failedOps.get(spec.goneEventId);
  if (ids?.delete(spec.opId) && ids.size === 0) failedOps.delete(spec.goneEventId);
}

/** The owner sent the event again: its older failures' toasts close and their Retries go inert. */
function retireFailedOps(eventId: string | undefined): void {
  if (eventId === undefined) return;
  const ids = failedOps.get(eventId);
  if (!ids) return;
  failedOps.delete(eventId);
  for (const opId of ids) {
    staleRetries.add(opId);
    dismissToast(`${opId}:failed`);
  }
}

/** The screen unmounting releases every guard — the next mount starts clean. */
export function releaseHeldWrites(): void {
  writesEpoch += 1;
  heldTargets.clear();
  failedOps.clear();
  staleRetries.clear();
  heldWrites.clear();
  releasePendingHolds();
}

/** The event a write's hold would guard — only a write that asks for one can clash. */
function heldTargetOf(fx: CalendarEffect): string | undefined {
  switch (fx.kind) {
    case 'eventSet':
      // A create names its calendar, not an event: nothing to clash with. `notify` unset means the
      // write never asks for a hold, so it cannot hit another hold either.
      return fx.notify === true && fx.change.type !== 'create' ? fx.change.id : undefined;
    case 'rsvp':
      // `Event/rsvp` notifies by default (the engine's `notify ?? true`): it is always held.
      return fx.id;
    default:
      return undefined;
  }
}

/**
 * Z while the calendar is up (the screen's `app.undo` handler): the shared undo stack's newest change,
 * same as the default handler — plus a refused undo says something. A conflict on a held write names
 * which of the engine's two refusals landed ("already undone" vs "already sent", holds.ts); anything
 * else repeats the engine's own plain sentence.
 */
export function undoLastCalendarChange(): void {
  const outcome = undoStack.undoLast();
  if (outcome?.kind !== 'operation') return;
  void outcome.result.receipt.then(undefined, error => {
    const body = bodyOf(error);
    const held = body.type === 'conflict' && heldWrites.has(outcome.opId);
    pushToast({
      id: `${outcome.opId}:undo`,
      kind: 'info',
      message: held ? undoFailureMessage(body) : body.message || 'Couldn’t undo that change.',
      undoable: false,
    });
  });
}

/**
 * The toast's own Undo (the store's undo runner) refuses the same way Z does: a conflict on a held
 * write names the engine's sentence ("already undone" vs "already sent", holds.ts). Refusals for
 * anything the lane did not hold stay silent — mail's toasts behave exactly as before.
 */
export function calendarUndoRefused(opId: string, error: unknown): void {
  const body = bodyOf(error);
  if (body.type !== 'conflict' || !heldWrites.has(opId)) return;
  pushToast({
    id: `${opId}:undo`,
    kind: 'info',
    message: undoFailureMessage(body),
    undoable: false,
  });
}

/**
 * Retry of a failure the provider reported after the receipt: `Operation/retry` on the same op id
 * (`ports.operationRetry`), never the write again — a fresh `Event/set` beside the engine's hold would
 * queue a second change. A refused retry is its own plain sentence (the engine's words are already safe).
 */
function retryOperation(ports: EffectPorts, opId: string): void {
  // A stale Retry — the owner already sent the event again — answers nothing (review17).
  if (staleRetries.has(opId)) return;
  void ports.operationRetry({ opId }).then(
    () => emitHoldsRefresh(),
    error => {
      emitHoldsRefresh();
      const body = bodyOf(error);
      // A refused retry keeps the surface it came from — persistent, showing the refusal's own
      // sentence in place of the first failure's. An actionless toast would fade 4 s later and
      // leave the failed send invisible (review17). Terminal refusals — the op was undone, already
      // sent, dropped from the queue, or must be checked by hand (conflict incl.
      // calendar.checkFirst, notFound) — get Dismiss only: a Retry that can never succeed is worse
      // than none. Transient refusals (unavailable, unknown) keep it (review18).
      const terminal = body.type === 'conflict' || body.type === 'notFound';
      opFailureToast(
        opId,
        {
          message: body.message || 'Couldn’t send that change.',
          retry: terminal ? 'none' : 'operation',
        },
        ports,
      );
    },
  );
}

// The Review rows' Retry and Discard live in `holdEffects.ts` (review20; the file's size cap):
// `Queue/retry` and `Queue/discard` on the `cal:` item id, quiet refusals in the `<opId>:failed`
// toast. A stale Retry — the owner already sent the event again — answers nothing (review17), so
// the entry point guards on `staleRetries` before delegating.

/** The row's Retry, skipped when a newer write already retired this op's failure (review17). */
function retryHeldItem(ports: EffectPorts, id: string, opId: string): void {
  if (!staleRetries.has(opId)) retryHold(ports, id, opId);
}

/**
 * What the receipt decided about the write: where its overlay settles, whether the engine held it
 * (a queued hold — `undoable` behind an `undoUntil`), and whether an `Operation` row exists to watch
 * (a journaled op at all — a write-through receipt has none and `Operation/get` says notFound).
 */
interface WriteOutcome {
  /** The overlay stays until a window reaches this state (`Receipt.appliedState`). */
  readonly at: State | null;
  /** A queued hold: never settles at its receipt — the hold's own commit does not advance seq. */
  readonly held: boolean;
  /** The engine journaled an operation for the write: `operation` frames can reach it. */
  readonly undoable: boolean;
}

/**
 * The receipt's own word on a queued hold — never a clock compare against `undoUntil`: a zero-second
 * undo window still queues the hold, and `undoUntil <= now` would read it unheld (review16).
 */
const isHeld = (receipt: Receipt): boolean =>
  receipt.undoable !== false && receipt.undoUntil !== undefined;

/** The receipt's outcome for `runWrite`: where to settle, whether held, whether an op exists. */
const outcomeOf = (receipt: Receipt): WriteOutcome => ({
  at: receipt.appliedState,
  held: isHeld(receipt),
  undoable: receipt.undoable !== false,
});

interface WriteSpec {
  readonly opId: string;
  /** Every overlay id the write covers (a series time shift patches a whole family); they settle and roll back together. */
  readonly entryIds: readonly string[];
  /** The write's call: resolves to the receipt's outcome. */
  readonly call: () => Promise<WriteOutcome>;
  /** The sent wording a held write's Undo toast demotes to once its window closes; absent = the toast simply closes. */
  readonly sentToast?: ToastWording;
  /** The refusal sentence; absent = a quiet dismissal (a plan's "Not now"). */
  readonly failure?: string;
  /** An editor save's event id: on `calendar.conflict` the editor re-opens on the newer copy. */
  readonly reopenEditorId?: string;
  /** An editor save's draft: a times refusal re-opens the editor on it, typed work intact. */
  readonly draft?: EditorDraft;
  /** The event the hold guards while queued/syncing (`heldTargetOf`); a second write on it fails fast. */
  readonly target?: string;
  /** The entry the write was about: `calendar.eventGone` closes the detail only when it shows this id. */
  readonly goneEventId?: string;
  /** The account the write went to: `permission.calendarWrite` offers Enable editing on it. */
  readonly accountId?: string;
  /** A blind retry could duplicate the write or re-notify guests (a create, an RSVP): unknown codes get none. */
  readonly blindRetryUnsafe?: boolean;
}

/**
 * Runs one write's mapped failure: notice, Enable editing when the grant lacks the scope, then the
 * code's own follow-up. `atOperation` marks a failure the provider reported after the receipt — its
 * sentence says what is still owed and its toast is the persistent `Operation/retry` one.
 */
function writeFailed(
  spec: WriteSpec,
  ui: EffectUi,
  ports: EffectPorts,
  error: unknown,
  retry: () => void,
  atOperation = false,
): void {
  spec.entryIds.forEach(id => ui.rollback(id, spec.opId));
  dismissToast(spec.opId);
  if (!spec.failure) return;
  const failure = writeFailureOf(error, spec.failure, spec.blindRetryUnsafe === true, atOperation);
  // The conflict's sentence lands once: the re-opened editor's own line, or the toast when no
  // editor can re-open — never both (review7 5). A times refusal is the same, on the saved draft.
  const reopened =
    failure.reopenEditor === true &&
    spec.reopenEditorId !== undefined &&
    ui.reopenEditor(spec.reopenEditorId, failure.message);
  const restored =
    failure.keepDraft === true &&
    spec.draft !== undefined &&
    ui.restoreEditor(spec.draft, failure.message);
  if (atOperation) {
    // After the receipt every refusal is a failure the owner must answer — including a dead
    // grant or a missing write scope: the persistent op toast says the change is still owed and
    // keeps the grant verb beside the Operation/retry (review18). A refusal the editor already
    // carries (re-opened or restored draft) needs no toast of its own.
    if (!reopened && !restored) {
      opFailureToast(spec.opId, failure, ports, spec.accountId);
      // Register the open failure by its event: a newer write on it retires this toast and its
      // Retry, so a stale Operation/retry can never replay the old change (review17).
      rememberFailedOp(spec);
    }
  } else if (failure.enableEditing) editingNotice(ports, spec.accountId);
  else if (failure.reconnect) reconnectNotice(ports, spec.accountId);
  else if (!reopened && !restored) failureToast(spec.opId, failure, retry);
  if (failure.closeDetail && spec.goneEventId !== undefined) ui.closeDetail(spec.goneEventId);
}

/** Every entry an optimistic change covers: its own id and its `more` siblings'. */
function optimisticIds(change: OptimisticChange): string[] {
  return [change.id, ...(change.more ?? []).map(m => m.id)];
}

/**
 * The write's provider-side life after the receipt (the `operation` frame, `watchOperation`): a `failed`
 * hold is a refusal like any other — the overlay rolls back and the mapped sentence lands once, its
 * Retry `Operation/retry` on the same op id; an owner's `cancelled` (Undo inside the window) rolls back
 * and closes both toasts quietly; a terminal `conflict` is the same refusal with no way forward, so
 * the watch ends there. Leaving `queued` ends the undo window, so the held toast demotes to the sent
 * wording. One remote state answers once (frames may repeat), and a terminal state ends the watch —
 * except `failed`, which stays so a retried-then-synced hold can take its failure toast down.
 * `held` is the receipt's verdict: a held write settles its layer on the frame after `synced`.
 */
function watchWrite(spec: WriteSpec, ui: EffectUi, ports: EffectPorts, held: boolean): void {
  const watch = ports.watchOperation;
  if (!watch) return;
  let lastRemote: OperationView['remote'] | undefined;
  // The watch may answer synchronously at subscribe: `dead` marks an `off` run before the
  // real unsubscribe landed, so it still runs and never joins `pendingRetries`.
  const sub: { stop?: () => void } = {};
  let dead = false;
  // This write still owns its target's mark: frames may free it before the watch ends (a failure,
  // a send), and only the owner may release it — a stale `off` must never unguard a newer write's
  // live mark (review17).
  let ownsTarget = held && spec.target !== undefined && heldTargets.get(spec.target) === spec.opId;
  // The hold guards its target only while queued or sending; every later remote state frees it.
  const updateTarget = (remote: OperationView['remote']): void => {
    if (!held || spec.target === undefined) return;
    if (remote === 'queued' || remote === 'syncing') {
      heldTargets.set(spec.target, spec.opId);
      ownsTarget = true;
    } else if (remote !== null) {
      unmarkHeldTarget(spec.target, spec.opId);
      ownsTarget = false;
    }
  };
  const off = (): void => {
    dead = true;
    pendingRetries.delete(off);
    // The hold's life is over however the watch ends: the event is writable again — but only this
    // write's own mark is freed.
    if (ownsTarget) {
      unmarkHeldTarget(spec.target, spec.opId);
      ownsTarget = false;
    }
    sub.stop?.();
  };
  // The same mapped refusal the submit path runs, at operation level: `failed` keeps the watch so a
  // retried-then-synced hold takes its failure toast down; terminal `conflict` ends it.
  const opRefused = (remote: 'failed' | 'conflict', view: OperationView): void => {
    writeFailed(
      spec,
      ui,
      ports,
      {
        error: view.error ?? {
          type: remote === 'conflict' ? 'conflict' : 'unavailable',
          message: spec.failure ?? 'Couldn’t send that change.',
        },
      },
      () => retryOperation(ports, spec.opId),
      true,
    );
    if (remote === 'conflict') off();
  };
  // The undo window is over (a queued hold started sending, or the write went straight to the
  // provider): the held toast becomes the sent line, or goes quietly when the write has none.
  const opSent = (sent: boolean, view: OperationView): void => {
    if (view.undoUntil !== null) {
      const toast = getToasts().find(t => t.id === spec.opId);
      if (toast && isUndoToast(toast)) {
        if (spec.sentToast) demoteUndoToast(spec.opId, spec.sentToast);
        else dismissToast(spec.opId);
      }
    }
    if (sent) {
      // A held write's layer outlives `synced` until the next window frame: the synced op frame can
      // land ahead of the throttled rerun that carries the provider state — dropping at once would
      // snap the entry back for ~250 ms (and a held create would vanish briefly, review16). An
      // unheld write's overlay already dropped at its receipt.
      if (held) spec.entryIds.forEach(id => ui.settleAfterFrame(id, spec.opId));
      dismissToast(`${spec.opId}:failed`);
      forgetFailedOp(spec);
      off();
    }
  };
  // `seen` marks the op as once present in the store: an `undefined` view after it means the
  // record was forgotten (Operations.add evicts at 200); before it, the row simply has not landed
  // — an op that never arrived is not forgotten and must not roll back (review17).
  let seen = false;
  const apply = (view: OperationView | undefined): void => {
    if (dead) return;
    // The store forgot the operation record: nothing is coming for this write — its patch (or a
    // create's temp row) rolls back here rather than ride the grid forever, its held Undo toast
    // closes, and `off` frees the guarded event and the subscription. This runs BEFORE the remote
    // dedup: a forgotten record reads `remote: null`, and `null === lastRemote` would drop it.
    if (!view) {
      if (!seen) return;
      spec.entryIds.forEach(id => ui.rollback(id, spec.opId));
      dismissToast(spec.opId);
      off();
      return;
    }
    seen = true;
    const remote = view.remote ?? null;
    if (remote === lastRemote) return;
    lastRemote = remote;
    updateTarget(remote);
    if (remote === 'failed') opRefused('failed', view);
    else if (remote === 'conflict') opRefused('conflict', view);
    else if (remote === 'cancelled') {
      // The owner's Undo inside the window: roll back and close both toasts quietly.
      spec.entryIds.forEach(id => ui.rollback(id, spec.opId));
      dismissToast(spec.opId);
      dismissToast(`${spec.opId}:failed`);
      forgetFailedOp(spec);
      off();
    } else if (remote === 'syncing') opSent(false, view);
    else if (remote === 'synced' || remote === 'applied') opSent(true, view);
  };
  sub.stop = watch(spec.opId, apply);
  if (dead) {
    sub.stop();
    return;
  }
  pendingRetries.add(off);
}

/** Runs one write: overlay now, settle on the applied state, roll back and say so on a refusal. */
function runWrite(spec: WriteSpec, ui: EffectUi, ports: EffectPorts, retry: () => void): void {
  // A newer write on the event retires any still-open failure of an older one — but only once
  // THIS write's receipt is accepted (below): retiring at submit would leave the owner with
  // neither the old failure toast nor a successful new write when this one is rejected (review18).
  // A write that can be held guards its target from SUBMIT, not from the receipt: a second press
  // inside one round trip fails fast — two full writes interleaved in the engine's hold queue
  // would tell guests twice (review17). Only where a watch exists to end the guard, else nothing
  // would ever free the mark (review16).
  const marked =
    spec.target !== undefined && ports.watchOperation !== undefined ? spec.target : undefined;
  if (marked !== undefined) heldTargets.set(marked, spec.opId);
  const epoch = writesEpoch;
  spec.call().then(
    out => {
      // The screen unmounted inside the round trip: the late receipt registers nothing — no
      // settle, no mark, no watch nothing could cancel (review17).
      if (epoch !== writesEpoch) return;
      // The write was accepted: now it retires the event's older open failures — the old toast
      // closes and its Retry disarms (review18).
      retireFailedOps(spec.goneEventId);
      // A held write never settles at its receipt: the hold's own commit does not advance seq, so
      // `appliedState` is already reached and the frame test would drop the patch at once — the
      // change would snap back for the whole undo window. It settles at `synced` (then on the
      // frame after) inside `watchWrite`.
      if (!out.held) spec.entryIds.forEach(id => ui.settle(id, out.at, spec.opId));
      // The receipt decides the mark's life: a held write's stays until its watch ends the hold;
      // anything else frees it here — no hold ever existed.
      if (!out.held) unmarkHeldTarget(marked, spec.opId);
      // Only a journaled op can ever surface an `operation` frame — the real engine has no
      // Operation row for a write-through receipt (`Operation/get` answers notFound), so watching
      // one would leak the subscription (review16).
      if (out.held || out.undoable) watchWrite(spec, ui, ports, out.held);
    },
    error => {
      // The screen is gone: its marks were already released — no rollback, no refusal toast.
      if (epoch !== writesEpoch) return;
      // A rejection accepted nothing: the submit-time mark dies with it, then the refusal runs.
      unmarkHeldTarget(marked, spec.opId);
      writeFailed(spec, ui, ports, error, retry);
    },
  );
}

export function runCalendarEffect(fx: CalendarEffect, ports: EffectPorts, ui: EffectUi): void {
  // The failed-holds Review rows' effects run beside the write switch (they answer Queue, not Event).
  if (fx.kind.startsWith('hold')) {
    runHoldEffect(fx, ports);
    return;
  }
  const retry = () => runCalendarEffect(fx, ports, ui);
  switch (fx.kind) {
    case 'eventSet': {
      const opId = newOpId();
      const spec: WriteSpec = {
        opId,
        entryIds: optimisticIds(fx.optimistic),
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
              const outcome = outcomeOf(out.receipt);
              if (out.receipt.undoable === false) {
                if (fx.toast) demoteUndoToast(opId, fx.toast);
              } else if (
                // No hold (nothing more to tell guests): the toast says it went, like the RSVP's.
                fx.toast?.held !== undefined &&
                !outcome.held
              )
                updateToast(opId, { message: fx.toast.message });
              if (outcome.held) heldWrites.add(opId);
              return outcome;
            }),
        sentToast: fx.toast ? { kind: fx.toast.kind, message: fx.toast.message } : undefined,
        failure: fx.failure,
        reopenEditorId: fx.reopenEditorId,
        draft: fx.draft,
        target: heldTargetOf(fx),
        goneEventId: fx.change.type === 'create' ? undefined : fx.change.id,
        accountId: fx.accountId,
        blindRetryUnsafe: fx.change.type === 'create',
      };
      // Its own earlier write is still held: refuse at once — the engine would answer
      // `calendar.holdPending` anyway, and the optimistic change must never merge over the
      // still-held first write's layer (review16).
      if (spec.target !== undefined && heldTargets.has(spec.target)) {
        writeFailed(
          spec,
          ui,
          ports,
          {
            error: {
              type: 'conflict',
              message: 'held',
              reasonCode: 'calendar.holdPending',
            },
          },
          retry,
        );
        return;
      }
      ui.optimistic(opId, fx.optimistic);
      if (fx.toast)
        pushToast({
          id: opId,
          kind: fx.toast.kind,
          message: fx.toast.held ?? fx.toast.message,
          actions: UNDO_ACTION,
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
        call: () =>
          ports
            .eventRsvp({ opId, id: fx.id, response: fx.response, scope: fx.scope })
            .then(receipt => {
              const outcome = outcomeOf(receipt);
              if (receipt.undoable === false)
                demoteUndoToast(opId, {
                  kind: 'done',
                  message: rsvpMessage(fx.answer, fx.organizer, 'sent'),
                });
              // No hold (nothing left to tell guests): the toast says it went.
              else if (!outcome.held)
                updateToast(opId, { message: rsvpMessage(fx.answer, fx.organizer, 'sent') });
              if (outcome.held) heldWrites.add(opId);
              return outcome;
            }),
        sentToast: { kind: 'done', message: rsvpMessage(fx.answer, fx.organizer, 'sent') },
        failure: fx.failure,
        target: heldTargetOf(fx),
        goneEventId: fx.id,
        accountId: fx.accountId,
        blindRetryUnsafe: true,
      };
      if (spec.target !== undefined && heldTargets.has(spec.target)) {
        writeFailed(
          spec,
          ui,
          ports,
          {
            error: {
              type: 'conflict',
              message: 'held',
              reasonCode: 'calendar.holdPending',
            },
          },
          retry,
        );
        return;
      }
      ui.optimistic(opId, fx.optimistic);
      pushToast({
        id: opId,
        kind: 'done',
        message: rsvpMessage(fx.answer, fx.organizer, 'held'),
        actions: UNDO_ACTION,
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
          actions: UNDO_ACTION,
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
      ui.optimistic(opId, fx.optimistic);
      runWrite(
        {
          opId,
          entryIds: optimisticIds(fx.optimistic),
          call: () =>
            ports
              .planConfirm({
                opId,
                id: fx.planId,
                ...(fx.calendarId ? { calendarId: fx.calendarId } : {}),
              })
              .then(out => outcomeOf(out.receipt)),
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
      ui.optimistic(opId, fx.optimistic);
      runWrite(
        {
          opId,
          entryIds: optimisticIds(fx.optimistic),
          call: () => ports.planDismiss({ opId, ids: [fx.planId] }).then(outcomeOf),
        },
        ui,
        ports,
        retry,
      );
      return;
    }
    case 'eventHide': {
      const opId = newOpId();
      ui.optimistic(opId, fx.optimistic);
      pushToast({
        id: opId,
        kind: fx.toast.kind,
        message: fx.toast.message,
        actions: UNDO_ACTION,
        undoable: true,
      });
      runWrite(
        {
          opId,
          entryIds: [fx.id],
          call: () =>
            ports.eventHide({ opId, ids: [fx.id], hidden: true }).then(receipt => {
              const outcome = outcomeOf(receipt);
              if (receipt.undoable === false) demoteUndoToast(opId, fx.toast);
              else if (outcome.held) heldWrites.add(opId);
              return outcome;
            }),
          sentToast: { kind: fx.toast.kind, message: fx.toast.message },
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

/** A Review row's effects: the queue item's own Retry/Discard and a dead grant's fix (review21). */
function runHoldEffect(fx: CalendarEffect, ports: EffectPorts): void {
  if (fx.kind === 'holdRetry') return retryHeldItem(ports, fx.id, fx.opId);
  if (fx.kind === 'holdDiscard') return discardHold(ports, fx.id);
  if (fx.kind === 'holdReconnect') {
    // The same sign-in sheet the sidebar's account row opens.
    ports.reconnect(fx.accountId);
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
    operationRetry: args => api.operation.retry(args),
    queueRetry: args => api.queue.retry(args),
    queueDiscard: args => api.queue.discard(args),
    watchOperation: (opId, listener) => subscribeOperation(opId, listener),
    // The same connect sheet as the read grant, asking for calendar editing too (`enable: 'calendarWrite'` is the only
    // way Aplos ever asks for it); the account's grantedScopes gains the scope when the sheet finishes.
    enableEditing: accountId =>
      api.account.grantPermissions({ accountId, enable: 'calendarWrite' }).then(() => undefined),
    // The same sheet the sidebar's Sign in again opens (CalendarAccounts' 'reconnect' action).
    reconnect: accountId => openSheet('reconnect', { accountId, mode: 'reconnect' }),
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
