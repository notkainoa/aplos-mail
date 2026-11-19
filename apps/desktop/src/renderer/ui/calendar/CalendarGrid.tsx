import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { CalendarGridProps } from '../props';
import { AgendaView } from './AgendaView';
import { rangeOf } from './dates';
import { eventDomId } from './eventText';
import { MonthGrid } from './MonthGrid';
import { ActiveStack } from './segment';
import { TimeGrid } from './TimeGrid';

/** One stop of the ↑ ↓ walk: a rendered entry, or a rendered "+N" / "N more" button that holds folded entries. */
interface Stop {
  domId: string;
  eventId?: string;
  at: number;
  el: HTMLElement;
}

/**
 * The stops that exist in the DOM, in reading order. Entries folded away have no element, so they are never
 * walked to; their "+N" or "N more" button stands in for them.
 */
function stopsOf(root: HTMLElement): Stop[] {
  const stops: Stop[] = [];
  root.querySelectorAll<HTMLElement>('[data-walk-at]').forEach(el => {
    if (!el.id) return;
    stops.push({ domId: el.id, eventId: el.dataset.eventId, at: Number(el.dataset.walkAt), el });
  });
  return stops.sort((a, b) => a.at - b.at || a.domId.localeCompare(b.domId));
}

/** The stop one step down (1) or up (-1) from the current one; ↑ with none current starts at the last. */
function nextStop(stops: readonly Stop[], current: string | null, step: 1 | -1): Stop | undefined {
  const at = stops.findIndex(x => x.domId === current);
  if (step === 1) return stops[Math.min(stops.length - 1, at + 1)];
  return stops[at < 0 ? stops.length - 1 : Math.max(0, at - 1)];
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
  const [activeStack, setActiveStack] = useState<string | null>(null);

  // A selection from outside (pointer, props) takes the walk off a "+N" button.
  useEffect(() => setActiveStack(null), [selectedId, view]);

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
    const id = activeStack ?? (selectedId ? eventDomId(selectedId) : null);
    if (id) document.getElementById(id)?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedId, activeStack]);

  const currentDomId = () => activeStack ?? (selectedId ? eventDomId(selectedId) : null);

  /** Move the walk to a stop: a "+N" button becomes the active descendant, an entry becomes the selection. */
  const walkTo = (next: Stop) => {
    if (next.eventId === undefined) {
      // A "+N" or "N more" button: it becomes the active descendant and Return opens it.
      setActiveStack(next.domId);
      announce?.(next.el.getAttribute('aria-label') ?? next.el.textContent ?? '');
      return;
    }
    setActiveStack(null);
    onSelect(next.eventId);
    const event = events.find(x => x.id === next.eventId);
    if (event)
      announce?.(`${event.title}, ${event.allDay ? 'all day' : rangeOf(event.start, event.end)}`);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    // The focused hours scroller keeps its arrows for scrolling.
    if ((e.target as HTMLElement).dataset.scroller === 'true') return;
    const walking = e.key === 'ArrowUp' || e.key === 'ArrowDown';
    // Buttons inside keep Return and Space for themselves; only the walk is shared.
    if (e.target !== e.currentTarget && !walking) return;
    const root = rootRef.current;
    const stops = root ? stopsOf(root) : [];
    if (stops.length === 0) return;
    const current = currentDomId();
    if (walking) {
      e.preventDefault();
      const next = nextStop(stops, current, e.key === 'ArrowDown' ? 1 : -1);
      if (next && next.domId !== current) walkTo(next);
      return;
    }
    if (e.key === 'Enter' && current) {
      const stop = stops.find(x => x.domId === current);
      if (!stop) return;
      e.preventDefault();
      if (stop.eventId === undefined) stop.el.click();
      else onOpen(stop.eventId, stop.el);
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
      aria-activedescendant={
        gridLike ? (activeStack ?? (selectedId ? eventDomId(selectedId) : undefined)) : undefined
      }
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <ActiveStack.Provider value={activeStack}>
        {view === 'agenda' ? (
          <AgendaView {...props} />
        ) : view === 'month' ? (
          <MonthGrid {...props} />
        ) : (
          <TimeGrid {...props} />
        )}
      </ActiveStack.Provider>
    </div>
  );
}
