/**
 * The Calendar's undoable writes, one record per `opId` (review1 3 and the undo PLAUSIBLE items). No React: the container
 * hands in the contract calls and the shell's toast and undo functions.
 *
 * - Each write's toast Undo undoes that write, by its `opId`; Z (the undo stack) keeps undoing the newest change.
 * - Undo pressed before the write has returned is not lost: the record waits for the write, then cancels or inverts it
 *   (`Operation/undo`). A write that failed meanwhile needs no undo, and its failure toast is not shown.
 * - One undo entry per write: the lane pushes its own only when the port's writes do not join the stack themselves.
 * - Undoing twice (the toast, then Z) runs once.
 */
import type { State } from '../../data';

export interface WriteDeps {
  /** `Operation/undo {opId}`: cancel while held, else the inverse; resolves once the engine has it. */
  readonly undoOperation: (opId: string) => Promise<unknown>;
  /** Drop the write's optimistic overlay entry. */
  readonly rollback: (entryId: string) => void;
  /** Keep the overlay until a window reaches the write's state. */
  readonly settle: (entryId: string, at: State | null) => void;
  readonly dismissToast: (opId: string) => void;
  /** A refused write with a sentence: drop its overlay and say so with Retry. */
  readonly failed: (opId: string, entryId: string, message: string, retry: () => void) => void;
  /** Push Z's entry; absent when the port's writes join the undo stack themselves (no second entry). */
  readonly pushUndo?: (label: string, undo: () => Promise<void>) => { forget(): void };
}

export interface WriteRequest {
  readonly opId: string;
  /** The overlay entry the write changed. */
  readonly entryId: string;
  /** Z's label ("Moved Q4 review"). */
  readonly label: string;
  /** The contract call; resolves with the state the write reached. */
  readonly call: () => Promise<State | null>;
  /** The sentence if it is refused; without one the overlay just drops (a dismissed plan comes back quietly). */
  readonly failure?: string;
  readonly retry: () => void;
}

interface Live {
  readonly entryId: string;
  /** True once the write was accepted, false if it was refused. */
  readonly accepted: Promise<boolean>;
  undone: boolean;
  forget?: () => void;
}

export interface Writes {
  start(request: WriteRequest): void;
  /** Undo this write (a toast's Undo, or Z's entry); a no-op for an unknown or already undone write. */
  undo(opId: string): Promise<void>;
}

export function createWrites(deps: WriteDeps): Writes {
  const live = new Map<string, Live>();

  async function undo(opId: string): Promise<void> {
    const record = live.get(opId);
    if (!record || record.undone) return;
    record.undone = true;
    record.forget?.();
    deps.dismissToast(opId);
    // Undo before the receipt: wait for the write, then cancel or invert it. A refused write has nothing to undo.
    if (await record.accepted) await deps.undoOperation(opId);
    deps.rollback(record.entryId);
    live.delete(opId);
  }

  function start(request: WriteRequest): void {
    const { opId, entryId } = request;
    let record: Live | undefined;
    const accepted = request.call().then(
      at => {
        if (!record?.undone) deps.settle(entryId, at);
        return true;
      },
      () => {
        record?.forget?.();
        if (!record?.undone) {
          live.delete(opId);
          if (request.failure) deps.failed(opId, entryId, request.failure, request.retry);
          else deps.rollback(entryId);
        }
        return false;
      },
    );
    record = { entryId, accepted, undone: false };
    const handle = deps.pushUndo?.(request.label, () => undo(opId));
    if (handle) record.forget = () => handle.forget();
    live.set(opId, record);
  }

  return { start, undo };
}
