/**
 * One letter of the reader (DESIGN 7.5): the thread's four parts in order inside one 640 px column with no card and
 * nothing beside it: the sender line, the big summary, the one action row, then the thread (the dim subject line,
 * the earlier messages in one line, the messages, the Reply stub). A letter is mounted either on paper or off it: the
 * wanted letter lays itself out off paper and tells the reader when it is measured, and only then does it replace the
 * letter on paper (the no-blank-sheet double buffer, `letterController`).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  api,
  toIsoDateTime,
  useAccounts,
  useMessageBody,
  useRow,
  type Account,
  type Message,
  type ThreadRow,
} from '../../data';
import type { MailFrameKey, MailFrameReady } from '../../mailframe';
import { useRegisterCommands, type CommandHandlerTable } from '../../shell';
import { EmptyLine, ErrorLine } from '../../ui/list';
import { EarlierMessages, ReaderHead, ReplyStub } from '../../ui/reader';
import { InlineReplyHost } from '../compose';
import { FindBar } from './FindBar';
import { inviteOf, type InviteView } from './invite';
import { ReaderMessage } from './ReaderMessage';
import {
  collapsedOf,
  dueOf,
  loadingLabel,
  myAddresses,
  participantsOf,
  recipientsLabel,
  replyName,
  senderInfo,
  subjectLine,
  suggestionFor,
  summaryFor,
} from './readerRows';
import { walkableIds, type ReaderUi, type UiEvent } from './readerUi';
import { useLetterData, type LetterData } from './useLetterData';

export const GONE_COPY = 'This email is no longer here.';

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
export interface LetterControls {
  readonly suggest: () => void;
  readonly later: () => void;
  readonly done: () => void;
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
  /** The letter's body is laid out and measured (or it is gone or failed, which is an answer too). */
  readonly onReady: (threadId: string) => void;
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? 'message' : 'messages'}`;
}

function accountLabelOf(accounts: readonly Account[], accountId: string): string {
  const account = accounts.find(a => a.id === accountId);
  return account?.name || account?.address || '';
}

const NO_HANDLERS: CommandHandlerTable = {};
const ID_SEPARATOR = '\u0000';

function run(action: () => void) {
  return { run: () => action() };
}

/** O, ⌘F and ↑/↓: the keys of the letter on paper; an off-paper letter registers none. */
function useMessageKeys(
  paper: boolean,
  messages: readonly Message[],
  ui: ReaderUi,
  dispatch: (event: UiEvent) => void,
): void {
  const earlierIds = messages.slice(0, -1).map(m => m.id);
  const latestId = messages[messages.length - 1]?.id ?? null;
  const walk = walkableIds(earlierIds, ui.expanded, latestId).join(ID_SEPARATOR);
  const hasEarlier = earlierIds.length > 0;
  const table = useMemo<CommandHandlerTable>(() => {
    if (!paper) return NO_HANDLERS;
    const ids = walk ? walk.split(ID_SEPARATOR) : [];
    const move = (dir: 'next' | 'previous') => dispatch({ type: 'moveCursor', ids, dir });
    const expand = () => {
      if (hasEarlier) dispatch({ type: 'toggleExpanded' });
    };
    return {
      'reader.expand': run(expand),
      'reader.find': run(() => dispatch({ type: 'openFind' })),
      'reader.nextMessage': run(() => move('next')),
      'reader.previousMessage': run(() => move('previous')),
    };
  }, [paper, dispatch, walk, hasEarlier]);
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

function Thread(props: BodyProps & { readonly row: NonNullable<LetterData['row']> }) {
  const { row, data, ui, dispatch, controls } = props;
  const accounts = useAccounts();
  const me = myAddresses(row, accounts);
  const invite = useInvite(row, data.messages, me);
  const earlier = data.messages.slice(0, -1);
  const latest = data.messages[data.messages.length - 1];
  if (!latest) return null;
  const message = (m: Message, cursor: boolean) => (
    <ReaderMessage
      key={m.id}
      message={m}
      me={me}
      cursor={cursor}
      expanded={ui.expanded}
      invite={invite?.messageId === m.id ? invite.view : undefined}
      imagesLoaded={ui.imagesLoaded.includes(m.id)}
      findQuery={props.paper ? (ui.find ?? undefined) : undefined}
      loadingLabel={loadingLabel(row) ?? undefined}
      onFrame={props.onFrame}
      onLoadImages={id => dispatch({ type: 'loadImages', id })}
      onKey={controls.relayKey}
    />
  );
  const head = (
    <ReaderHead
      sender={senderInfo(latest, me, accountLabelOf(accounts, row.accountId))}
      recipientsLabel={recipientsLabel(latest, me)}
      due={dueOf(row)}
      date={toIsoDateTime(latest.date)}
      summary={summaryFor(row)}
      suggestion={suggestionFor(row)}
      commands={TRIAGE_COMMANDS}
      demoted={ui.replyOpen}
      onSuggestion={controls.suggest}
      onLater={controls.later}
      onDone={controls.done}
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
      {head}
      <section className="aplos-reader__thread" aria-label={countLabel(data.messages.length)}>
        {/* The messages without the reply: a layout hook for the card options (reader.css `data-cards`). */}
        <div className="aplos-reader__messages">
          <h2 className="aplos-reader__subject">{subjectLine(row, data.messages.length)}</h2>
          <EarlierMessages
            count={earlier.length}
            participants={participantsOf(earlier, me)}
            expanded={ui.expanded}
            messages={earlier.map(m => collapsedOf(m, me))}
            cursorId={ui.cursor ?? undefined}
            commandId="reader.expand"
            onToggle={() => dispatch({ type: 'toggleExpanded' })}
            onOpenMessage={id => dispatch({ type: 'openMessage', id })}
          />
          {earlier.filter(m => ui.opened.includes(m.id)).map(m => message(m, ui.cursor === m.id))}
          {message(latest, ui.cursor === null || ui.cursor === latest.id)}
        </div>
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
    </>
  );
}

function Contents(props: BodyProps): ReactNode {
  const { data } = props;
  const row = data.row;
  if (data.status === 'missing') return <EmptyLine text={GONE_COPY} />;
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
  return <Contents {...props} data={data} onFrame={onFrame} />;
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
