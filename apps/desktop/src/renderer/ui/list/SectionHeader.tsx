// SectionHeader (DESIGN §4.3, §5 rule 6, §6, §7.2, §7.3). Mockups: home.html, later.html, inbox.html,
// done.html, search.html, settings.js. A label, never a page title: `ui` 600 --ink plus a --dim count and one
// optional quiet text action. It keeps rendering at 0 while `held`, so emptying a section moves nothing.

import type { SectionHeaderProps } from '../props';
import { Action, useInListbox } from './internal/Action';
import { formatCount } from './internal/format';
import { Icon } from './internal/Icon';
import { literalKeycap, useKeycapOf, useTooltipText } from './internal/keys';

/** A section, sub or date label with its count and quiet action. */
export function SectionHeader({
  id,
  label,
  variant,
  count,
  held,
  tone = 'default',
  waitingNew,
  action,
  dropTarget,
}: SectionHeaderProps) {
  const inListbox = useInListbox();
  const capOf = useKeycapOf();
  const tip = useTooltipText();
  const actionKey = action
    ? action.keys
      ? literalKeycap(action.keys)
      : capOf(action.commandId)
    : '';
  const content = (
    <>
      {tone === 'overdue' ? <Icon name="clock" size="sm" /> : null}
      <span className="ui-section-header__label">{label}</span>
      {count !== undefined ? (
        <span className="ui-section-header__count">{formatCount(count)}</span>
      ) : null}
      {waitingNew && waitingNew > 0 ? (
        <span className="ui-section-header__new">{formatCount(waitingNew)} new</span>
      ) : null}
      {dropTarget ? (
        <span className="ui-section-header__target" data-drop={dropTarget.state}>
          {dropTarget.state === 'unavailable' ? null : `Move to ${dropTarget.label}`}
        </span>
      ) : null}
      {action ? (
        <span className="ui-section-header__action">
          <Action
            variant="text"
            size="sm"
            label={action.label}
            icon={action.icon}
            tooltip={tip(action.label, action.commandId, action.keys)}
            hintKey={actionKey}
            onPress={() => action.onSelect()}
          />
        </span>
      ) : null}
    </>
  );
  const data = {
    id,
    className: 'ui-section-header',
    'data-variant': variant,
    'data-tone': tone,
    'data-held': held ? 'true' : undefined,
    'data-drop': dropTarget?.state,
  };
  // Inside a listbox the label is the group's presentational first child; elsewhere it is a heading.
  if (inListbox) {
    return (
      <div role="presentation" {...data}>
        {content}
      </div>
    );
  }
  return <h2 {...data}>{content}</h2>;
}
