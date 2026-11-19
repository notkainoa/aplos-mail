/**
 * The agenda body of CalendarGrid: the narrow-pane calendar list ('full') and the Today tab's compact agenda
 * ('today', DESIGN 7.7: what is left of the day — the event under way, the now-line, the next event and the
 * following two, with the free gaps between — plus a quiet "N earlier" for what already ended). Internal to the
 * calendar family.
 */
import { useId } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { CalendarEventData, CalendarGridProps } from '../props';
import { dayOf, dayTitle, durationText, longDay, minutesBetween, timeOf } from './dates';
import { agendaLabel, calVar, eventDomId, walkAt } from './eventText';
import { GridAction } from './GridAction';
import { allDayOn, daysOf } from './layout';
import { NowLine } from './NowLine';

type RowState = 'next' | 'later';

function row(
  props: CalendarGridProps,
  event: CalendarEventData,
  sub: string | undefined,
  state: RowState = 'later',
  first = true,
) {
  const { selectedId, onSelect, onOpen } = props;
  return (
    <button
      key={event.id}
      type="button"
      id={first ? eventDomId(event.id) : undefined}
      data-walk-at={first ? walkAt(event) : undefined}
      className="ui-calendar-grid__ag"
      data-state={state}
      data-kind={event.kind}
      data-event-id={event.id}
      aria-pressed={selectedId === event.id}
      aria-label={agendaLabel(event, sub)}
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
      <span className="ui-calendar-grid__ag-time">
        {event.allDay ? 'All day' : timeOf(event.start)}
      </span>
      {/* A whitespace text node: a flex row draws none, but the visible text then reads "9:30 AM Dental", like the label. */}{' '}
      <span className="ui-calendar-grid__ag-event">
        <i aria-hidden="true" data-plan={event.kind === 'plan' ? 'true' : undefined} />
        <span className="ui-calendar-grid__ag-text">
          <span className="ui-calendar-grid__ag-name" dir="auto">
            {event.title}
          </span>
          {sub ? ' ' : null}
          {sub ? <span className="ui-calendar-grid__ag-sub">{sub}</span> : null}
        </span>
      </span>
    </button>
  );
}

function TodayAgenda(props: CalendarGridProps) {
  const { events, now, emptyAction } = props;
  const day = dayOf(now);
  const nowMs = new Date(now).getTime();
  const todays = [
    ...allDayOn(events, day),
    ...events
      .filter(e => !e.allDay && dayOf(e.start) === day)
      .sort((a, b) => a.start.localeCompare(b.start)),
  ];
  const timed = todays.filter(e => !e.allDay);
  const upcoming = timed.filter(e => new Date(e.start).getTime() >= nowMs);
  const current = timed.filter(
    e => new Date(e.start).getTime() < nowMs && new Date(e.end).getTime() > nowMs,
  );
  const earlier = timed.filter(e => new Date(e.end).getTime() <= nowMs).length;
  const left = todays.length - earlier;
  const ahead = upcoming.slice(0, 3);
  const next = upcoming[0];
  const sub =
    left === 0
      ? 'Nothing left today'
      : `${left} left today${next ? ` · next at ${timeOf(next.start)}` : ''}`;
  const detail = (e: CalendarEventData, lead?: string): string =>
    [lead, e.calendar.name, durationText(minutesBetween(e.start, e.end))]
      .filter(Boolean)
      .join(' · ');

  // The events already over fold into one quiet line where the dimmed rows used to sit.
  const earlierLine =
    earlier > 0 ? (
      <p key="earlier" className="ui-calendar-grid__earlier">
        <span aria-hidden="true" />
        <span>{`${earlier} earlier`}</span>
      </p>
    ) : null;

  const parts: ReactNode[] = [];
  for (const e of todays.filter(x => x.allDay)) parts.push(row(props, e, e.calendar.name));
  if (earlierLine) parts.push(earlierLine);
  for (const e of current) parts.push(row(props, e, detail(e, 'Now')));
  // The now-line stays between the running event and the next one; with nothing timed left there is no between.
  if (current.length + upcoming.length > 0)
    parts.push(<NowLine key="now" now={now} variant="agenda" />);
  // A gap starts at the latest end so far — an earlier event still running inside a longer one does
  // not shorten it (the same running `free` cursor the Today model uses).
  let free = Math.max(nowMs, ...current.map(c => new Date(c.end).getTime()));
  ahead.forEach((e, i) => {
    const gap = Math.round((new Date(e.start).getTime() - free) / 60000);
    if (gap >= 30) {
      parts.push(
        <p key={`gap-${e.id}`} className="ui-calendar-grid__gap">
          <span aria-hidden="true" />
          <span>{`Free for ${durationText(gap)}`}</span>
        </p>,
      );
    }
    parts.push(row(props, e, detail(e, i === 0 ? 'Next' : undefined), i === 0 ? 'next' : 'later'));
    free = Math.max(free, new Date(e.end).getTime());
  });

  return (
    <div className="ui-calendar-grid__today">
      <div className="ui-calendar-grid__today-head">
        <h2 className="ui-calendar-grid__today-day">{longDay(day)}</h2>
        <p className="ui-calendar-grid__today-sub">{sub}</p>
      </div>
      {left === 0 ? (
        <>
          <div className="ui-calendar-grid__empty" data-view="agenda" role="status">
            <span>{todays.length === 0 ? 'Nothing scheduled' : 'Nothing left today'}</span>
            {todays.length === 0 && emptyAction ? <GridAction action={emptyAction} /> : null}
          </div>
          {earlierLine}
        </>
      ) : (
        <div className="ui-calendar-grid__ag-list">{parts}</div>
      )}
    </div>
  );
}

function FullAgenda(props: CalendarGridProps) {
  const { start, events, now, emptyAction } = props;
  const uid = useId();
  const today = dayOf(now);
  const seen = new Set<string>(); // a multi-day entry is listed on each day, but only the first row is the DOM target
  const days = daysOf('agenda', start)
    .map(day => ({
      day,
      list: [
        ...allDayOn(events, day),
        ...events
          .filter(e => !e.allDay && dayOf(e.start) === day)
          .sort((a, b) => a.start.localeCompare(b.start)),
      ],
    }))
    .filter(d => d.list.length > 0 || d.day === today);

  if (days.every(d => d.list.length === 0)) {
    return (
      <div className="ui-calendar-grid__empty" data-view="agenda" role="status">
        <span>Nothing scheduled</span>
        {emptyAction ? <GridAction action={emptyAction} /> : null}
      </div>
    );
  }

  return (
    <div className="ui-calendar-grid__full">
      {days.map(({ day, list }) => {
        const headId = `${uid}-${day}`;
        const nowMs = new Date(now).getTime();
        const parts: ReactNode[] = [];
        let placed = day !== today;
        for (const e of list) {
          if (!placed && !e.allDay && new Date(e.start).getTime() >= nowMs) {
            parts.push(<NowLine key="now" now={now} variant="agenda" />);
            placed = true;
          }
          const first = !seen.has(e.id);
          seen.add(e.id);
          parts.push(
            row(
              props,
              e,
              e.place ? `${e.calendar.name} · ${e.place}` : e.calendar.name,
              'later',
              first,
            ),
          );
        }
        if (!placed) parts.push(<NowLine key="now" now={now} variant="agenda" />);
        return (
          <section
            key={day}
            className="ui-calendar-grid__day"
            aria-labelledby={headId}
            data-today={day === today ? 'true' : undefined}
          >
            <h3 className="ui-calendar-grid__day-title" id={headId}>
              {dayTitle(day)}
            </h3>
            <div className="ui-calendar-grid__ag-list">{parts}</div>
          </section>
        );
      })}
    </div>
  );
}

export function AgendaView(props: CalendarGridProps) {
  return props.agenda === 'today' ? <TodayAgenda {...props} /> : <FullAgenda {...props} />;
}
