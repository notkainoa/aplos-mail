/**
 * The Review rows' effect bodies (review20): Retry is `Queue/retry {id}` — the engine's own path
 * for `cal:` hold items, which refuses an uncertain one (`calendar.checkFirst`) — and Discard is
 * `Queue/discard {id}`. A refusal stays quiet in a persistent toast; a settled action closes the
 * op's `<opId>:failed` toast and tells `useFailedHolds` to re-list. Sibling to `effects.ts`, whose
 * size cap this keeps.
 */
import { dismissToast, pushToast } from '../../shell';
import type { EffectPorts } from './effects';
import { emitHoldsRefresh, opIdOf } from './FailedHolds';
import { bodyOf } from './writeErrors';

/**
 * A Review row's Retry on a `cal:` item: `Queue/retry {id}` — never `Event/set` again (a fresh
 * write beside the engine's hold would re-notify guests). A refusal stays quiet:
 * `calendar.checkFirst` (an uncertain hold — the answer was lost, so a blind second send could
 * tell the guests twice) gets the check-first sentence and Discard alone; a conflict, notFound or
 * forbidden answer keeps Dismiss; a transient one keeps Retry, wired to the same item id.
 */
export function retryHold(ports: EffectPorts, id: string, opId: string): void {
  void ports.queueRetry({ id }).then(
    () => {
      dismissToast(`${opId}:failed`);
      emitHoldsRefresh();
    },
    error => {
      emitHoldsRefresh();
      const body = bodyOf(error);
      const checkFirst = body.reasonCode === 'calendar.checkFirst';
      const terminal =
        checkFirst ||
        body.type === 'conflict' ||
        body.type === 'notFound' ||
        body.type === 'forbidden';
      pushToast({
        id: `${opId}:failed`,
        kind: 'info',
        message: checkFirst
          ? "Check your calendar first: we couldn't confirm that change went through."
          : body.message || 'Couldn’t send that change.',
        // `checkFirst` offers Discard alone: the change may already be at Google, so the only
        // safe action left is dropping the hold — there is no honest Retry.
        actions: checkFirst
          ? [{ id: 'discard', label: 'Discard' }]
          : [
              ...(terminal ? [] : [{ id: 'retry', label: 'Retry' }]),
              { id: 'dismiss', label: 'Dismiss' },
            ],
        undoable: false,
        persistent: true,
        onAction: actionId => {
          if (actionId === 'retry') retryHold(ports, id, opId);
          else if (actionId === 'discard') discardHold(ports, id);
        },
      });
    },
  );
}

/** A Review row's Discard: `Queue/discard` on the item id; a refusal gets one quiet sentence. */
export function discardHold(ports: EffectPorts, id: string): void {
  void ports.queueDiscard({ id }).then(
    () => {
      dismissToast(`${opIdOf({ id })}:failed`);
      emitHoldsRefresh();
    },
    error => {
      emitHoldsRefresh();
      pushToast({
        id: crypto.randomUUID(),
        kind: 'info',
        message: bodyOf(error).message || 'Couldn’t discard that change.',
        undoable: false,
      });
    },
  );
}
