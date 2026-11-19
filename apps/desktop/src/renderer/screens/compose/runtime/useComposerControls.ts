/**
 * What both composers (the inline reply and the compose page) share once their session exists: the registry handlers
 * and key layer while open (context `compose`, conditions `suggestion` and `emptyBody`), Z while a send is held,
 * dictation, the ⋯ menu, Cc and Bcc, the scheduled and offline notices, and the one-tray-per-send claim.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getNow, type Submission } from '../../../data';
import {
  pushToast,
  useRegisterCommands,
  useShellKeyLayer,
  type CommandHandlerTable,
} from '../../../shell';
import type { Anchor } from '../../../ui/props';
import { UNDO_ACTION } from '../../undoOperation';
import type { HoldKey } from '../model/dictationModel';
import { ccRowsShown } from '../model/composeView';
import { isLiveSubmission, type SendAction } from '../model/sendState';
import { composeCommands, undoSendCommands } from './composeCommands';
import { claimSend, releaseSend } from './sendHandoff';
import type { ComposeBinding } from './useComposeSession';
import { useDictation, type DictationHook } from './useDictation';
import type { DictationSource } from './dictationSource';

const NONE: CommandHandlerTable = {};

export interface ComposerControls {
  readonly dictation: DictationHook;
  readonly showCc: boolean;
  readonly setShowCc: (show: boolean) => void;
  readonly menuAnchor: Anchor;
  readonly setMenuAnchor: (anchor: Anchor) => void;
  readonly send: (alsoDone?: boolean, notBefore?: number) => void;
  /** A recipient field offers its "commit what is typed" so a send takes the address typed but not yet a chip. */
  readonly registerTyped: (commit: () => void) => () => void;
  readonly onSendAction: (action: SendAction) => void;
  readonly startDictation: (holdKey: HoldKey) => void;
  readonly endDictation: (keep: boolean) => void;
}

export interface ComposerControlOptions {
  readonly popOut?: () => void;
  readonly dictationSource?: DictationSource | null;
}

/** Pushes the scheduled or offline notice once per send. */
function useSendNotice(binding: ComposeBinding): void {
  const pushed = useRef(new Set<string>());
  const notice = binding.view.send.notice;
  const send = binding.state.send;
  const key = notice
    ? `${send.kind === 'tracking' ? send.submissionId : 'pending'}:${notice.kind}`
    : null;
  const { session } = binding;
  useEffect(() => {
    if (!notice || !key || pushed.current.has(key)) return;
    pushed.current.add(key);
    const undoable = notice.actions.includes('undo');
    pushToast({
      id: `send-${key}`,
      kind: notice.kind === 'offline' ? 'offline' : 'info',
      message: notice.message,
      actions: undoable ? [UNDO_ACTION] : [],
      undoable,
      onAction: id => {
        if (id === UNDO_ACTION.id) session.dispatch({ type: 'action', action: 'undo' });
      },
    });
  }, [notice, key, session]);
}

/** Claims the tracked send while mounted; hands it to the toast stack if this composer goes away mid-send. */
function useSendClaim(binding: ComposeBinding): void {
  const send = binding.state.send;
  const id = send.kind === 'tracking' ? send.submissionId : null;
  const live = useRef(true);
  const row = useRef<Submission | null>(null);
  live.current = send.kind === 'tracking' && (send.row === null || isLiveSubmission(send.row));
  row.current = send.kind === 'tracking' ? send.row : null;
  useEffect(() => {
    if (!id) return;
    claimSend(id);
    return () => releaseSend(id, live.current, row.current);
  }, [id]);
}

export function useComposerControls(
  binding: ComposeBinding,
  options: ComposerControlOptions = {},
): ComposerControls {
  const { session, view, undoSeconds } = binding;
  const [askedCc, setShowCc] = useState(() => ccRowsShown(false, binding.state.fields));
  const showCc = ccRowsShown(askedCc, binding.state.fields);
  const [menuAnchor, setMenuAnchor] = useState<Anchor>(null);
  const onText = useCallback(
    (text: string) => session.dispatch({ type: 'dictated', text, now: getNow() }),
    [session],
  );
  const dictation = useDictation(onText, options.dictationSource);
  const { controller } = dictation;

  const typed = useRef(new Set<() => void>());
  const registerTyped = useCallback((commit: () => void) => {
    typed.current.add(commit);
    return () => {
      typed.current.delete(commit);
    };
  }, []);
  const send = useCallback(
    (alsoDone = false, notBefore?: number) => {
      // An address typed but not yet a chip becomes one before the send reads the fields.
      for (const commit of [...typed.current]) commit();
      session.dispatch({
        type: 'send',
        now: getNow(),
        undoSeconds,
        alsoDone,
        ...(notBefore ? { notBefore } : {}),
      });
    },
    [session, undoSeconds],
  );
  const onSendAction = useCallback(
    (action: SendAction) => session.dispatch({ type: 'action', action, now: getNow() }),
    [session],
  );
  const startDictation = useCallback((holdKey: HoldKey) => controller.start(holdKey), [controller]);
  const endDictation = useCallback((keep: boolean) => void controller.release(keep), [controller]);

  const handlers = useMemo(
    () =>
      composeCommands({
        send,
        keepSuggestion: () => session.dispatch({ type: 'keepSuggestion', now: getNow() }),
        dismissSuggestion: () => session.dispatch({ type: 'dismissSuggestion' }),
        close: () => {
          if (controller.getPhase().kind === 'listening') return controller.cancel();
          session.dispatch({ type: 'escape' });
        },
        discard: () => {
          session.dispatch({ type: 'askDiscard' });
          session.dispatch({ type: 'confirmDiscard' });
        },
        toggleCc: () => setShowCc(!showCc),
        popOut: options.popOut,
        dictateStart: () => controller.start('Space'),
        dictateRelease: keep => void controller.release(keep),
      }),
    [send, session, controller, options.popOut, showCc],
  );
  useRegisterCommands(view.open ? handlers : NONE);
  useShellKeyLayer({
    contexts: view.open ? ['compose'] : [],
    conditions: view.open ? view.conditions : {},
  });

  const held = view.phase.kind === 'held' || view.phase.kind === 'submitting';
  const undoTable = useMemo(
    () =>
      held ? undoSendCommands(() => session.dispatch({ type: 'action', action: 'undo' })) : NONE,
    [held, session],
  );
  useRegisterCommands(undoTable);
  useSendNotice(binding);
  useSendClaim(binding);

  return {
    dictation,
    showCc,
    setShowCc,
    menuAnchor,
    setMenuAnchor,
    send,
    registerTyped,
    onSendAction,
    startDictation,
    endDictation,
  };
}
