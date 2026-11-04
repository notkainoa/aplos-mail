// ReaderActions (DESIGN §6, §7.5 item 3). The one action row: the suggestion as the filled button with Space, then
// Later and Done as text buttons. Owner review 2026-11-03: it is a bar pinned to the bottom of the pane, centred. It
// sits in the flow at the end of the letter (so nothing ever hides behind it) and sticks to the pane's bottom while the
// letter is longer than the pane, over a soft pane-coloured scrim so text never shows beside or through the pill.
// While the inline reply is open (`demoted`) it rests in the flow under the reply, and a reply suggestion reads
// "Replying" (pressed) instead of offering a second Reply.

import type { ReaderActionsProps } from '../props';
import { Action } from '../list/internal/Action';
import { keycapFor, tooltipText } from '../list/internal/keys';

/** The pinned Reply / Later / Done bar. */
export function ReaderActions({
  suggestion,
  commands,
  demoted,
  onSuggestion,
  onLater,
  onDone,
}: ReaderActionsProps) {
  const replying = demoted && suggestion.icon === 'reply';
  return (
    <div className="ui-reader-actions" data-demoted={demoted ? 'true' : undefined}>
      <div className="ui-reader-actions__bar" role="group" aria-label="Actions">
        <Action
          variant={demoted ? 'text' : 'filled'}
          size="md"
          label={replying ? 'Replying' : suggestion.verb}
          icon={suggestion.icon}
          keycap={demoted ? undefined : keycapFor(commands.suggest)}
          pressed={replying ? true : undefined}
          tooltip={tooltipText(suggestion.verb, commands.suggest)}
          onPress={() => onSuggestion()}
        />
        <Action
          variant="text"
          size="md"
          label="Later"
          icon="clock"
          tooltip={tooltipText('Later', commands.later)}
          hintKey={keycapFor(commands.later)}
          onPress={anchor => onLater(anchor)}
        />
        {suggestion.isDone ? null : (
          <Action
            variant="text"
            size="md"
            label="Done"
            icon="check"
            tooltip={tooltipText('Done', commands.done)}
            hintKey={keycapFor(commands.done)}
            onPress={() => onDone()}
          />
        )}
      </div>
    </div>
  );
}
