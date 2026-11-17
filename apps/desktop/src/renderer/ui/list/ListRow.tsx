// ListRow (DESIGN §4.1 Rows, §4.4, §5 rules 11 and 17, §6, §7.2–7.4). Mockups: home.html, inbox.html,
// later.html, done.html, search.html, errors.html (row-error).
// Fixed height per density, no avatar. Read: 400 --ink-2 sender, --dim line. Unread: 600 --ink sender,
// --ink-2 line; no dots on a row (owner decision 2026-11-13). Cursor: --puck plus a 2 px accent bar on the leading edge. Picked:
// --accent-wash. Hover actions overlay the date column (or sit left of the Done stamp) and never reflow.

import type { CSSProperties, ReactNode, Ref } from 'react';
import type { CommitKind, IconName, ListRowProps } from '../props';
import { Chip } from './Chip';
import { ErrorLine } from './ErrorLine';
import { Action } from './internal/Action';
import { formatFull, formatListDate, sameDay } from './internal/format';
import { Icon } from './internal/Icon';
import { useKeycapFor, useTooltipText } from './internal/keys';

const COMMIT_WORD: Record<CommitKind, string> = { done: 'Done', later: 'Later', trash: 'Trash' };
const COMMIT_ICON: Record<CommitKind, IconName> = { done: 'check', later: 'clock', trash: 'trash' };

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Bold the search terms (search.html); case-insensitive, never changes the text. */
function highlighted(text: string, terms: readonly string[] | undefined): ReactNode {
  const words = (terms ?? []).map(t => t.trim()).filter(t => t.length > 0);
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

type RowProps = ListRowProps;

/**
 * The Done stamp column: the date it was finished, like every other list's date column, behind a quiet hill-coloured
 * check that is named "Done". With no date at all only the check shows.
 */
function DoneStamp({
  doneAt,
  estimated,
}: {
  doneAt: RowProps['doneAt'];
  estimated: RowProps['doneEstimated'];
}) {
  // Only a reported finish time may say "Done"; the fallback date is the last message's.
  const title = doneAt
    ? estimated
      ? formatFull(doneAt)
      : `Done ${formatFull(doneAt)}`
    : undefined;
  return (
    <span className="ui-list-row__stamp" title={title}>
      <span role="img" aria-label="Done" className="ui-list-row__stamp-mark">
        <Icon name="check" size="sm" />
      </span>
      {doneAt ? <time dateTime={doneAt}>{formatListDate(doneAt)}</time> : null}
    </span>
  );
}

/** The Done stamp, the Later-until chip or the date, whichever the layout puts in the date column. */
function DateColumn({
  layout,
  date,
  doneAt,
  doneEstimated,
  laterUntil,
  hideReturn,
}: Pick<RowProps, 'layout' | 'date' | 'doneAt' | 'doneEstimated' | 'laterUntil'> & {
  /** The row's due chip already says the day it comes back. */
  hideReturn?: boolean;
}) {
  if (layout === 'done') return <DoneStamp doneAt={doneAt} estimated={doneEstimated} />;
  if (layout === 'later' && hideReturn) return null;
  if (layout === 'later' && laterUntil) return <Chip kind="laterUntil" until={laterUntil} />;
  return (
    <time className="ui-list-row__date" dateTime={date} title={formatFull(date)}>
      {formatListDate(date)}
    </time>
  );
}

/** The two swipe underlays, right then left; hidden until the swipe starts. */
function Underlays({ swipe }: { swipe: NonNullable<RowProps['swipe']> }) {
  return (
    <>
      {(['right', 'left'] as const).map(side => (
        <span
          key={side}
          className="ui-list-row__underlay"
          data-side={side}
          data-kind={swipe[side]}
          aria-hidden="true"
          hidden
        >
          <Icon name={COMMIT_ICON[swipe[side]]} />
          {COMMIT_WORD[swipe[side]]}
        </span>
      ))}
    </>
  );
}

/** The sentence: a rejected write's error line, or the due chip, the primary text and the secondary text. */
function RowLine({
  rejected,
  due,
  tag,
  primary,
  secondary,
  highlight,
}: Pick<RowProps, 'rejected' | 'due' | 'tag' | 'primary' | 'secondary' | 'highlight'>) {
  return (
    <span className="ui-list-row__line">
      {rejected ? (
        <ErrorLine
          kind="writeRejected"
          op={rejected.op}
          placement="row"
          onAction={() => rejected.onRetry()}
        />
      ) : (
        <>
          {due ? (
            <span className="ui-list-row__due">
              <Chip kind="due" due={due} format="short" />
            </span>
          ) : null}
          {tag ? <span className="ui-list-row__tag">{tag}</span> : null}
          <span
            className="ui-list-row__primary"
            dir="auto"
            data-has-secondary={secondary ? 'true' : undefined}
          >
            {highlighted(primary, highlight)}
          </span>
          {secondary ? (
            <span className="ui-list-row__secondary" dir="auto">
              {highlighted(secondary, highlight)}
            </span>
          ) : null}
        </>
      )}
    </span>
  );
}

const MARKS = [
  { key: 'replied', title: 'Replied', icon: 'reply', word: 'Replied.' },
  { key: 'bookmarked', title: 'Bookmarked', icon: 'bookmark', word: 'Bookmarked.' },
  { key: 'attachment', title: 'Has attachments', icon: 'paperclip', word: 'Has attachments.' },
] as const;

/** Replied, bookmarked and attachment marks, in that order, each only when set. */
function RowMarks({ marks }: Pick<RowProps, 'marks'>) {
  return (
    <>
      {MARKS.map(({ key, title, icon, word }) =>
        marks?.[key] ? (
          <span key={key} className="ui-list-row__mark" title={title}>
            <Icon name={icon} size="sm" />
            <span className="ui-list-sr">{word}</span>
          </span>
        ) : null,
      )}
    </>
  );
}

/** One hover icon button; its hint cap comes from the shell's registry when mounted (→ on Home, E elsewhere). */
function HoverAction({
  action,
  onAction,
}: {
  action: RowProps['hoverActions'][number];
  onAction: NonNullable<RowProps['onAction']>;
}) {
  const tip = useTooltipText();
  const key = useKeycapFor(action.commandId);
  return (
    <Action
      variant="icon"
      size="sm"
      label={action.label}
      icon={action.icon}
      tooltip={tip(action.label, action.commandId)}
      hintKey={key}
      duplicate
      onPress={anchor => onAction(action.commandId, anchor)}
    />
  );
}

/** The hover actions: an overlay inside the meta cell, so it always covers the whole date column. */
function HoverActions({
  actions,
  onAction,
}: {
  actions: RowProps['hoverActions'];
  onAction: RowProps['onAction'];
}) {
  return (
    <span className="ui-list-row__actions">
      <span className="ui-list-row__actions-fill">
        {actions.map(action => (
          <HoverAction key={action.commandId} action={action} onAction={onAction} />
        ))}
      </span>
    </span>
  );
}

/** A mail row in any list: Home, Later, All mail, Done, Drafts, Sent, Trash, Spam, search, the Low sheet. */
export function ListRow(props: ListRowProps) {
  const { id, layout, density, sender, account, unread, cursor, picked } = props;
  const { picking, hoverActions, swipe, rejected, lifted, onSelect, onOpen, onAction, ref } = props;

  // An overdue Later row says so once: the Later-until chip in the date column. The due chip before the summary
  // would be a second red time ("Yesterday" beside "Today, 8:00 AM").
  const laterOverdue =
    layout === 'later' && props.laterUntil?.kind === 'at' && props.laterUntil.overdue;

  // One statement per meaning: a deadline chip and a return chip for the same day ("Due today" beside "Today,
  // 11:59 PM") say it twice, so the deadline stays and the return, which only repeats it, goes.
  const returnsOnDeadline =
    layout === 'later' &&
    !laterOverdue &&
    props.due !== undefined &&
    props.laterUntil?.kind === 'at' &&
    sameDay(props.due.at, props.laterUntil.at);

  // The action count sizes the date column so the hover overlay never spills over the line (DESIGN §5 rule 17).
  const rowStyle =
    hoverActions.length > 0
      ? ({ '--ui-actions': hoverActions.length } as CSSProperties)
      : undefined;

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
      style={rowStyle}
      onClick={onSelect}
      onDoubleClick={onOpen}
    >
      {swipe ? <Underlays swipe={swipe} /> : null}

      <span className="ui-list-row__lead" aria-hidden="true">
        {picking ? (
          <span className="ui-list-row__pick">
            {picked ? <Icon name="check" size="xs" /> : null}
          </span>
        ) : null}
      </span>
      {unread ? <span className="ui-list-sr">Unread. </span> : null}

      <span className="ui-list-row__sender" dir="auto" title={props.senderTitle ?? sender}>
        {sender}
      </span>

      <RowLine
        rejected={rejected}
        due={laterOverdue ? undefined : props.due}
        tag={props.tag}
        primary={props.primary}
        secondary={props.secondary}
        highlight={props.highlight}
      />

      <span className="ui-list-row__meta">
        <RowMarks marks={props.marks} />
        <DateColumn
          layout={layout}
          date={props.date}
          doneAt={props.doneAt}
          doneEstimated={props.doneEstimated}
          laterUntil={props.laterUntil}
          hideReturn={returnsOnDeadline}
        />
        {/* Inside the meta cell so the overlay always covers the whole date column: no half glyph or chip. */}
        {hoverActions.length > 0 ? (
          <HoverActions actions={hoverActions} onAction={onAction} />
        ) : null}
      </span>
    </div>
  );
}
