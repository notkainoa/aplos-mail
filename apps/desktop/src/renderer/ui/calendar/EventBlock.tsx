import { useContext } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import type { EventBlockProps } from '../props';
import { rangeOf, timeOf } from './dates';
import { calVar, densityOf, eventDomId, eventLabel, stackDomId, walkAt } from './eventText';
import { ActiveStack, FirstSegment } from './segment';

/**
 * One entry on the grid: radius 6, a 2 px leading rule in the calendar colour, the DESIGN 4.2 fill composited over
 * the canvas, title `small` 500, time dim (dark: ink-2). Under 30 minutes it is a single title line. Or the "+N"
 * stack that folds the third and later overlapping entries (DESIGN 6 EventBlock, 7.8).
 *
 * CalendarGrid places it: a slot element around it carries the top, height and lane; the block fills the slot.
 */
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
        onClick={(e) => props.onOpen(e.currentTarget)}
      >
        <span className="ui-event-block__count">+{count}</span>
      </button>
    );
  }

  const { event, placement, selected, onSelect, onOpen } = props;
  const density = densityOf(event);
  const showTime = density === 'full' || (density === 'one' && placement.wide);
  const time = rangeOf(event.start, event.end);
  const detail = placement.wide && event.place && density === 'full' ? `${time} · ${event.place}` : time;

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
      data-unanswered={event.unanswered ? 'true' : undefined}
      aria-pressed={selected}
      aria-label={eventLabel(event)}
      tabIndex={-1}
      style={{ '--cal': calVar(event.calendar.color) } as CSSProperties}
      onClick={onSelect}
      onDoubleClick={(e) => onOpen(e.currentTarget)}
      onKeyDown={onKeyDown}
    >
      <span className="ui-event-block__title" dir="auto">{event.title}</span>
      {showTime ? <span className="ui-event-block__time">{detail}</span> : null}
    </button>
  );
}
