// Calendar family: dates, layout, ids and the building blocks (EventBlock, PlanOutline, MiniMonth, CalendarList).
// Run: npx tsx --tsconfig apps/desktop/tsconfig.json --test apps/desktop/src/renderer/ui/calendar/calendar.test.tsx

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CalendarInfo } from '../props';
import { CalendarList, EventBlock, MiniMonth, NowLine, PlanOutline } from './index';
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
import { eventDomId, stackDomId } from './eventText';
import { dragRange, lanesFor, layoutDay, timedOn } from './layout';
import { noop, NOW, html, assertCleanCopy, WORK, PERSONAL, ev, DEMO } from './fixtures.test';

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
  assert.equal(openHour({ today: true, nowHours: 15.5 }), 14);
  assert.equal(openHour({ today: true, nowHours: 0.25 }), 7, 'never above 7 AM');
  assert.equal(
    openHour({ today: true, nowHours: 13, firstEvent: 9 }),
    8.5,
    'the first event is in view',
  );
  assert.equal(
    openHour({ today: false, nowHours: 13, firstEvent: 14 }),
    8,
    'a late first event keeps 8 AM',
  );
  assert.equal(
    openHour({ today: true, nowHours: 15, firstEvent: 6 }),
    7,
    'the floor wins over an early event',
  );
  assert.equal(openHour({ today: true, nowHours: 15, override: 3 }), 3, 'the screen can say');
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

test('EventBlock: 30 minutes or less is one line, the title alone in a column and with its time in a wide one; selected and unanswered are marked', () => {
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
  assert.doesNotMatch(tiny, /ui-event-block__time">[^<]*–/, 'no full range in a narrow column');
  assert.match(
    tiny,
    /data-compact="true">· \d{1,2}:\d{2} [AP]M</,
    'the start time follows the title: "Weekly sync · 9:00 AM"',
  );
  const wideTiny = html(
    <EventBlock
      kind="event"
      event={DEMO[2]}
      placement={{ ...place, wide: true }}
      selected={false}
      onSelect={noop}
      onOpen={noop}
    />,
  );
  assert.match(wideTiny, /ui-event-block__time/);
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
  assert.match(out, /from mail, [^"]*, not added yet/);
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

test('MiniMonth: only the weeks of the month, out-of-month days dim, today filled, the range marked, one tab stop', () => {
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
  // October 2026 spans five Sunday-first weeks: no row of November, its room kept as one empty spare row.
  assert.equal((out.match(/class="ui-mini-month__day"/g) ?? []).length, 35);
  assert.equal((out.match(/data-out="true"/g) ?? []).length, 4); // the 4 days of September
  assert.equal((out.match(/<tr aria-hidden="true">/g) ?? []).length, 1);
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
