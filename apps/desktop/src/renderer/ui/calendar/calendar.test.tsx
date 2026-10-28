// Run: npx tsx --tsconfig apps/desktop/tsconfig.json --test apps/desktop/src/renderer/ui/calendar/calendar.test.tsx
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { copyProblem } from '../../commands/internal';
import type {
  CalendarEventData,
  CalendarGridProps,
  CalendarInfo,
  DatePresetsProps,
  EventDetailProps,
} from '../props';
import {
  CalendarGrid,
  CalendarList,
  DatePresets,
  EventBlock,
  EventDetail,
  MiniMonth,
  NowLine,
  PlanOutline,
  ScopeChooser,
} from './index';
import {
  addDays,
  dayTitle,
  durationText,
  monthMatrix,
  openHour,
  rangeOf,
  shiftMonth,
  snapHours,
  timeOf,
} from './dates';
import { firstNameOf } from './EventDetail';
import { eventDomId, stackDomId } from './eventText';
import { dragRange, lanesFor, layoutDay, timedOn } from './layout';

const noop = () => {};
const NOW = '2026-10-29T10:00:00';
const html = (node: React.ReactElement): string => renderToStaticMarkup(node);

/** Visible copy of a render: text nodes plus aria-label, title and placeholder values, entities decoded. */
function copyOf(markup: string): string[] {
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

function assertCleanCopy(markup: string): void {
  for (const line of copyOf(markup)) assert.equal(copyProblem(line), null, `banned copy: ${line}`);
  assert.doesNotMatch(markup, /backdrop-filter|sparkle|wand|gradient/i);
}

const cal = (id: string, name: string, color: CalendarInfo['color']) => ({ id, name, color });
const WORK = cal('work', 'Work', 'hill');
const PERSONAL = cal('personal', 'Personal', 'sky');
const HOLLOW = cal('hollow', 'Hollow Creek', 'ember');

function ev(
  id: string,
  title: string,
  start: string,
  end: string,
  extra: Partial<CalendarEventData> = {},
): CalendarEventData {
  return { id, title, start, end, calendar: WORK, kind: 'event', persisted: true, ...extra };
}

const DEMO: CalendarEventData[] = [
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

const gridProps = (over: Partial<CalendarGridProps> = {}): CalendarGridProps => ({
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

/* ---------------------------------- dates and layout ---------------------------------- */

test('dates: titles carry the comma, ranges share AM or PM, durations read plainly', () => {
  assert.equal(dayTitle('2026-10-25'), 'Sunday, October 25, 2026');
  assert.equal(rangeOf('2026-10-29T10:30:00', '2026-10-29T11:30:00'), '10:30 – 11:30 AM');
  assert.equal(rangeOf('2026-10-29T11:30:00', '2026-10-29T12:30:00'), '11:30 AM – 12:30 PM');
  assert.equal(timeOf('2026-10-29T00:05:00'), '12:05 AM');
  assert.equal(durationText(165), '2 h 45 min');
  assert.equal(durationText(180), '3 h');
  assert.equal(addDays('2026-10-31', 1), '2026-11-01');
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(snapHours(10.1), 10);
});

test('dates: the grid opens at 8 AM, or an hour before now when today is shown, or where the screen says', () => {
  assert.equal(openHour({ today: false, nowHours: 15 }), 8);
  assert.equal(openHour({ today: true, nowHours: 15.5 }), 14.5);
  assert.equal(openHour({ today: true, nowHours: 0.25 }), 0);
  assert.equal(openHour({ today: true, nowHours: 15, override: 6 }), 6);
  assert.equal(openHour({ today: false, nowHours: 15, override: 99 }), 24);
});

test('dates: a month matrix is six weeks of seven and starts on the locale weekday', () => {
  const sunday = monthMatrix('2026-10', 0);
  assert.equal(sunday.length, 6);
  assert.ok(sunday.every(w => w.length === 7));
  assert.equal(sunday[0][0], '2026-09-27');
  assert.equal(monthMatrix('2026-10', 1)[0][0], '2026-09-28');
});

test('layout: two overlaps share the width, three fold into the first lane plus a stack', () => {
  const day = '2026-10-28';
  const timed = DEMO.map(e => timedOn(e, day)).filter(t => t !== null);
  const week = layoutDay(timed, 2);
  assert.equal(week.items.length, 1);
  assert.equal(week.items[0].beside, true);
  assert.equal(week.items[0].event.id, 'o1');
  assert.deepEqual(week.stacks[0].events.map(e => e.id).sort(), ['o2', 'o3']);
  const wide = layoutDay(timed, 6);
  assert.equal(wide.stacks.length, 0);
  assert.ok(wide.items.every(i => i.lanes === 3));
  const two = layoutDay(timed.slice(0, 2), 2);
  assert.equal(two.stacks.length, 0);
  assert.ok(two.items.every(i => i.lanes === 2));
});

test('layout: drag math snaps to 15 minutes, keeps the length when moving and never inverts', () => {
  assert.deepEqual(dragRange('create', { at: 10, end: 10, pointer: 10 }, 11.1), {
    at: 10,
    end: 11,
  });
  assert.deepEqual(dragRange('create', { at: 10, end: 10, pointer: 10 }, 9), { at: 9, end: 10 });
  assert.deepEqual(dragRange('move', { at: 14, end: 14.5, pointer: 14.2 }, 15.2), {
    at: 15,
    end: 15.5,
  });
  assert.deepEqual(dragRange('resize', { at: 14, end: 14.5, pointer: 14.5 }, 13), {
    at: 14,
    end: 14.25,
  });
});

test('layout: seven overlaps in a day column keep their own lanes beside one stack; none share a slot', () => {
  const seven = Array.from({ length: 7 }, (_, i) =>
    ev(`o${i + 1}`, `Overlap ${i + 1}`, '2026-10-28T10:00:00', '2026-10-28T12:30:00'),
  );
  const timed = seven.map(e => timedOn(e, '2026-10-28')).filter(t => t !== null);
  const day = layoutDay(timed, 6);
  assert.equal(day.items.length, 5);
  assert.deepEqual(day.items.map(i => i.lane).sort(), [0, 1, 2, 3, 4]);
  assert.ok(day.items.every(i => i.lanes === 5 && i.beside));
  assert.equal(day.stacks.length, 1);
  assert.equal(day.stacks[0].events.length, 2);
  assert.equal(day.stacks[0].alone, false);
  // Every entry is either on the grid in its own lane or in the stack, exactly once.
  const all = [
    ...day.items.map(i => i.event.id),
    ...day.stacks.flatMap(x => x.events.map(e => e.id)),
  ].sort();
  assert.deepEqual(all, seven.map(e => e.id).sort());
});

test('layout: when not even one lane and the stack fit, everything folds into one stack; lanes follow the width', () => {
  const three = ['a', 'b', 'c'].map(id => ev(id, id, '2026-10-28T10:00:00', '2026-10-28T11:00:00'));
  const timed = three.map(e => timedOn(e, '2026-10-28')).filter(t => t !== null);
  const narrow = layoutDay(timed, 1);
  assert.equal(narrow.items.length, 0);
  assert.equal(narrow.stacks[0].events.length, 3);
  assert.equal(narrow.stacks[0].alone, true);
  assert.equal(layoutDay(timed.slice(0, 1), 1).items.length, 1);
  assert.equal(lanesFor(87, 2), 1); // 7 narrow columns: no lane under 44 px
  assert.equal(lanesFor(130, 2), 2);
  assert.equal(lanesFor(700, 6), 6);
  assert.equal(lanesFor(0, 2), 2); // unknown width: the count alone
});

test('ids: distinct entry ids never share a DOM id; a stack is keyed by its first entry', () => {
  assert.notEqual(eventDomId('a b'), eventDomId('a-b'));
  assert.notEqual(eventDomId('a_b'), eventDomId('a b'));
  assert.equal(eventDomId('q4'), 'ui-event-q4');
  assert.match(eventDomId('x"y]'), /^[A-Za-z0-9_-]+$/);
  assert.match(stackDomId(['o2', 'o3']), /^ui-stack-o2$/);
});

/* ---------------------------------- NowLine ---------------------------------- */

test('NowLine: a hidden 1 px grid line, and an agenda row that names the time', () => {
  const grid = html(<NowLine now={NOW} variant="grid" />);
  assert.match(grid, /data-variant="grid"/);
  assert.match(grid, /aria-hidden="true"/);
  assert.match(grid, /--now:10/);
  const agenda = html(<NowLine now={NOW} variant="agenda" />);
  assert.match(agenda, /role="separator"/);
  assert.match(agenda, /aria-label="Now, 10:00 AM"/);
  assert.match(agenda, />10:00 AM</);
});

/* ---------------------------------- EventBlock and PlanOutline ---------------------------------- */

const place = { lane: 0, lanes: 1, wide: false };

test('EventBlock: title and time, calendar colour as a custom property, label for screen readers', () => {
  const out = html(
    <EventBlock
      kind="event"
      event={DEMO[1]}
      placement={place}
      selected={false}
      onSelect={noop}
      onOpen={noop}
    />,
  );
  assert.match(out, /class="ui-event-block"/);
  assert.match(out, /data-density="full"/);
  assert.match(out, /--cal:var\(--tag-sky\)/);
  assert.match(out, /aria-pressed="false"/);
  assert.match(out, /aria-label="Northwind Dental, 9:30 – 10:30 AM, Personal"/);
  assert.match(out, /9:30 – 10:30 AM/);
  assertCleanCopy(out);
});

test('EventBlock: under 30 minutes is one line with the title only; selected and unanswered are marked', () => {
  const tiny = html(
    <EventBlock
      kind="event"
      event={DEMO[2]}
      placement={place}
      selected
      onSelect={noop}
      onOpen={noop}
    />,
  );
  assert.match(tiny, /data-density="tiny"/);
  assert.doesNotMatch(tiny, /ui-event-block__time/);
  assert.match(tiny, /aria-pressed="true"/);
  assert.match(tiny, /data-selected="true"/);
  const invite = html(
    <EventBlock
      kind="event"
      event={DEMO[5]}
      placement={place}
      selected={false}
      onSelect={noop}
      onOpen={noop}
    />,
  );
  assert.match(invite, /data-unanswered="true"/);
  assert.match(invite, /invitation, not answered yet/);
});

test('EventBlock: a wide column adds the place to the time line; a short wide block adds the time', () => {
  const wide = { ...place, wide: true };
  const full = html(
    <EventBlock
      kind="event"
      event={DEMO[1]}
      placement={wide}
      selected={false}
      onSelect={noop}
      onOpen={noop}
    />,
  );
  assert.match(full, /9:30 – 10:30 AM · Northwind Dental, 14 Alder Street/);
  const half = ev('half', 'Short', '2026-10-29T09:00:00', '2026-10-29T09:45:00');
  const one = html(
    <EventBlock
      kind="event"
      event={half}
      placement={wide}
      selected={false}
      onSelect={noop}
      onOpen={noop}
    />,
  );
  assert.match(one, /data-density="one"/);
  assert.match(one, /ui-event-block__time/);
});

test('EventBlock stack: "+N" with a plain label and a menu popup', () => {
  const out = html(
    <EventBlock
      kind="stack"
      ids={['o2', 'o3']}
      start="2026-10-28T11:00:00"
      end="2026-10-28T11:45:00"
      color="ember"
      onOpen={noop}
    />,
  );
  assert.match(out, /data-kind="stack"/);
  assert.match(out, />\+2</);
  assert.match(out, /aria-label="2 more events at 11:00 AM"/);
  assert.match(out, /aria-haspopup="menu"/);
  assert.match(out, /--cal:var\(--tag-ember\)/);
});

test('PlanOutline: the label "From mail" and a name that says it is not added yet', () => {
  const out = html(
    <PlanOutline plan={DEMO[7]} placement={place} selected={false} onSelect={noop} onOpen={noop} />,
  );
  assert.match(out, /class="ui-plan-outline"/);
  assert.match(out, /From mail/);
  assert.match(out, /found in mail, not added yet/);
  assert.match(out, /data-kind="plan"/);
  assertCleanCopy(out);
});

test('EventBlock worst case: 300-character title, unbreakable 80-character name, CJK, Arabic, emoji', () => {
  const titles = [
    'Quarterly planning '.repeat(16).slice(0, 300),
    'a'.repeat(30) + '@' + 'b'.repeat(49),
    'A',
    '四半期レビュー会議 田中さんと',
    'اجتماع مراجعة الربع الرابع مع الفريق',
    'Birthday dinner 🎂🎉 for Mom',
  ];
  for (const title of titles) {
    const out = html(
      <EventBlock
        kind="event"
        event={ev('w', title, '2026-10-29T10:00:00', '2026-10-29T11:00:00')}
        placement={place}
        selected={false}
        onSelect={noop}
        onOpen={noop}
      />,
    );
    assert.ok(out.includes(`${title}</span>`), `title rendered: ${title.slice(0, 20)}`);
    assert.match(out, /aria-label="/);
  }
  const rtl = html(
    <PlanOutline
      plan={ev('p', titles[4], '2026-10-29T10:00:00', '2026-10-29T11:00:00', {
        kind: 'plan',
        persisted: false,
      })}
      placement={place}
      selected={false}
      onSelect={noop}
      onOpen={noop}
    />,
  );
  assert.ok(rtl.includes(titles[4]));
});

/* ---------------------------------- MiniMonth ---------------------------------- */

test('MiniMonth: six weeks, out-of-month days dim, today filled, the range marked, one tab stop', () => {
  const out = html(
    <MiniMonth
      month="2026-10"
      today="2026-10-29"
      range={{ start: '2026-10-25', end: '2026-10-31' }}
      weekStartsOn={0}
      onMonthChange={noop}
      onPick={noop}
    />,
  );
  assert.match(out, />October 2026</);
  assert.equal((out.match(/class="ui-mini-month__day"/g) ?? []).length, 42);
  assert.equal((out.match(/data-out="true"/g) ?? []).length, 11); // 4 days of September, 7 of November
  assert.match(
    out,
    /data-today="true"[^>]*aria-label="Thursday, October 29, 2026"[^>]*aria-current="date"/,
  );
  assert.equal((out.match(/data-in-range="true"/g) ?? []).length, 7);
  assert.equal((out.match(/tabindex="0"/g) ?? []).length, 1);
  assert.match(out, /aria-label="Previous month"/);
  assert.match(out, /aria-label="Next month"/);
  assert.match(out, /abbr="Sunday">S</);
  assertCleanCopy(out);
});

test('MiniMonth: Monday first changes the column order', () => {
  const out = html(
    <MiniMonth
      month="2026-10"
      today="2026-10-29"
      weekStartsOn={1}
      onMonthChange={noop}
      onPick={noop}
    />,
  );
  assert.match(out, /<th scope="col" abbr="Monday">M<\/th>/);
  assert.ok(out.indexOf('abbr="Monday"') < out.indexOf('abbr="Sunday"'));
  assert.doesNotMatch(out, /data-in-range/);
});

/* ---------------------------------- CalendarList ---------------------------------- */

test('CalendarList: swatches as custom properties, shown and hidden states, Option-click hint', () => {
  const calendars: CalendarInfo[] = [
    { ...WORK, visible: true },
    { ...PERSONAL, visible: false },
    {
      id: 'long',
      name: 'A calendar with a name that goes on and on and on past any sidebar width',
      color: 'dusk',
      visible: true,
    },
    { id: 'cjk', name: '家族', color: 'stamp', visible: true },
  ];
  const out = html(<CalendarList calendars={calendars} onToggle={noop} onSolo={noop} />);
  assert.match(out, />Calendars</);
  assert.equal((out.match(/role="checkbox"/g) ?? []).length, 4);
  assert.match(out, /aria-checked="true"/);
  assert.match(out, /data-state="hidden"/);
  assert.match(out, /--swatch:var\(--tag-hill\)/);
  assert.match(out, /Option-click shows only this one/);
  assert.ok(out.includes('家族'));
  assert.equal(
    html(<CalendarList calendars={[]} onToggle={noop} onSolo={noop} />).includes('role="checkbox"'),
    false,
  );
});

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

test('CalendarGrid day: wide columns, an empty day says "Nothing scheduled." with New event and its key', () => {
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
  assert.match(empty, /Nothing scheduled\./);
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

test('CalendarGrid month: six weeks, "N more" past three, never a lonely "1 more"', () => {
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
  assert.equal((out.match(/role="gridcell"/g) ?? []).length, 42);
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
  assert.match(out, /4 events · next at 11:00 AM/);
  assert.match(out, /role="separator"[^>]*aria-label="Now, 10:00 AM"/);
  assert.match(out, /Next · Work · 15 min/);
  assert.match(out, /Free for 2 h 45 min/);
  assert.match(out, /Free for 3 h/);
  assert.match(out, /Now · Personal · 1 h/);
  assert.ok(out.indexOf('Standup') < out.indexOf('Design review'));
  assertCleanCopy(out);
});

test('CalendarGrid agenda today: nothing left says so; an empty day offers the action', () => {
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
  assert.match(later, /4 events · none left today/);
  assert.match(later, /Climbing with Theo/);
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
  assert.match(empty, /0 events · none left today/);
  assert.match(empty, /Nothing scheduled\./);
});

test('CalendarGrid agenda full: days with the comma title, only days with entries and today', () => {
  const out = html(
    <CalendarGrid {...gridProps({ view: 'agenda', label: 'Week of October 25, 2026' })} />,
  );
  assert.match(out, /Friday, October 30, 2026/);
  assert.match(out, /Thursday, October 29, 2026/);
  assert.doesNotMatch(out, /Saturday, October 31, 2026/);
  assert.match(out, /role="region"/);
  assert.match(out, /From mail|found in mail/);
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

/* ---------------------------------- EventDetail ---------------------------------- */

const Q4: CalendarEventData = ev('q4', 'Q4 review', '2026-10-30T11:00:00', '2026-10-30T12:00:00', {
  video: 'meet.fernworks.studio/q4-review',
  unanswered: true,
  invite: { from: 'Priya Raman', threadId: 't-3' },
  myReply: null,
  guests: [
    { name: 'Priya Raman', status: 'going', isOrganizer: true },
    { name: 'Mina Cho', status: 'maybe' },
    { name: 'Alex Moreno', status: 'none', isYou: true },
  ],
  description: 'Walk through the Q4 deck and agree next quarter’s priorities.',
});

const reply = (answer: 'yes' | 'maybe' | 'no' | null): NonNullable<EventDetailProps['reply']> => ({
  answer,
  commands: { yes: 'calendar.answerYes', maybe: 'calendar.answerMaybe', no: 'calendar.answerNo' },
  onAnswer: noop,
  onSend: noop,
});

const detail = (event: CalendarEventData, over: Partial<EventDetailProps> = {}): string =>
  html(<EventDetail event={event} presentation="popover" onMore={noop} onClose={noop} {...over} />);

test('EventDetail rsvp: nothing chosen, "Send reply" disabled until you choose, keys in the tooltips', () => {
  const out = detail(Q4, { reply: reply(null) });
  assert.match(out, /<h3[^>]*>Going\?<\/h3>/);
  assert.equal((out.match(/role="radio"/g) ?? []).length, 3);
  assert.equal((out.match(/aria-checked="false"/g) ?? []).length, 3);
  assert.doesNotMatch(out, /aria-checked="true"/);
  assert.match(out, /<button[^>]*disabled=""[^>]*>Send reply/);
  assert.match(out, /title="Yes · Y"/);
  assert.match(out, /title="Maybe · M"/);
  assert.match(out, /title="No · N"/);
  assert.match(out, /role="radiogroup"/);
  const chosen = detail(Q4, { reply: reply('maybe') });
  assert.match(chosen, /aria-checked="true"[^>]*data-checked="true"[^>]*title="Maybe · M"/);
  assert.doesNotMatch(chosen, /disabled=""/);
  assertCleanCopy(out);
});

test('EventDetail: title, the when line with the comma day, swatch, video, invite, guests with roles and words', () => {
  const out = detail(Q4);
  assert.match(out, /<h2[^>]*>Q4 review<\/h2>/);
  assert.match(out, /Friday, October 30 · 11:00 AM – 12:00 PM/);
  assert.match(out, /--swatch:var\(--tag-hill\)/);
  assert.match(out, />Work</);
  assert.match(out, />meet\.fernworks\.studio\/q4-review</);
  assert.match(out, />Invite from Priya</);
  assert.match(out, /Open the invite email · O/);
  assert.match(out, />Guests</);
  assert.match(out, /organizer/);
  assert.match(out, />you</);
  assert.match(out, /Going/);
  assert.match(out, /Maybe/);
  assert.match(out, /Not answered/);
  assert.doesNotMatch(out, /No reply yet/);
  assert.match(out, /aria-label="More"/);
  assert.match(out, /title="More: change your reply, hide"/);
  assert.match(out, /aria-label="Close"/);
  assert.match(out, /data-presentation="popover"/);
});

test('EventDetail: "Invite from" uses the first name, skipping titles, and falls back to the whole name', () => {
  assert.equal(firstNameOf('Priya Raman'), 'Priya');
  assert.equal(firstNameOf('Dr. Priya Raman'), 'Priya');
  assert.equal(firstNameOf('  Prof Mina Cho '), 'Mina');
  assert.equal(firstNameOf('Dr.'), 'Dr.');
  assert.equal(firstNameOf('priya@fernworks.studio'), 'priya@fernworks.studio');
  assert.equal(firstNameOf(''), '');
  assert.match(
    detail({ ...Q4, invite: { from: 'Dr. Priya Raman', threadId: 't' } }),
    />Invite from Priya</,
  );
  assert.match(detail({ ...Q4, invite: { from: '', threadId: 't' } }), />Invite</);
});

test('EventDetail rsvp: one tab stop, the chosen answer or the first when nothing is chosen', () => {
  const none = detail(Q4, { reply: reply(null) });
  assert.deepEqual(
    [...none.matchAll(/role="radio"[^>]*?tabindex="(-?\d)"/g)].map(m => m[1]),
    ['0', '-1', '-1'],
  );
  const maybe = detail(Q4, { reply: reply('maybe') });
  assert.deepEqual(
    [...maybe.matchAll(/role="radio"[^>]*?tabindex="(-?\d)"/g)].map(m => m[1]),
    ['-1', '0', '-1'],
  );
});

test('EventDetail: Delete is named only on a saved event you organise; the rail has no close', () => {
  const mine = ev('m', 'Design review', '2026-10-29T14:00:00', '2026-10-29T14:30:00', {
    isOrganizer: true,
  });
  assert.match(detail(mine), /title="More: edit, delete"/);
  assert.match(detail({ ...mine, persisted: false }), /title="More: edit"/);
  const rail = detail(mine, { presentation: 'rail', onClose: undefined });
  assert.doesNotMatch(rail, /aria-label="Close"/);
  assert.match(rail, /data-presentation="rail"/);
});

test('EventDetail plan: confirm and source email, and all-day wording', () => {
  const out = detail(DEMO[7]);
  assert.match(out, /Found in your mail\. Nothing is added until you confirm\./);
  assert.match(out, />Add to Calendar</);
  assert.match(out, />From Jordan Park: Build timing</);
  assert.match(out, /title="More: hide"/);
  const allDay = detail(
    ev('ad', 'Offsite', '2026-10-29T00:00:00', '2026-10-30T00:00:00', { allDay: true }),
  );
  assert.match(allDay, /Thursday, October 29 · All day/);
});

test('EventDetail worst case: long title and place, unbreakable name, one-letter guest, emoji, RTL', () => {
  const out = detail(
    ev('w', 'T'.repeat(300), '2026-10-29T10:00:00', '2026-10-29T11:00:00', {
      place: 'p'.repeat(80),
      description: 'd'.repeat(300),
      guests: [
        { name: 'a'.repeat(40) + '@' + 'b'.repeat(39), status: 'going' },
        { name: 'J', status: 'declined', isYou: true, isOrganizer: true },
        { name: '田中 さん', status: 'none' },
        { name: 'مينا', status: 'maybe' },
        { name: 'Party 🎉', status: 'going' },
      ],
    }),
    { reply: reply(null) },
  );
  assert.ok(out.includes('T'.repeat(300)));
  assert.match(out, /you, organizer/);
  assert.match(out, /Declined/);
  assert.ok(out.includes('田中 さん') && out.includes('مينا') && out.includes('🎉'));
});

/* ---------------------------------- DatePresets ---------------------------------- */

const PRESETS: DatePresetsProps['presets'] = [
  { id: 'evening', at: '2026-10-29T18:00:00' },
  { id: 'tomorrow', at: '2026-10-30T08:00:00' },
  { id: 'weekend', at: '2026-10-31T09:00:00' },
  { id: 'nextWeek', at: '2026-11-02T08:00:00' },
  { id: 'someday' },
];

const presetsProps = (over: Partial<DatePresetsProps> = {}): DatePresetsProps => ({
  open: true,
  anchor: null,
  purpose: 'later',
  presets: PRESETS,
  activeId: 'tomorrow',
  onActiveChange: noop,
  onPick: noop,
  calendarOpen: false,
  month: '2026-11',
  onMonthChange: noop,
  onPickDate: noop,
  pickedTime: '08:00',
  onTimeChange: noop,
  onConfirmDate: noop,
  onClose: noop,
  ...over,
});

test('DatePresets: closed renders nothing', () => {
  assert.equal(html(<DatePresets {...presetsProps({ open: false })} />), '');
});

test('DatePresets: five presets with digits always visible, fixed copy, Return on the active one', () => {
  const out = html(<DatePresets {...presetsProps()} />);
  assert.match(out, /role="menu"[^>]*aria-label="Later until"/);
  for (const [i, label] of [
    'Today evening',
    'Tomorrow',
    'This weekend',
    'Next week',
    'Someday',
  ].entries()) {
    assert.match(
      out,
      new RegExp(
        `ui-date-presets__num" aria-hidden="true">${i + 1}</span><span class="ui-date-presets__text">${label}<`,
      ),
    );
  }
  assert.match(out, /Thu 6:00 PM/);
  assert.match(out, /Fri 8:00 AM/);
  assert.match(out, /Pick a date…/);
  assert.equal((out.match(/<kbd class="ui-date-presets__kbd">Return<\/kbd>/g) ?? []).length, 1);
  assert.match(out, /data-id="tomorrow"[^>]*>.*?Return/);
  assert.match(out, /aria-activedescendant="[^"]*-tomorrow"/);
  assert.equal((out.match(/role="menuitem"/g) ?? []).length, 6);
  assert.doesNotMatch(out, /ui-date-presets__calendar/);
  assertCleanCopy(out);
});

test('DatePresets calendar: month grid of six weeks, picked day, time list, "Move to Later" with Return', () => {
  const out = html(
    <DatePresets
      {...presetsProps({ activeId: 'date', calendarOpen: true, pickedDate: '2026-11-04' })}
    />,
  );
  assert.match(out, /November 2026/);
  assert.equal((out.match(/class="ui-date-presets__day"/g) ?? []).length, 42);
  assert.match(out, /data-picked="true"[^>]*aria-label="Wed, Nov 4"/);
  assert.match(out, /Wed, Nov 4<\/span>/);
  assert.match(out, /<option value="08:00" selected="">8:00 AM<\/option>/);
  assert.match(out, /Move to Later<kbd class="ui-cal-kbd">Return<\/kbd>/);
  assert.doesNotMatch(out, /disabled=""/);
  const none = html(<DatePresets {...presetsProps({ activeId: 'date', calendarOpen: true })} />);
  assert.match(none, /<button[^>]*disabled=""[^>]*>Move to Later/);
  const due = html(
    <DatePresets
      {...presetsProps({
        purpose: 'due',
        activeId: 'date',
        calendarOpen: true,
        pickedDate: '2026-11-04',
        pickedTime: '09:15',
      })}
    />,
  );
  // With the month open, the footer button carries Return; the "Pick a date…" row does not repeat it.
  assert.equal((out.match(/class="ui-date-presets__kbd"/g) ?? []).length, 0);
  assert.match(due, /aria-label="Due date"/);
  assert.match(due, /Set due date/);
  assert.match(due, /<option value="09:15" selected="">9:15 AM<\/option>/);
});

/* ---------------------------------- manifest ---------------------------------- */

test('the barrel exports all nine components of the family', async () => {
  const barrel = await import('./index');
  assert.deepEqual(Object.keys(barrel).sort(), [
    'CalendarGrid',
    'CalendarList',
    'DatePresets',
    'EventBlock',
    'EventDetail',
    'MiniMonth',
    'NowLine',
    'PlanOutline',
    'ScopeChooser',
  ]);
});

test('ScopeChooser: "This event" is the filled default on Return, "All events" on ⇧Return, Esc cancels', () => {
  const html = renderToStaticMarkup(
    <ScopeChooser action="move" title="Design review" onChoose={() => {}} onCancel={() => {}} />,
  );
  assert.match(html, /role="group"/);
  assert.match(html, /aria-label="Move this repeating event\? Design review"/);
  assert.match(html, /This event/);
  assert.match(html, /All events/);
  assert.equal((html.match(/data-variant="filled"/g) ?? []).length, 1);
  for (const action of ['change', 'delete', 'reply'] as const) {
    const text = renderToStaticMarkup(
      <ScopeChooser action={action} title="x" onChoose={() => {}} onCancel={() => {}} />,
    );
    assert.equal(copyProblem(text.replace(/<[^>]+>/g, ' ')), null);
  }
});

test('EventBlock locked: marks itself and the grid offers no resize handle to a locked entry', () => {
  const placement = { lane: 0, lanes: 1, wide: false };
  const block = (event: CalendarEventData, locked?: boolean): string =>
    html(
      <EventBlock
        kind="event"
        event={event}
        placement={placement}
        selected={false}
        locked={locked}
        onSelect={noop}
        onOpen={noop}
      />,
    );
  const open = ev('free', 'Planning', '2026-10-29T09:00:00', '2026-10-29T10:00:00');
  assert.doesNotMatch(block(open), /data-locked/);
  assert.match(block(open, true), /data-locked="true"/);
  assert.match(block({ ...open, locked: true }), /data-locked="true"/);
  const grid = (events: CalendarEventData[]): string =>
    html(<CalendarGrid {...gridProps({ view: 'day', start: '2026-10-29', events })} />);
  assert.equal((grid([open]).match(/data-resize="true"/g) ?? []).length, 1);
  const shut = grid([{ ...open, locked: true }]);
  assert.equal((shut.match(/data-resize="true"/g) ?? []).length, 0);
  assert.match(shut, /data-locked="true"/);
});

test('EventDetail: a multi-day entry names both days; an all-day one is a date range', () => {
  const timed = ev('trip', 'Offsite', '2026-10-26T09:00:00', '2026-10-28T17:00:00');
  assert.match(detail(timed), /Mon, Oct 26, 9:00 AM – Wed, Oct 28, 5:00 PM/);
  const allDay = ev('away', 'Away', '2026-10-26T00:00:00', '2026-10-29T00:00:00', { allDay: true });
  assert.match(detail(allDay), /Mon, Oct 26 – Wed, Oct 28 · All day/);
  // One all-day day, and an evening that ends at midnight, stay single-day.
  const one = ev('one', 'Holiday', '2026-10-29T00:00:00', '2026-10-30T00:00:00', { allDay: true });
  assert.match(detail(one), /Thursday, October 29 · All day/);
  const late = ev('late', 'Late', '2026-10-29T22:00:00', '2026-10-30T00:00:00');
  assert.match(detail(late), /Thursday, October 29 · 10:00 PM – 12:00 AM/);
});
