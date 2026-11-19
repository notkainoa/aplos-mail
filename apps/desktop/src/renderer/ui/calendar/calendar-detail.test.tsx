// Calendar family: EventDetail, DatePresets, ScopeChooser, locked events and the barrel.
// Run: npx tsx --tsconfig apps/desktop/tsconfig.json --test apps/desktop/src/renderer/ui/calendar/calendar-detail.test.tsx

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { copyProblem } from '../../commands/internal';
import type { CalendarEventData, DatePresetsProps, EventDetailProps } from '../props';
import { CalendarGrid, DatePresets, EventBlock, EventDetail, ScopeChooser } from './index';
import { firstNameOf } from './EventDetail';
import { noop, html, assertCleanCopy, ev, DEMO, gridProps } from './fixtures.test';

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

test('EventDetail guests: one shared answer is said once in the heading, not on every row', () => {
  const same = ev('same', 'Offsite', '2026-10-30T11:00:00', '2026-10-30T12:00:00', {
    guests: [
      { name: 'Priya Raman', status: 'going', isOrganizer: true },
      { name: 'Mina Cho', status: 'going' },
    ],
  });
  const out = detail(same);
  assert.match(out, /All going/);
  assert.doesNotMatch(out, /ui-event-detail__status/, 'no per-row chip');
  assert.doesNotMatch(detail(Q4), /All going/, 'mixed answers keep their rows');
});

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
  assert.match(out, />Organizer</);
  assert.match(out, />\(you\)</);
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
  assert.match(out, /\(you\) · Organizer/);
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
  assert.equal((out.match(/<kbd class="ui-date-presets__kbd">↩<\/kbd>/g) ?? []).length, 1);
  assert.match(out, /data-id="tomorrow"[^>]*>.*?↩/);
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
  assert.match(out, /Move to Later<kbd class="ui-cal-kbd">↩<\/kbd>/);
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
