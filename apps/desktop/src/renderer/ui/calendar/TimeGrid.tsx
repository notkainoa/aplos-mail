/**
 * The day and week body of CalendarGrid: day headers, an all-day strip, the hour gutter and one column per day
 * with 56 px per hour, lanes, the "+N" stack, the now-line and pointer drag (create, move, resize).
 * Internal to the calendar family; CalendarGrid is the public component.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { CalendarEventData, CalendarGridProps } from '../props';
import {
  dateOf,
  dateTimeAt,
  dayOf,
  DAY_HOURS,
  dayTitle,
  hourLabel,
  openHour,
  rangeOf,
  shortWeekday,
  snapHours,
} from './dates';
import { EventBlock } from './EventBlock';
import { calVar } from './eventText';
import { GridAction } from './GridAction';
import {
  allDayOn,
  daysOf,
  dragRange,
  lanesFor,
  layoutDay,
  MAX_LANES,
  allDayRows,
  timedOn,
  type Timed,
} from './layout';
import { NowLine } from './NowLine';
import { PlanOutline } from './PlanOutline';
import { keepGridFocus } from './press-focus';
import { FirstSegment } from './segment';

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
  /** The element that took the press and its pointer, captured only once the press becomes a drag. */
  el: HTMLElement;
  pointerId: number;
}

/**
 * The hour label the scroller's bottom edge would cut in half sits just below the edge instead: the grid opens a few
 * pixels earlier, so the visible window ends between two labels. Opening only; scrolling afterwards is the reader's.
 */
function clearLabelAtEdge(scroller: HTMLElement): void {
  const edge = scroller.getBoundingClientRect().bottom;
  for (const label of scroller.querySelectorAll('.ui-calendar-grid__hour')) {
    const box = label.getBoundingClientRect();
    if (box.top < edge && box.bottom > edge) {
      scroller.scrollTop = Math.max(0, scroller.scrollTop - (edge - box.top) - 1);
      return;
    }
  }
}

/** Pixels the pointer must travel before a press becomes a drag, so a click still selects. */
const DRAG_SLOP = 4;

export function TimeGrid(props: CalendarGridProps) {
  const {
    view,
    start,
    events,
    now,
    selectedId,
    onSelect,
    onOpen,
    onCreate,
    onMove,
    onResize,
    onOpenStack,
    emptyAction,
    scrollToHour,
  } = props;
  const wide = view === 'day';
  const days = daysOf(wide ? 'day' : 'week', start);
  const today = dayOf(now);
  // Lanes are limited by width as well as by count: none narrower than 44 px (DESIGN 7.8). Unknown width (first
  // render, no layout) uses the count alone.
  const [colWidth, setColWidth] = useState(0);
  const maxLanes = lanesFor(colWidth, wide ? MAX_LANES.day : MAX_LANES.week);

  const perDay = days.map(day => {
    const timed = events.map(e => timedOn(e, day)).filter((t): t is Timed => t !== null);
    return { day, timed, allDay: allDayOn(events, day), layout: layoutDay(timed, maxLanes) };
  });
  // The whole day is always drawn; the body scrolls (see the opening scroll below).
  const first = 0;
  const count = DAY_HOURS;
  const hasAllDay = perDay.some(d => d.allDay.length > 0);
  const dayRows = allDayRows(events, days);
  const rowCount = Math.max(0, ...[...dayRows.values()].map(r => r + 1));
  const nowHours = new Date(now).getHours() + new Date(now).getMinutes() / 60;

  const scrollRef = useRef<HTMLDivElement>(null);
  const trackRefs = useRef<Array<HTMLDivElement | null>>([]);
  const run = useRef<DragRun | null>(null);
  const suppressClick = useRef(false);
  const [drag, setDrag] = useState<DragState | null>(null);

  // Opens at 8 AM, or at now when today is shown (or at `scrollToHour`); runs on mount and when the view changes,
  // so paging between weeks keeps the reader's place. A grid mounted without layout (a hidden tab or dock, a pane
  // laid out after mount; the first render in tests) has no height yet: the scroll waits, once, for the first
  // layout instead of being lost. The deferred scroll uses the latest open hour (read through the ref), not the
  // hour from mount.
  const opensAt = useRef(0);
  opensAt.current = openHour({ today: days.includes(today), nowHours, override: scrollToHour });
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const track = trackRefs.current[0];
    if (!scroller || !track) return;
    const open = (): boolean => {
      const perHour = track.offsetHeight / DAY_HOURS;
      if (perHour <= 0) return false;
      scroller.scrollTop = perHour * opensAt.current;
      // The pane settles after the first layout (header rows, fonts), so the edge is checked again a frame later.
      frame = requestAnimationFrame(() => clearLabelAtEdge(scroller));
      return true;
    };
    let frame = 0;
    if (open() || typeof ResizeObserver === 'undefined') return () => cancelAnimationFrame(frame);
    const observer = new ResizeObserver(() => {
      if (open()) observer.disconnect();
    });
    observer.observe(track);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [view]);

  useEffect(() => {
    const track = trackRefs.current[0];
    if (!track) return;
    const measure = (): void => setColWidth(Math.round(track.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [view]);

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

  const begin = (
    e: ReactPointerEvent<HTMLElement>,
    kind: DragState['kind'],
    dayIndex: number,
    at: number,
    end: number,
    id?: string,
  ): void => {
    if (e.button !== 0) return;
    const pointer = hoursAt(e.clientY, dayIndex);
    // No capture yet: a plain click must still land on the entry (capture would retarget it to the slot).
    run.current = {
      kind,
      id,
      dayIndex,
      origin: { at, end, pointer },
      x: e.clientX,
      y: e.clientY,
      moved: false,
      el: e.currentTarget,
      pointerId: e.pointerId,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const r = run.current;
    if (!r) return;
    if (!r.moved && Math.hypot(e.clientX - r.x, e.clientY - r.y) < DRAG_SLOP) return;
    if (!r.moved) r.el.setPointerCapture?.(r.pointerId);
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
    if (r.kind !== 'create') {
      // The click that ends a move or resize must not select; a create ends on the empty track, which has no click.
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
    }
    if (!commit || !state) return;
    const day = days[state.dayIndex];
    const range = { start: dateTimeAt(day, state.at), end: dateTimeAt(day, state.end) };
    if (state.kind === 'create') onCreate(range);
    else if (state.kind === 'move' && state.id) {
      if (state.dayIndex !== r.dayIndex || state.at !== r.origin.at) onMove(state.id, range);
    } else if (state.kind === 'resize' && state.id && state.end !== r.origin.end)
      onResize(state.id, range.end);
  };

  // Esc cancels a drag that is under way wherever focus is (a press on an empty track focuses the grid root).
  const finishRef = useRef(finish);
  finishRef.current = finish;
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      finishRef.current(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dragging]);

  const movable = (e: CalendarEventData): boolean =>
    e.kind === 'event' && e.persisted && !e.allDay && !e.locked;

  const block = (
    event: CalendarEventData,
    placement: { lane: number; lanes: number; wide: boolean },
  ): ReactNode =>
    event.kind === 'plan' ? (
      <PlanOutline
        plan={event}
        placement={placement}
        selected={selectedId === event.id}
        onSelect={() => onSelect(event.id)}
        onOpen={anchor => onOpen(event.id, anchor)}
      />
    ) : (
      <EventBlock
        kind="event"
        event={event}
        placement={placement}
        selected={selectedId === event.id}
        onSelect={() => onSelect(event.id)}
        onOpen={anchor => onOpen(event.id, anchor)}
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
    >
      <div className="ui-calendar-grid__head" role="row">
        <div className="ui-calendar-grid__corner" aria-hidden="true" />
        {days.map(day => {
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
          {perDay.map(({ day, allDay }, dayIndex) => (
            <div key={day} role="gridcell" className="ui-calendar-grid__allday-cell">
              {/* The cell's name comes from its content, which holds the visible titles; a label would hide them. */}
              <span className="ui-sr-only">{`${dayTitle(day)}, all day`}</span>
              {Array.from({ length: rowCount }, (_, row) => {
                const event = allDay.find(e => dayRows.get(e.id) === row);
                if (!event) return <div className="ui-calendar-grid__strip" key={`gap-${row}`} />;
                const before =
                  dayIndex > 0 && perDay[dayIndex - 1].allDay.some(x => x.id === event.id);
                const after =
                  dayIndex < perDay.length - 1 &&
                  perDay[dayIndex + 1].allDay.some(x => x.id === event.id);
                return (
                  <div
                    className="ui-calendar-grid__strip"
                    key={event.id}
                    data-joins-before={before ? 'true' : undefined}
                    data-joins-after={after ? 'true' : undefined}
                  >
                    {/* A multi-day entry is one bar: it shows on each day it covers, but only its first segment is the DOM target. */}
                    <FirstSegment.Provider value={!before}>
                      {block(event, { lane: 0, lanes: 1, wide })}
                    </FirstSegment.Provider>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}

      {/* The hours scroll, so the scroller is a tab stop: a rowgroup (a plain role would break the grid's rows) named by
          the range, and PageUp, PageDown and the arrows scroll it natively (the grid's own walk skips it). Naming a
          rowgroup is not reliably announced; the label is kept for the tools that do read it. A mouse press inside
          keeps focus on the grid root (see press-focus), so the arrows still walk the entries after a click. */}
      <div
        className="ui-calendar-grid__scroll"
        ref={scrollRef}
        role="rowgroup"
        aria-label={`${props.label}, hours`}
        tabIndex={0}
        data-scroller="true"
        onMouseDown={e =>
          keepGridFocus(e, e.currentTarget.closest<HTMLElement>('.ui-calendar-grid'))
        }
      >
        <div className="ui-calendar-grid__body" role="row">
          <div className="ui-calendar-grid__hours" aria-hidden="true">
            {/* One label per hour; the line that closes the day (the second midnight) has none. */}
            {Array.from({ length: count }, (_, i) => (
              <span
                key={i}
                className="ui-calendar-grid__hour"
                style={{ '--h': i } as CSSProperties}
              >
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
              >
                <span className="ui-sr-only">{dayTitle(day)}</span>
                <div
                  ref={el => {
                    trackRefs.current[dayIndex] = el;
                  }}
                  className="ui-calendar-grid__track"
                  onPointerDown={e => {
                    if (e.target !== e.currentTarget) return;
                    const p = snapHours(hoursAt(e.clientY, dayIndex));
                    begin(e, 'create', dayIndex, p, p);
                  }}
                  onDoubleClick={e => {
                    if (e.target !== e.currentTarget) return;
                    const at = Math.floor(hoursAt(e.clientY, dayIndex) * 2) / 2;
                    onCreate({ start: dateTimeAt(day, at), end: dateTimeAt(day, at + 1) });
                  }}
                >
                  {Array.from({ length: count + 1 }, (_, i) => (
                    <span
                      key={i}
                      className="ui-calendar-grid__line"
                      aria-hidden="true"
                      style={{ '--h': i } as CSSProperties}
                    />
                  ))}
                  {layout.items.map(item => {
                    const dragging = drag?.kind !== 'create' && drag?.id === item.event.id;
                    return (
                      <div
                        key={item.event.id}
                        className="ui-calendar-grid__slot"
                        data-beside={item.beside ? 'true' : undefined}
                        data-dragging={dragging ? 'true' : undefined}
                        style={slotStyle(item.at, item.end, item.lane, item.lanes)}
                        onPointerDown={e => {
                          if (
                            !movable(item.event) ||
                            (e.target as HTMLElement).closest('[data-resize]')
                          )
                            return;
                          begin(e, 'move', dayIndex, item.at, item.end, item.event.id);
                        }}
                        onClickCapture={e => {
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
                            onPointerDown={e =>
                              begin(e, 'resize', dayIndex, item.at, item.end, item.event.id)
                            }
                          />
                        ) : null}
                      </div>
                    );
                  })}
                  {layout.stacks.map(stack => (
                    <div
                      key={stack.events.map(e => e.id).join('+')}
                      className="ui-calendar-grid__slot"
                      data-kind="stack"
                      data-alone={stack.alone ? 'true' : undefined}
                      style={slotStyle(stack.at, stack.end, 0, 1)}
                    >
                      <EventBlock
                        kind="stack"
                        ids={stack.events.map(e => e.id)}
                        start={dateTimeAt(day, stack.at)}
                        end={dateTimeAt(day, stack.end)}
                        color={stack.events[0].calendar.color}
                        onOpen={anchor =>
                          onOpenStack(
                            stack.events.map(e => e.id),
                            anchor,
                          )
                        }
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
                          '--cal': drag.id
                            ? calVar(events.find(e => e.id === drag.id)?.calendar.color ?? 'sky')
                            : 'var(--accent)',
                        } as CSSProperties
                      }
                    >
                      {rangeOf(dateTimeAt(day, drag.at), dateTimeAt(day, drag.end))}
                    </div>
                  ) : null}
                  {isToday ? <NowLine now={now} variant="grid" /> : null}
                  {wide &&
                  timed.length === 0 &&
                  perDay[dayIndex].allDay.length === 0 &&
                  emptyAction ? (
                    <div className="ui-calendar-grid__empty" role="status">
                      <span>Nothing scheduled</span>
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
