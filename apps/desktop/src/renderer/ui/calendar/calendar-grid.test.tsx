// Calendar family: CalendarGrid in week, day, month and agenda views.
// Run: npx tsx --tsconfig apps/desktop/tsconfig.json --test apps/desktop/src/renderer/ui/calendar/calendar-grid.test.tsx

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CalendarGrid } from './index';
import { allDayRows } from './layout';
import { noop, html, assertCleanCopy, ev, gridProps } from './fixtures.test';

/* ---------------------------------- CalendarGrid ---------------------------------- */

test('CalendarGrid week: a labelled grid, seven day headers, today badge, hour labels, now-line once', () => {
  const out = html(<CalendarGrid {...gridProps()} />);
  assert.match(out, /role="grid"/);
  assert.match(out, /aria-label="Week of October 25, 2026"/);
  assert.equal((out.match(/role="columnheader"/g) ?? []).length, 7);
  assert.match(out, /aria-label="Sunday, October 25, 2026"/);
  assert.match(
    out,
    /data-today="true"[^>]*aria-label="Thursday, October 29, 2026"[^>]*aria-current="date"/,
  );
  // The whole day is drawn: 24 hour labels, and 25 lines per column (the last closes the day).
  assert.equal((out.match(/class="ui-calendar-grid__hour"/g) ?? []).length, 24);
  assert.match(out, />12 AM</);
  assert.match(out, />8 AM</);
  assert.match(out, />8 PM</);
  assert.match(out, />11 PM</);
  assert.equal((out.match(/class="ui-now-line"/g) ?? []).length, 1);
  assert.equal((out.match(/class="ui-calendar-grid__line"/g) ?? []).length, 7 * 25);
  assert.match(out, /--ncols:7/);
  assert.match(out, /tabindex="0"/);
  assertCleanCopy(out);
});

test('CalendarGrid week: plans show "From mail", three overlaps show the first lane and "+2"', () => {
  const out = html(<CalendarGrid {...gridProps()} />);
  assert.match(out, /From mail/);
  assert.match(out, /class="ui-plan-outline"/);
  assert.match(out, />\+2</);
  assert.match(out, /data-beside="true"/);
  assert.match(out, /aria-label="2 more events at 11:00 AM"/);
  // Two events in the same slot share it: lane 0 of 2 and lane 1 of 2.
  const two = html(
    <CalendarGrid
      {...gridProps({
        events: [
          ev('a', 'First', '2026-10-27T10:00:00', '2026-10-27T11:00:00'),
          ev('b', 'Second', '2026-10-27T10:30:00', '2026-10-27T11:30:00'),
        ],
      })}
    />,
  );
  assert.match(two, /--lane:0;--lanes:2/);
  assert.match(two, /--lane:1;--lanes:2/);
  assert.doesNotMatch(two, /\+\d/);
});

test('CalendarGrid week: an overlapped tile of 90 minutes or more is tall, so it keeps its time line', () => {
  const out = html(
    <CalendarGrid
      {...gridProps({
        events: [
          ev('a', 'Long one', '2026-10-27T10:00:00', '2026-10-27T12:00:00'),
          ev('b', 'Short one', '2026-10-27T10:30:00', '2026-10-27T11:30:00'),
        ],
      })}
    />,
  );
  assert.equal((out.match(/data-tall="true"/g) ?? []).length, 1);
});

/** Elements the ↑ ↓ walk can land on in a render: those with a walk time and an id. */
function walkables(markup: string): string[] {
  return [...markup.matchAll(/<[^>]*data-walk-at="[^"]*"[^>]*>/g)].map(
    m => /\sid="([^"]*)"/.exec(m[0])?.[1] ?? '',
  );
}

test('CalendarGrid day: with seven overlaps every walkable element has its own id; folded entries are reached through "+N"', () => {
  const seven = Array.from({ length: 7 }, (_, i) =>
    ev(`o${i + 1}`, `Overlap ${i + 1}`, '2026-10-28T10:00:00', '2026-10-28T12:30:00'),
  );
  const out = html(
    <CalendarGrid
      {...gridProps({
        view: 'day',
        start: '2026-10-28',
        events: seven,
        label: 'Wednesday, October 28, 2026',
      })}
    />,
  );
  const ids = walkables(out);
  assert.equal(ids.length, 6); // five entries and one stack
  assert.ok(ids.every(Boolean));
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('ui-stack-o6'));
  assert.doesNotMatch(out, /id="ui-event-o6"/);
  // Five different lanes, none stacked on another.
  const lanes = [...out.matchAll(/--lane:(\d);--lanes:5/g)].map(m => m[1]);
  assert.deepEqual([...new Set(lanes)].sort(), ['0', '1', '2', '3', '4']);
  assert.match(out, />\+2</);
});

test('CalendarGrid: a multi-day all-day entry has one DOM id in week and month, and the agenda', () => {
  const trip = ev('trip', 'Trip to Hollow Creek', '2026-10-27', '2026-10-30', { allDay: true });
  for (const view of ['week', 'month'] as const) {
    const out = html(
      <CalendarGrid
        {...gridProps({
          view,
          start: view === 'week' ? '2026-10-25' : '2026-10-01',
          events: [trip],
        })}
      />,
    );
    assert.equal((out.match(/id="ui-event-trip"/g) ?? []).length, 1, view);
    assert.equal(walkables(out).length, 1, view);
  }
  const agenda = html(
    <CalendarGrid
      {...gridProps({ view: 'agenda', agenda: 'full', start: '2026-10-25', events: [trip] })}
    />,
  );
  assert.equal((agenda.match(/id="ui-event-trip"/g) ?? []).length, 1);
  // Ids that only differ in punctuation still stay apart.
  const two = html(
    <CalendarGrid
      {...gridProps({
        events: [
          ev('a b', 'One', '2026-10-27T10:00:00', '2026-10-27T11:00:00'),
          ev('a-b', 'Two', '2026-10-27T12:00:00', '2026-10-27T13:00:00'),
        ],
      })}
    />,
  );
  assert.equal(new Set(walkables(two)).size, 2);
});

test('CalendarGrid month: "N more" is a walkable stop with its own id', () => {
  const crowded = ['a', 'b', 'c', 'd'].map((id, i) =>
    ev(
      id,
      `Item ${id}`,
      `2026-10-29T${String(8 + i).padStart(2, '0')}:00:00`,
      `2026-10-29T${String(8 + i).padStart(2, '0')}:30:00`,
    ),
  );
  const out = html(
    <CalendarGrid
      {...gridProps({ view: 'month', start: '2026-10-01', events: crowded, label: 'October 2026' })}
    />,
  );
  const ids = walkables(out);
  assert.equal(ids.length, 3); // a, b and "2 more"
  assert.ok(ids.some(id => id.startsWith('ui-stack-')));
  assert.ok(ids.every(Boolean));
});

test('CalendarGrid: the selected entry is the active descendant and is pressed', () => {
  const out = html(<CalendarGrid {...gridProps({ selectedId: 'q4' })} />);
  assert.match(out, /aria-activedescendant="ui-event-q4"/);
  assert.match(out, /id="ui-event-q4"[^>]*data-selected="true"/);
});

test('CalendarGrid day: wide columns, an empty day says "Nothing scheduled" with New event and its key', () => {
  const empty = html(
    <CalendarGrid
      {...gridProps({
        view: 'day',
        start: '2026-11-01',
        events: [],
        label: 'Sunday, November 1, 2026',
        emptyAction: { label: 'New event', commandId: 'calendar.newEvent', onSelect: noop },
      })}
    />,
  );
  assert.match(empty, /Nothing scheduled(?!\.)/);
  assert.match(empty, />New event</);
  assert.match(empty, /<kbd class="ui-cal-kbd">N<\/kbd>/);
  assert.equal((empty.match(/role="columnheader"/g) ?? []).length, 1);
  assert.equal((empty.match(/ui-now-line/g) ?? []).length, 0);
  const full = html(
    <CalendarGrid
      {...gridProps({ view: 'day', start: '2026-10-29', label: 'Thursday, October 29, 2026' })}
    />,
  );
  assert.match(full, /data-wide="true"/);
  assert.match(full, /9:30 – 10:30 AM · Northwind Dental, 14 Alder Street/);
  assert.doesNotMatch(full, /Nothing scheduled/);
});

test('CalendarGrid: an early entry sits on the full-day scale; all-day entries get a strip', () => {
  const out = html(
    <CalendarGrid
      {...gridProps({
        events: [
          ev('early', 'Flight', '2026-10-29T06:30:00', '2026-10-29T07:30:00'),
          ev('trip', 'Offsite', '2026-10-29T00:00:00', '2026-10-30T00:00:00', { allDay: true }),
        ],
      })}
    />,
  );
  assert.match(out, />6 AM</);
  assert.match(out, /--nhours:24/);
  assert.match(out, /--grid-first:0/);
  assert.match(out, /All day/);
  assert.match(out, /Offsite, all day, Work/);
});

test('CalendarGrid month: only the weeks of the month, "N more" past three, never a lonely "1 more"', () => {
  const crowded = ['a', 'b', 'c', 'd'].map((id, i) =>
    ev(
      id,
      `Item ${id}`,
      `2026-10-29T${String(8 + i).padStart(2, '0')}:00:00`,
      `2026-10-29T${String(8 + i).padStart(2, '0')}:30:00`,
    ),
  );
  const three = crowded.slice(0, 3);
  const out = html(
    <CalendarGrid
      {...gridProps({ view: 'month', start: '2026-10-01', events: crowded, label: 'October 2026' })}
    />,
  );
  assert.equal((out.match(/role="gridcell"/g) ?? []).length, 35, 'five weeks hold October 2026');
  assert.match(out, /2 more/);
  assert.match(out, /aria-label="2 more events on Thursday, October 29, 2026"/);
  const calm = html(
    <CalendarGrid
      {...gridProps({ view: 'month', start: '2026-10-01', events: three, label: 'October 2026' })}
    />,
  );
  assert.doesNotMatch(calm, /more</);
  assert.match(calm, /Item c/);
});

test('CalendarGrid agenda today: header, now-line, next event, following gaps', () => {
  const out = html(
    <CalendarGrid {...gridProps({ view: 'agenda', agenda: 'today', label: 'Today' })} />,
  );
  assert.match(out, /<h2[^>]*>Thursday, October 29<\/h2>/);
  assert.match(out, /4 left today · next at 11:00 AM/);
  assert.match(out, /role="separator"[^>]*aria-label="Now, 10:00 AM"/);
  assert.match(out, /Next · Work · 15 min/);
  assert.match(out, /Free for 2 h 45 min/);
  assert.match(out, /Free for 3 h/);
  assert.match(out, /Now · Personal · 1 h/);
  assert.ok(out.indexOf('Standup') < out.indexOf('Design review'));
  // Nothing has ended yet, so no "earlier" line.
  assert.doesNotMatch(out, /ui-calendar-grid__earlier/);
  assertCleanCopy(out);
});

test('CalendarGrid agenda today: a gap is measured from the running end, not the last shown event', () => {
  const out = html(
    <CalendarGrid
      {...gridProps({
        view: 'agenda',
        agenda: 'today',
        now: '2026-10-29T09:30:00',
        label: 'Today',
        events: [
          ev('a', 'Offsite', '2026-10-29T10:00:00', '2026-10-29T13:00:00'),
          ev('b', 'Standup', '2026-10-29T11:00:00', '2026-10-29T11:30:00'),
          ev('c', 'Design review', '2026-10-29T14:00:00', '2026-10-29T15:00:00'),
        ],
      })}
    />,
  );
  // B ends inside A: C's free stretch starts at A's 13:00 end — one hour, not 2 h 30 min.
  assert.match(out, /Free for 30 min</);
  assert.match(out, /Free for 1 h</);
  assert.doesNotMatch(out, /Free for 2 h 30 min/);
});

test('CalendarGrid agenda today: finished events fold into one "N earlier" line', () => {
  const out = html(
    <CalendarGrid
      {...gridProps({
        view: 'agenda',
        agenda: 'today',
        label: 'Today',
        events: [
          ev('a', 'Breakfast with Leah', '2026-10-29T07:00:00', '2026-10-29T08:00:00'),
          ev('b', 'Call Sami', '2026-10-29T08:00:00', '2026-10-29T09:00:00'),
          ev('c', 'Budget check', '2026-10-29T09:00:00', '2026-10-29T09:30:00'),
          ev('d', 'Standup', '2026-10-29T11:00:00', '2026-10-29T11:15:00'),
          ev('e', 'Design review', '2026-10-29T14:00:00', '2026-10-29T14:30:00'),
        ],
      })}
    />,
  );
  // Three finished + two left: the rows are only what is left, the rest one quiet count.
  assert.match(out, /2 left today · next at 11:00 AM/);
  assert.equal((out.match(/class="ui-calendar-grid__ag"/g) ?? []).length, 2);
  assert.match(out, /3 earlier/);
  assert.doesNotMatch(out, /Breakfast with Leah|Budget check/);
  assertCleanCopy(out);
});

test('CalendarGrid agenda today: a running event counts as left beside an overlapped finished one', () => {
  const out = html(
    <CalendarGrid
      {...gridProps({
        view: 'agenda',
        agenda: 'today',
        label: 'Today',
        events: [
          ev('long', 'Workshop', '2026-10-29T08:00:00', '2026-10-29T10:30:00'),
          ev('short', 'Standup', '2026-10-29T09:00:00', '2026-10-29T09:15:00'),
          ev('noon', 'Lunch with Leah', '2026-10-29T12:00:00', '2026-10-29T13:00:00'),
        ],
      })}
    />,
  );
  assert.match(out, /2 left today · next at 12:00 PM/);
  assert.equal((out.match(/class="ui-calendar-grid__ag"/g) ?? []).length, 2);
  assert.match(out, /Now · Work/);
  assert.match(out, /Workshop/);
  assert.match(out, /1 earlier/);
  assert.doesNotMatch(out, /Standup/);
});

test('CalendarGrid agenda today: nothing left says so and keeps the earlier count; an empty day offers the action', () => {
  const later = html(
    <CalendarGrid
      {...gridProps({
        view: 'agenda',
        agenda: 'today',
        now: '2026-10-29T20:00:00',
        label: 'Today',
      })}
    />,
  );
  assert.match(later, /Nothing left today(?!\.)/);
  // All four events are over: no rows, one "4 earlier" line instead.
  assert.equal((later.match(/class="ui-calendar-grid__ag"/g) ?? []).length, 0);
  assert.match(later, /4 earlier/);
  assert.doesNotMatch(later, /Climbing with Theo/);
  const empty = html(
    <CalendarGrid
      {...gridProps({
        view: 'agenda',
        agenda: 'today',
        events: [],
        label: 'Today',
        emptyAction: { label: 'New event', commandId: 'calendar.newEvent', onSelect: noop },
      })}
    />,
  );
  assert.match(empty, /Nothing left today(?!\.)/);
  assert.match(empty, /Nothing scheduled(?!\.)/);
  assert.doesNotMatch(empty, /ui-calendar-grid__earlier/);
});

test('CalendarGrid agenda full: days with the comma title, only days with entries and today', () => {
  const out = html(
    <CalendarGrid {...gridProps({ view: 'agenda', label: 'Week of October 25, 2026' })} />,
  );
  assert.match(out, /Friday, October 30, 2026/);
  assert.match(out, /Thursday, October 29, 2026/);
  assert.doesNotMatch(out, /Saturday, October 31, 2026/);
  assert.match(out, /role="region"/);
  assert.match(out, /From mail|from mail/);
});

test('CalendarGrid worst case: hundreds of entries in one slot, CJK and RTL titles, counts, no crash', () => {
  const many = Array.from({ length: 40 }, (_, i) =>
    ev(
      `m${i}`,
      i % 2 ? '会議 田中さん' : 'اجتماع الفريق',
      '2026-10-27T10:00:00',
      '2026-10-27T11:00:00',
    ),
  );
  const out = html(<CalendarGrid {...gridProps({ events: many })} />);
  assert.match(out, />\+39</);
  const monthMany = html(
    <CalendarGrid
      {...gridProps({ view: 'month', start: '2026-10-01', events: many, label: 'October 2026' })}
    />,
  );
  assert.match(monthMany, /38 more/);
  const longTitle = 'x'.repeat(300);
  const agenda = html(
    <CalendarGrid
      {...gridProps({
        view: 'agenda',
        events: [ev('l', longTitle, '2026-10-29T12:00:00', '2026-10-29T13:00:00')],
      })}
    />,
  );
  assert.ok(agenda.includes(longTitle));
});

test('all-day entries keep one row across the days they cover, so a multi-day entry reads as one bar', () => {
  const span = ev('span', 'Offsite', '2026-10-29T00:00:00', '2026-10-31T00:00:00', {
    allDay: true,
  });
  const one = ev('one', 'Holiday', '2026-10-30T00:00:00', '2026-10-31T00:00:00', { allDay: true });
  const rows = allDayRows([one, span], ['2026-10-29', '2026-10-30', '2026-10-31']);
  assert.equal(rows.get('span'), 0, 'the longer entry takes the first row');
  assert.equal(rows.get('one'), 1, 'the one-day entry sits under it on the shared day');
  const out = html(<CalendarGrid {...gridProps({ events: [span, one] })} />);
  assert.equal((out.match(/data-joins-after="true"/g) ?? []).length, 1, 'Thu joins on to Fri');
  assert.equal((out.match(/data-joins-before="true"/g) ?? []).length, 1, 'Fri continues from Thu');
});

test('CalendarGrid month: a multi-day entry is one bar, labelled once per week row and joined across its cells', () => {
  const trip = ev('trip', 'Offsite prep', '2026-10-29T00:00:00', '2026-10-31T00:00:00', {
    allDay: true,
  });
  const out = html(
    <CalendarGrid
      {...gridProps({ view: 'month', start: '2026-10-01', events: [trip], label: 'October 2026' })}
    />,
  );
  const bars = [...out.matchAll(/<button[^>]*data-bar="true"[^>]*>/g)].map(m => m[0]);
  assert.equal(bars.length, 2);
  assert.doesNotMatch(bars[0], /data-joins-before/);
  assert.match(bars[0], /data-joins-after="true"/);
  assert.match(bars[1], /data-joins-before="true"/);
  assert.doesNotMatch(bars[1], /data-joins-after/);
});
