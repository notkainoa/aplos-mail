// ReaderHead (DESIGN §6, §7.5 items 1–3, §4.6). Mockups: reader.html, reply.html, errors.html (send-failed).
// The top of the one 640 px column: the sender line (name in `title`, "to you and Mina Cho" in --dim, a due
// chip and the time on the right), the big serif summary, and one action row: the suggestion as the filled
// button with Space, then Later and Done. No monogram, no card, no margin rail. ⋯ lives in the pane header.

import type { Ref } from 'react';
import type { ReaderHeadProps } from '../props';
import { Chip } from '../list/Chip';
import { Action } from '../list/internal/Action';
import { formatFull, formatReaderTime } from '../list/internal/format';
import { keycapFor, tooltipText } from '../list/internal/keys';
import { Summary } from './Summary';

/** The reader's sender line, summary and action row. */
export function ReaderHead({
  sender,
  recipientsLabel,
  due,
  date,
  summary,
  suggestion,
  commands,
  demoted,
  onSuggestion,
  onLater,
  onDone,
  ref,
}: ReaderHeadProps) {
  const details = [sender.address, sender.accountLabel, sender.history].filter(Boolean).join(' · ');
  return (
    <div ref={ref as Ref<HTMLDivElement>} className="ui-reader-head" data-demoted={demoted ? 'true' : undefined}>
      <div className="ui-reader-head__from">
        <span className="ui-reader-head__name" title={details}>
          {sender.name}
        </span>
        <span className="ui-reader-head__to">{recipientsLabel}</span>
        <span className="ui-reader-head__when">
          {due ? <Chip kind="due" due={due} format="sentence" /> : null}
          <time dateTime={date} title={formatFull(date)}>
            {formatReaderTime(date)}
          </time>
        </span>
      </div>

      <section className="ui-reader-head__summary" aria-label="Summary">
        <Summary {...summary} clamp="none" />
      </section>

      <div className="ui-reader-head__actions">
        <span className="ui-reader-head__suggest">
          <Action
            variant={demoted ? 'text' : 'filled'}
            size="md"
            label={suggestion.verb}
            icon={suggestion.icon}
            keycap={demoted ? undefined : keycapFor(commands.suggest)}
            tooltip={tooltipText(suggestion.verb, commands.suggest)}
            onPress={() => onSuggestion()}
          />
        </span>
        <Action variant="text" size="md" label="Later" icon="clock" tooltip={tooltipText('Later', commands.later)} onPress={(anchor) => onLater(anchor)} />
        {suggestion.isDone ? null : (
          <Action variant="text" size="md" label="Done" icon="check" tooltip={tooltipText('Done', commands.done)} onPress={() => onDone()} />
        )}
      </div>
    </div>
  );
}
