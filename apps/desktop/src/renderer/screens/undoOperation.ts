/**
 * A toast's own Undo (DESIGN 5 rule 11, 7.13). The shared `app.undo` command (Z) undoes the newest operation, so an
 * Undo button on an older toast must not run it: it would restore the newer thread. These helpers undo exactly the
 * operation the toast belongs to, with `api.operation.undo({opId})`. The toast keeps `undoable: true` so the stack
 * still protects it from eviction.
 */
import { api, type ActResult } from '../data';

/**
 * The Undo verb on a toast. It has no `commandId` (that would run the shared command on the newest operation): the
 * toast's `onAction` runs it against its own operation, and `keysFrom` only draws the Z keycap.
 */
export const UNDO_ACTION = { id: 'undo', label: 'Undo', keysFrom: 'app.undo' } as const;

/**
 * A Later toast says what the move left unset: the L key puts a thread back without a date, and the toast offers
 * "Set a date" beside it. It goes before the sender's name, which is the part a narrow toast may cut. A dated move says "Later until …" instead (see `reschedule`).
 */
export function undated(message: string): string {
  return `${message} · no date`;
}

const TRIAGE_KINDS: ReadonlySet<string> = new Set(['done', 'later', 'trash']);

/** `{ slot: 'triage' }` for a Done, Later or Trash toast, so a newer one takes its place; nothing for any other kind. */
export function triageSlot(kind: string): { readonly slot?: 'triage' } {
  return TRIAGE_KINDS.has(kind) ? { slot: 'triage' } : {};
}

/** Runs `after` once the undo's receipt is accepted; a rejected undo is the data layer's to report and runs nothing. */
export function afterAccepted(result: ActResult, after?: () => void): void {
  result.receipt.then(
    () => after?.(),
    () => undefined,
  );
}

/** Undoes one operation; `after` runs only when the engine accepted the undo. */
export function undoOperation(opId: string, after?: () => void): void {
  afterAccepted(api.operation.undo({ opId }), after);
}

/** The toast's `onAction` for its Undo verb alone; `after` runs once the undo is accepted. */
export function undoHandler(opId: string, after?: () => void): (actionId: string) => void {
  return actionId => {
    if (actionId === UNDO_ACTION.id) undoOperation(opId, after);
  };
}
