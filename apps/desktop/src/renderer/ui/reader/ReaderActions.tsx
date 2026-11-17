// ReaderActions (DESIGN §6, §7.5 item 3). The one action row: the suggestion as the filled button with Space, then
// Later and Done as text buttons. Owner review 2026-11-03: it is a bar pinned to the bottom of the pane, centred. It
// sits in the flow at the end of the letter (so nothing ever hides behind it) and sticks to the pane's bottom while the
// letter is longer than the pane, over a soft pane-coloured scrim so text never shows beside or through the pill.
// While the inline reply is open (`demoted`) it rests in the flow under the reply, and a reply suggestion reads
// "Replying" (pressed) instead of offering a second Reply. The bar keeps its shape: the primary slot holds the
// filled button's width (an invisible copy sizes it), and Later and Done keep their keycaps, so nothing slides.

import type { ReaderActionsProps } from '../props';
import { Action, Keycap } from '../list/internal/Action';
import { Icon } from '../list/internal/Icon';
import { useKeycapFor, useTooltipText } from '../list/internal/keys';
import { HOLD_R } from './ReplyStub';

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
  const tip = useTooltipText();
  const base = tip(suggestion.verb, commands.suggest);
  const suggestionTooltip = suggestion.icon === 'reply' ? `${base}. ${HOLD_R}` : base;
  const space = useKeycapFor(commands.suggest);
  const later = useKeycapFor(commands.later);
  const done = useKeycapFor(commands.done);
  // Later stays left of Done in every lane (← Later, Done →); the lane's primary is the filled one and keeps Space.
  const suggestAction = (
    <Action
      variant={demoted ? 'text' : 'filled'}
      size="md"
      label={replying ? 'Replying' : suggestion.verb}
      icon={suggestion.icon}
      keycap={replying ? undefined : space}
      pressed={replying ? true : undefined}
      tooltip={suggestionTooltip}
      onPress={() => onSuggestion()}
    />
  );
  const laterAction = (
    <Action
      variant="text"
      size="md"
      label="Later"
      icon="clock"
      tooltip={tip('Later', commands.later)}
      keycap={later}
      onPress={anchor => onLater(anchor)}
    />
  );
  const doneAction = (
    <Action
      variant="text"
      size="md"
      label="Done"
      icon="check"
      tooltip={tip('Done', commands.done)}
      keycap={done}
      onPress={() => onDone()}
    />
  );
  // The quiet "Replying" state sits in the filled button's footprint: an unseen copy of that button sizes the slot.
  const primary = replying ? (
    <span className="ui-reader-actions__slot">
      <span className="ui-list-btn" data-variant="text" data-size="md" aria-hidden="true">
        {suggestion.icon ? <Icon name={suggestion.icon} /> : null}
        <span className="ui-list-btn__label">{suggestion.verb}</span>
        {space ? <Keycap chord={space} /> : null}
      </span>
      {suggestAction}
    </span>
  ) : (
    suggestAction
  );
  return (
    <div className="ui-reader-actions" data-demoted={demoted ? 'true' : undefined}>
      <div className="ui-reader-actions__bar" role="group" aria-label="Actions">
        {suggestion.isDone ? laterAction : primary}
        {suggestion.isDone ? primary : laterAction}
        {suggestion.isDone ? null : doneAction}
      </div>
    </div>
  );
}
