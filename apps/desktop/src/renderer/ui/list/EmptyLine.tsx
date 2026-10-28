// EmptyLine (DESIGN §6, §7.14). Mockups: empty.html, search.html (no-match), calendar-day.html, ask.html.
// One plain sentence plus at most one action (two only for No accounts). No icon in a circle, no illustration.

import type { EmptyLineProps } from '../props';
import { Action } from './internal/Action';
import { keycapFor, literalKeycap, tooltipText } from './internal/keys';

/** An empty state: a line in the column, or the calm centred inbox-zero block. */
export function EmptyLine({ text, size = 'line', detail, action, secondaryAction }: EmptyLineProps) {
  const key = action ? (action.keys ? literalKeycap(action.keys) : keycapFor(action.commandId)) : '';
  return (
    <div className="ui-empty-line" data-size={size} role="status">
      <div className="ui-empty-line__copy">
        <p className="ui-empty-line__text">{text}</p>
        {detail ? <p className="ui-empty-line__detail">{detail}</p> : null}
      </div>
      {action ? (
        <div className="ui-empty-line__actions">
          <Action
            variant={action.emphasis}
            size="md"
            label={action.label}
            icon={action.icon}
            keycap={key}
            tooltip={tooltipText(action.label, action.commandId, action.keys)}
            onPress={() => action.onSelect()}
          />
          {secondaryAction ? (
            <Action
              variant="text"
              size="md"
              label={secondaryAction.label}
              icon={secondaryAction.icon}
              tooltip={tooltipText(secondaryAction.label, secondaryAction.commandId, secondaryAction.keys)}
              onPress={() => secondaryAction.onSelect()}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
