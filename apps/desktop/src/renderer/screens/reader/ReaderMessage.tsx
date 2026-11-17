/**
 * One message of the thread: `ThreadMessage` around the `MailFrame` body (an earlier message is a compact card with
 * its first sentence or two until it is opened; a click or O opens and folds it), with the dim "N trackers removed" line, the
 * blocked-images notice and the attachment chips (DESIGN 7.5). An invite email shows its invitation above the body; a
 * plain-text body keeps its quoted history behind "Show quoted text" (O shows it too). The frame reports its height
 * and tracker count once per letter; the latest message's report tells the reader its letter is laid out.
 */
import { useState, type ReactNode } from 'react';
import { toIsoDateTime, useMessageBody, type Message, type MessageBody } from '../../data';
import {
  MailFrame,
  foldsQuoted,
  quotedRangesFor,
  type MailFrameKey,
  type MailFrameReady,
} from '../../mailframe';
import { ThreadMessage } from '../../ui/reader';
import type { InviteView } from './invite';
import { InviteCard } from './InviteCard';
import { RecipientsLine } from './RecipientsLine';
import { SenderMark } from './SenderMark';
import { allowImagesFrom, fetchAttachment } from './readerEffects';
import {
  attachmentChips,
  excerptView,
  fromName,
  toLabel,
  trackersLine,
  type DownloadState,
} from './readerRows';

/** Props for `ReaderMessage`. */
export interface ReaderMessageProps {
  readonly message: Message;
  readonly me: ReadonlySet<string>;
  /** The ↑/↓ rail is on this message. */
  readonly cursor: boolean;
  /** Remote images were loaded for this message in this reading. */
  readonly imagesLoaded: boolean;
  readonly findQuery?: string;
  /** The frame's loading line: "Loading <subject>…". */
  readonly loadingLabel?: string;
  /** O is on (the cursor on the latest message): quoted text is shown. */
  readonly expanded?: boolean;
  /** An earlier message: a compact card that opens and folds. Absent: the latest message, always open. */
  readonly fold?: {
    readonly open: boolean;
    readonly onToggle: () => void;
    /** The toggle took keyboard focus: the cursor follows, so O acts on this card. */
    readonly onFocus?: () => void;
  };
  /** The invitation this message carries (an invite email). */
  readonly invite?: InviteView;
  /** The header's right side (Importance, bell, ⋯): the latest message's card only. */
  readonly headActions?: ReactNode;
  /** The frame is laid out and measured. */
  readonly onFrame: (messageId: string, ready: MailFrameReady) => void;
  readonly onLoadImages: (messageId: string) => void;
  readonly onKey: (key: MailFrameKey) => boolean;
}

function useDownloads(message: Message) {
  const [states, setStates] = useState<ReadonlyMap<string, DownloadState>>(new Map());
  const open = (attachmentId: string) =>
    fetchAttachment(message, attachmentId, state =>
      setStates(current => new Map(current).set(`${message.id}:${attachmentId}`, state)),
    );
  return attachmentChips(message, states, open);
}

/** A plain-text body with quoted history in it. */
function hasQuoted(body: MessageBody | undefined): boolean {
  if (!body || body.bodyKind !== 'text') return false;
  return foldsQuoted(body.text, quotedRangesFor(body.text, body.quoted));
}

/** "Show quoted text": the message's own choice once made, else O's (on the latest message, where O means it). */
function useQuoted(body: MessageBody | undefined, expanded: boolean, keyed: boolean) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const shown = chosen ?? expanded;
  if (!hasQuoted(body)) return { shown: false, toggle: undefined };
  return {
    shown,
    toggle: {
      shown,
      onToggle: () => setChosen(!shown),
      ...(keyed ? { commandId: 'reader.expand' as const } : {}),
    },
  };
}

/**
 * An invite email's own HTML repeats the invitation block above it (the same table, a second set of Yes/Maybe/No), so
 * the original stays laid out but hidden behind "Show original"; a find in the thread opens it. Other mail has no toggle.
 */
function useOriginal(invited: boolean, finding: boolean) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const shown = !invited || (chosen ?? finding);
  return {
    shown,
    toggle: invited ? { shown, onToggle: () => setChosen(!shown) } : undefined,
  };
}

const FOLD_COMMAND = 'reader.expand' as const;

/** The fold, with O's command: an earlier message folds and opens with a click, Enter, Space or O on its card. */
function foldOf(fold: ReaderMessageProps['fold'], complete: boolean) {
  return fold ? { ...fold, commandId: FOLD_COMMAND, complete } : undefined;
}

/**
 * One message of the thread, as one component whether it is folded or open, so the card's toggle button is the same node
 * through every fold and keeps keyboard focus. A folded earlier message shows who, when and the first sentence or two
 * from its snippet and fetches nothing; open (or the latest), it loads the body, the attachments and the notices.
 * O toggles quoted text only on the latest message: on a card it folds the card, so a card's own "Show quoted text"
 * button carries no key.
 */
export function ReaderMessage(props: ReaderMessageProps) {
  const { message, me, imagesLoaded, onFrame, fold } = props;
  const open = !fold || fold.open;
  const excerpt = open ? undefined : excerptView(message);
  const body = useMessageBody(open ? message.id : undefined);
  const [trackers, setTrackers] = useState<number | undefined>(undefined);
  const chips = useDownloads(message);
  const quoted = useQuoted(body.body, fold ? false : (props.expanded ?? false), !fold);
  const policy = imagesLoaded ? 'load' : 'block';
  const hasImages = body.body?.hasRemoteImages === true;
  const trackersNote = trackersLine(trackers);
  const original = useOriginal(
    props.invite !== undefined,
    props.findQuery !== undefined && props.findQuery !== '',
  );
  const frame = open ? (
    <>
      {props.invite ? <InviteCard invite={props.invite} /> : null}
      <div className="aplos-reader__original" hidden={!original.shown}>
        <MailFrame
          messageId={message.id}
          imagePolicy={policy}
          findQuery={props.findQuery}
          showQuoted={quoted.shown}
          label={props.loadingLabel}
          onReady={ready => {
            setTrackers(ready.trackers);
            onFrame(message.id, ready);
          }}
          onKey={props.onKey}
        />
        {trackersNote ? <p className="aplos-reader__trackers">{trackersNote}</p> : null}
      </div>
    </>
  ) : undefined;
  return (
    <ThreadMessage
      id={message.id}
      from={fromName(message, me)}
      toLabel={toLabel(message, me)}
      leading={<SenderMark message={message} me={me} />}
      recipients={<RecipientsLine message={message} me={me} />}
      headActions={fold ? undefined : props.headActions}
      date={toIsoDateTime(message.date)}
      cursor={props.cursor}
      fold={foldOf(fold, excerpt?.complete === true)}
      excerpt={excerpt?.text}
      body={frame}
      quoted={open && original.shown ? quoted.toggle : undefined}
      original={open ? original.toggle : undefined}
      attachments={open ? chips : undefined}
      remoteImages={
        open
          ? {
              blocked: hasImages && !imagesLoaded,
              present: hasImages,
              onLoad: () => {
                allowImagesFrom(message);
                props.onLoadImages(message.id);
              },
            }
          : undefined
      }
    />
  );
}
