/**
 * The month body of CalendarGrid: six weeks of day cells, today as a filled accent badge, each entry one quiet
 * line with a colour mark, and "N more" once a day holds more than three (never a lonely "1 more").
 * Internal to the calendar family.
 */
import { useContext } from 'react';
import type { CSSProperties } from 'react';
import type { CalendarEventData, CalendarGridProps } from '../props';
import {
  dateOf,
  dayOf,
  dayTitle,
  hoursOf,
  monthMatrix,
  parseYearMonth,
  WEEKDAYS,
  weekdayOrder,
  yearMonthOf,
} from './dates';
import { calVar, eventDomId, eventLabel, stackDomId, walkAt } from './eventText';
import { allDayOn } from './layout';
import { GridAction } from './GridAction';
import { ActiveStack } from './segment';

/** One day's entries in reading order: all-day first, then by start. */
function onDay(events: readonly CalendarEventData[], day: string): CalendarEventData[] {
  const allDay = allDayOn(events, day);
  const timed = events
    .filter(e => !e.allDay && dayOf(e.start) === day)
    .sort((a, b) => hoursOf(a.start) - hoursOf(b.start) || a.id.localeCompare(b.id));
  return [...allDay, ...timed];
}

export function MonthGrid({
  start,
  events,
  now,
  weekStartsOn,
  selectedId,
  onSelect,
  onOpen,
  onOpenStack,
  emptyAction,
}: CalendarGridProps) {
  const ym = yearMonthOf(start);
  const month = parseYearMonth(ym).m;
  const weeks = monthMatrix(ym, weekStartsOn);
  const today = dayOf(now);
  const empty = events.length === 0;
  const activeStack = useContext(ActiveStack);
  const seen = new Set<string>(); // a multi-day entry shows in each cell it covers, but only the first is the DOM target

  return (
    <div className="ui-calendar-grid__month">
      <div className="ui-calendar-grid__mrow" role="row" data-head="true">
        {weekdayOrder(weekStartsOn).map(d => (
          <div
            key={d}
            role="columnheader"
            className="ui-calendar-grid__mh"
            aria-label={WEEKDAYS[d]}
          >
            {WEEKDAYS[d].slice(0, 3)}
          </div>
        ))}
      </div>
      {weeks.map(week => (
        <div className="ui-calendar-grid__mrow" role="row" key={week[0]}>
          {week.map(day => {
            const list = onDay(events, day);
            const shown = list.length <= 3 ? list : list.slice(0, 2);
            const hidden = list.slice(shown.length);
            const isToday = day === today;
            return (
              <div
                key={day}
                role="gridcell"
                className="ui-calendar-grid__mcell"
                data-out={parseYearMonth(day.slice(0, 7)).m === month ? undefined : 'true'}
                data-today={isToday ? 'true' : undefined}
                aria-label={dayTitle(day)}
              >
                <span
                  className="ui-calendar-grid__mnum"
                  aria-current={isToday ? 'date' : undefined}
                >
                  {dateOf(day).getDate()}
                </span>
                {shown.map(event => {
                  const first = !seen.has(event.id);
                  seen.add(event.id);
                  return (
                    <button
                      key={event.id}
                      type="button"
                      id={first ? eventDomId(event.id) : undefined}
                      className="ui-calendar-grid__mev"
                      data-walk-at={first ? walkAt(event) : undefined}
                      data-event-id={event.id}
                      data-kind={event.kind}
                      aria-pressed={selectedId === event.id}
                      aria-label={eventLabel(event)}
                      tabIndex={-1}
                      style={{ '--cal': calVar(event.calendar.color) } as CSSProperties}
                      onClick={() => onSelect(event.id)}
                      onDoubleClick={e => onOpen(event.id, e.currentTarget)}
                      onKeyDown={e => {
                        if (e.nativeEvent.isComposing || e.key !== 'Enter') return;
                        e.preventDefault();
                        onOpen(event.id, e.currentTarget);
                      }}
                    >
                      <i aria-hidden="true" />
                      <span dir="auto">{event.title}</span>
                    </button>
                  );
                })}
                {hidden.length > 0 ? (
                  <button
                    type="button"
                    id={stackDomId([`${day}:${hidden[0].id}`])}
                    className="ui-calendar-grid__mev"
                    data-more="true"
                    data-walk-at={walkAt(hidden[0])}
                    data-active={
                      activeStack === stackDomId([`${day}:${hidden[0].id}`]) ? 'true' : undefined
                    }
                    tabIndex={-1}
                    aria-haspopup="menu"
                    aria-label={`${hidden.length} more ${hidden.length === 1 ? 'event' : 'events'} on ${dayTitle(day)}`}
                    onClick={e =>
                      onOpenStack(
                        hidden.map(h => h.id),
                        e.currentTarget,
                      )
                    }
                  >
                    {hidden.length} more
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
      {empty && emptyAction ? (
        <div className="ui-calendar-grid__empty" data-view="month" role="status">
          <span>Nothing scheduled.</span>
          <GridAction action={emptyAction} />
        </div>
      ) : null}
    </div>
  );
}
