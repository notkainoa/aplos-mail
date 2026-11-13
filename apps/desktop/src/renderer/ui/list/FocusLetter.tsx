// FocusLetter (DESIGN §4.6, §7.2 The focus letter, §9). Mockups: home.html, demo.html.
// A card (--elev-card) that fills the fixed FocusSlot: the meta line (sender `base` 600, due chip, relative
// date), the serif summary cut at two lines, and the action row: the suggestion as the one filled button
// (icon + verb + Space keycap), Later and Done as text buttons (Done omitted when the suggestion is Done),
// then ⋯. No subject, no bookmark icon. The buttons are pointer duplicates of their keys inside the option.

import type { FocusLetterProps } from '../props';
import { useEffect, useRef, useState } from 'react';
import { Summary } from '../reader/Summary';
import { SummaryPlaceholder } from './SummaryPlaceholder';
import { Chip } from './Chip';
import { ErrorLine } from './ErrorLine';
import { Action } from './internal/Action';
import { Icon } from './internal/Icon';
import { formatFull, formatListDate } from './internal/format';
import { useKeycapFor, useTooltipText } from './internal/keys';

/**
 * The summary space: a quiet placeholder while it is being written, the serif line when it lands (a short fade
 * only when it replaces the placeholder), or the subject alone when no summary will come (the slot then fits it).
 */
function SummarySpace({ id, summary }: Pick<FocusLetterProps, 'id' | 'summary'>) {
  const before = useRef<{ id: string; state: string } | null>(null);
  // The fade is latched until it ends, so a re-render for any other reason cannot cut it short.
  const [fading, setFading] = useState<string | null>(null);
  const arrived =
    summary.state === 'ready' && before.current?.id === id && before.current.state !== 'ready';
  useEffect(() => {
    before.current = { id, state: summary.state };
  });
  useEffect(() => {
    if (arrived) setFading(id);
  }, [arrived, id]);
  if (summary.state === 'pending') return <SummaryPlaceholder subject={summary.subject} />;
  return (
    <div
      className="ui-focus-letter__summary"
      data-arrive={arrived || fading === id ? 'true' : undefined}
      onAnimationEnd={() => setFading(null)}
    >
      <Summary {...summary} clamp="two-lines" />
    </div>
  );
}

/** The Home focus letter, the selected option of the Home listbox. */
export function FocusLetter({
  id,
  sender,
  due,
  date,
  summary,
  suggestion,
  commands,
  demoted,
  narrow,
  picked,
  rejected,
  onSuggestion,
  onLater,
  onDone,
  onMore,
}: FocusLetterProps) {
  const space = useKeycapFor(commands.suggest);
  const later = useKeycapFor(commands.later);
  const done = useKeycapFor(commands.done);
  const more = useKeycapFor(commands.more);
  const tip = useTooltipText();
  return (
    <div
      id={id}
      role="option"
      aria-selected="true"
      className="ui-focus-letter"
      data-demoted={demoted ? 'true' : undefined}
      data-narrow={narrow ? 'true' : undefined}
      data-picked={picked ? 'true' : undefined}
      data-state={rejected ? 'rejected' : undefined}
      aria-busy={summary.state === 'pending' ? true : undefined}
    >
      {picked ? (
        <span className="ui-focus-letter__pick" aria-hidden="true">
          <Icon name="check" size="xs" />
        </span>
      ) : null}
      <div className="ui-focus-letter__meta">
        <span className="ui-focus-letter__sender" dir="auto" title={sender}>
          {sender}
        </span>
        {due ? <Chip kind="due" due={due} format="short" /> : null}
        <time className="ui-focus-letter__date" dateTime={date} title={formatFull(date)}>
          {formatListDate(date)}
        </time>
      </div>

      <SummarySpace id={id} summary={summary} />

      {rejected ? (
        <ErrorLine
          kind="writeRejected"
          op={rejected.op}
          placement="row"
          onAction={() => rejected.onRetry()}
        />
      ) : null}

      <div className="ui-focus-letter__actions">
        <span className="ui-focus-letter__suggest">
          <Action
            variant={demoted ? 'text' : 'filled'}
            size="md"
            label={suggestion.verb}
            icon={suggestion.icon}
            keycap={demoted ? undefined : space}
            tooltip={tip(suggestion.verb, commands.suggest)}
            duplicate
            onPress={() => onSuggestion()}
          />
        </span>
        <Action
          variant="text"
          size="md"
          label="Later"
          icon="clock"
          labelHidden={narrow}
          tooltip={tip('Later', commands.later)}
          keycap={demoted ? undefined : later}
          duplicate
          onPress={anchor => onLater(anchor)}
        />
        {suggestion.isDone ? null : (
          <Action
            variant="text"
            size="md"
            label="Done"
            icon="check"
            labelHidden={narrow}
            tooltip={tip('Done', commands.done)}
            keycap={demoted ? undefined : done}
            duplicate
            onPress={() => onDone()}
          />
        )}
        <Action
          variant="icon"
          size="md"
          label="More"
          icon="more"
          tooltip={tip('More: bookmark, trash, why it’s here', commands.more)}
          hintKey={more}
          duplicate
          onPress={anchor => onMore(anchor)}
        />
      </div>
    </div>
  );
}
