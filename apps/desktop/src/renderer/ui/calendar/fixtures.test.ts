// Shared fixtures for the calendar family tests: demo events, grid props and the copy checks.
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { copyProblem } from '../../commands/internal';
import type { CalendarEventData, CalendarGridProps, CalendarInfo } from '../props';

export const noop = () => {};
export const NOW = '2026-10-29T10:00:00';
export const html = (node: React.ReactElement): string => renderToStaticMarkup(node);

/** Visible copy of a render: text nodes plus aria-label, title and placeholder values, entities decoded. */
export function copyOf(markup: string): string[] {
  const decode = (s: string): string =>
    s
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  const attrs = [...markup.matchAll(/(?:aria-label|title|placeholder)="([^"]*)"/g)].map(m =>
    decode(m[1]),
  );
  const text = markup
    .replace(/<[^>]+>/g, '\n')
    .split('\n')
    .map(t => decode(t.trim()))
    .filter(Boolean);
  return [...attrs, ...text];
}

export function assertCleanCopy(markup: string): void {
  for (const line of copyOf(markup)) assert.equal(copyProblem(line), null, `banned copy: ${line}`);
  assert.doesNotMatch(markup, /backdrop-filter|sparkle|wand|gradient/i);
}

export const cal = (id: string, name: string, color: CalendarInfo['color']) => ({
  id,
  name,
  color,
});
export const WORK = cal('work', 'Work', 'hill');
export const PERSONAL = cal('personal', 'Personal', 'sky');
export const HOLLOW = cal('hollow', 'Hollow Creek', 'ember');

export function ev(
  id: string,
  title: string,
  start: string,
  end: string,
  extra: Partial<CalendarEventData> = {},
): CalendarEventData {
  return { id, title, start, end, calendar: WORK, kind: 'event', persisted: true, ...extra };
}

export const DEMO: CalendarEventData[] = [
  ev('brunch', 'Brunch with Mom', '2026-10-25T10:00:00', '2026-10-25T11:30:00', {
    calendar: cal('family', 'Family', 'sand'),
  }),
  ev('dental', 'Northwind Dental', '2026-10-29T09:30:00', '2026-10-29T10:30:00', {
    calendar: PERSONAL,
    place: 'Northwind Dental, 14 Alder Street',
  }),
  ev('standup', 'Standup', '2026-10-29T11:00:00', '2026-10-29T11:15:00'),
  ev('design', 'Design review with Mina and Jordan', '2026-10-29T14:00:00', '2026-10-29T14:30:00', {
    calendar: HOLLOW,
    isOrganizer: true,
  }),
  ev('climb', 'Climbing with Theo', '2026-10-29T17:30:00', '2026-10-29T19:00:00', {
    calendar: PERSONAL,
  }),
  ev('q4', 'Q4 review', '2026-10-30T11:00:00', '2026-10-30T12:00:00', {
    unanswered: true,
    persisted: true,
  }),
  ev('lunch', 'Lunch with Leah', '2026-10-30T12:30:00', '2026-10-30T13:30:00', {
    calendar: PERSONAL,
  }),
  ev('launch', 'Hollow Creek launch prep', '2026-10-30T15:00:00', '2026-10-30T16:30:00', {
    calendar: HOLLOW,
    kind: 'plan',
    persisted: false,
    source: { from: 'Jordan Park', subject: 'Build timing', threadId: 't-9' },
  }),
  // Three overlapping entries on Wednesday: the first lane plus a "+2" stack.
  ev('o1', 'Focus time', '2026-10-28T10:00:00', '2026-10-28T12:00:00'),
  ev('o2', '1:1 with Mina', '2026-10-28T11:00:00', '2026-10-28T11:45:00', { calendar: HOLLOW }),
  ev('o3', 'Call Sami about the lease', '2026-10-28T11:15:00', '2026-10-28T11:30:00', {
    calendar: PERSONAL,
  }),
];

export const gridProps = (over: Partial<CalendarGridProps> = {}): CalendarGridProps => ({
  view: 'week',
  start: '2026-10-25',
  events: DEMO,
  now: NOW,
  weekStartsOn: 0,
  onSelect: noop,
  onOpen: noop,
  onCreate: noop,
  onMove: noop,
  onResize: noop,
  onOpenStack: noop,
  label: 'Week of October 25, 2026',
  ...over,
});
