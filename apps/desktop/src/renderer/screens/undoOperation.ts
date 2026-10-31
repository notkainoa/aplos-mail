/**
 * A toast's own Undo (DESIGN 5 rule 11, 7.13). The shared `app.undo` command (Z) undoes the newest operation, so an
 * Undo button on an older toast must not run it: it would restore the newer thread. These helpers undo exactly the
 * operation the toast belongs to, with `api.operation.undo({opId})`. The toast keeps `undoable: true` so the stack
 * still protects it from eviction.
 */
import { api } from '../data';

/**
 * The Undo verb on a toast. It has no `commandId` (that would run the shared command on the newest operation): the
 * toast's `onAction` runs it against its own operation, and `keysFrom` only draws the Z keycap.
 */
export const UNDO_ACTION = { id: 'undo', label: 'Undo', keysFrom: 'app.undo' } as const;

/** Undoes one operation; a rejected undo is the data layer's to report. */
export function undoOperation(opId: string): void {
  api.operation.undo({ opId }).receipt.catch(() => undefined);
}

/** The toast's `onAction` for its Undo verb alone; `after` runs once the undo is issued. */
export function undoHandler(opId: string, after?: () => void): (actionId: string) => void {
  return actionId => {
    if (actionId !== UNDO_ACTION.id) return;
    undoOperation(opId);
    after?.();
  };
}
