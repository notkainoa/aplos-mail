/**
 * New message as a page in the pane, non-modal (DESIGN 7.6): a To row, the subject as a `heading`-size field, the text
 * in `read`, and the footer pinned to the bottom of the pane with Send (⌘↩), the draft line, attach and format. C or the
 * palette opens it fresh; Drafts and the inline reply's Pop out open it on a draft. Esc closes it and keeps the draft.
 * On Send the composer closes at once; the page itself goes once the engine has answered (Z until then undoes this
 * send, never an older triage action), and the send's every phase goes to the shell's toast stack: the undo tray,
 * "Scheduled for …", "Saved here · will sync", or "Couldn’t send to Jordan. Your draft is saved." with Try again and
 * Edit. A save that fails meanwhile brings the composer back with "Couldn’t save · Retry"; nothing closes silently.
 */
import { useEffect, useMemo, useRef } from 'react';
import {
  getNow,
  useAccounts,
  useMessageBody,
  useRow,
  useView,
  type Account,
  type Draft,
  type Message,
} from '../../data';
import { useAccountScope, useRegisterCommands, type CommandHandlerTable } from '../../shell';
import { Composer } from '../../ui/compose';
import { useCardStyle, type CardStyle } from '../cardStyle';
import { headerMenu, headerMoreButton } from './composeHeader';
import { composeFromDraft, freshCompose, type ComposeState } from './model/composeState';
import { forwardSeed } from './model/forwardSeed';
import { ownAddresses, replySeed } from './model/replySeed';
import { undoSendCommands } from './runtime/composeCommands';
import type { DictationSource } from './runtime/dictationSource';
import { withKeptText } from './runtime/recovery';
import type { ComposeSession } from './runtime/session';
import { useComposerControls } from './runtime/useComposerControls';
import { useComposeSession, type ComposeBinding } from './runtime/useComposeSession';
import { useSchedulePresets } from './runtime/useSchedulePresets';
import { ComposeMenu, DiscardConfirm } from './views/ComposeOverlays';
import { useSharedComposerProps } from './views/composerParts';

export interface ComposeScreenProps {
  /** Open on this draft (Drafts, Pop out). */
  readonly draftId?: string;
  /** A reply popped out before its first save. */
  readonly replyTo?: {
    readonly threadId: string;
    readonly messageId: string;
    readonly replyAll?: boolean;
  };
  /** A forward of this thread's latest message: the page opens once the message and its text have loaded. */
  readonly forward?: { readonly threadId: string };
  /** The page has gone (Esc, discarded, sent): the shell goes back. */
  readonly onClose?: () => void;
  readonly dictationSource?: DictationSource | null;
  /** 'a' one card (the default), 'off' the bare page of DESIGN 7.6. Absent: `CardStyleContext`'s, else 'a'. */
  readonly cardStyle?: ComposeCardStyle;
}

/** How the compose page is grouped: 'a' is one card (the default); 'off' is DESIGN 7.6's bare page. */
export type ComposeCardStyle = CardStyle;

function useInitialCompose(props: ComposeScreenProps): ComposeState | null {
  const draft = useRow('Draft', props.draftId);
  const message = useRow('Message', props.replyTo?.messageId);
  const accounts = useAccounts();
  const scope = useAccountScope();
  const decided = useRef<ComposeState | null>(null);
  if (decided.current) return decided.current;
  const start = startingState(props, { draft, message, accounts, scope });
  // Text a closed composer could not save yet is taken over, never shown stale.
  decided.current = start ? withKeptText(start) : null;
  return decided.current;
}

function startingState(
  props: ComposeScreenProps,
  known: {
    readonly draft: Draft | undefined;
    readonly message: Message | undefined;
    readonly accounts: readonly Account[];
    readonly scope: string | null | undefined;
  },
): ComposeState | null {
  if (props.draftId) return known.draft ? composeFromDraft(known.draft) : null;
  if (props.replyTo) {
    const me = ownAddresses(known.accounts);
    const replyAll = props.replyTo.replyAll ?? false;
    const seed = known.message ? replySeed(known.message, me, replyAll) : null;
    return seed ? freshCompose(seed.context, seed.fields) : null;
  }
  const accountId = known.scope ?? known.accounts[0]?.id;
  return accountId ? freshCompose({ accountId, mode: 'new' }) : null;
}

const NO_COMMANDS: CommandHandlerTable = {};

/** A pressed send still waiting for its answer (not one that has waited past `SEND_CONFIRM_MS`). */
function awaitingAnswer(state: ComposeState): boolean {
  return state.send.kind === 'pending' && !state.send.unconfirmed;
}

/**
 * The page has nothing left to show: the composer is closed, nothing is being confirmed, no send awaits its answer. A
 * send unconfirmed after `SEND_CONFIRM_MS` no longer holds the page: it goes to the toast stack.
 */
export function pageDone(state: ComposeState): boolean {
  return !state.open && state.confirm === null && !awaitingAnswer(state);
}

/** Z between Send and the engine's answer: this send's Undo (it shadows the shell's Z), let go once unconfirmed. */
export function pendingUndoTable(
  state: ComposeState,
  session: Pick<ComposeSession, 'dispatch'>,
): CommandHandlerTable {
  if (!awaitingAnswer(state)) return NO_COMMANDS;
  return undoSendCommands(() => session.dispatch({ type: 'action', action: 'undo' }));
}

/**
 * Calls `onClose` once the page has nothing left to show. While a pressed send waits for the engine's answer the page
 * stays (empty), so the answer is never lost: accepted, refused or a failed save all have somewhere to go. Closing hands
 * the send to the toast stack (`closeSession`).
 */
function useCloseWhenDone(binding: ComposeBinding | null, onClose: (() => void) | undefined) {
  const done = binding !== null && pageDone(binding.state);
  useEffect(() => {
    if (done) onClose?.();
  }, [done, onClose]);
}

/** Between Send and the engine's answer, Z undoes this send (it is sent the moment the submission exists). */
function usePendingUndo(binding: ComposeBinding | null) {
  const session = binding?.session;
  const pending = binding ? awaitingAnswer(binding.state) : false;
  const table = useMemo(
    () => (pending && session ? pendingUndoTable(session.getState(), session) : NO_COMMANDS),
    [pending, session],
  );
  useRegisterCommands(table);
}

/** ⋯ in the pane header (`compose.more`) opens the menu under that button; ⌘/ (`compose.format`) under the text. */
function useMenuCommands(
  open: boolean,
  setMenuAnchor: (anchor: HTMLElement | null) => void,
  editor: { readonly current: HTMLTextAreaElement | null },
) {
  useEffect(() => headerMenu.subscribe(anchor => setMenuAnchor(anchor)), [setMenuAnchor]);
  const table = useMemo<CommandHandlerTable>(
    () => ({
      'compose.format': { run: () => setMenuAnchor(editor.current) },
      'compose.more': { run: () => setMenuAnchor(headerMoreButton() ?? editor.current) },
    }),
    [setMenuAnchor, editor],
  );
  useRegisterCommands(open ? table : NO_COMMANDS);
}

export function ComposePageView({
  binding,
  props,
}: {
  readonly binding: ComposeBinding;
  readonly props: ComposeScreenProps;
}) {
  const controls = useComposerControls(binding, { dictationSource: props.dictationSource });
  const shared = useSharedComposerProps(binding, controls, {
    label: 'Message',
    focusTo: binding.state.fields.to.length === 0,
    from: true,
  });
  const { session, state, view } = binding;
  const cards = useCardStyle(props.cardStyle);
  const presets = useSchedulePresets(controls.menuAnchor !== null);
  useMenuCommands(view.open, controls.setMenuAnchor, shared.editorRef);
  return (
    <>
      <div className="aplos-compose" data-cards={cards}>
        <Composer
          {...shared}
          subject={state.fields.subject}
          onSubjectChange={subject =>
            session.dispatch({ type: 'edit', patch: { subject }, now: getNow() })
          }
          onFormat={anchor => controls.setMenuAnchor(anchor)}
        />
      </div>
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

/**
 * A forward's starting state, decided once the thread's latest message and its text are in (a body that failed to load
 * quotes the snippet instead). A thread that cannot be read closes the page rather than leave it blank.
 */
function useForwardCompose(
  threadId: string,
  onClose: (() => void) | undefined,
): ComposeState | null {
  const view = useView({ kind: 'thread', threadId });
  const ids = view.ids;
  const latest = ids.length > 0 ? view.rows.get(ids[ids.length - 1]) : undefined;
  const body = useMessageBody(latest?.id);
  const decided = useRef<ComposeState | null>(null);
  const failed = view.status === 'failed' || (view.status === 'live' && ids.length === 0);
  useEffect(() => {
    if (failed) onClose?.();
  }, [failed, onClose]);
  if (decided.current || !latest) return decided.current;
  if (body.status !== 'ready' && body.status !== 'failed') return null;
  const seed = forwardSeed(latest, body.body?.text ?? latest.snippet);
  decided.current = freshCompose(seed.context, seed.fields);
  return decided.current;
}

/** `ComposeScreen({draftId?, replyTo?, forward?})`: the compose page. */
export function ComposeScreen(props: ComposeScreenProps) {
  return props.forward ? (
    <ForwardScreen {...props} threadId={props.forward.threadId} />
  ) : (
    <ComposePage {...props} />
  );
}

function ForwardScreen(props: ComposeScreenProps & { readonly threadId: string }) {
  const initial = useForwardCompose(props.threadId, props.onClose);
  return <ComposeBound initial={initial} props={props} />;
}

function ComposePage(props: ComposeScreenProps) {
  return <ComposeBound initial={useInitialCompose(props)} props={props} />;
}

function ComposeBound({
  initial,
  props,
}: {
  readonly initial: ComposeState | null;
  readonly props: ComposeScreenProps;
}) {
  const binding = useComposeSession(initial);
  useCloseWhenDone(binding, props.onClose);
  usePendingUndo(binding);
  if (!binding || !binding.view.open) return null;
  return <ComposePageView binding={binding} props={props} />;
}
