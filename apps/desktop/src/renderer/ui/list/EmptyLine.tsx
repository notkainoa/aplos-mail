// EmptyLine (DESIGN §6, §7.14; owner override 2026-11-05). Mockups: empty.html, search.html (no-match), calendar-day.html, ask.html.
// One plain sentence, no trailing period, plus at most one action (two only for No accounts) and at most one small
// muted icon above the line — never in a circle, never an illustration. `placement='pane'` fills the pane body and
// centres the line both ways; `inline` stays a compact line in flow.

import type { EmptyLineProps } from '../props';
import { Action } from './internal/Action';
import { Icon } from './internal/Icon';
import { literalKeycap, useKeycapOf, useTooltipText } from './internal/keys';

/** An empty state: a compact line in flow, or a line centred in the pane (the calm centred inbox-zero block). */
export function EmptyLine({
  text,
  size = 'line',
  placement = 'inline',
  icon,
  detail,
  action,
  secondaryAction,
}: EmptyLineProps) {
  const capOf = useKeycapOf();
  const tip = useTooltipText();
  const key = action ? (action.keys ? literalKeycap(action.keys) : capOf(action.commandId)) : '';
  return (
    <div className="ui-empty-line" data-size={size} data-placement={placement} role="status">
      <div className="ui-empty-line__copy">
        {icon ? <Icon name={icon} size="sm" /> : null}
        <p className="ui-empty-line__text">{text}</p>
        {detail ? <p className="ui-empty-line__detail">{detail}</p> : null}
      </div>
      {action ? (
        <div
          className="ui-empty-line__actions"
          data-quiet={action.emphasis === 'quiet' ? 'true' : undefined}
        >
          <Action
            variant={action.emphasis === 'filled' ? 'filled' : 'text'}
            size="md"
            label={action.label}
            icon={action.icon}
            keycap={key}
            tooltip={tip(action.label, action.commandId, action.keys)}
            onPress={() => action.onSelect()}
          />
          {secondaryAction ? (
            <Action
              variant="text"
              size="md"
              label={secondaryAction.label}
              icon={secondaryAction.icon}
              tooltip={tip(secondaryAction.label, secondaryAction.commandId, secondaryAction.keys)}
              onPress={() => secondaryAction.onSelect()}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
