/**
 * The day and week body of CalendarGrid: day headers, an all-day strip, the hour gutter and one column per day
 * with 56 px per hour, lanes, the "+N" stack, the now-line and pointer drag (create, move, resize).
 * Internal to the calendar family; CalendarGrid is the public component.
 */
import { useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { CalendarEventData, CalendarGridProps } from '../props';
import { dateOf, dateTimeAt, dayOf, dayTitle, hourLabel, hourRange, rangeOf, shortWeekday, snapHours } from './dates';
import { EventBlock } from './EventBlock';
import { calVar } from './eventText';
import { GridAction } from './GridAction';
import { allDayOn, daysOf, dragRange, layoutDay, MAX_LANES, timedOn, type Timed } from './layout';
import { NowLine } from './NowLine';
import { PlanOutline } from './PlanOutline';

interface DragState {
  kind: 'create' | 'move' | 'resize';
  id?: string;
  dayIndex: number;
  at: number;
  end: number;
}

interface DragRun {
  kind: DragState['kind'];
  id?: string;
  dayIndex: number;
  origin: { at: number; end: number; pointer: number };
  x: number;
  y: number;
  moved: boolean;
  last?: string;
}

/** Pixels the pointer must travel before a press becomes a drag, so a click still selects. */
const DRAG_SLOP = 4;

export function TimeGrid(props: CalendarGridProps) {
  const { view, start, events, now, selectedId, onSelect, onOpen, onCreate, onMove, onResize, onOpenStack, emptyAction } = props;
  const wide = view === 'day';
  const days = daysOf(wide ? 'day' : 'week', start);
  const today = dayOf(now);
  const maxLanes = wide ? MAX_LANES.day : MAX_LANES.week;

  const perDay = days.map((day) => {
    const timed = events.map((e) => timedOn(e, day)).filter((t): t is Timed => t !== null);
    return { day, timed, allDay: allDayOn(events, day), layout: layoutDay(timed, maxLanes) };
  });
  const { first, last } = hourRange(perDay.flatMap((d) => d.timed.map((t) => ({ start: t.at, end: t.end }))));
  const count = last - first;
  const hasAllDay = perDay.some((d) => d.allDay.length > 0);
  const nowHours = new Date(now).getHours() + new Date(now).getMinutes() / 60;

  const trackRefs = useRef<Array<HTMLDivElement | null>>([]);
  const run = useRef<DragRun | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<DragState | null>(null);

  const hoursAt = (clientY: number, dayIndex: number): number => {
    const track = trackRefs.current[dayIndex];
    if (!track) return first;
    const rect = track.getBoundingClientRect();
    return first + ((clientY - rect.top) / rect.height) * count;
  };
  const dayIndexAt = (clientX: number, fallback: number): number => {
    for (let i = 0; i < days.length; i += 1) {
      const rect = trackRefs.current[i]?.getBoundingClientRect();
      if (rect && clientX >= rect.left && clientX < rect.right) return i;
    }
    return fallback;
  };

  const begin = (e: ReactPointerEvent<HTMLElement>, kind: DragState['kind'], dayIndex: number, at: number, end: number, id?: string): void => {
    if (e.button !== 0) return;
    const pointer = hoursAt(e.clientY, dayIndex);
    run.current = { kind, id, dayIndex, origin: { at, end, pointer }, x: e.clientX, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const r = run.current;
    if (!r) return;
    if (!r.moved && Math.hypot(e.clientX - r.x, e.clientY - r.y) < DRAG_SLOP) return;
    r.moved = true;
    const dayIndex = r.kind === 'move' ? dayIndexAt(e.clientX, r.dayIndex) : r.dayIndex;
    const range = dragRange(r.kind, r.origin, hoursAt(e.clientY, r.dayIndex));
    const key = `${dayIndex}:${range.at}:${range.end}`;
    if (key === r.last) return;
    r.last = key;
    setDrag({ kind: r.kind, id: r.id, dayIndex, at: range.at, end: range.end });
  };

  const finish = (commit: boolean): void => {
    const r = run.current;
    run.current = null;
    if (!r) return;
    const state = drag;
    setDrag(null);
    if (!r.moved) return;
    suppressClick.current = true;
    if (!commit || !state) return;
    const day = days[state.dayIndex];
    const range = { start: dateTimeAt(day, state.at), end: dateTimeAt(day, state.end) };
    if (state.kind === 'create') onCreate(range);
    else if (state.kind === 'move' && state.id) {
      if (state.dayIndex !== r.dayIndex || state.at !== r.origin.at) onMove(state.id, range);
    } else if (state.kind === 'resize' && state.id && state.end !== r.origin.end) onResize(state.id, range.end);
  };

  const movable = (e: CalendarEventData): boolean => e.kind === 'event' && e.persisted && !e.allDay;

  const block = (event: CalendarEventData, placement: { lane: number; lanes: number; wide: boolean }): ReactNode =>
    event.kind === 'plan' ? (
      <PlanOutline
        plan={event}
        placement={placement}
        selected={selectedId === event.id}
        onSelect={() => onSelect(event.id)}
        onOpen={(anchor) => onOpen(event.id, anchor)}
      />
    ) : (
      <EventBlock
        kind="event"
        event={event}
        placement={placement}
        selected={selectedId === event.id}
        onSelect={() => onSelect(event.id)}
        onOpen={(anchor) => onOpen(event.id, anchor)}
      />
    );

  const slotStyle = (at: number, end: number, lane: number, lanes: number): CSSProperties =>
    ({ '--s': at - first, '--d': end - at, '--lane': lane, '--lanes': lanes }) as CSSProperties;

  return (
    <div
      className="ui-calendar-grid__time"
      style={{ '--ncols': days.length, '--nhours': count, '--grid-first': first } as CSSProperties}
      onPointerMove={onPointerMove}
      onPointerUp={() => finish(true)}
      onPointerCancel={() => finish(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && run.current) {
          e.stopPropagation();
          finish(false);
        }
      }}
    >
      <div className="ui-calendar-grid__head" role="row">
        <div className="ui-calendar-grid__corner" aria-hidden="true" />
        {days.map((day) => {
          const isToday = day === today;
          return (
            <div
              key={day}
              role="columnheader"
              className="ui-calendar-grid__dh"
              data-today={isToday ? 'true' : undefined}
              aria-label={dayTitle(day)}
              aria-current={isToday ? 'date' : undefined}
            >
              <span className="ui-calendar-grid__dow">{shortWeekday(day)}</span>
              <span className="ui-calendar-grid__num">{dateOf(day).getDate()}</span>
            </div>
          );
        })}
      </div>

      {hasAllDay ? (
        <div className="ui-calendar-grid__allday" role="row">
          <div className="ui-calendar-grid__corner" role="rowheader">
            All day
          </div>
          {perDay.map(({ day, allDay }) => (
            <div key={day} role="gridcell" className="ui-calendar-grid__allday-cell" aria-label={`${dayTitle(day)}, all day`}>
              {allDay.map((event) => (
                <div className="ui-calendar-grid__strip" key={event.id}>
                  {block(event, { lane: 0, lanes: 1, wide })}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}

      <div className="ui-calendar-grid__scroll">
        <div className="ui-calendar-grid__body" role="row">
          <div className="ui-calendar-grid__hours" aria-hidden="true">
            {Array.from({ length: count + 1 }, (_, i) => (
              <span key={i} className="ui-calendar-grid__hour" style={{ '--h': i } as CSSProperties}>
                {hourLabel(first + i)}
              </span>
            ))}
          </div>
          {perDay.map(({ day, layout, timed }, dayIndex) => {
            const isToday = day === today;
            return (
              <div
                key={day}
                role="gridcell"
                className="ui-calendar-grid__col"
                data-today={isToday ? 'true' : undefined}
                data-date={day}
                aria-label={dayTitle(day)}
              >
                <div
                  ref={(el) => {
                    trackRefs.current[dayIndex] = el;
                  }}
                  className="ui-calendar-grid__track"
                  onPointerDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    const p = snapHours(hoursAt(e.clientY, dayIndex));
                    begin(e, 'create', dayIndex, p, p);
                  }}
                  onDoubleClick={(e) => {
                    if (e.target !== e.currentTarget) return;
                    const at = Math.floor(hoursAt(e.clientY, dayIndex) * 2) / 2;
                    onCreate({ start: dateTimeAt(day, at), end: dateTimeAt(day, at + 1) });
                  }}
                >
                  {Array.from({ length: count + 1 }, (_, i) => (
                    <span key={i} className="ui-calendar-grid__line" aria-hidden="true" style={{ '--h': i } as CSSProperties} />
                  ))}
                  {layout.items.map((item) => {
                    const dragging = drag?.kind !== 'create' && drag?.id === item.event.id;
                    return (
                      <div
                        key={item.event.id}
                        className="ui-calendar-grid__slot"
                        data-beside={item.beside ? 'true' : undefined}
                        data-dragging={dragging ? 'true' : undefined}
                        style={slotStyle(item.at, item.end, item.lane, item.lanes)}
                        onPointerDown={(e) => {
                          if (!movable(item.event) || (e.target as HTMLElement).closest('[data-resize]')) return;
                          begin(e, 'move', dayIndex, item.at, item.end, item.event.id);
                        }}
                        onClickCapture={(e) => {
                          if (!suppressClick.current) return;
                          suppressClick.current = false;
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                      >
                        {block(item.event, { lane: item.lane, lanes: item.lanes, wide })}
                        {movable(item.event) ? (
                          <span
                            className="ui-calendar-grid__resize"
                            data-resize="true"
                            aria-hidden="true"
                            onPointerDown={(e) => begin(e, 'resize', dayIndex, item.at, item.end, item.event.id)}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                  {layout.stacks.map((stack) => (
                    <div
                      key={stack.events.map((e) => e.id).join('+')}
                      className="ui-calendar-grid__slot"
                      data-kind="stack"
                      style={slotStyle(stack.at, stack.end, 0, 1)}
                    >
                      <EventBlock
                        kind="stack"
                        ids={stack.events.map((e) => e.id)}
                        start={dateTimeAt(day, stack.at)}
                        end={dateTimeAt(day, stack.end)}
                        color={stack.events[0].calendar.color}
                        onOpen={(anchor) => onOpenStack(stack.events.map((e) => e.id), anchor)}
                      />
                    </div>
                  ))}
                  {drag && drag.dayIndex === dayIndex ? (
                    <div
                      className="ui-calendar-grid__drag"
                      data-kind={drag.kind}
                      aria-hidden="true"
                      style={
                        {
                          ...slotStyle(drag.at, drag.end, 0, 1),
                          '--cal': drag.id ? calVar(events.find((e) => e.id === drag.id)?.calendar.color ?? 'sky') : 'var(--accent)',
                        } as CSSProperties
                      }
                    >
                      {rangeOf(dateTimeAt(day, drag.at), dateTimeAt(day, drag.end))}
                    </div>
                  ) : null}
                  {isToday && nowHours >= first && nowHours <= last ? <NowLine now={now} variant="grid" /> : null}
                  {wide && timed.length === 0 && perDay[dayIndex].allDay.length === 0 && emptyAction ? (
                    <div className="ui-calendar-grid__empty" role="status">
                      <span>Nothing scheduled.</span>
                      <GridAction action={emptyAction} />
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
