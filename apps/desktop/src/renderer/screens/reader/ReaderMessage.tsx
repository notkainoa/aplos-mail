/**
 * One message of the thread: `ThreadMessage` around the `MailFrame` body, with the dim "N trackers removed" line, the
 * blocked-images notice and the attachment chips (DESIGN 7.5). The frame reports its height and tracker count once per
 * letter; the latest message's report tells the reader its letter is laid out.
 */
import { useState } from 'react';
import { toIsoDateTime, useMessageBody, type Message } from '../../data';
import { MailFrame, type MailFrameKey, type MailFrameReady } from '../../mailframe';
import { ThreadMessage } from '../../ui/reader';
import { allowImagesFrom, fetchAttachment } from './readerEffects';
import { attachmentChips, fromName, toLabel, trackersLine, type DownloadState } from './readerRows';

/** Props for `ReaderMessage`. */
export interface ReaderMessageProps {
  readonly message: Message;
  readonly me: ReadonlySet<string>;
  /** The ↑/↓ rail is on this message. */
  readonly cursor: boolean;
  /** Remote images were loaded for this message in this reading. */
  readonly imagesLoaded: boolean;
  readonly findQuery?: string;
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

export function ReaderMessage(props: ReaderMessageProps) {
  const { message, me, imagesLoaded, onFrame } = props;
  const body = useMessageBody(message.id);
  const [blocked, setBlocked] = useState(0);
  const chips = useDownloads(message);
  const policy = imagesLoaded ? 'load' : 'block';
  const hasImages = body.body?.hasRemoteImages === true;
  const trackers = trackersLine(blocked);
  const frame = (
    <>
      <MailFrame
        messageId={message.id}
        imagePolicy={policy}
        findQuery={props.findQuery}
        onReady={ready => {
          setBlocked(ready.blocked);
          onFrame(message.id, ready);
        }}
        onKey={props.onKey}
      />
      {trackers ? <p className="aplos-reader__trackers">{trackers}</p> : null}
    </>
  );
  return (
    <ThreadMessage
      id={message.id}
      from={fromName(message, me)}
      toLabel={toLabel(message, me)}
      date={toIsoDateTime(message.date)}
      cursor={props.cursor}
      body={frame}
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
