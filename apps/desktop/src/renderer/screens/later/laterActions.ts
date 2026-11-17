/**
 * Re-dating a Later thread (DESIGN 7.3): the one write behind the date picker, a drop on a group and the L and D keys.
 * It commits on the keydown or drop, starts the hold, and raises one toast keyed by its opId with Undo. Pure over its
 * deps, like the list's actions.
 */
import type { DataApi } from '../../data';
import type { PushedToast } from '../../shell';
import { UNDO_ACTION, triageSlot, undoHandler } from '../undoOperation';

/** The screen's side of re-dating. */
export interface RescheduleDeps {
  /** `api.thread.act`. */
  act: DataApi['thread']['act'];
  push(toast: PushedToast): string;
  dismiss(id: string): void;
  /** Starts or extends the list's hold around these ids. */
  hold(ids: readonly string[]): void;
}

/** Moves one thread to `until` (absent: Someday) and says where, e.g. "Moved to Tomorrow, 8:00 AM". */
export function reschedule(
  deps: RescheduleDeps,
  id: string,
  until: number | undefined,
  label: string,
): void {
  deps.hold([id]);
  const { opId, receipt } = deps.act({ ids: [id], action: { type: 'later', until } });
  deps.push({
    id: opId,
    kind: 'later',
    ...triageSlot('later'),
    message: `Moved to ${label}`,
    undoable: true,
    actions: [UNDO_ACTION],
    onAction: undoHandler(opId),
  });
  receipt.catch(() => deps.dismiss(opId));
}
