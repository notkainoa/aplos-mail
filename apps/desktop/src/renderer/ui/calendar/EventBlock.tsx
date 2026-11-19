import { useContext } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import type { CalendarEventData, EventBlockProps } from '../props';
import { minutesBetween, rangeOf, timeOf } from './dates';
import {
  calVar,
  densityOf,
  eventDomId,
  eventLabel,
  stackDomId,
  TALL_MINUTES,
  walkAt,
} from './eventText';
import { ActiveStack, FirstSegment } from './segment';

/** A short tile alone in a narrow week column still says when it starts, "Weekly sync · 9:00 AM", if the tile has room. */
function compactStartOf(
  event: CalendarEventData,
  density: ReturnType<typeof densityOf>,
  lanes: number,
): string | null {
  if (lanes !== 1 || (density !== 'one' && density !== 'tiny')) return null;
  return timeOf(event.start);
}

function isTall(event: CalendarEventData, density: ReturnType<typeof densityOf>): boolean {
  return density === 'full' && minutesBetween(event.start, event.end) >= TALL_MINUTES;
}

/** The words a timed block draws beyond its title, and the name that carries them (WCAG 2.5.3). */
function blockWords(
  event: CalendarEventData,
  placement: { readonly wide: boolean; readonly lanes: number },
  density: ReturnType<typeof densityOf>,
) {
  // A wide day column has room beside the title, so a short tile (30 minutes or less included) says its time there.
  const showTime =
    density === 'full' || ((density === 'one' || density === 'tiny') && placement.wide);
  const compactStart = showTime ? null : compactStartOf(event, density, placement.lanes);
  // Overlapping tiles are narrow: the title takes one line (cut with an ellipsis) and the start time the second.
  const startOnly = placement.lanes > 1 && density === 'full' && !isTall(event, density);
  const time = startOnly ? timeOf(event.start) : rangeOf(event.start, event.end);
  const showPlace = placement.wide && !!event.place && density === 'full';
  const detail = showPlace ? `${time} · ${event.place}` : time;
  // The name holds every visible word: when the place is drawn, it is in the label too.
  // A compact tile draws only the start time ("· 9:00 AM"), so its name says that, like a crowded tile's.
  const label = eventLabel(event, {
    place: showPlace,
    startOnly: startOnly || compactStart !== null,
  });
  return { showTime, compactStart, detail, label };
}

/**
 * One entry on the grid: radius 6, a 2 px leading rule in the calendar colour, the DESIGN 4.2 fill composited over
 * the canvas, title `small` 500, time dim (dark: ink-2). Up to 30 minutes it is one title line using the full width. Or the "+N"
 * stack that folds the third and later overlapping entries (DESIGN 6 EventBlock, 7.8).
 *
 * CalendarGrid places it: a slot element around it carries the top, height and lane; the block fills the slot.
 */
/** A name this long wraps in a crowded lane (about 12 characters fit a 90 px tile): it takes two lines and the time line steps aside. */
const LONG_CROWDED_TITLE = 12;

export function EventBlock(props: EventBlockProps) {
  const first = useContext(FirstSegment);
  const activeStack = useContext(ActiveStack);
  if (props.kind === 'stack') {
    const count = props.ids.length;
    const domId = stackDomId(props.ids);
    return (
      <button
        type="button"
        id={domId}
        className="ui-event-block"
        data-kind="stack"
        data-walk-at={new Date(props.start).getTime()}
        data-active={activeStack === domId ? 'true' : undefined}
        tabIndex={-1}
        aria-haspopup="menu"
        aria-label={`${count} more ${count === 1 ? 'event' : 'events'} at ${timeOf(props.start)}`}
        title={`${count} more, ${rangeOf(props.start, props.end)}`}
        style={{ '--cal': calVar(props.color) } as CSSProperties}
        onClick={e => props.onOpen(e.currentTarget)}
      >
        <span className="ui-event-block__count">+{count}</span>
      </button>
    );
  }

  const { event, placement, selected, onSelect, onOpen } = props;
  const locked = props.locked ?? event.locked ?? false;
  const density = densityOf(event);
  const { showTime, compactStart, detail, label } = blockWords(event, placement, density);

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
      id={first ? eventDomId(event.id) : undefined}
      className="ui-event-block"
      data-walk-at={first ? walkAt(event) : undefined}
      data-kind="event"
      data-event-id={event.id}
      data-density={density}
      data-selected={selected ? 'true' : 'false'}
      data-wide={placement.wide ? 'true' : 'false'}
      data-compact-time={compactStart ? 'true' : undefined}
      data-crowded={placement.lanes > 1 ? 'true' : undefined}
      data-tall={isTall(event, density) ? 'true' : undefined}
      data-long-title={
        placement.lanes > 1 && event.title.length > LONG_CROWDED_TITLE ? 'true' : undefined
      }
      data-unanswered={event.unanswered ? 'true' : undefined}
      data-locked={locked ? 'true' : undefined}
      aria-pressed={selected}
      aria-label={label}
      tabIndex={-1}
      style={{ '--cal': calVar(event.calendar.color) } as CSSProperties}
      onClick={onSelect}
      onDoubleClick={e => onOpen(e.currentTarget)}
      onKeyDown={onKeyDown}
    >
      <span className="ui-event-block__title" dir="auto">
        {event.title}
      </span>
      {/* A whitespace text node: the block is a flex column that draws none, but the visible text then reads
          "Dental 9:30" like the label, which axe label-content-name-mismatch needs. */}
      {showTime ? ' ' : null}
      {showTime ? <span className="ui-event-block__time">{detail}</span> : null}
      {compactStart ? (
        <span className="ui-event-block__time" data-compact="true">
          · {compactStart}
        </span>
      ) : null}
    </button>
  );
}
