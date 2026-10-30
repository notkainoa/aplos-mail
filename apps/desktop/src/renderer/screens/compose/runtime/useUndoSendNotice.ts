/**
 * The undo-send notice for the shell's ToastStack (`ToastStackProps.undoSend`, DESIGN 7.6 "With no visible thread, it
 * is a single toast with the same words"): the newest send a composer handed off (`sendHandoff.ts`), read from its
 * `Submission` row on the data layer's clock. Z undoes it while it is held. The shell calls this once and passes the
 * result to ToastStack; it returns undefined when there is nothing to show.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { api, useNow, useRow } from '../../../data';
import { navigate, useRegisterCommands, type CommandHandlerTable } from '../../../shell';
import type { UndoTrayAction, UndoTrayProps } from '../../../ui/props';
import { rowPhase, sendView } from '../model/sendState';
import { undoSendCommands } from './composeCommands';
import { handoffStore, settleSend, shownByToast } from './sendHandoff';
import { useReducedMotion } from '../views/SendStatus';

const NONE: CommandHandlerTable = {};

function actOn(id: string, revision: number, action: UndoTrayAction): void {
  if (action === 'checkSent') return navigate('sent');
  if (action === 'undo')
    void api.submission.set({ action: { type: 'undo', submissionId: id } }).catch(() => undefined);
  if (action === 'sendNow' || action === 'sendAnyway')
    void api.submission
      .set({ action: { type: action, submissionId: id, revision } })
      .catch(() => undefined);
}

export function useUndoSendNotice(): Omit<UndoTrayProps, 'placement'> | undefined {
  const handoff = useSyncExternalStore(handoffStore.subscribe, handoffStore.get, handoffStore.get);
  const id = shownByToast(handoff);
  const row = useRow('Submission', id ?? undefined);
  const now = useNow({ granularity: 'second' });
  const reducedMotion = useReducedMotion();
  const tray = row ? sendView(rowPhase(row, now, true), String).tray : null;
  const settled = row !== undefined && tray === null;
  useEffect(() => {
    if (id && settled) settleSend(id);
  }, [id, settled]);
  const held = tray?.kind === 'sending' && row ? row : null;
  const commands = useMemo(
    () => (held ? undoSendCommands(() => actOn(held.id, held.revision, 'undo')) : NONE),
    [held],
  );
  useRegisterCommands(commands);
  if (!row || !tray) return undefined;
  return {
    state: tray,
    reducedMotion,
    undoCommandId: 'app.undo',
    onAction: action => actOn(row.id, row.revision, action),
  };
}
