// ListRow (DESIGN §4.1 Rows, §4.4, §5 rules 11 and 17, §6, §7.2–7.4). Mockups: home.html, inbox.html,
// later.html, done.html, search.html, errors.html (row-error).
// Fixed height per density, no avatar. Read: 400 --ink-2 sender, --dim line. Unread: 600 --ink sender,
// --ink-2 line, the 6 px accent dot. Cursor: --puck plus a 2 px accent bar on the leading edge. Picked:
// --accent-wash. Hover actions overlay the date column (or sit left of the Done stamp) and never reflow.

import type { CSSProperties, ReactNode, Ref } from 'react';
import type { CommitKind, IconName, ListRowProps } from '../props';
import { Chip } from './Chip';
import { ErrorLine } from './ErrorLine';
import { Action } from './internal/Action';
import { formatDoneStamp, formatFull, formatListDate } from './internal/format';
import { Icon } from './internal/Icon';
import { tooltipText } from './internal/keys';

const COMMIT_WORD: Record<CommitKind, string> = { done: 'Done', later: 'Later', trash: 'Trash' };
const COMMIT_ICON: Record<CommitKind, IconName> = { done: 'check', later: 'clock', trash: 'trash' };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Bold the search terms (search.html); case-insensitive, never changes the text. */
function highlighted(text: string, terms: readonly string[] | undefined): ReactNode {
  const words = (terms ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
  if (words.length === 0) return text;
  const pattern = new RegExp(`(${words.map(escapeRegExp).join('|')})`, 'gi');
  return text.split(pattern).map((part, i) =>
    i % 2 === 1 ? (
      <b key={i} className="ui-list-row__hit">
        {part}
      </b>
    ) : (
      part
    ),
  );
}

/** A mail row in any list: Home, Later, All mail, Done, Drafts, Sent, Trash, Spam, search, the Low sheet. */
export function ListRow(props: ListRowProps) {
  const {
    id,
    layout,
    density,
    sender,
    primary,
    secondary,
    highlight,
    unread,
    date,
    due,
    laterUntil,
    doneAt,
    marks,
    account,
    showAccountDot,
    cursor,
    picked,
    picking,
    hoverActions,
    swipe,
    rejected,
    lifted,
    onSelect,
    onOpen,
    onAction,
    ref,
  } = props;

  const dateColumn =
    layout === 'done' ? (
      <span className="ui-list-row__stamp" title={doneAt ? formatFull(doneAt) : undefined}>
        <Icon name="check" size="sm" />
        {doneAt ? formatDoneStamp(doneAt) : 'Done'}
      </span>
    ) : layout === 'later' && laterUntil ? (
      <Chip kind="laterUntil" until={laterUntil} />
    ) : (
      <time className="ui-list-row__date" dateTime={date} title={formatFull(date)}>
        {formatListDate(date)}
      </time>
    );

  const accountStyle = account && showAccountDot ? ({ '--swatch': `var(--tag-${account.color})` } as CSSProperties) : undefined;

  return (
    <div
      ref={ref as Ref<HTMLDivElement>}
      id={id}
      role="option"
      aria-selected={picking ? picked : cursor}
      className="ui-list-row"
      data-layout={layout}
      data-density={density}
      data-unread={unread ? 'true' : undefined}
      data-cursor={cursor ? 'true' : undefined}
      data-picked={picked ? 'true' : undefined}
      data-picking={picking ? 'true' : undefined}
      data-lifted={lifted ? 'true' : undefined}
      data-state={rejected ? 'rejected' : undefined}
      title={account ? account.label : undefined}
      onClick={onSelect}
      onDoubleClick={onOpen}
    >
      {swipe ? (
        <>
          <span className="ui-list-row__underlay" data-side="right" data-kind={swipe.right} aria-hidden="true" hidden>
            <Icon name={COMMIT_ICON[swipe.right]} />
            {COMMIT_WORD[swipe.right]}
          </span>
          <span className="ui-list-row__underlay" data-side="left" data-kind={swipe.left} aria-hidden="true" hidden>
            <Icon name={COMMIT_ICON[swipe.left]} />
            {COMMIT_WORD[swipe.left]}
          </span>
        </>
      ) : null}

      <span className="ui-list-row__lead" aria-hidden="true">
        {picking ? (
          <span className="ui-list-row__pick">{picked ? <Icon name="check" size="xs" /> : null}</span>
        ) : (
          <span className="ui-list-row__dot" />
        )}
      </span>
      {unread ? <span className="ui-list-sr">Unread. </span> : null}

      <span className="ui-list-row__sender">{sender}</span>

      <span className="ui-list-row__line">
        {rejected ? (
          <ErrorLine kind="writeRejected" op={rejected.op} placement="row" onAction={() => rejected.onRetry()} />
        ) : (
          <>
            {due ? <Chip kind="due" due={due} format="short" /> : null}
            <span className="ui-list-row__primary" data-has-secondary={secondary ? 'true' : undefined}>
              {highlighted(primary, highlight)}
            </span>
            {secondary ? <span className="ui-list-row__secondary">{highlighted(secondary, highlight)}</span> : null}
          </>
        )}
      </span>

      <span className="ui-list-row__meta">
        {marks?.replied ? (
          <span className="ui-list-row__mark" title="Replied">
            <Icon name="reply" size="sm" />
            <span className="ui-list-sr">Replied.</span>
          </span>
        ) : null}
        {marks?.bookmarked ? (
          <span className="ui-list-row__mark" title="Bookmarked">
            <Icon name="bookmark" size="sm" />
            <span className="ui-list-sr">Bookmarked.</span>
          </span>
        ) : null}
        {marks?.attachment ? (
          <span className="ui-list-row__mark" title="Has attachments">
            <Icon name="paperclip" size="sm" />
            <span className="ui-list-sr">Has attachments.</span>
          </span>
        ) : null}
        {accountStyle && account ? (
          <span className="ui-list-row__account" style={accountStyle}>
            <span className="ui-list-sr">{account.label}</span>
          </span>
        ) : null}
        {dateColumn}
      </span>

      {hoverActions.length > 0 ? (
        <span className="ui-list-row__actions">
          <span className="ui-list-row__actions-fill">
            {hoverActions.map((action) => (
              <Action
                key={action.commandId}
                variant="icon"
                size="sm"
                label={action.label}
                icon={action.icon}
                tooltip={tooltipText(action.label, action.commandId)}
                duplicate
                onPress={(anchor) => onAction(action.commandId, anchor)}
              />
            ))}
          </span>
        </span>
      ) : null}
    </div>
  );
}
