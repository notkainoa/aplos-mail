// ThreadMessage (DESIGN §7.5 item 4, HTML mail; §11.3). Mockups: reader.html, reply.html (sent), errors.html.
// One message as an `article` landmark: the header (who in `ui` 600, the dim "to" phrase, the time right),
// "Load images from this sender" when remote images are blocked, the `read` body at 64ch, quoted text on O,
// attachments, and the undo-send line under a message you just sent. The 2 px accent rail marks the cursor.

import type { Ref } from 'react';
import type { ThreadMessageProps } from '../props';
import { Chip } from '../list/Chip';
import { Action } from '../list/internal/Action';
import { formatFull, formatMessageTime } from '../list/internal/format';
import { tooltipText } from '../list/internal/keys';
import { UndoTray } from './UndoTray';

/** A full message in the thread. */
export function ThreadMessage({ id, from, toLabel, date, cursor, body, attachments, remoteImages, quoted, undoTray, ref }: ThreadMessageProps) {
  const fromId = `${id}-from`;
  return (
    <article ref={ref as Ref<HTMLElement>} id={id} className="ui-thread-message" data-cursor={cursor ? 'true' : undefined} aria-labelledby={fromId}>
      <header className="ui-thread-message__head">
        <span id={fromId} className="ui-thread-message__from" dir="auto">
          {from}
        </span>
        <span className="ui-thread-message__to">{toLabel}</span>
        <time className="ui-thread-message__when" dateTime={date} title={formatFull(date)}>
          {formatMessageTime(date)}
        </time>
      </header>

      {remoteImages?.blocked ? (
        <div className="ui-thread-message__images">
          <Action variant="text" size="sm" icon="eye" label="Load images from this sender" onPress={() => remoteImages.onLoad()} />
        </div>
      ) : null}

      <div className="ui-thread-message__body">{body}</div>

      {quoted ? (
        <div className="ui-thread-message__quoted">
          <Action
            variant="text"
            size="sm"
            label={quoted.shown ? 'Hide quoted text' : 'Show quoted text'}
            tooltip={tooltipText(quoted.shown ? 'Hide quoted text' : 'Show quoted text', quoted.commandId)}
            expanded={quoted.shown}
            onPress={() => quoted.onToggle()}
          />
        </div>
      ) : null}

      {attachments && attachments.length > 0 ? (
        <div className="ui-thread-message__attachments" role="list" aria-label="Attachments">
          {attachments.map((attachment, i) => (
            <span key={`${attachment.name}-${i}`} role="listitem">
              <Chip {...attachment} />
            </span>
          ))}
        </div>
      ) : null}

      {undoTray ? <UndoTray {...undoTray} placement="thread" /> : null}
    </article>
  );
}
