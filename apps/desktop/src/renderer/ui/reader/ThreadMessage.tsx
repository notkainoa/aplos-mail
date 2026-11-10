// ThreadMessage (DESIGN §7.5 item 4, HTML mail; §11.3). Mockups: reader.html, reply.html (sent), errors.html.
// One message as an `article` landmark: the header (who in `ui` 600, the dim "to" phrase, the time right),
// "Load images from this sender" when remote images are blocked, the `read` body at 64ch, quoted text on O,
// attachments, and the undo-send line under a message you just sent. The 2 px accent rail marks the cursor.
// An earlier message is a compact card (owner review 2026-11-03): its head is one button (`aria-expanded`) that holds the
// who, the time and, while folded, the plain-text first sentence or two; a click anywhere on a folded card (the button
// stretches over it), Enter, Space or O on it opens it to the full message. Once open, only the head is the target, so
// links, attachments and the body keep their own clicks.

import type { ReactNode, Ref } from 'react';
import type { ThreadMessageProps } from '../props';
import { Chip } from '../list/Chip';
import { Action } from '../list/internal/Action';
import { formatFull, formatMessageTime } from '../list/internal/format';
import { useTooltipText } from '../list/internal/keys';
import { UndoTray } from './UndoTray';

/** The excerpt's words when a message has no text to show (plain, dim, no exclamation mark). */
export const NO_PREVIEW = 'No preview';

function TimeText({ date }: { readonly date: string }) {
  return (
    <time className="ui-thread-message__when" dateTime={date} title={formatFull(date)}>
      {formatMessageTime(date)}
    </time>
  );
}

interface HeadLineProps {
  readonly fromId: string;
  readonly from: string;
  readonly date: string;
  readonly toLabel: string;
  /** The card layout: who, when, then the screen's "To"; `actions` take the right side. Else who, the dim phrase, when. */
  readonly recipients: ReactNode;
  readonly actions: ReactNode;
  /** The folded card's first sentence or two; absent while open. */
  readonly excerpt: string | undefined;
}

/** Who, when and (folded) the excerpt: the content of a message's head, which a fold wraps in its one button. */
function HeadLine({ fromId, from, date, toLabel, recipients, actions, excerpt }: HeadLineProps) {
  const card = recipients !== undefined || actions !== undefined;
  return (
    <>
      <span className="ui-thread-message__line" data-layout={card ? 'card' : undefined}>
        <span id={fromId} className="ui-thread-message__from" dir="auto">
          {from}
        </span>
        {card ? null : <span className="ui-thread-message__to">{toLabel}</span>}
        <TimeText date={date} />
        {recipients}
        {actions === undefined ? null : (
          <span className="ui-thread-message__actions">{actions}</span>
        )}
      </span>
      {excerpt === undefined ? null : (
        <span
          className="ui-thread-message__excerpt"
          dir="auto"
          data-empty={excerpt === '' ? 'true' : undefined}
        >
          {excerpt === '' ? NO_PREVIEW : excerpt}
        </span>
      )}
    </>
  );
}

/** A full message in the thread. */
export function ThreadMessage({
  id,
  from,
  toLabel,
  subject,
  recipients,
  headActions,
  date,
  cursor,
  body,
  fold,
  excerpt,
  attachments,
  remoteImages,
  quoted,
  undoTray,
  ref,
}: ThreadMessageProps) {
  const tip = useTooltipText();
  const fromId = `${id}-from`;
  const folded = fold !== undefined && !fold.open;
  const head = (
    <HeadLine
      fromId={fromId}
      from={from}
      date={date}
      toLabel={toLabel}
      recipients={fold ? undefined : recipients}
      actions={fold ? undefined : headActions}
      excerpt={folded ? excerpt : undefined}
    />
  );
  return (
    <article
      ref={ref as Ref<HTMLElement>}
      id={id}
      className="ui-thread-message"
      data-cursor={cursor ? 'true' : undefined}
      data-titled={subject ? 'true' : undefined}
      data-fold={fold ? (fold.open ? 'open' : 'folded') : undefined}
      aria-labelledby={fromId}
    >
      {subject ? (
        <h2 className="ui-thread-message__subject" dir="auto">
          {subject}
        </h2>
      ) : null}
      <header className="ui-thread-message__head">
        {fold ? (
          <button
            type="button"
            className="ui-thread-message__toggle"
            aria-expanded={fold.open}
            aria-controls={`${id}-content`}
            title={tip(fold.open ? 'Fold this message' : 'Open this message', fold.commandId)}
            onFocus={fold.onFocus}
            onClick={fold.onToggle}
          >
            {head}
          </button>
        ) : (
          head
        )}
      </header>

      {remoteImages?.blocked ? (
        <div className="ui-thread-message__images">
          <Action
            variant="text"
            size="sm"
            icon="eye"
            label="Load images from this sender"
            onPress={() => remoteImages.onLoad()}
          />
        </div>
      ) : null}

      {folded ? null : (
        <div className="ui-thread-message__body" id={`${id}-content`}>
          {body}
        </div>
      )}

      {quoted ? (
        <div className="ui-thread-message__quoted">
          <Action
            variant="text"
            size="sm"
            label={quoted.shown ? 'Hide quoted text' : 'Show quoted text'}
            tooltip={
              quoted.commandId
                ? tip(quoted.shown ? 'Hide quoted text' : 'Show quoted text', quoted.commandId)
                : undefined
            }
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
