/**
 * The reader (DESIGN 7.5): the thread opened from a list, in one 640 px column. J and K move to the next and previous
 * thread of the list it was opened from; the letter on paper stays until the next one reports it is laid out, and a
 * 12 px line shows after 1.5 s (the no-blank-sheet double buffer). E, L, Space and R, Esc, O, ⌘F and ↑/↓ are the
 * registry's. R, ⇧R, hold R, a Reply suggestion and the Reply stub open the inline reply under the thread (the composer's
 * `InlineReplyHost`, mounted by `ReaderLetter`); Pop out opens the compose page.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { api, useRow, type ThreadRow } from '../../data';
import {
  clearPendingReply,
  closeThread,
  dismissToast,
  openCompose,
  openThread,
  pushToast,
  screenLabel,
  useCommandTarget,
  useOpenThread,
  useOpenThreadContext,
  usePaneHeaderPart,
  usePendingReply,
  useRegisterCommands,
  useShellKeyLayer,
  useShellRegistry,
  type Screen,
} from '../../shell';
import { EmptyLine } from '../../ui/list';
import { LoadingLine } from '../../ui/reader';
import type { SuggestedAction } from '../../ui/props';
import { senderOf, subjectOf } from '../home/homeRows';
import { loadingLabel } from './readerRows';
import { crumbPosition, stepThread } from './readerModel';
import { readerHeader } from './readerHeader';
import { settleFocus } from './readerFocus';
import {
  createReaderActions,
  whileOpen,
  type ReaderActions,
  type ReaderDeps,
} from './readerActions';
import { commandsForReader, relayToShell } from './readerCommands';
import {
  PLAIN_REPLY,
  freshUi,
  reduceFor,
  uiFor,
  type ReplyRequest,
  type UiEvent,
} from './readerUi';
import { useCardStyle, type CardStyle } from '../cardStyle';
import { ReaderLetter, type LetterControls, type PopOut } from './ReaderLetter';
import { useLetterBuffer, useLetterController, usePrefetchAround } from './useLetterBuffer';
import { useHomeOrder, useReaderList } from './useReaderList';

/** The loading line's words when the thread has no subject or sender to name yet (DESIGN 5 rule 10 names what it loads). */
export const LOADING_COPY = 'Loading this email…';
export const NO_THREAD_COPY = 'No email is open';

/** How the letter is grouped: 'a' is a card per message (the default); 'off' is DESIGN 7.5's one column with no card. */
export type ReaderCardStyle = CardStyle;

/** Props for `ReaderScreen`. */
export interface ReaderScreenProps {
  /** The list the reader was opened from, in order, for J and K. Absent: the ids `openThread` recorded, else Home's order. */
  readonly listIds?: readonly string[];
  /** Where Esc and "no thread left" go. Absent: the screen `openThread` recorded (`from`), else Home. */
  readonly backTo?: Screen;
  /** Any suggestion that is neither a reply nor Done ("View invoice", "Add to calendar"); a later slice's. */
  readonly onSuggested?: (threadId: string, action: SuggestedAction) => void;
  /** 'a' a card per message (the default), 'off' no card. Absent: `CardStyleContext`'s, else 'a'. */
  readonly cardStyle?: ReaderCardStyle;
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
  /** Closes find on the letter on paper when it is open; false when it was not. */
  readonly closeFind: () => boolean;
}

/** A thread this reading sent away (Done, Later, Trash) or got back (Undo). */
interface GoneChange {
  readonly id: string;
  readonly gone: boolean;
}

const NOBODY: ReadonlySet<string> = new Set();

function goneReducer(state: ReadonlySet<string>, { id, gone }: GoneChange): ReadonlySet<string> {
  if (state.has(id) === gone) return state;
  const next = new Set(state);
  if (gone) next.add(id);
  else next.delete(id);
  return next;
}

function useLive<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

function useReaderActions(
  live: { readonly current: Live },
  markGone: (change: GoneChange) => void,
): ReaderActions {
  const { registry } = useShellRegistry();
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  return useMemo(() => {
    const deps: ReaderDeps = {
      shown: () => live.current.shown,
      wanted: () => live.current.wanted,
      ids: () => live.current.ids,
      rowOf: id => (live.current.row?.id === id ? live.current.row : undefined),
      go: openThread,
      markGone: (id, gone) => markGone({ id, gone }),
      reopen: whileOpen(open, openThread),
      // One call: a second `navigate(backTo)` after the close would be a screen shown other than through Esc and drop the saved places.
      leave: () => closeThread(live.current.props.backTo),
      act: args => api.thread.act(args),
      push: pushToast,
      dismiss: dismissToast,
      undoLabel: (commandId, fallback) => {
        const entry = registry.get(commandId);
        return (entry?.kind === 'command' ? entry.spec.undo?.label : undefined) ?? fallback;
      },
      closeFind: () => live.current.closeFind(),
      reply: (_id, request) => live.current.openReply(request ?? PLAIN_REPLY),
      suggested: (id, action) => live.current.props.onSuggested?.(id, action),
    };
    return createReaderActions(deps);
  }, [live, registry, markGone]);
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
  readonly walk: readonly string[];
  readonly at: string;
  readonly row: ThreadRow | undefined;
  readonly from: Screen | null;
  readonly back: () => void;
}): void {
  const { ids, walk, at, row, from, back } = input;
  const latest = useLive({ back });
  const goBack = useCallback(() => latest.current.back(), [latest]);
  const origin = screenLabel(from ?? 'home');
  const place = crumbPosition(ids, at);
  const index = place?.index;
  const of = place?.of;
  const subject = row ? subjectOf(row) : '';
  const hasPrevious = stepThread(walk, at, 'previous') !== null;
  const hasNext = stepThread(walk, at, 'next') !== null;
  // The part compares by reference: it changes only when what it draws does, never with the render.
  const part = useMemo(
    () =>
      readerHeader({
        origin,
        position: index === undefined || of === undefined ? null : { index, of },
        subject,
        summaryScrolledAway: false,
        hasPrevious,
        hasNext,
        back: goBack,
      }),
    [origin, index, of, subject, hasPrevious, hasNext, goBack],
  );
  usePaneHeaderPart(part);
}

function controlsOf(actions: ReaderActions): LetterControls {
  return {
    popOut: popOutToCompose,
    suggest: actions.suggest,
    later: actions.later,
    done: actions.done,
    reply: actions.reply,
    replyAll: actions.replyAll,
    bookmark: actions.bookmark,
    trash: actions.trash,
    lane: actions.lane,
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

type OpenProps = ReaderScreenProps & { readonly open: string };

function OpenReader(props: OpenProps & { readonly source: readonly string[] }) {
  const { open } = props;
  const cards = useCardStyle(props.cardStyle);
  const context = useOpenThreadContext();
  const [gone, markGone] = useReducer(goneReducer, NOBODY);
  const list = useReaderList(props.source, open, gone);
  const controller = useLetterController();
  const buffer = useLetterBuffer(controller, open);
  const shown = buffer.letter;
  const row = useRow('Thread', shown ?? undefined);
  const wantedRow = useRow('Thread', open);
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
  // A thread opened for a reply (R, ⇧R, hold R or the nudge on Home or one by one) shows its reply card at once.
  const pending = usePendingReply();
  useEffect(() => {
    if (pending === null || shown !== pending.id) return;
    const { replyAll, dictate, nudge } = pending.reply;
    openReply(nudge ? { replyAll, dictate, suggest: { kind: 'followUp' } } : { replyAll, dictate });
    clearPendingReply();
  }, [pending, shown, openReply]);
  const closeFind = useCallback(() => {
    if (shown === null || uiFor(ui, shown).find === null) return false;
    send({ threadId: shown, event: { type: 'closeFind' } });
    return true;
  }, [shown, ui]);
  const live = useLive<Live>({
    props,
    shown,
    wanted: open,
    ids: list.walk,
    row,
    openReply,
    closeFind,
  });
  const actions = useReaderActions(live, markGone);
  useRegisterCommands(useMemo(() => commandsForReader(actions), [actions]));
  useShellKeyLayer({ contexts: ['reader'] });
  useReaderTarget(row);
  usePrefetchAround(list.walk, open);
  useReaderHeader({
    ids: list.ids,
    walk: list.walk,
    at: shown ?? open,
    row,
    from: props.backTo ?? context.from,
    back: actions.back,
  });

  const controls = useMemo(() => controlsOf(actions), [actions]);
  const root = useRef<HTMLDivElement>(null);
  const findOpen = shown !== null && uiFor(ui, shown).find !== null;
  // The element that held focus may be gone (find closed, the letter changed): the reader's root takes it.
  useEffect(() => {
    settleFocus(root.current);
  }, [shown, findOpen]);
  // A stable order, so a letter that stays mounted is never moved in the DOM (moving a frame reloads it).
  const letters = [...new Set([shown, open].filter((id): id is string => id !== null))].sort();
  return (
    <div className="aplos-reader" data-keyctx="reader" data-cards={cards} tabIndex={-1} ref={root}>
      {buffer.loadingLine ? <LoadingLine label={loadingLabel(wantedRow) ?? LOADING_COPY} /> : null}
      {letters.map(id => (
        <ReaderLetter
          key={id}
          threadId={id}
          paper={id === shown}
          cards={cards}
          topBarMore
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
  const context = useOpenThreadContext();
  if (open === null) return <EmptyLine placement="pane" icon="mail" text={NO_THREAD_COPY} />;
  const listIds = props.listIds ?? context.listIds;
  if (listIds) return <OpenReader {...props} open={open} source={listIds} />;
  return <ReaderOverHome {...props} open={open} />;
}

/** No list came with the thread (a deep link, the palette): the walk follows Home, which only this branch subscribes to. */
function ReaderOverHome(props: OpenProps) {
  return <OpenReader {...props} source={useHomeOrder()} />;
}
