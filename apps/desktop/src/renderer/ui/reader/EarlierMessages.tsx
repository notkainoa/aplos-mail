// EarlierMessages (DESIGN §6, §7.5 item 4). Mockups: reader.html (earlier).
// Collapsed: one line, "3 earlier messages from Jordan, you and Mina", with the O keycap. O expands it into
// 36 px one-liners; the one thread cursor shows as a 2 px accent rail beside the line it is on.

import { useId } from 'react';
import type { EarlierMessagesProps } from '../props';
import { Keycap } from '../list/internal/Action';
import { formatCount, formatFull, formatListDate, joinNames } from '../list/internal/format';
import { Icon } from '../list/internal/Icon';
import { keycapFor, tooltipText } from '../list/internal/keys';

/** "3 earlier messages from Jordan, you and Mina". */
export function earlierLine(count: number, participants: readonly string[]): string {
  const noun = count === 1 ? 'earlier message' : 'earlier messages';
  const from = joinNames(participants);
  return from ? `${formatCount(count)} ${noun} from ${from}` : `${formatCount(count)} ${noun}`;
}

/** The earlier messages of a thread, collapsed or as one-liners. */
export function EarlierMessages({
  count,
  participants,
  expanded,
  messages,
  cursorId,
  commandId,
  onToggle,
  onOpenMessage,
}: EarlierMessagesProps) {
  const listId = useId();
  if (count <= 0) return null;
  const line = earlierLine(count, participants);
  return (
    <div className="ui-earlier-messages" data-state={expanded ? 'expanded' : 'collapsed'}>
      {expanded ? null : (
        <button
          type="button"
          className="ui-earlier-messages__toggle"
          aria-expanded={false}
          aria-controls={listId}
          title={tooltipText('Show earlier messages', commandId)}
          onClick={onToggle}
        >
          <Icon name="chevron-right" size="sm" />
          <span className="ui-earlier-messages__line">{line}</span>
          <Keycap chord={keycapFor(commandId)} />
        </button>
      )}
      <ul id={listId} className="ui-earlier-messages__list" aria-label={line} hidden={!expanded}>
        {expanded
          ? messages.map(message => (
              <li key={message.id} className="ui-earlier-messages__item">
                <button
                  type="button"
                  id={message.id}
                  className="ui-earlier-messages__message"
                  data-cursor={message.id === cursorId ? 'true' : undefined}
                  aria-current={message.id === cursorId ? 'true' : undefined}
                  onClick={() => onOpenMessage(message.id)}
                >
                  <span className="ui-earlier-messages__from" dir="auto">
                    {message.from}
                  </span>
                  <span className="ui-earlier-messages__preview" dir="auto">
                    {message.preview}
                  </span>
                  <time
                    className="ui-earlier-messages__date"
                    dateTime={message.date}
                    title={formatFull(message.date)}
                  >
                    {formatListDate(message.date)}
                  </time>
                </button>
              </li>
            ))
          : null}
      </ul>
    </div>
  );
}
