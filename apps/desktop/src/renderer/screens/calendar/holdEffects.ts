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
import type { ErrorBody } from '../../data';

/**
 * Queue item ids with a Retry or Discard still in flight (review21): the row's buttons hold busy
 * and a second press is ignored — the engine would refuse it ('Only a failed change can be
 * retried'), and reading that refusal as a fresh failure pushed a phantom toast while the first
 * send succeeded.
 */
const pendingHolds = new Set<string>();

/** Whether the item's own action is in flight: the row's buttons hold busy. */
export function holdPending(id: string): boolean {
  return pendingHolds.has(id);
}

/** The screen unmounting releases the guards, like `releaseHeldWrites` does for its own marks. */
export function releasePendingHolds(): void {
  pendingHolds.clear();
}

/**
 * A refusal that only means the send is already under way: the engine's `inflight` guard, its
 * verdict on a state the first press already moved past, or its discard-on-a-syncing-hold
 * refusal. All are `conflict`s with no reasonCode — the engine's own words name them, like
 * `undoFailureMessage` keys its conflicts.
 */
function alreadySending(body: ErrorBody): boolean {
  return (
    body.type === 'conflict' &&
    (body.message === 'Only a failed change can be retried.' ||
      body.message === 'That change is being sent.' ||
      body.message === 'That change is already on its way to Google.')
  );
}

/**
 * A Review row's Retry on a `cal:` item: `Queue/retry {id}` — never `Event/set` again (a fresh
 * write beside the engine's hold would re-notify guests). A refusal stays quiet:
 * `calendar.checkFirst` (an uncertain hold — the answer was lost, so a blind second send could
 * tell the guests twice) gets the check-first sentence and Discard alone; a conflict, notFound or
 * forbidden answer keeps Dismiss; a transient one keeps Retry, wired to the same item id.
 */
export function retryHold(ports: EffectPorts, id: string, opId: string): void {
  if (pendingHolds.has(id)) return; // a second press while the first is out (review21)
  pendingHolds.add(id);
  emitHoldsRefresh();
  void ports.queueRetry({ id }).then(
    () => {
      pendingHolds.delete(id);
      dismissToast(`${opId}:failed`);
      emitHoldsRefresh();
    },
    error => {
      pendingHolds.delete(id);
      emitHoldsRefresh();
      const body = bodyOf(error);
      // The first press is already sending it: quiet — the row simply leaves when it settles.
      if (alreadySending(body)) return;
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
  if (pendingHolds.has(id)) return; // a second press while the first is out (review21)
  pendingHolds.add(id);
  emitHoldsRefresh();
  void ports.queueDiscard({ id }).then(
    () => {
      pendingHolds.delete(id);
      dismissToast(`${opIdOf({ id })}:failed`);
      emitHoldsRefresh();
    },
    error => {
      pendingHolds.delete(id);
      emitHoldsRefresh();
      const body = bodyOf(error);
      // The item is already on its way: quiet — the row simply leaves when it settles.
      if (alreadySending(body)) return;
      pushToast({
        id: `${opIdOf({ id })}:failed`,
        kind: 'info',
        message: body.message || 'Couldn’t discard that change.',
        undoable: false,
      });
    },
  );
}
