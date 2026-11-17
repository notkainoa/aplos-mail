/**
 * The Search page's row verbs and its opener (DESIGN §7.9, §7.13): every write is one `api.thread.act`, one toast
 * keyed by its opId carrying its own Undo (`UNDO_ACTION` — never the shared Z, which would undo a newer op), and a
 * rejected write dismisses its toast so the row's failure line can explain. `openResult` hands the reader the
 * visible result ids so its J and K walk them. Deps are injectable so the tests drive the verbs without an engine.
 */
import { api, type DataApi, type ThreadId } from '../../data';
import { dismissToast, openThread, pushToast, type PushedToast } from '../../shell';
import type { Screen } from '../../shell/store-route';
import type { ToastKind } from '../../ui/props';
import { UNDO_ACTION, triageSlot, undoHandler } from '../undoOperation';

/** One `Thread/act` action (done, later, trash, bookmark, read/unread, …). */
export type RowAction = Parameters<DataApi['thread']['act']>[0]['action'];

/** What the verbs need: the engine's `Thread/act` and the shell's toast lane. */
export interface ActDeps {
  readonly act: DataApi['thread']['act'];
  readonly push: (toast: PushedToast) => string;
  readonly dismiss: (id: string) => void;
}

/** The live deps: the real api and the real toast stack. */
export const ACT_DEPS: ActDeps = {
  act: args => api.thread.act(args),
  push: toast => pushToast(toast),
  dismiss: id => {
    dismissToast(id);
  },
};

/** One verb on one result row: commit, toast with Undo, drop the toast when the write is refused. */
export function actOnRow(
  deps: ActDeps,
  threadId: ThreadId,
  action: RowAction,
  toast: { readonly kind: ToastKind; readonly message: string },
): void {
  const { opId, receipt } = deps.act({ ids: [threadId], action });
  deps.push({
    id: opId,
    undoable: true,
    actions: [UNDO_ACTION],
    onAction: undoHandler(opId),
    ...triageSlot(toast.kind),
    ...toast,
  });
  receipt.catch(() => deps.dismiss(opId));
}

/** Opens a result in the reader; `listIds` are the visible results so J and K walk them (listActions' open). */
export function openResult(from: Screen, threadId: ThreadId, listIds: readonly string[]): void {
  openThread(threadId, { from, listIds: [...listIds] });
}
