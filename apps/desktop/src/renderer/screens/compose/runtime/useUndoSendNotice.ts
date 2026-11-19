/**
 * The undo-send notice for the shell's ToastStack (`ToastStackProps.undoSend`, DESIGN 7.6 "With no visible thread, it
 * is a single toast with the same words") and every other notice of the sends composers handed off (`sendHandoff.ts`,
 * `toastPlan.ts`): the newest tray is the stack's UndoTray, older held sends stack as Undo toasts, and a send later,
 * an offline send or a failure each say so once. Rows come from the data layer on its clock. Z undoes the newest held
 * send. The shell calls this once and passes the result to ToastStack; undefined when no tray shows.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { api, useNow, useRow, useStatus, type Submission } from '../../../data';
import { navigate, useRegisterCommands, type CommandHandlerTable } from '../../../shell';
import type { UndoTrayAction, UndoTrayProps } from '../../../ui/props';
import { scheduledLabel } from '../model/schedule';
import { useReducedMotion } from '../views/SendStatus';
import { undoSendCommands } from './composeCommands';
import { handoffStore, settleSend, watchedByToast, watchedSends } from './sendHandoff';
import {
  dropHeldSend,
  pushFailedSubmission,
  pushHeldSend,
  pushSendNotice,
  undoSubmission,
} from './sendNotices';
import { toastPlan, type HeldBehind, type ToastPlan, type Watched } from './toastPlan';

const NONE: CommandHandlerTable = {};

function actOn(row: Submission, action: UndoTrayAction): void {
  const { id, revision } = row;
  if (action === 'checkSent') return navigate('sent');
  if (action === 'undo') return undoSubmission(id, row);
  if (action === 'sendNow' || action === 'sendAnyway')
    void api.submission
      .set({ action: { type: action, submissionId: id, revision } })
      .catch(() => undefined);
}

/**
 * Every handed-off send with its row. Hooks come in a fixed number, so the oldest `LIVE_ROW_SLOTS` read their live
 * rows and any later ones show the row they were handed off with until a slot frees; none is ever dropped.
 */
function useWatched(): readonly Watched[] {
  const handoff = useSyncExternalStore(handoffStore.subscribe, handoffStore.get, handoffStore.get);
  const ids = watchedByToast(handoff);
  const s0 = useRow('Submission', ids[0]);
  const s1 = useRow('Submission', ids[1]);
  const s2 = useRow('Submission', ids[2]);
  const s3 = useRow('Submission', ids[3]);
  const s4 = useRow('Submission', ids[4]);
  const s5 = useRow('Submission', ids[5]);
  return useMemo(
    () => watchedSends(handoff, [s0, s1, s2, s3, s4, s5]),
    [handoff, s0, s1, s2, s3, s4, s5],
  );
}

/** What a held toast says now: it is pushed again only when this changes (once a second). */
function heldWords(held: HeldBehind): string {
  return `${held.recipients}:${Math.ceil(held.secondsLeft)}:${held.row.rev}`;
}

/** Pushes each one-off notice and failure once; the held toasts follow the clock until their send moves on. */
function usePlanEffects(plan: ToastPlan): void {
  const pushed = useRef(new Set<string>());
  const shownHeld = useRef(new Map<string, string>());
  useEffect(() => {
    for (const notice of plan.notices) {
      const key = `${notice.id}:${notice.kind}`;
      if (pushed.current.has(key)) continue;
      pushed.current.add(key);
      pushSendNotice(notice.id, notice.kind, notice.message);
    }
    for (const row of plan.failed) {
      const key = `${row.id}:failed:${row.rev}`;
      if (pushed.current.has(key)) continue;
      pushed.current.add(key);
      pushFailedSubmission(row);
    }
    for (const id of plan.settle) settleSend(id);
  }, [plan]);
  useEffect(() => {
    const next = new Map<string, string>();
    for (const held of plan.held) {
      const words = heldWords(held);
      next.set(held.row.id, words);
      if (shownHeld.current.get(held.row.id) !== words)
        pushHeldSend(held.row, held.recipients, held.secondsLeft);
    }
    for (const id of shownHeld.current.keys()) if (!next.has(id)) dropHeldSend(id);
    shownHeld.current = next;
  }, [plan]);
}

function useHeldUndo(tray: ToastPlan['tray']): void {
  const held: Submission | null = tray?.state.kind === 'sending' ? tray.row : null;
  const commands = useMemo(
    () => (held ? undoSendCommands(() => undoSubmission(held.id, held)) : NONE),
    [held],
  );
  useRegisterCommands(commands);
}

export function useUndoSendNotice(): Omit<UndoTrayProps, 'placement'> | undefined {
  const watched = useWatched();
  const now = useNow({ granularity: 'second' });
  const online = useStatus()?.status.state !== 'offline';
  const reducedMotion = useReducedMotion();
  const plan = useMemo(
    () => toastPlan(watched, now, online, ms => scheduledLabel(ms, now)),
    [watched, now, online],
  );
  usePlanEffects(plan);
  useHeldUndo(plan.tray);
  const tray = plan.tray;
  if (!tray) return undefined;
  return {
    state: tray.state,
    reducedMotion,
    undoCommandId: 'app.undo',
    onAction: action => actOn(tray.row, action),
  };
}
