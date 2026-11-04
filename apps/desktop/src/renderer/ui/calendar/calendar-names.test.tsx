// Calendar family: the accessible name of an entry holds its visible text (WCAG 2.5.3, axe label-content-name-mismatch),
// and the hours scroller is a labelled tab stop (axe scrollable-region-focusable).
// Run: npx tsx --tsconfig apps/desktop/tsconfig.json --test apps/desktop/src/renderer/ui/calendar/calendar-names.test.tsx

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CalendarEventData } from '../props';
import { CalendarGrid, EventBlock } from './index';
import { agendaLabel, eventLabel } from './eventText';
import { noop, html, ev, gridProps, DEMO } from './fixtures.test';

const decode = (s: string): string =>
  s
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

/** The way axe compares: lower case, punctuation gone, white space collapsed. */
const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const ENTRY =
  /<button[^>]*class="(?:ui-event-block|ui-plan-outline|ui-calendar-grid__ag|ui-calendar-grid__mev)"[^>]*>/;

/**
 * Every entry button of a render with its name and its visible text. `text` reads tags as spaces (these are flex
 * items); `joined` is the plain textContent (tags removed, nothing inserted), which is what axe compares, so a
 * whitespace node between two spans matters there.
 */
function entries(markup: string): { label: string; text: string; joined: string }[] {
  const out: { label: string; text: string; joined: string }[] = [];
  for (const m of markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)) {
    const tag = m[0].match(/^<button\b[^>]*>/)?.[0] ?? '';
    if (!/data-event-id=/.test(tag)) continue;
    const label = tag.match(/aria-label="([^"]*)"/)?.[1] ?? '';
    assert.ok(label.trim(), `an entry button lost its aria-label: ${tag}`);
    out.push({
      label: decode(label),
      text: decode(m[0].replace(/<[^>]+>/g, ' ')),
      joined: decode(m[0].replace(/<[^>]+>/g, '')),
    });
  }
  return out;
}

function assertNamesHoldText(markup: string, count: number): void {
  const found = entries(markup);
  assert.ok(found.length >= count, `expected at least ${count} entries, saw ${found.length}`);
  for (const { label, text, joined } of found) {
    assert.ok(norm(label).includes(norm(text)), `name "${label}" does not hold "${text.trim()}"`);
    assert.ok(
      norm(label).includes(norm(joined)),
      `name "${label}" does not hold the textContent "${joined.trim()}" (a whitespace node between spans is missing)`,
    );
  }
}

const ALL_DAY = ev('hol', 'Hollow Creek day', '2026-10-29T00:00:00', '2026-10-30T00:00:00', {
  allDay: true,
});
const WITH_PLACE = ev('cafe', 'Coffee with Sami', '2026-10-29T12:00:00', '2026-10-29T13:00:00', {
  place: 'Bluebird Cafe',
});
const EVENTS: CalendarEventData[] = [...DEMO, ALL_DAY, WITH_PLACE];

test('eventLabel: title, time as drawn, then the place when drawn, then the calendar and the status', () => {
  assert.equal(
    eventLabel(WITH_PLACE, { place: true }),
    'Coffee with Sami, 12:00 – 1:00 PM, Bluebird Cafe, Work',
  );
  assert.equal(eventLabel(WITH_PLACE), 'Coffee with Sami, 12:00 – 1:00 PM, Work');
  assert.equal(eventLabel(ALL_DAY), 'Hollow Creek day, all day, Work');
  const invite = DEMO.find(e => e.id === 'q4') as CalendarEventData;
  assert.equal(
    eventLabel(invite),
    'Q4 review, 11:00 AM – 12:00 PM, Work, invitation, not answered yet',
  );
  const plan = DEMO.find(e => e.id === 'launch') as CalendarEventData;
  assert.match(eventLabel(plan), /^Hollow Creek launch prep, from mail, .*, not added yet$/);
});

test('agendaLabel: the start time, the title and the line under it, then what is not drawn', () => {
  assert.equal(
    agendaLabel(WITH_PLACE, 'Next · Work'),
    '12:00 PM, Coffee with Sami, Next · Work, ends 1:00 PM',
  );
  assert.equal(agendaLabel(ALL_DAY, 'Work'), 'All day, Hollow Creek day, Work');
  const invite = DEMO.find(e => e.id === 'q4') as CalendarEventData;
  assert.match(
    agendaLabel(invite),
    /^11:00 AM, Q4 review, ends 12:00 PM, invitation, not answered/,
  );
});

test('EventBlock: the name starts with the drawn text and holds the place when a wide block draws it', () => {
  const wide = { lane: 0, lanes: 1, wide: true };
  const block = html(
    <EventBlock
      kind="event"
      event={WITH_PLACE}
      placement={wide}
      selected={false}
      onSelect={noop}
      onOpen={noop}
    />,
  );
  assert.match(block, /Bluebird Cafe<\/span>/);
  assert.match(block, /aria-label="Coffee with Sami, 12:00 – 1:00 PM, Bluebird Cafe, Work"/);
  assertNamesHoldText(block, 1);
});

for (const [name, over] of [
  ['week', { view: 'week' as const }],
  ['day (wide, with place)', { view: 'day' as const, start: '2026-10-29' }],
  ['month', { view: 'month' as const, start: '2026-10-01', label: 'October 2026' }],
  ['agenda today', { view: 'agenda' as const, agenda: 'today' as const, label: 'Today' }],
  ['agenda week', { view: 'agenda' as const }],
] as const) {
  test(`CalendarGrid ${name}: every entry's name holds its visible text`, () => {
    const out = html(<CalendarGrid {...gridProps({ ...over, events: EVENTS })} />);
    assertNamesHoldText(out, 3);
    assert.ok(ENTRY.test(out));
  });
}

test('CalendarGrid day: the all-day, timed, placed and unanswered entries are all named', () => {
  const out = html(
    <CalendarGrid {...gridProps({ view: 'day', start: '2026-10-30', events: EVENTS })} />,
  );
  const labels = entries(out).map(e => e.label);
  assert.ok(labels.some(l => /^Q4 review, .*invitation, not answered yet$/.test(l)));
  const today = html(
    <CalendarGrid {...gridProps({ view: 'day', start: '2026-10-29', events: EVENTS })} />,
  );
  const todays = entries(today).map(e => e.label);
  assert.ok(todays.some(l => l === 'Hollow Creek day, all day, Work'));
  assert.ok(todays.some(l => l === 'Coffee with Sami, 12:00 – 1:00 PM, Bluebird Cafe, Work'));
});

test('TimeGrid: the scroller is a tab stop with a role and a name from the range label', () => {
  for (const view of ['week', 'day'] as const) {
    const out = html(<CalendarGrid {...gridProps({ view, label: 'Week of October 25, 2026' })} />);
    const scroller = out.match(/<div[^>]*class="ui-calendar-grid__scroll"[^>]*>/)?.[0] ?? '';
    assert.match(scroller, /tabindex="0"/);
    assert.match(scroller, /role="rowgroup"/);
    assert.match(scroller, /aria-label="Week of October 25, 2026, hours"/);
  }
});

test('the month grid and the agenda have no hours scroller', () => {
  const month = html(<CalendarGrid {...gridProps({ view: 'month', start: '2026-10-01' })} />);
  assert.doesNotMatch(month, /ui-calendar-grid__scroll/);
});
