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
import { api, getNow, type Receipt, type State } from '../../data';
import { dismissToast, openThread, pushToast, updateToast, type PushedToast } from '../../shell';
import type { CommandId, EventScope } from '../../ui/props';
import { rsvpMessage, type CalendarEffect, type OptimisticChange } from './calendar.model';

/** The contract calls an effect may make, bound by the container (or a test). */
export interface EffectPorts {
  eventSet(args: {
    readonly opId: string;
    readonly change: EventChange;
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
}

const newOpId = (): string => crypto.randomUUID();

/** The toast action that makes the shell undo this write's own operation by its id. */
const UNDO_ACTION: PushedToast['actions'] = [
  { id: 'undo', label: 'Undo', commandId: 'app.undo' as CommandId },
];

function failureToast(opId: string, message: string, retry: () => void): void {
  pushToast({
    id: `${opId}:failed`,
    kind: 'info',
    message,
    actions: [{ id: 'retry', label: 'Retry' }],
    undoable: false,
    onAction: actionId => {
      if (actionId === 'retry') retry();
    },
  });
}

interface WriteSpec {
  readonly opId: string;
  readonly entryId: string;
  /** The overlay stays until a window reaches this state. */
  readonly call: () => Promise<State | null>;
  /** The refusal sentence; absent = a quiet dismissal (a plan's "Not now"). */
  readonly failure?: string;
}

/** Runs one write: overlay now, settle on the applied state, roll back and say so on a refusal. */
function runWrite(spec: WriteSpec, ui: EffectUi, retry: () => void): void {
  spec.call().then(
    at => ui.settle(spec.entryId, at),
    () => {
      ui.rollback(spec.entryId);
      dismissToast(spec.opId);
      if (spec.failure) failureToast(spec.opId, spec.failure, retry);
    },
  );
}

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
          actions: UNDO_ACTION,
          undoable: true,
        });
      runWrite(
        {
          opId,
          entryId: fx.optimistic.id,
          call: () =>
            ports.eventSet({ opId, change: fx.change }).then(out => {
              // No hold left (nothing more to tell guests): the toast says it went, like the RSVP's.
              if (
                fx.toast?.held !== undefined &&
                (out.receipt.undoUntil === undefined || out.receipt.undoUntil <= getNow())
              )
                updateToast(opId, { message: fx.toast.message });
              return out.receipt.appliedState;
            }),
          failure: fx.failure,
        },
        ui,
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
        actions: UNDO_ACTION,
        undoable: true,
      });
      runWrite(
        {
          opId,
          entryId: fx.id,
          call: () =>
            ports
              .eventRsvp({ opId, id: fx.id, response: fx.response, scope: fx.scope })
              .then(receipt => {
                // No hold (nothing left to tell guests): the toast says it went.
                if (receipt.undoUntil === undefined || receipt.undoUntil <= getNow())
                  updateToast(opId, { message: rsvpMessage(fx.answer, fx.organizer, 'sent') });
                return receipt.appliedState;
              }),
          failure: fx.failure,
        },
        ui,
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
        () => ui.shownSettled(fx.id),
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
          entryId: fx.optimistic.id,
          call: () =>
            ports
              .planConfirm({
                opId,
                id: fx.planId,
                ...(fx.calendarId ? { calendarId: fx.calendarId } : {}),
              })
              .then(out => out.receipt.appliedState),
          failure: 'Couldn’t add it to the calendar.',
        },
        ui,
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
          entryId: fx.optimistic.id,
          call: () =>
            ports.planDismiss({ opId, ids: [fx.planId] }).then(receipt => receipt.appliedState),
        },
        ui,
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
        actions: UNDO_ACTION,
        undoable: true,
      });
      runWrite(
        {
          opId,
          entryId: fx.id,
          call: () =>
            ports
              .eventHide({ opId, ids: [fx.id], hidden: true })
              .then(receipt => receipt.appliedState),
          failure: 'Couldn’t hide it.',
        },
        ui,
        retry,
      );
      return;
    }
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
