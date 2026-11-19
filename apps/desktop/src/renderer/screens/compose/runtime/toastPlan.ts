/**
 * What the toast stack shows for the sends composers handed off (pure, so the tests read it without React). Every
 * phase is covered, not only the held one: the newest send with a tray is the UndoTray; older held sends stack as Undo
 * toasts; a send later says "Scheduled for …" once; offline says "Saved here · will sync" once; a failure says
 * "Couldn’t send to …" with Try again and Edit. A send leaves the list only once it is over (sent, cancelled), belongs
 * to Scheduled, or its failure notice took over; while it is still on its way ("sending") it stays followed, so a late
 * failure is never lost.
 */
import type { Submission } from '../../../data';
import type { UndoTrayState } from '../../../ui/props';
import { isLiveSubmission, rowPhase, sendView } from '../model/sendState';

export interface HeldBehind {
  readonly row: Submission;
  readonly recipients: string;
  readonly secondsLeft: number;
}

export interface ToastPlan {
  /** The newest send with a tray: the ToastStack's UndoTray. */
  readonly tray: { readonly row: Submission; readonly state: UndoTrayState } | null;
  /** Held sends behind it: one Undo toast each. */
  readonly held: readonly HeldBehind[];
  /** One-off notices (pushed once per send and kind). */
  readonly notices: readonly {
    readonly id: string;
    readonly kind: 'scheduled' | 'offline';
    readonly message: string;
  }[];
  /** Failed sends (one notice per failure). */
  readonly failed: readonly Submission[];
  /** Sends the toast stack no longer follows. */
  readonly settle: readonly string[];
}

/** One handed-off send's id and its row (undefined until the row is known). */
export interface Watched {
  readonly id: string;
  readonly row: Submission | undefined;
}

function newestWithTray(
  rows: readonly Submission[],
  now: number,
  online: boolean,
): ToastPlan['tray'] {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    const tray = sendView(rowPhase(row, now, online), String).tray;
    if (tray) return { row, state: tray };
  }
  return null;
}

/** The plan for the watched sends, oldest first. */
export function toastPlan(
  watched: readonly Watched[],
  now: number,
  online: boolean,
  formatTime: (ms: number) => string,
): ToastPlan {
  const rows = watched.flatMap(w => (w.row ? [w.row] : []));
  const tray = newestWithTray(rows, now, online);
  const plan = { held: [] as HeldBehind[], notices: [] as ToastPlan['notices'][number][] };
  const failed: Submission[] = [];
  const settle: string[] = [];
  for (const row of rows) {
    const view = sendView(rowPhase(row, now, online), formatTime);
    if (!isLiveSubmission(row)) settle.push(row.id);
    if (view.notice) plan.notices.push({ id: row.id, ...view.notice });
    if (view.notice?.kind === 'scheduled') settle.push(row.id);
    // A failure's notice carries Try again and Edit (Try again hands the send back to the stack): it frees its place.
    if (view.failure) failed.push(row);
    if (view.failure) settle.push(row.id);
    const held = view.tray?.kind === 'sending' && row !== tray?.row ? view.tray : null;
    if (held) plan.held.push({ row, recipients: held.recipients, secondsLeft: held.secondsLeft });
  }
  return { tray, held: plan.held, notices: plan.notices, failed, settle };
}
