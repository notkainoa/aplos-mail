// FocusLetter (DESIGN §4.6, §7.2 The focus letter, §9). Mockups: home.html, demo.html.
// A card (--elev-card) that fills the fixed FocusSlot: the meta line (sender `base` 600, due chip, relative
// date), the serif summary cut at two lines, and the action row: the suggestion as the one filled button
// (icon + verb + Space keycap), Later and Done as text buttons (Done omitted when the suggestion is Done),
// then ⋯. No subject, no bookmark icon. The buttons are pointer duplicates of their keys inside the option.

import type { FocusLetterProps } from '../props';
import { Summary } from '../reader/Summary';
import { Chip } from './Chip';
import { ErrorLine } from './ErrorLine';
import { Action } from './internal/Action';
import { formatFull, formatListDate } from './internal/format';
import { keycapFor, tooltipText } from './internal/keys';

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
  rejected,
  onSuggestion,
  onLater,
  onDone,
  onMore,
}: FocusLetterProps) {
  const space = keycapFor(commands.suggest);
  return (
    <div
      id={id}
      role="option"
      aria-selected="true"
      className="ui-focus-letter"
      data-demoted={demoted ? 'true' : undefined}
      data-narrow={narrow ? 'true' : undefined}
      data-state={rejected ? 'rejected' : undefined}
    >
      <div className="ui-focus-letter__meta">
        <span className="ui-focus-letter__sender" dir="auto">
          {sender}
        </span>
        {due ? <Chip kind="due" due={due} format="short" /> : null}
        <time className="ui-focus-letter__date" dateTime={date} title={formatFull(date)}>
          {formatListDate(date)}
        </time>
      </div>

      <Summary {...summary} clamp="two-lines" />

      {rejected ? <ErrorLine kind="writeRejected" op={rejected.op} placement="row" onAction={() => rejected.onRetry()} /> : null}

      <div className="ui-focus-letter__actions">
        <span className="ui-focus-letter__suggest">
          <Action
            variant={demoted ? 'text' : 'filled'}
            size="md"
            label={suggestion.verb}
            icon={suggestion.icon}
            keycap={demoted ? undefined : space}
            tooltip={tooltipText(suggestion.verb, commands.suggest)}
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
          tooltip={tooltipText('Later', commands.later)}
          hintKey={keycapFor(commands.later)}
          duplicate
          onPress={(anchor) => onLater(anchor)}
        />
        {suggestion.isDone ? null : (
          <Action
            variant="text"
            size="md"
            label="Done"
            icon="check"
            labelHidden={narrow}
            tooltip={tooltipText('Done', commands.done)}
            hintKey={keycapFor(commands.done)}
            duplicate
            onPress={() => onDone()}
          />
        )}
        <Action
          variant="icon"
          size="md"
          label="More"
          icon="more"
          tooltip={tooltipText('More: bookmark, trash, why it’s here', commands.more)}
          hintKey={keycapFor(commands.more)}
          duplicate
          onPress={(anchor) => onMore(anchor)}
        />
      </div>
    </div>
  );
}
