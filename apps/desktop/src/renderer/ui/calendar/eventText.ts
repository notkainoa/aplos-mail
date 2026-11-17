/** Shared wording and ids for entries on the grid (EventBlock, PlanOutline, the agenda and month cells). */
import type { CalendarEventData, TagColor } from '../props';
import { minutesBetween, rangeOf, timeOf } from './dates';

/** Encodes `id` to id-safe characters, one to one: anything outside letters, digits and "-" becomes `_<hex>_`. */
function safe(id: string): string {
  return id.replace(/[^A-Za-z0-9-]/g, c => `_${(c.codePointAt(0) ?? 0).toString(16)}_`);
}

/** A DOM id for an entry, safe for `aria-activedescendant`. Distinct ids never share a DOM id. */
export function eventDomId(id: string): string {
  return `ui-event-${safe(id)}`;
}

/** A DOM id for a "+N" or "N more" button: keyed by the first entry it holds. */
export function stackDomId(ids: readonly string[]): string {
  return `ui-stack-${safe(ids[0] ?? '')}`;
}

/** The start of an entry in ms, the `data-walk-at` that orders ↑ and ↓. */
export function walkAt(event: CalendarEventData): number {
  return new Date(event.start).getTime();
}

/** Value of the `--cal` custom property: the calendar's tag colour. */
export function calVar(color: TagColor): string {
  return `var(--tag-${color})`;
}

/** How much a block can show: up to 30 minutes is the title alone on one full-width line, under an hour a title and time on one line. */
export type BlockDensity = 'allday' | 'tiny' | 'one' | 'full';

/** From this length a tile in a crowded lane has a line to spare below its title, so its time shows too. */
export const TALL_MINUTES = 90;

export function densityOf(event: CalendarEventData): BlockDensity {
  if (event.allDay) return 'allday';
  const minutes = minutesBetween(event.start, event.end);
  return minutes <= 30 ? 'tiny' : minutes < 60 ? 'one' : 'full';
}

/** The time as written in a label: "2:00 – 2:30 PM" or "all day". */
export function whenOf(event: CalendarEventData): string {
  return event.allDay ? 'all day' : rangeOf(event.start, event.end);
}

/** What a grid block draws beyond its title and time, so the name can say the same words in the same order. */
export interface LabelDrawn {
  /** The place is drawn after the time (a wide, full-height block). */
  readonly place?: boolean;
}

/** Accessible name of an entry. It begins with the words the block draws, in the order it draws them (title, time,
 * then the place when it is drawn), and only then adds what is not drawn: its calendar and its status. So the name
 * always holds the visible text (WCAG 2.5.3). A plan says "from mail" right after the title, as the outline does. */
export function eventLabel(event: CalendarEventData, drawn: LabelDrawn = {}): string {
  if (event.kind === 'plan')
    return [event.title, 'from mail', whenOf(event), 'not added yet'].join(', ');
  const place = drawn.place && event.place ? [event.place] : [];
  const parts = [event.title, whenOf(event), ...place, event.calendar.name];
  if (event.unanswered) parts.push('invitation, not answered yet');
  return parts.join(', ');
}

/** Accessible name of an agenda row. The row draws the start time, the title, then `sub`, so the name starts with
 * those three, then says what the row does not: when it ends, that a plan is from mail and not added yet, and an
 * invitation that is still unanswered. */
export function agendaLabel(event: CalendarEventData, sub?: string): string {
  const lead = event.allDay ? 'All day' : timeOf(event.start);
  const parts = [lead, event.title];
  if (sub) parts.push(sub);
  if (!event.allDay) parts.push(`ends ${timeOf(event.end)}`);
  if (event.kind === 'plan') parts.push('from mail, not added yet');
  if (event.unanswered) parts.push('invitation, not answered yet');
  return parts.join(', ');
}

/** Start time only, for a stack's label. */
export function startOf(event: CalendarEventData): string {
  return event.allDay ? 'all day' : timeOf(event.start);
}
