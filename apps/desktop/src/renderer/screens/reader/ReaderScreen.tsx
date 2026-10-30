/**
 * The reader (DESIGN 7.5): the thread opened from a list, in one 640 px column. J and K move to the next and previous
 * thread of the list it was opened from; the letter on paper stays until the next one reports it is laid out, and a
 * 12 px line shows after 1.5 s (the no-blank-sheet double buffer). E, L, Space and R, Esc, O, ⌘F and ↑/↓ are the
 * registry's. Compose and the inline reply are a later slice's: R and the Reply stub call `onReply`.
 */
import { useCallback, useMemo, useReducer, useRef } from 'react';
import { api, useRow, type ThreadRow } from '../../data';
import {
  closeThread,
  dismissToast,
  navigate,
  openThread,
  pushToast,
  useCommandTarget,
  useOpenThread,
  useRegisterCommands,
  useShellKeyLayer,
  useShellRegistry,
  type Screen,
} from '../../shell';
import { EmptyLine } from '../../ui/list';
import { LoadingLine } from '../../ui/reader';
import type { SuggestedAction } from '../../ui/props';
import { senderOf, subjectOf } from '../home/homeRows';
import { createReaderActions, type ReaderActions, type ReaderDeps } from './readerActions';
import { commandsForReader, relayToShell } from './readerCommands';
import { freshUi, reduceFor, uiFor, type UiEvent } from './readerUi';
import { ReaderLetter, type LetterControls } from './ReaderLetter';
import { useLetterBuffer, useLetterController, usePrefetchAround } from './useLetterBuffer';
import { useReaderList } from './useReaderList';

export const LOADING_COPY = 'Loading this email…';
export const NO_THREAD_COPY = 'No email is open.';

/** Props for `ReaderScreen`. */
export interface ReaderScreenProps {
  /** The list the reader was opened from, in order, for J and K. Absent: Home's order. */
  readonly listIds?: readonly string[];
  /** Where Esc and "no thread left" go: the screen the reader was opened from. Default Home. */
  readonly backTo?: Screen;
  /** Reply (R, the stub, or a Reply suggestion). The composer lane implements it; absent until it lands. */
  readonly onReply?: (threadId: string) => void;
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
        navigate(live.current.props.backTo ?? 'home');
        closeThread();
      },
      act: args => api.thread.act(args),
      push: pushToast,
      dismiss: dismissToast,
      undoLabel: (commandId, fallback) => {
        const entry = registry.get(commandId);
        return (entry?.kind === 'command' ? entry.spec.undo?.label : undefined) ?? fallback;
      },
      reply: id => live.current.props.onReply?.(id),
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

function controlsOf(actions: ReaderActions): LetterControls {
  return {
    suggest: actions.suggest,
    later: actions.later,
    done: actions.done,
    reply: actions.reply,
    relayKey: relayToShell,
  };
}

function ignore(_event: UiEvent): void {
  return undefined;
}

function OpenReader(props: ReaderScreenProps & { readonly open: string }) {
  const { open } = props;
  const ids = useReaderList(props.listIds);
  const controller = useLetterController();
  const buffer = useLetterBuffer(controller, open);
  const shown = buffer.letter;
  const row = useRow('Thread', shown ?? undefined);
  const live = useLive<Live>({ props, shown, wanted: open, ids, row });
  const actions = useReaderActions(live);
  useRegisterCommands(useMemo(() => commandsForReader(actions), [actions]));
  useShellKeyLayer({ contexts: ['reader'] });
  useReaderTarget(row);
  usePrefetchAround(ids, open);

  const [ui, send] = useReducer(reduceFor, freshUi(null));
  const dispatchShown = useCallback(
    (event: UiEvent) => {
      if (shown !== null) send({ threadId: shown, event });
    },
    [shown],
  );
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
