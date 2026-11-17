/**
 * One letter of the reader (DESIGN 7.5): the thread's parts in order inside one 640 px column with nothing beside it:
 * the big summary and its hairline, then the thread (every message its own card, the earlier ones compact, the Reply
 * stub), then the pinned action bar (Reply, Later, Done; owner review 2026-11-03). A letter is mounted either on paper or off it: the
 * wanted letter lays itself out off paper and tells the reader when it is measured, and only then does it replace the
 * letter on paper (the no-blank-sheet double buffer, `letterController`).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, useAccounts, useMessageBody, useRow, type Message, type ThreadRow } from '../../data';
import type { MailFrameKey, MailFrameReady } from '../../mailframe';
import { useRegisterCommands, type CommandHandlerTable } from '../../shell';
import { EmptyLine, ErrorLine } from '../../ui/list';
import { senderOf, subjectOf } from '../home/homeRows';
import type { SuggestedAction } from '../../ui/props';
import { LoadingLine, ReaderActions, ReaderHead, ReplyStub } from '../../ui/reader';
import { FOLLOW_UP_VERB } from './readerActions';
import { InlineReplyHost } from '../compose';
import { EventOffers } from './EventOffer';
import { FindBar } from './FindBar';
import { HeadActions, type HeadControls } from './HeadActions';
import { inviteOf, type InviteView } from './invite';
import { ReaderMessage } from './ReaderMessage';
import {
  dueOf,
  loadingLabel,
  myAddresses,
  replyName,
  suggestionFor,
  summaryFor,
} from './readerRows';
import { expandEvent, walkableIds, type ReaderUi, type UiEvent } from './readerUi';
import { useLetterData, type LetterData } from './useLetterData';

export const GONE_COPY = 'This email is no longer here';

const TRIAGE_COMMANDS = {
  suggest: 'mail.suggested',
  later: 'mail.later',
  done: 'mail.done',
} as const;

/** Pop out of the inline reply: the saved draft's id, or (nothing saved yet) the message the reply answers. */
export interface PopOut {
  readonly draftId: string | null;
  readonly threadId: string;
  readonly messageId: string;
  readonly replyAll: boolean;
}

/** What the letter's buttons and the frame's keys call. The screen implements them. */
export interface LetterControls extends HeadControls {
  readonly reply: () => void;
  /** Pop out of the inline reply to the compose page. */
  readonly popOut?: (pop: PopOut) => void;
  /** A key pressed inside a frame, relayed to the shell's key listener; true when it ran a command. */
  readonly relayKey: (key: MailFrameKey) => boolean;
}

/** Props for `ReaderLetter`. */
export interface ReaderLetterProps {
  readonly threadId: string;
  /** On paper: visible, focusable, and the owner of the message-level keys. Off paper it is only laying itself out. */
  readonly paper: boolean;
  readonly ui: ReaderUi;
  readonly dispatch: (event: UiEvent) => void;
  readonly controls: LetterControls;
  /** The card treatment: 'a' (the default) is the email card with nothing above it (owner sketch 2026-11-10); 'off' keeps DESIGN 7.5's column, with the big summary on top. */
  readonly cards?: 'a' | 'off';
  /** The reader's own letters answer the pane header's ⋯ and the . key; one by one (which has its own menu) does not. */
  readonly topBarMore?: boolean;
  /** The letter's body is laid out and measured (or it is gone or failed, which is an answer too). */
  readonly onReady: (threadId: string) => void;
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? 'message' : 'messages'}`;
}

const NO_HANDLERS: CommandHandlerTable = {};
const ID_SEPARATOR = '\u0000';

function run(action: () => void) {
  return { run: () => action() };
}

/**
 * O, ⌘F and ↑/↓: the keys of the letter on paper; an off-paper letter registers none. O folds or opens the card the
 * cursor is on when that is an earlier message; on the latest message (the cursor's home) it shows the quoted text.
 */
function useMessageKeys(
  paper: boolean,
  messages: readonly Message[],
  ui: ReaderUi,
  dispatch: (event: UiEvent) => void,
): void {
  const earlierKey = messages
    .slice(0, -1)
    .map(m => m.id)
    .join(ID_SEPARATOR);
  const latestId = messages[messages.length - 1]?.id ?? null;
  const cursor = ui.cursor;
  const table = useMemo<CommandHandlerTable>(() => {
    if (!paper) return NO_HANDLERS;
    const earlierIds = earlierKey ? earlierKey.split(ID_SEPARATOR) : [];
    const ids = walkableIds(earlierIds, latestId);
    const move = (dir: 'next' | 'previous') => dispatch({ type: 'moveCursor', ids, dir });
    const expand = () => dispatch(expandEvent(cursor, earlierIds));
    return {
      'reader.expand': run(expand),
      'reader.find': run(() => dispatch({ type: 'openFind' })),
      'reader.nextMessage': run(() => move('next')),
      'reader.previousMessage': run(() => move('previous')),
    };
  }, [paper, dispatch, earlierKey, latestId, cursor]);
  useRegisterCommands(table);
}

function useReadiness(
  data: LetterData,
  threadId: string,
  onReady: (id: string) => void,
): (messageId: string, ready: MailFrameReady) => void {
  const latestId = data.messages[data.messages.length - 1]?.id;
  const [framed, setFramed] = useState<string | null>(null);
  const bodyFailed = useMessageBody(latestId).status === 'failed';
  const answered = data.status === 'missing' || data.status === 'failed';
  const laidOut = data.status === 'ready' && (framed === latestId || bodyFailed);
  useEffect(() => {
    if (answered || laidOut) onReady(threadId);
  }, [answered, laidOut, onReady, threadId]);
  return (messageId, ready) => {
    if (ready.height > 0) setFramed(messageId);
  };
}

interface BodyProps extends ReaderLetterProps {
  readonly data: LetterData;
  readonly onFrame: (messageId: string, ready: MailFrameReady) => void;
  readonly onRetry: () => void;
}

interface ReplyAreaProps {
  readonly threadId: string;
  readonly messageId: string;
  readonly ui: ReaderUi;
  readonly dispatch: (event: UiEvent) => void;
  readonly controls: LetterControls;
}

/** The Reply stub, or (once asked for) the composer's inline reply in its place. */
function ReplyArea({
  threadId,
  messageId,
  ui,
  dispatch,
  controls,
  stub,
}: ReplyAreaProps & { readonly stub: ReactNode }) {
  const request = ui.reply;
  const replyAll = request?.replyAll ?? false;
  const { popOut } = controls;
  const onClose = useCallback(() => dispatch({ type: 'closeReply' }), [dispatch]);
  const onOpenChange = useCallback(
    (open: boolean) => dispatch({ type: 'replyOpen', open }),
    [dispatch],
  );
  const onPopOut = useCallback(
    (draftId: string | null) => popOut?.({ draftId, threadId, messageId, replyAll }),
    [popOut, threadId, messageId, replyAll],
  );
  if (!request) return stub;
  return (
    <InlineReplyHost
      threadId={threadId}
      messageId={messageId}
      replyAll={request.replyAll}
      dictate={request.dictate}
      suggest={request.suggest}
      onClose={onClose}
      onOpenChange={onOpenChange}
      onPopOut={popOut ? onPopOut : undefined}
    />
  );
}

/** The thread's invitation (`eventId`) and the message that carries it: the invite's own, else the latest. */
function useInvite(
  row: ThreadRow,
  messages: readonly Message[],
  me: ReadonlySet<string>,
): { readonly messageId: string; readonly view: InviteView } | null {
  const event = useRow('Event', row.eventId);
  const latest = messages[messages.length - 1];
  if (!event || !latest) return null;
  const carrier = messages.find(m => m.id === event.invite?.messageId) ?? latest;
  return { messageId: carrier.id, view: inviteOf(event, me, row.subject) };
}

/** The bar says plain "Reply" for the follow-up suggestion (a nudge is drafted once the reply opens, not before). */
function barSuggestion(suggestion: SuggestedAction): SuggestedAction {
  return suggestion.verb === FOLLOW_UP_VERB ? { ...suggestion, verb: 'Reply' } : suggestion;
}

function Thread(props: BodyProps & { readonly row: NonNullable<LetterData['row']> }) {
  const { row, data, ui, dispatch, controls } = props;
  const accounts = useAccounts();
  const me = myAddresses(row, accounts);
  const invite = useInvite(row, data.messages, me);
  const earlier = data.messages.slice(0, -1);
  const latest = data.messages[data.messages.length - 1];
  if (!latest) return null;
  // Rendered on and off paper alike, so the measured letter is the one that is promoted (no jump).
  const offers = <EventOffers row={row} hasInvite={invite !== null} />;
  const message = (m: Message, cursor: boolean) => (
    <ReaderMessage
      key={m.id}
      message={m}
      me={me}
      cursor={cursor}
      expanded={ui.expanded}
      fold={
        m.id === latest.id
          ? undefined
          : {
              open: ui.opened.includes(m.id),
              onToggle: () => dispatch({ type: 'toggleMessage', id: m.id }),
              onFocus: () => dispatch({ type: 'focusMessage', id: m.id }),
            }
      }
      headActions={
        m.id === latest.id ? (
          <HeadActions
            row={row}
            message={m}
            suggestion={barSuggestion(suggestionFor(row))}
            controls={controls}
            topBarMore={props.paper && props.topBarMore}
          />
        ) : undefined
      }
      invite={invite?.messageId === m.id ? invite.view : undefined}
      imagesLoaded={ui.imagesLoaded.includes(m.id)}
      findQuery={props.paper ? (ui.find ?? undefined) : undefined}
      loadingLabel={loadingLabel(row) ?? undefined}
      onFrame={props.onFrame}
      onLoadImages={id => dispatch({ type: 'loadImages', id })}
      onKey={controls.relayKey}
    />
  );
  return (
    <>
      {props.paper && ui.find !== null ? (
        <FindBar
          query={ui.find}
          focusKey={ui.findFocus}
          onChange={query => dispatch({ type: 'setFind', query })}
          onClose={() => dispatch({ type: 'closeFind' })}
        />
      ) : null}
      {props.cards === 'off' ? <ReaderHead due={dueOf(row)} summary={summaryFor(row)} /> : null}
      {offers && props.cards === 'off' ? offers : null}
      <section className="aplos-reader__thread" aria-label={countLabel(data.messages.length)}>
        {/* The messages without the reply: a layout hook for the cards (reader.css `data-cards`). */}
        <div className="aplos-reader__messages">
          {earlier.map(m => message(m, ui.cursor === m.id))}
          {message(latest, ui.cursor === latest.id)}
        </div>
        {/* The card has nothing above it (owner sketch 2026-11-10): its offers sit under it; the card-less column keeps them under the summary. */}
        {offers && props.cards !== 'off' ? offers : null}
        <ReplyArea
          threadId={props.threadId}
          messageId={latest.id}
          ui={ui}
          dispatch={dispatch}
          controls={controls}
          stub={
            <ReplyStub
              recipientName={replyName(latest, me)}
              commandId="mail.reply"
              onOpen={controls.reply}
            />
          }
        />
      </section>
      {props.paper ? (
        <ReaderActions
          suggestion={barSuggestion(suggestionFor(row))}
          commands={TRIAGE_COMMANDS}
          demoted={ui.replyOpen}
          onSuggestion={controls.suggest}
          onLater={controls.later}
          onDone={controls.done}
        />
      ) : null}
    </>
  );
}

/**
 * A letter on paper whose messages have not come yet (opened from search, or the next one after Done): the sender and
 * the subject at once, and the quiet loading line in place of the body, so the screen is never blank and the keys act
 * on the thread the header names.
 */
function LoadingHead({ row }: { readonly row: ThreadRow }) {
  return (
    <header className="aplos-reader__pending">
      <h2 className="aplos-reader__pending-subject">{subjectOf(row)}</h2>
      <p className="aplos-reader__pending-from">{senderOf(row)}</p>
      <LoadingLine label={loadingLabel(row) ?? 'Loading this email…'} />
    </header>
  );
}

function Contents(props: BodyProps): ReactNode {
  const { data } = props;
  const row = data.row;
  if (props.paper && data.status === 'loading' && data.messages.length === 0 && row)
    return <LoadingHead row={row} />;
  if (data.status === 'missing') return <EmptyLine placement="pane" icon="mail" text={GONE_COPY} />;
  if (data.status === 'failed')
    return <ErrorLine kind="bodyFailed" placement="column" onAction={props.onRetry} />;
  return row ? <Thread {...props} row={row} /> : null;
}

function LetterBody(props: ReaderLetterProps & { readonly onRetry: () => void }) {
  const { threadId, paper, ui, dispatch, onReady } = props;
  const data = useLetterData(threadId);
  const onFrame = useReadiness(data, threadId, onReady);
  useMessageKeys(paper, data.messages, ui, dispatch);
  useEffect(() => {
    // The reader opened this thread: the engine completes a partial row and keeps its bodies (once per open).
    api.thread.open({ threadId }).catch(() => undefined);
  }, [threadId]);
  useMarkReadOnPaper(paper, threadId, data.row?.unread === true);
  return <Contents {...props} data={data} onFrame={onFrame} />;
}

/**
 * Opening a thread reads it, as in Gmail: the letter that comes on paper marks its thread read once. It is a quiet write
 * (not on the undo stack, so Z still undoes the owner's own last action), and only once per letter, so a thread the owner
 * marks unread while it is open is not read again behind their back.
 */
function useMarkReadOnPaper(paper: boolean, threadId: string, unread: boolean): void {
  const done = useRef(false);
  useEffect(() => {
    if (!paper || !unread || done.current) return;
    done.current = true;
    api.thread
      .act({ ids: [threadId], action: { type: 'read' }, quiet: true })
      .receipt.catch(() => undefined);
  }, [paper, unread, threadId]);
}

/** One letter, on paper or laying itself out off paper. */
export function ReaderLetter(props: ReaderLetterProps) {
  const [attempt, setAttempt] = useState(0);
  return (
    <div
      className="aplos-reader__letter"
      data-paper={props.paper ? 'true' : 'false'}
      data-thread={props.threadId}
      aria-hidden={props.paper ? undefined : true}
      inert={!props.paper}
    >
      <LetterBody key={attempt} {...props} onRetry={() => setAttempt(n => n + 1)} />
    </div>
  );
}
