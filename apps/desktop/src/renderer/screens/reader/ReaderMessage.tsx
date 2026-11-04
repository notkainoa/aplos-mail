/**
 * One message of the thread: `ThreadMessage` around the `MailFrame` body (an earlier message is a compact card with
 * its first sentence or two until it is opened; a click or O opens and folds it), with the dim "N trackers removed" line, the
 * blocked-images notice and the attachment chips (DESIGN 7.5). An invite email shows its invitation above the body; a
 * plain-text body keeps its quoted history behind "Show quoted text" (O shows it too). The frame reports its height
 * and tracker count once per letter; the latest message's report tells the reader its letter is laid out.
 */
import { useState } from 'react';
import { toIsoDateTime, useMessageBody, type Message, type MessageBody } from '../../data';
import {
  MailFrame,
  quotedRangesFor,
  type MailFrameKey,
  type MailFrameReady,
} from '../../mailframe';
import { ThreadMessage } from '../../ui/reader';
import type { InviteView } from './invite';
import { InviteCard } from './InviteCard';
import { allowImagesFrom, fetchAttachment } from './readerEffects';
import {
  attachmentChips,
  excerptOf,
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
  readonly fold?: { readonly open: boolean; readonly onToggle: () => void };
  /** The invitation this message carries (an invite email). */
  readonly invite?: InviteView;
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
  return quotedRangesFor(body.text, body.quoted).length > 0;
}

/** "Show quoted text": the message's own choice once made, else O's. */
function useQuoted(body: MessageBody | undefined, expanded: boolean) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const shown = chosen ?? expanded;
  if (!hasQuoted(body)) return { shown: false, toggle: undefined };
  return {
    shown,
    toggle: { shown, onToggle: () => setChosen(!shown), commandId: 'reader.expand' as const },
  };
}

const FOLD_COMMAND = 'reader.expand' as const;

/** A folded earlier message: who, when and the first sentence or two, from the message's snippet (no body is loaded). */
function FoldedMessage({ message, me, cursor, fold }: ReaderMessageProps) {
  return (
    <ThreadMessage
      id={message.id}
      from={fromName(message, me)}
      toLabel={toLabel(message, me)}
      date={toIsoDateTime(message.date)}
      cursor={cursor}
      fold={fold ? { ...fold, commandId: FOLD_COMMAND } : undefined}
      excerpt={excerptOf(message)}
    />
  );
}

/** The message in full (the latest one, or an earlier one that was opened). */
function FullMessage(props: ReaderMessageProps) {
  const { message, me, imagesLoaded, onFrame } = props;
  const body = useMessageBody(message.id);
  const [trackers, setTrackers] = useState<number | undefined>(undefined);
  const chips = useDownloads(message);
  const quoted = useQuoted(body.body, props.expanded ?? false);
  const policy = imagesLoaded ? 'load' : 'block';
  const hasImages = body.body?.hasRemoteImages === true;
  const trackersNote = trackersLine(trackers);
  const frame = (
    <>
      {props.invite ? <InviteCard invite={props.invite} /> : null}
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
    </>
  );
  return (
    <ThreadMessage
      id={message.id}
      from={fromName(message, me)}
      toLabel={toLabel(message, me)}
      date={toIsoDateTime(message.date)}
      cursor={props.cursor}
      fold={props.fold ? { ...props.fold, commandId: FOLD_COMMAND } : undefined}
      body={frame}
      quoted={quoted.toggle}
      attachments={chips}
      remoteImages={{
        blocked: hasImages && !imagesLoaded,
        onLoad: () => {
          allowImagesFrom(message);
          props.onLoadImages(message.id);
        },
      }}
    />
  );
}

/** One message of the thread: open in full, or (an earlier one) a compact card until it is opened. */
export function ReaderMessage(props: ReaderMessageProps) {
  if (props.fold && !props.fold.open) return <FoldedMessage {...props} />;
  return <FullMessage {...props} />;
}
