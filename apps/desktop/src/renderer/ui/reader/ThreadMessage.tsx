// ThreadMessage (DESIGN §7.5 item 4, HTML mail; §11.3). Mockups: reader.html, reply.html (sent), errors.html.
// One message as an `article` landmark: the header (who in `ui` 600, the dim "to" phrase, the time right),
// "Load images from this sender" when remote images are blocked, the `read` body at 64ch, quoted text on O,
// attachments, and the undo-send line under a message you just sent. The 2 px accent rail marks the cursor.
// An earlier message is a compact card (owner review 2026-11-03; owner feedback 2026-11-11): its row shows who, when and the
// message's own first sentence or two (never an AI summary: those are per thread), with a visible "Show full" and a chevron
// at the right. The row's one `button` (`aria-expanded`) is that hint, stretched by a pseudo-element over the whole card, so a
// click anywhere on a folded card, Enter, Space or O opens the full message in place with the same header row (the sender's
// mark, the name, the time, the "To" circles) and the same button now reads "Show less". The button is one DOM node,
// last in the head, folded or open, so keyboard focus survives a fold; once open only it is the target, so links,
// attachments and the body keep their own clicks.

import type { ReactNode, Ref } from 'react';
import type { ThreadMessageProps } from '../props';
import { Chip } from '../list/Chip';
import { Action } from '../list/internal/Action';
import { formatFull, formatMessageTime } from '../list/internal/format';
import { useTooltipText } from '../list/internal/keys';
import { Icon } from '../buttons-keys';
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
  /** The card layout's mark before the name (the sender's avatar square). */
  readonly leading: ReactNode;
  /** DOM id of the excerpt, so the fold button can describe itself with it. */
  readonly excerptId: string;
  /** The folded card's first sentence or two; absent while open. */
  readonly excerpt: string | undefined;
}

/** Who, when and (folded) the excerpt: the content of a message's head. */
function HeadLine({
  fromId,
  from,
  date,
  toLabel,
  recipients,
  actions,
  leading,
  excerptId,
  excerpt,
}: HeadLineProps) {
  const card = leading !== undefined || recipients !== undefined || actions !== undefined;
  return (
    <>
      <span className="ui-thread-message__line" data-layout={card ? 'card' : undefined}>
        {card ? leading : null}
        <span id={fromId} className="ui-thread-message__from" dir="auto">
          {from}
        </span>
        {/* One header for a card, folded or open: mark, name, when, then who it went to. */}
        {card ? <TimeText date={date} /> : null}
        {recipients === undefined ? <span className="ui-thread-message__to">{toLabel}</span> : null}
        {card ? null : <TimeText date={date} />}
        {recipients}
        {actions === undefined ? null : (
          <span className="ui-thread-message__actions">{actions}</span>
        )}
      </span>
      {excerpt === undefined ? null : (
        <span
          id={excerptId}
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

interface FoldButtonProps {
  readonly id: string;
  readonly from: string;
  readonly fold: NonNullable<ThreadMessageProps['fold']>;
  /** The id of the folded row's excerpt. */
  readonly describedBy: string | undefined;
}

/** "Show full" and a chevron on a folded row, "Show less" once open: the one button of an earlier message. */
function FoldButton({ id, from, fold, describedBy }: FoldButtonProps) {
  const tip = useTooltipText();
  const label = fold.open ? 'Show less' : 'Show full';
  return (
    <button
      type="button"
      className="ui-thread-message__toggle"
      aria-expanded={fold.open}
      aria-controls={fold.open ? `${id}-content` : undefined}
      aria-label={`${label}, message from ${from}`}
      aria-describedby={describedBy}
      title={tip(fold.open ? 'Fold this message' : 'Open this message', fold.commandId)}
      onFocus={fold.onFocus}
      onClick={fold.onToggle}
    >
      <span className="ui-thread-message__toggle-label" aria-hidden="true">
        {label}
      </span>
      <Icon name={fold.open ? 'chevron-up' : 'chevron-down'} size="sm" />
    </button>
  );
}

/** A full message in the thread. */
export function ThreadMessage({
  id,
  from,
  toLabel,
  leading,
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
  original,
  undoTray,
  ref,
}: ThreadMessageProps) {
  const tip = useTooltipText();
  const fromId = `${id}-from`;
  const folded = fold !== undefined && !fold.open;
  const excerptId = `${id}-excerpt`;
  const head = (
    <HeadLine
      fromId={fromId}
      from={from}
      date={date}
      toLabel={toLabel}
      // A folded card is compact: no circles. An opened earlier message has the card's header row; its actions are the latest's.
      recipients={folded ? undefined : recipients}
      actions={fold ? undefined : headActions}
      leading={leading}
      excerptId={excerptId}
      excerpt={folded ? excerpt : undefined}
    />
  );
  return (
    <article
      ref={ref as Ref<HTMLElement>}
      id={id}
      className="ui-thread-message"
      data-cursor={cursor ? 'true' : undefined}
      data-fold={fold ? (fold.open ? 'open' : 'folded') : undefined}
      aria-labelledby={fromId}
    >
      <header className="ui-thread-message__head" data-fold={fold ? 'true' : undefined}>
        {head}
        {fold ? (
          <FoldButton
            id={id}
            from={from}
            fold={fold}
            describedBy={folded && excerpt !== undefined ? excerptId : undefined}
          />
        ) : null}
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

      {original ? (
        <div className="ui-thread-message__quoted">
          <Action
            variant="text"
            size="sm"
            label={original.shown ? 'Hide original' : 'Show original'}
            expanded={original.shown}
            onPress={() => original.onToggle()}
          />
        </div>
      ) : null}

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
