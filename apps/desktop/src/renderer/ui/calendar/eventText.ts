/** Shared wording and ids for entries on the grid (EventBlock, PlanOutline, the agenda and month cells). */
import type { CalendarEventData, TagColor } from '../props';
import { minutesBetween, rangeOf, timeOf } from './dates';

/** A DOM id for an entry, safe for `aria-activedescendant`. */
export function eventDomId(id: string): string {
  return `ui-event-${id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

/** Value of the `--cal` custom property: the calendar's tag colour. */
export function calVar(color: TagColor): string {
  return `var(--tag-${color})`;
}

/** How much a block can show: under 30 minutes is a single title line, under an hour a single line. */
export type BlockDensity = 'allday' | 'tiny' | 'one' | 'full';

export function densityOf(event: CalendarEventData): BlockDensity {
  if (event.allDay) return 'allday';
  const minutes = minutesBetween(event.start, event.end);
  return minutes < 30 ? 'tiny' : minutes < 60 ? 'one' : 'full';
}

/** The time as written in a label: "2:00 – 2:30 PM" or "all day". */
export function whenOf(event: CalendarEventData): string {
  return event.allDay ? 'all day' : rangeOf(event.start, event.end);
}

/** Accessible name of an entry: title, time, then its calendar or its status. */
export function eventLabel(event: CalendarEventData): string {
  const parts = [event.title, whenOf(event)];
  if (event.kind === 'plan') parts.push('found in mail, not added yet');
  else {
    parts.push(event.calendar.name);
    if (event.unanswered) parts.push('invitation, not answered yet');
  }
  return parts.join(', ');
}

/** Start time only, for a stack's label. */
export function startOf(event: CalendarEventData): string {
  return event.allDay ? 'all day' : timeOf(event.start);
}
