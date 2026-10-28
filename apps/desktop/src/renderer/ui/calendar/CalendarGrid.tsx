import { useEffect, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { CalendarEventData, CalendarGridProps } from '../props';
import { AgendaView } from './AgendaView';
import { rangeOf } from './dates';
import { eventDomId } from './eventText';
import { MonthGrid } from './MonthGrid';
import { TimeGrid } from './TimeGrid';

/** Entries in reading order, the order ↑ and ↓ walk. */
function reading(events: readonly CalendarEventData[]): CalendarEventData[] {
  return [...events].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime() || a.id.localeCompare(b.id));
}

/**
 * The calendar grid (DESIGN 6 CalendarGrid, 7.8): `--line` hairlines at 56 px per hour, today's column on
 * `--today-tint` with a filled accent date badge, the now-line, overlap lanes with a "+N" stack, plans from mail,
 * month cells and the agenda list for narrow panes and the Today tab. A `grid` with `aria-activedescendant`
 * on the selected entry: ↑ and ↓ select, Return opens, drag on an empty hour creates, drag an entry to move or
 * resize it. Moves, resizes and creates report on release; the motion runtime owns the springs (`lift`, `snap`).
 */
export function CalendarGrid(props: CalendarGridProps) {
  const { view, events, selectedId, onSelect, onOpen, label, announce } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  // Announce range changes, but not the first render.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    announce?.(label);
  }, [label, announce]);

  // Keep the selected entry in view as ↑ and ↓ walk the list.
  useEffect(() => {
    if (!selectedId) return;
    document.getElementById(eventDomId(selectedId))?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedId]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.target !== e.currentTarget) {
      // Buttons inside keep Return and Space for themselves; only the walk is shared.
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    }
    const list = reading(events);
    if (list.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const at = list.findIndex((x) => x.id === selectedId);
      const next = e.key === 'ArrowDown' ? list[Math.min(list.length - 1, at + 1)] : list[at < 0 ? list.length - 1 : Math.max(0, at - 1)];
      if (!next || next.id === selectedId) return;
      onSelect(next.id);
      announce?.(`${next.title}, ${next.allDay ? 'all day' : rangeOf(next.start, next.end)}`);
      return;
    }
    if (e.key === 'Enter' && selectedId) {
      const el = rootRef.current?.querySelector<HTMLElement>(`[id="${eventDomId(selectedId)}"]`);
      if (el) {
        e.preventDefault();
        onOpen(selectedId, el);
      }
    }
  };

  const gridLike = view !== 'agenda';
  return (
    <div
      ref={rootRef}
      className="ui-calendar-grid"
      data-view={view}
      data-agenda={view === 'agenda' ? (props.agenda ?? 'full') : undefined}
      role={gridLike ? 'grid' : 'region'}
      aria-label={label}
      aria-activedescendant={gridLike && selectedId ? eventDomId(selectedId) : undefined}
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {view === 'agenda' ? <AgendaView {...props} /> : view === 'month' ? <MonthGrid {...props} /> : <TimeGrid {...props} />}
    </div>
  );
}
