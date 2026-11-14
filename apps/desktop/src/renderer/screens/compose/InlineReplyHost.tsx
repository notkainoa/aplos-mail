/**
 * The inline reply under the thread (DESIGN 7.6): R, the Reply stub or a reply suggestion opens one card under the
 * message, with the To line (Cc and Pop out on the right), the text, Send (⌘↩), the draft line, attach and ⋯. While it
 * is open it owns the filled button. Esc closes it and keeps the draft; Send closes it and the message arrives at the end
 * of the thread with the undo tray. After a reload the host finds the thread's send or reply draft on the engine again.
 *
 * The reader mounts it under the thread (REQUEST: wiring in ReaderLetter) and demotes its own suggestion while
 * `onOpenChange(true)`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, getNow, useAccounts, useRow, useView, type Message } from '../../data';
import { useRegisterCommands, type CommandHandlerTable } from '../../shell';
import { InlineReply } from '../../ui/compose';
import { composeFromDraft, freshCompose, type ComposeState } from './model/composeState';
import { replyDraftFor, rowsResolved } from './model/reopen';
import { ownAddresses, replySeed } from './model/replySeed';
import { dictateReplyCommands } from './runtime/composeCommands';
import type { DictationSource } from './runtime/dictationSource';
import { withKeptText } from './runtime/recovery';
import { loadSuggestion, type SuggestionRequest } from './runtime/suggestion';
import { useComposerControls } from './runtime/useComposerControls';
import type { ComposeSession } from './runtime/session';
import { useComposeSession, type ComposeBinding } from './runtime/useComposeSession';
import { useSchedulePresets } from './runtime/useSchedulePresets';
import { ComposeMenu, DiscardConfirm } from './views/ComposeOverlays';
import { SendStatus, useReducedMotion } from './views/SendStatus';
import { useSharedComposerProps } from './views/composerParts';

export interface InlineReplyHostProps {
  readonly threadId: string;
  /** The message replied to (the latest one, usually). */
  readonly messageId: string;
  /** The reply has gone: closed with Esc (draft kept), discarded, or sent and settled. The reader shows its stub again. */
  readonly onClose: () => void;
  /** ⇧R: reply to everyone. */
  readonly replyAll?: boolean;
  /** A suggestion to show as dim text: the Follow up nudge, or a reply suggestion's drafted text. */
  readonly suggest?: SuggestionRequest;
  /** Opened by holding R: start listening at once. */
  readonly dictate?: boolean;
  /** The card opened or closed: the reader demotes its suggestion to a text button while open. */
  readonly onOpenChange?: (open: boolean) => void;
  /** Pop out: open the compose page on this draft (its id once saved). */
  readonly onPopOut?: (draftId: string | null) => void;
  /** Tests and the harness: where dictation audio comes from. */
  readonly dictationSource?: DictationSource | null;
}

function rowsOf<R>(rows: ReadonlyMap<string, R>): readonly R[] {
  return [...rows.values()];
}

/** How long the host waits for the rows of the drafts and sends it looks through before it starts a fresh reply. */
const ROWS_WAIT_MS = 2000;

/** True once `ms` have passed since mount: the bound on waiting for rows that never come. */
function useElapsed(ms: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setElapsed(true), ms);
    return () => clearTimeout(timer);
  }, [ms]);
  return elapsed;
}

/** The starting state, decided once: the thread's send or reply draft on the engine, else a fresh reply. */
function useInitialReply(props: InlineReplyHostProps): ComposeState | null {
  const drafts = useView({ kind: 'drafts' });
  const scheduled = useView({ kind: 'scheduled' });
  const message = useRow('Message', props.messageId);
  const accounts = useAccounts();
  const gaveUp = useElapsed(ROWS_WAIT_MS);
  const rowsIn = (rowsResolved(drafts) && rowsResolved(scheduled)) || gaveUp;
  const settled = (status: string) => status === 'live' || status === 'failed';
  const ready =
    settled(drafts.status) && settled(scheduled.status) && rowsIn && message !== undefined;
  const candidate = ready
    ? replyDraftFor(props.threadId, rowsOf(drafts.rows), rowsOf(scheduled.rows))
    : null;
  const draft = useRow('Draft', candidate ?? undefined);
  const decided = useRef<ComposeState | null>(null);
  if (decided.current || !ready) return decided.current;
  if (candidate && !draft) return null;
  const me = ownAddresses(accounts);
  const start = draft ? composeFromDraft(draft) : freshFrom(message, me, props.replyAll ?? false);
  // Text a closed reply could not save yet is taken over, never shown stale.
  decided.current = withKeptText(start);
  return decided.current;
}

function freshFrom(message: Message, me: ReadonlySet<string>, replyAll: boolean): ComposeState {
  const seed = replySeed(message, me, replyAll);
  return freshCompose(seed.context, seed.fields);
}

/** Loads the dim suggestion once per session; the reducer shows it only while the body is empty. */
function useSuggestion(
  binding: ComposeBinding | null,
  threadId: string,
  request: SuggestionRequest | undefined,
) {
  const session = binding?.session;
  const asked = useRef(request);
  useEffect(() => {
    const wanted = asked.current;
    if (!session || !wanted) return;
    let live = true;
    void loadSuggestion(api.ai, threadId, wanted).then(suggestion => {
      if (live && suggestion) session.dispatch({ type: 'suggest', suggestion });
    });
    return () => {
      live = false;
    };
  }, [session, threadId]);
}

/** Tells the reader when the card opens and closes, and when the reply has gone for good. */
function useLifecycle(binding: ComposeBinding | null, props: InlineReplyHostProps) {
  const open = binding?.view.open ?? false;
  const { onOpenChange, onClose } = props;
  useEffect(() => {
    onOpenChange?.(open);
  }, [open, onOpenChange]);
  const view = binding?.view;
  const gone =
    view !== undefined &&
    !view.open &&
    view.send.tray === null &&
    view.send.failure === null &&
    (binding?.state.ended !== null ||
      view.phase.kind === 'scheduled' ||
      view.phase.kind === 'sent');
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
}

const NO_COMMANDS: CommandHandlerTable = {};

/** Pop out: the text is saved first, so the compose page opens on the draft as it stands. */
async function popOut(
  session: ComposeSession,
  open: InlineReplyHostProps['onPopOut'],
): Promise<void> {
  session.dispatch({ type: 'flush' });
  await session.settled();
  open?.(session.getState().save.draftId);
}

/** When the send was pressed, or queued once the engine has it: the sent message's time. */
function sentAt(state: ComposeState): number {
  if (state.send.kind === 'pending') return state.send.pressedAt;
  if (state.send.kind === 'tracking' && state.send.row) return state.send.row.queuedAt;
  return getNow();
}

export function InlineReplyView({
  binding,
  props,
}: {
  readonly binding: ComposeBinding;
  readonly props: InlineReplyHostProps;
}) {
  const { onPopOut } = props;
  const { session: current } = binding;
  const onPop = useMemo(
    () => (onPopOut ? () => void popOut(current, onPopOut) : undefined),
    [current, onPopOut],
  );
  const controls = useComposerControls(binding, {
    popOut: onPop,
    dictationSource: props.dictationSource,
  });
  const shared = useSharedComposerProps(binding, controls, {
    label: 'Reply',
    focusTo: false,
    // DESIGN 7.6: with two or more accounts a reply shows the account it goes from, as plain text (no menu).
    from: true,
  });
  const reducedMotion = useReducedMotion();
  const { session, state, view } = binding;
  const { startDictation, endDictation } = controls;
  const startedDictation = useRef(false);
  useEffect(() => {
    if (!props.dictate || startedDictation.current) return;
    startedDictation.current = true;
    startDictation('R');
  }, [props.dictate, startDictation]);
  const dictateTable = useMemo(
    () => dictateReplyCommands(() => startDictation('R'), endDictation),
    [startDictation, endDictation],
  );
  // Only an open card listens: holding R over a sent message's tray must not start a recording nobody can keep.
  useRegisterCommands(view.open ? dictateTable : NO_COMMANDS);
  const presets = useSchedulePresets(controls.menuAnchor !== null);
  const sentId = `sent-${state.save.draftId ?? 'reply'}`;
  return (
    <>
      {view.open ? (
        <InlineReply
          {...shared}
          onPopOut={() => onPop?.()}
          onMore={anchor => controls.setMenuAnchor(anchor)}
        />
      ) : (
        <SendStatus
          id={sentId}
          view={view.send}
          fields={state.fields}
          at={sentAt(state)}
          reducedMotion={reducedMotion}
          onAction={controls.onSendAction}
        />
      )}
      <ComposeMenu
        anchor={controls.menuAnchor}
        presets={presets}
        onSchedule={notBefore => controls.send(false, notBefore)}
        onDiscard={() => session.dispatch({ type: 'askDiscard' })}
        onClose={() => controls.setMenuAnchor(null)}
      />
      {view.confirming ? (
        <DiscardConfirm
          onConfirm={() => session.dispatch({ type: 'confirmDiscard' })}
          onCancel={() => session.dispatch({ type: 'cancelDiscard' })}
        />
      ) : null}
    </>
  );
}

/** `InlineReplyHost({threadId, messageId, onClose})`: the reply card, then the sent message with its tray. */
export function InlineReplyHost(props: InlineReplyHostProps) {
  const initial = useInitialReply(props);
  const binding = useComposeSession(initial);
  useSuggestion(binding, props.threadId, props.suggest);
  useLifecycle(binding, props);
  if (!binding) return null;
  return <InlineReplyView binding={binding} props={props} />;
}
