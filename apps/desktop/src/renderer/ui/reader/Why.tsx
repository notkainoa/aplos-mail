// Why (DESIGN §6, §9 rule 4, §7.2 corrections). Mockups: none drawn (reader.html's ⋯ tooltip names it).
// "Why it’s here", shown in a Popover: one plain sentence, a quote from the mail, and the two lane
// corrections with their keys (⌥↑ / ⌥↓). Up is off in Do now, down is off in Low importance.

import { useId } from 'react';
import type { WhyProps } from '../props';
import { Action } from '../list/internal/Action';
import { useKeycapOf, useTooltipText } from '../list/internal/keys';

/** The reason a thread sits in its lane, with the two corrections. */
export function Why({ reason, quote, lane, commands, onMove }: WhyProps) {
  const titleId = useId();
  const capOf = useKeycapOf();
  const tip = useTooltipText();
  return (
    <div className="ui-why" role="group" aria-labelledby={titleId} data-lane={lane}>
      <p id={titleId} className="ui-why__title">
        Why it’s here
      </p>
      <p className="ui-why__reason">{reason}</p>
      {quote ? <blockquote className="ui-why__quote">{quote}</blockquote> : null}
      <div className="ui-why__actions">
        <Action
          variant="text"
          size="sm"
          icon="chevron-up"
          label="Move up a lane"
          keycap={capOf(commands.up)}
          tooltip={tip('Move up a lane', commands.up)}
          disabled={lane === 'do'}
          onPress={() => onMove('up')}
        />
        <Action
          variant="text"
          size="sm"
          icon="chevron-down"
          label="Move down a lane"
          keycap={capOf(commands.down)}
          tooltip={tip('Move down a lane', commands.down)}
          disabled={lane === 'low'}
          onPress={() => onMove('down')}
        />
      </div>
    </div>
  );
}
