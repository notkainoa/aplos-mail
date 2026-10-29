import { useContext } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import type { PlanOutlineProps } from '../props';
import { calVar, densityOf, eventDomId, eventLabel, walkAt } from './eventText';
import { CalIcon } from './icons';
import { FirstSegment } from './segment';

/**
 * A plan found in mail, on the grid but not on the calendar yet: a dashed 1 px outline on the canvas and a
 * "From mail" label (DESIGN 6 PlanOutline, 7.8, 11.1). The dashed outline plus the word is the cue, never colour
 * alone. Confirming and opening the source email live in the detail (EventDetail).
 */
export function PlanOutline({ plan, placement, selected, onSelect, onOpen }: PlanOutlineProps) {
  const first = useContext(FirstSegment);
  const density = densityOf(plan);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpen(e.currentTarget);
    }
  };
  return (
    <button
      type="button"
      id={first ? eventDomId(plan.id) : undefined}
      className="ui-plan-outline"
      data-walk-at={first ? walkAt(plan) : undefined}
      data-kind="plan"
      data-event-id={plan.id}
      data-density={density === 'full' ? 'full' : 'one'}
      data-selected={selected ? 'true' : 'false'}
      data-wide={placement.wide ? 'true' : 'false'}
      aria-pressed={selected}
      aria-label={eventLabel(plan)}
      tabIndex={-1}
      style={{ '--cal': calVar(plan.calendar.color) } as CSSProperties}
      onClick={onSelect}
      onDoubleClick={e => onOpen(e.currentTarget)}
      onKeyDown={onKeyDown}
    >
      <span className="ui-plan-outline__title" dir="auto">
        {plan.title}
      </span>
      {/* A whitespace text node in the flex button: nothing is drawn, and the visible text reads "Launch prep From mail". */}{' '}
      <span className="ui-plan-outline__from">
        <CalIcon name="mail" />
        From mail
      </span>
    </button>
  );
}
