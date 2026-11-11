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
  getNow,
  type ActResult,
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
  /** Apply the write's optimistic change at once (DESIGN 5 rule 1). */
  optimistic(change: OptimisticChange): void;
  /** Keep the overlay until a window reaches the write's applied state. */
  settle(entryId: string, at: State | null): void;
  /** Drop the overlay entry (a refusal, an undo). */
  rollback(entryId: string): void;
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

/** The screen going away cancels every delayed retry still waiting: no write fires behind its back. */
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
    // An operation-level failure (`calendar.late`) offers Retry too: it is the operation's own.
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

interface WriteSpec {
  readonly opId: string;
  /** Every overlay id the write covers (a series time shift patches a whole family); they settle and roll back together. */
  readonly entryIds: readonly string[];
  /** Overlay ids the write added (a create's tmp entries): a held one has no real row until the send confirms. */
  readonly addedIds: readonly string[];
  /** The overlay stays until a window reaches this state; `held` says the receipt's hold is still open. */
  readonly call: () => Promise<WriteOutcome>;
  /** The refusal sentence; absent = a quiet dismissal (a plan's "Not now"). */
  readonly failure?: string;
  /** An editor save's event id: on `calendar.conflict` the editor re-opens on the newer copy. */
  readonly reopenEditorId?: string;
  /** An editor save's draft: a times refusal re-opens the editor on it, typed work intact. */
  readonly draft?: EditorDraft;
  /** The entry the write was about: `calendar.eventGone` closes the detail only when it shows this id. */
  readonly goneEventId?: string;
  /** The account the write went to: `permission.calendarWrite` offers Enable editing on it. */
  readonly accountId?: string;
  /** A blind retry could duplicate the write or re-notify guests (a create, an RSVP): unknown codes get none. */
  readonly blindRetryUnsafe?: boolean;
}

/** Runs one write's mapped failure: notice, Enable editing when the grant lacks the scope, then the code's own follow-up. */
function writeFailed(
  spec: WriteSpec,
  ui: EffectUi,
  ports: EffectPorts,
  error: unknown,
  retry: () => void,
): void {
  spec.entryIds.forEach(id => ui.rollback(id));
  dismissToast(spec.opId);
  if (!spec.failure) return;
  const failure = writeFailureOf(error, spec.failure, spec.blindRetryUnsafe === true);
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
  if (failure.enableEditing) editingNotice(ports, spec.accountId);
  else if (failure.reconnect) reconnectNotice(ports, spec.accountId);
  else if (!reopened && !restored) failureToast(spec.opId, failure, retry);
  if (failure.closeDetail && spec.goneEventId !== undefined) ui.closeDetail(spec.goneEventId);
}

/** Every entry an optimistic change covers: its own id and its `more` siblings'. */
function optimisticIds(change: OptimisticChange): string[] {
  return [change.id, ...(change.more ?? []).map(m => m.id)];
}

/** Every tmp entry an optimistic change adds: a held create's event is not committed until the send. */
function addedIdsOf(change: OptimisticChange): string[] {
  return [change, ...(change.more ?? [])].filter(c => c.add !== undefined).map(c => c.id);
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
      if (!out.held) spec.entryIds.forEach(id => ui.settle(id, out.at));
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
          ...(spec.failure === undefined ? {} : { failure: spec.failure }),
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
  eventIds: ReadonlySet<string>,
): 'watching' | 'done' {
  if (view === undefined) return 'done';
  // A re-watch after `Operation/retry`: the stale terminal row is still what the store answers —
  // ignore it until the operation reports a newer state.
  if (watch.since !== undefined && view === watch.since) return 'watching';
  if (watch.addedIds.length > 0 && view.targets.some(id => eventIds.has(id)))
    watch.addedIds.forEach(id => ui.rollback(id));
  switch (view.remote) {
    case 'failed': {
      watch.entryIds.forEach(id => ui.rollback(id));
      if (watch.failure === undefined) return 'done';
      const failure = writeFailureOf(view.error, watch.failure);
      if (failure.retry === 'none' && failure.opRetry !== true)
        pushToast({
          id: `${watch.opId}:failed`,
          kind: 'info',
          message: failure.message,
          undoable: false,
        });
      else failureToast(watch.opId, failure, () => retryOperation(watch, view, ui));
      return 'done';
    }
    case 'cancelled':
      watch.entryIds.forEach(id => ui.rollback(id));
      dismissToast(watch.opId);
      return 'done';
    case 'conflict':
      // Terminal too: roll back, and never offer a blind Retry on a conflict (review7 7).
      watch.entryIds.forEach(id => ui.rollback(id));
      pushToast({
        id: `${watch.opId}:failed`,
        kind: 'info',
        message: writeFailureOf(view.error, watch.failure ?? '', true).message,
        undoable: false,
      });
      return 'done';
    case 'synced':
      // Every held write skipped the receipt settle; the send's commit is in by this frame, so the
      // overlay settles now — a create's tmp entry drops with it, the real row committed already.
      if (watch.held) watch.entryIds.forEach(id => ui.settle(id, watch.at));
      return 'done';
    case 'applied':
      // A local write never leaves the device: nothing more to watch.
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

/** The receipt's hold is still open (`undoUntil` in the future): guests are not told yet. */
const isHeld = (receipt: Receipt): boolean =>
  receipt.undoable !== false && receipt.undoUntil !== undefined && receipt.undoUntil > getNow();

export function runCalendarEffect(fx: CalendarEffect, ports: EffectPorts, ui: EffectUi): void {
  const retry = () => runCalendarEffect(fx, ports, ui);
  switch (fx.kind) {
    case 'eventSet': {
      const opId = newOpId();
      ui.optimistic(fx.optimistic);
      if (fx.toast)
        pushToast({
          id: opId,
          kind: fx.toast.kind,
          message: fx.toast.held ?? fx.toast.message,
          ...undoVerb(ports, opId),
          undoable: true,
        });
      runWrite(
        {
          opId,
          entryIds: optimisticIds(fx.optimistic),
          addedIds: addedIdsOf(fx.optimistic),
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
          failure: fx.failure,
          reopenEditorId: fx.reopenEditorId,
          draft: fx.draft,
          goneEventId: fx.change.type === 'create' ? undefined : fx.change.id,
          accountId: fx.accountId,
          blindRetryUnsafe: fx.change.type === 'create',
        },
        ui,
        ports,
        retry,
      );
      return;
    }
    case 'rsvp': {
      const opId = newOpId();
      ui.optimistic(fx.optimistic);
      pushToast({
        id: opId,
        kind: 'done',
        message: rsvpMessage(fx.answer, fx.organizer, 'held'),
        ...undoVerb(ports, opId),
        undoable: true,
      });
      runWrite(
        {
          opId,
          entryIds: [fx.id],
          addedIds: [],
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
          failure: fx.failure,
          goneEventId: fx.id,
          accountId: fx.accountId,
          blindRetryUnsafe: true,
        },
        ui,
        ports,
        retry,
      );
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
      ui.optimistic(fx.optimistic);
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
      ui.optimistic(fx.optimistic);
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
      ui.optimistic(fx.optimistic);
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
