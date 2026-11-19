import { useId } from 'react';
import type { CSSProperties } from 'react';
import type { CalendarListProps } from '../props';
import { calVar } from './eventText';
import { CalIcon } from './icons';

/**
 * The "Calendars" list with colour swatches, the calendar legend. A click shows or hides one calendar; an
 * Option-click shows that one alone (DESIGN 6 CalendarList, 7.1, 7.8). A hidden calendar has a hollow swatch and
 * a dim name, and a shown one has a check in its swatch, so colour is never the only cue.
 */
export function CalendarList({ calendars, onToggle, onSolo }: CalendarListProps) {
  const headId = useId();
  const allReadOnly = calendars.length > 0 && calendars.every(c => c.readOnly);
  const someReadOnly = !allReadOnly && calendars.some(c => c.readOnly);
  return (
    <div className="ui-calendar-list" role="group" aria-labelledby={headId}>
      <div className="ui-calendar-list__head" id={headId}>
        Calendars
      </div>
      {allReadOnly ? <div className="ui-calendar-list__note">View only</div> : null}
      <ul className="ui-calendar-list__items">
        {calendars.map(calendar => (
          <li key={calendar.id}>
            <button
              type="button"
              role="checkbox"
              className="ui-calendar-list__item"
              aria-checked={calendar.visible}
              data-state={calendar.visible ? 'shown' : 'hidden'}
              title={`${calendar.visible ? 'Hide' : 'Show'} ${calendar.name}. Option-click shows only this one.`}
              style={{ '--swatch': calVar(calendar.color) } as CSSProperties}
              onClick={e => (e.altKey ? onSolo(calendar.id) : onToggle(calendar.id))}
            >
              <span className="ui-calendar-list__swatch" aria-hidden="true">
                {calendar.visible ? <CalIcon name="check" /> : null}
              </span>
              <span className="ui-calendar-list__name" dir="auto">
                {calendar.name}
              </span>
              {someReadOnly && calendar.readOnly ? (
                <span className="ui-calendar-list__tag">View only</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
