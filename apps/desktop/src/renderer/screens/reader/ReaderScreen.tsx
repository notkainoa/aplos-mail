/**
 * The reader (DESIGN 7.5): the thread opened from a list, in one 640 px column. J and K move to the next and previous
 * thread of the list it was opened from; the letter on paper stays until the next one reports it is laid out, and a
 * 12 px line shows after 1.5 s (the no-blank-sheet double buffer). E, L, Space and R, Esc, O, ⌘F and ↑/↓ are the
 * registry's. R, ⇧R, hold R, a Reply suggestion and the Reply stub open the inline reply under the thread (the composer's
 * `InlineReplyHost`, mounted by `ReaderLetter`); Pop out opens the compose page.
 */
import { useCallback, useMemo, useReducer, useRef } from 'react';
import { api, useRow, type ThreadRow } from '../../data';
import {
  closeThread,
  dismissToast,
  navigate,
  openCompose,
  openThread,
  pushToast,
  screenLabel,
  useCommandTarget,
  useOpenThread,
  useOpenThreadContext,
  usePaneHeader,
  useRegisterCommands,
  useShellKeyLayer,
  useShellRegistry,
  type Screen,
} from '../../shell';
import { EmptyLine } from '../../ui/list';
import { LoadingLine } from '../../ui/reader';
import type { SuggestedAction } from '../../ui/props';
import { senderOf, subjectOf } from '../home/homeRows';
import { crumbPosition, stepThread } from './readerModel';
import { readerHeader } from './readerHeader';
import { createReaderActions, type ReaderActions, type ReaderDeps } from './readerActions';
import { commandsForReader, relayToShell } from './readerCommands';
import {
  PLAIN_REPLY,
  freshUi,
  reduceFor,
  uiFor,
  type ReplyRequest,
  type UiEvent,
} from './readerUi';
import { ReaderLetter, type LetterControls, type PopOut } from './ReaderLetter';
import { useLetterBuffer, useLetterController, usePrefetchAround } from './useLetterBuffer';
import { useReaderList } from './useReaderList';

export const LOADING_COPY = 'Loading this email…';
export const NO_THREAD_COPY = 'No email is open.';

/** Props for `ReaderScreen`. */
export interface ReaderScreenProps {
  /** The list the reader was opened from, in order, for J and K. Absent: the ids `openThread` recorded, else Home's order. */
  readonly listIds?: readonly string[];
  /** Where Esc and "no thread left" go. Absent: the screen `openThread` recorded (`from`), else Home. */
  readonly backTo?: Screen;
  /** Any suggestion that is neither a reply nor Done ("View invoice", "Add to calendar"); a later slice's. */
  readonly onSuggested?: (threadId: string, action: SuggestedAction) => void;
}

/** What the actions read when a key arrives. */
interface Live {
  readonly props: ReaderScreenProps;
  readonly shown: string | null;
  readonly wanted: string;
  readonly ids: readonly string[];
  readonly row: ThreadRow | undefined;
  /** Opens the inline reply under the letter on paper. */
  readonly openReply: (request: ReplyRequest) => void;
}

function useLive<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

function useReaderActions(live: { readonly current: Live }): ReaderActions {
  const { registry } = useShellRegistry();
  return useMemo(() => {
    const deps: ReaderDeps = {
      shown: () => live.current.shown,
      wanted: () => live.current.wanted,
      ids: () => live.current.ids,
      rowOf: id => (live.current.row?.id === id ? live.current.row : undefined),
      go: openThread,
      leave: () => {
        closeThread();
        const { backTo } = live.current.props;
        if (backTo) navigate(backTo);
      },
      act: args => api.thread.act(args),
      push: pushToast,
      dismiss: dismissToast,
      undoLabel: (commandId, fallback) => {
        const entry = registry.get(commandId);
        return (entry?.kind === 'command' ? entry.spec.undo?.label : undefined) ?? fallback;
      },
      reply: (_id, request) => live.current.openReply(request ?? PLAIN_REPLY),
      suggested: (id, action) => live.current.props.onSuggested?.(id, action),
    };
    return createReaderActions(deps);
  }, [live, registry]);
}

/** The palette's context line names the letter on paper: "Drew Bell · October illustrations". */
function useReaderTarget(row: ThreadRow | undefined): void {
  useCommandTarget(
    row ? { kind: 'thread', id: row.id, title: senderOf(row), detail: subjectOf(row) } : null,
  );
}

/** The pane header (DESIGN 7.1): back with Esc, "Home  1 of 16", K and J, ⋯. The shell draws it. */
function useReaderHeader(input: {
  readonly ids: readonly string[];
  readonly at: string;
  readonly row: ThreadRow | undefined;
  readonly from: Screen | null;
  readonly back: () => void;
}): void {
  const { ids, at, row, from, back } = input;
  const header = readerHeader({
    origin: screenLabel(from ?? 'home'),
    position: crumbPosition(ids, at),
    subject: row ? subjectOf(row) : '',
    summaryScrolledAway: false,
    hasPrevious: stepThread(ids, at, 'previous') !== null,
    hasNext: stepThread(ids, at, 'next') !== null,
    back,
  });
  usePaneHeader({ ...header, askScope: 'thisEmail' });
}

function controlsOf(actions: ReaderActions): LetterControls {
  return {
    popOut: popOutToCompose,
    suggest: actions.suggest,
    later: actions.later,
    done: actions.done,
    reply: actions.reply,
    relayKey: relayToShell,
  };
}

/** Pop out: the compose page opens on the saved draft, or on a reply to the message when nothing was saved yet. */
function popOutToCompose(pop: PopOut): void {
  if (pop.draftId) openCompose({ draftId: pop.draftId });
  else
    openCompose({
      replyTo: { threadId: pop.threadId, messageId: pop.messageId, replyAll: pop.replyAll },
    });
}

function ignore(_event: UiEvent): void {
  return undefined;
}

function OpenReader(props: ReaderScreenProps & { readonly open: string }) {
  const { open } = props;
  const context = useOpenThreadContext();
  const ids = useReaderList(props.listIds ?? context.listIds ?? undefined);
  const controller = useLetterController();
  const buffer = useLetterBuffer(controller, open);
  const shown = buffer.letter;
  const row = useRow('Thread', shown ?? undefined);
  const [ui, send] = useReducer(reduceFor, freshUi(null));
  const dispatchShown = useCallback(
    (event: UiEvent) => {
      if (shown !== null) send({ threadId: shown, event });
    },
    [shown],
  );
  const openReply = useCallback(
    (request: ReplyRequest) => dispatchShown({ type: 'openReply', request }),
    [dispatchShown],
  );
  const live = useLive<Live>({ props, shown, wanted: open, ids, row, openReply });
  const actions = useReaderActions(live);
  useRegisterCommands(useMemo(() => commandsForReader(actions), [actions]));
  useShellKeyLayer({ contexts: ['reader'] });
  useReaderTarget(row);
  usePrefetchAround(ids, open);
  useReaderHeader({
    ids,
    at: shown ?? open,
    row,
    from: props.backTo ?? context.from,
    back: actions.back,
  });

  const controls = useMemo(() => controlsOf(actions), [actions]);
  // A stable order, so a letter that stays mounted is never moved in the DOM (moving a frame reloads it).
  const letters = [...new Set([shown, open].filter((id): id is string => id !== null))].sort();
  return (
    <div className="aplos-reader" data-keyctx="reader">
      {buffer.loadingLine ? <LoadingLine label={LOADING_COPY} /> : null}
      {letters.map(id => (
        <ReaderLetter
          key={id}
          threadId={id}
          paper={id === shown}
          ui={uiFor(ui, id)}
          dispatch={id === shown ? dispatchShown : ignore}
          controls={controls}
          onReady={controller.ready}
        />
      ))}
    </div>
  );
}

/** The reader for the shell's open thread. */
export function ReaderScreen(props: ReaderScreenProps) {
  const open = useOpenThread();
  if (open === null) return <EmptyLine text={NO_THREAD_COPY} />;
  return <OpenReader {...props} open={open} />;
}
