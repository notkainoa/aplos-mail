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
import { bodyOf, writeFailureOf, type WriteFailure } from './writeErrors';

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
 * The writes the owner held (`undoable` and an `undoUntil` on the receipt): for a refused undo, "That
 * change was already sent" is the honest sentence — the engine's `conflict` also covers "cannot be
 * undone", which means something different on writes that were never held. Module scope, like
 * `pendingRetries`: the screen lives as long as the session.
 */
const heldWrites = new Set<string>();

/**
 * Z while the calendar is up (the screen's `app.undo` handler): the shared undo stack's newest change,
 * same as the default handler — plus a refused undo says something. A conflict on a held write means
 * the window ended and the change already went; anything else repeats the engine's own plain sentence.
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
      message: held
        ? 'That change was already sent.'
        : body.message || 'Couldn’t undo that change.',
      undoable: false,
    });
  });
}

/**
 * The toast's own Undo (the store's undo runner) refuses the same way Z does: a conflict on a held
 * write says "That change was already sent." Refusals for anything the lane did not hold stay silent —
 * mail's toasts behave exactly as before.
 */
export function calendarUndoRefused(opId: string, error: unknown): void {
  const body = bodyOf(error);
  if (body.type !== 'conflict' || !heldWrites.has(opId)) return;
  pushToast({
    id: `${opId}:undo`,
    kind: 'info',
    message: 'That change was already sent.',
    undoable: false,
  });
}

/**
 * Retry of a failure the provider reported after the receipt: `Operation/retry` on the same op id
 * (`ports.operationRetry`), never the write again — a fresh `Event/set` beside the engine's hold would
 * queue a second change. A refused retry is its own plain sentence (the engine's words are already safe).
 */
function retryOperation(ports: EffectPorts, opId: string): void {
  void ports.operationRetry({ opId }).then(undefined, error => {
    const body = toErrorBody(error);
    pushToast({
      id: `${opId}:failed`,
      kind: 'info',
      message: body.message || 'Couldn’t send that change.',
      undoable: false,
    });
  });
}

interface WriteSpec {
  readonly opId: string;
  /** Every overlay id the write covers (a series time shift patches a whole family); they settle and roll back together. */
  readonly entryIds: readonly string[];
  /** The overlay stays until a window reaches this state. */
  readonly call: () => Promise<State | null>;
  /** The sent wording a held write's Undo toast demotes to once its window closes; absent = the toast simply closes. */
  readonly sentToast?: ToastWording;
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
  spec.entryIds.forEach(id => ui.rollback(id, spec.opId));
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
  else if (!reopened && !restored)
    // 'operation' names its own retry (`Operation/retry` on this op id) wherever the code surfaces;
    // the caller's `retry` re-runs the write — right for a rejected call, never for a failed hold.
    failureToast(
      spec.opId,
      failure,
      failure.retry === 'operation' ? () => retryOperation(ports, spec.opId) : retry,
    );
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
 */
function watchWrite(spec: WriteSpec, ui: EffectUi, ports: EffectPorts): void {
  const watch = ports.watchOperation;
  if (!watch) return;
  let lastRemote: OperationView['remote'] | undefined;
  // The watch may answer synchronously at subscribe: `dead` marks an `off` run before the
  // real unsubscribe landed, so it still runs and never joins `pendingRetries`.
  const sub: { stop?: () => void } = {};
  let dead = false;
  const off = (): void => {
    dead = true;
    pendingRetries.delete(off);
    sub.stop?.();
  };
  const apply = (view: OperationView | undefined): void => {
    if (dead) return;
    const remote = view?.remote ?? null;
    if (remote === lastRemote) return;
    lastRemote = remote;
    if (!view) return;
    if (remote === 'failed') {
      writeFailed(
        spec,
        ui,
        ports,
        {
          error: view.error ?? {
            type: 'unavailable',
            message: spec.failure ?? 'Couldn’t send that change.',
          },
        },
        () => retryOperation(ports, spec.opId),
      );
      return;
    }
    if (remote === 'cancelled') {
      spec.entryIds.forEach(id => ui.rollback(id, spec.opId));
      dismissToast(spec.opId);
      dismissToast(`${spec.opId}:failed`);
      off();
      return;
    }
    if (remote === 'conflict') {
      // Terminal like a failure but with no way forward: the same mapped refusal, then the watch ends.
      writeFailed(
        spec,
        ui,
        ports,
        {
          error: view.error ?? {
            type: 'conflict',
            message: spec.failure ?? 'Couldn’t send that change.',
          },
        },
        () => retryOperation(ports, spec.opId),
      );
      off();
      return;
    }
    if (remote === 'syncing' || remote === 'synced' || remote === 'applied') {
      // The undo window is over (a queued hold started sending, or the write went straight to the
      // provider): the held toast becomes the sent line, or goes quietly when the write has none.
      if (view.undoUntil !== null) {
        const toast = getToasts().find(t => t.id === spec.opId);
        if (toast && isUndoToast(toast)) {
          if (spec.sentToast) demoteUndoToast(spec.opId, spec.sentToast);
          else dismissToast(spec.opId);
        }
      }
      if (remote === 'synced' || remote === 'applied') {
        dismissToast(`${spec.opId}:failed`);
        off();
      }
    }
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
  spec.call().then(
    at => {
      spec.entryIds.forEach(id => ui.settle(id, at, spec.opId));
      watchWrite(spec, ui, ports);
    },
    error => writeFailed(spec, ui, ports, error, retry),
  );
}

export function runCalendarEffect(fx: CalendarEffect, ports: EffectPorts, ui: EffectUi): void {
  const retry = () => runCalendarEffect(fx, ports, ui);
  switch (fx.kind) {
    case 'eventSet': {
      const opId = newOpId();
      ui.optimistic(opId, fx.optimistic);
      if (fx.toast)
        pushToast({
          id: opId,
          kind: fx.toast.kind,
          message: fx.toast.held ?? fx.toast.message,
          actions: UNDO_ACTION,
          undoable: true,
        });
      runWrite(
        {
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
                if (out.receipt.undoable === false) {
                  if (fx.toast) demoteUndoToast(opId, fx.toast);
                } else if (
                  // No hold left (nothing more to tell guests): the toast says it went, like the RSVP's.
                  fx.toast?.held !== undefined &&
                  (out.receipt.undoUntil === undefined || out.receipt.undoUntil <= getNow())
                )
                  updateToast(opId, { message: fx.toast.message });
                if (out.receipt.undoable !== false && out.receipt.undoUntil !== undefined)
                  heldWrites.add(opId);
                return out.receipt.appliedState;
              }),
          sentToast: fx.toast ? { kind: fx.toast.kind, message: fx.toast.message } : undefined,
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
      ui.optimistic(opId, fx.optimistic);
      pushToast({
        id: opId,
        kind: 'done',
        message: rsvpMessage(fx.answer, fx.organizer, 'held'),
        actions: UNDO_ACTION,
        undoable: true,
      });
      runWrite(
        {
          opId,
          entryIds: [fx.id],
          call: () =>
            ports
              .eventRsvp({ opId, id: fx.id, response: fx.response, scope: fx.scope })
              .then(receipt => {
                if (receipt.undoable === false)
                  demoteUndoToast(opId, {
                    kind: 'done',
                    message: rsvpMessage(fx.answer, fx.organizer, 'sent'),
                  });
                // No hold (nothing left to tell guests): the toast says it went.
                else if (receipt.undoUntil === undefined || receipt.undoUntil <= getNow())
                  updateToast(opId, { message: rsvpMessage(fx.answer, fx.organizer, 'sent') });
                if (receipt.undoable !== false && receipt.undoUntil !== undefined)
                  heldWrites.add(opId);
                return receipt.appliedState;
              }),
          sentToast: { kind: 'done', message: rsvpMessage(fx.answer, fx.organizer, 'sent') },
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
              .then(out => out.receipt.appliedState),
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
          call: () =>
            ports.planDismiss({ opId, ids: [fx.planId] }).then(receipt => receipt.appliedState),
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
              if (receipt.undoable === false) demoteUndoToast(opId, fx.toast);
              else if (receipt.undoUntil !== undefined) heldWrites.add(opId);
              return receipt.appliedState;
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
