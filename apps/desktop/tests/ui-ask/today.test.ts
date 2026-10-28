// ui-ask: the Today tab's model (DESIGN §7.7 Today; map-ask decisions). Runs in the harness time zone.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Event } from '../../src/renderer/data';
import { Today } from '../../src/renderer/screens/today/Today';
import {
  calendarColor,
  formatDuration,
  formatWhen,
  todayModel,
  type TodayCalendar,
} from '../../src/renderer/screens/today/today.model';

process.env.TZ = 'America/Los_Angeles';
const at = (h: number, m = 0, day = 29) => new Date(2026, 9, day, h, m).getTime();
const NOW = at(10);

const calendars = new Map<string, TodayCalendar>([
  ['work', { id: 'work', name: 'Work', color: 'hill' }],
  ['hollow', { id: 'hollow', name: 'Hollow Creek', color: 'ember' }],
  ['personal', { id: 'personal', name: 'Personal', color: 'sky' }],
]);

let n = 0;
function event(title: string, start: number, end: number, extra: Partial<Event> = {}): Event {
  n += 1;
  return {
    id: `e${n}`,
    rev: 1,
    accountId: 'acc',
    calendarId: 'work',
    recurring: false,
    exception: false,
    title,
    start: { type: 'utc', utc: start },
    end: { type: 'utc', utc: end },
    allDay: false,
    attendees: [],
    status: 'confirmed',
    can: { edit: true, move: true, delete: true, rsvp: false, editGuests: true },
    sync: 'synced',
    ...extra,
  };
}

/** today-busy: a past event, the next, two after it, two gaps, and events that must not show. */
function busy(): Event[] {
  return [
    event('Northwind Dental', at(9, 30), at(10), { calendarId: 'personal' }),
    event('Standup', at(11), at(11, 15)),
    event('Design review with Mina and Jordan', at(14), at(14, 30), { calendarId: 'hollow' }),
    event('Climbing with Theo', at(17, 30), at(19), { calendarId: 'personal' }),
    event('Declined sync', at(12), at(13), { myResponse: 'declined' }),
    event('Focus time', at(15), at(16), { transparency: 'transparent' }),
    event('Cancelled lunch', at(12), at(13), { status: 'cancelled' }),
    event('Tomorrow’s standup', at(11, 0, 30), at(11, 15, 30)),
  ];
}

describe('ui-ask: Today', () => {
  test('today agenda – headline, past dimmed, next marked, gaps from now to the last event', () => {
    const model = todayModel(busy(), calendars, NOW);
    assert.equal(model.headline, '4 events · next at 11:00 AM');
    assert.equal(model.behind?.event.title, 'Northwind Dental');
    assert.equal(model.next?.event.title, 'Standup');
    assert.deepEqual(model.following.map(e => e.event.title), ['Design review with Mina and Jordan', 'Climbing with Theo']);
    assert.deepEqual(model.gaps.map(g => g.text), ['Free for 1 h', 'Free for 2 h 45 min', 'Free for 3 h']);
    assert.equal(model.moreText, undefined);
    assert.equal(model.now, '2026-10-29T10:00:00-07:00');
  });

  test('declined, cancelled and free events neither show nor block a gap', () => {
    const model = todayModel(busy(), calendars, NOW);
    const titles = model.events.map(e => e.title);
    for (const hidden of ['Declined sync', 'Focus time', 'Cancelled lunch', 'Tomorrow’s standup']) assert.ok(!titles.includes(hidden), hidden);
    assert.ok(model.gaps.some(g => g.minutes === 165), 'the free 3 PM focus block does not split the 2 h 45 min gap');
  });

  test('the following two in full, the rest folded as "2 more"', () => {
    const events = [...busy(), event('Dinner', at(20), at(21)), event('Call home', at(21, 30), at(22))];
    const model = todayModel(events, calendars, NOW);
    assert.equal(model.moreText, '2 more');
    assert.deepEqual(model.folded.map(e => e.event.title), ['Dinner', 'Call home']);
    assert.equal(model.shownGaps.length, 3);
  });

  test('today updates on clock – past 11:15 the next event is the 2:00 PM review', () => {
    const model = todayModel(busy(), calendars, at(11, 20));
    assert.equal(model.next?.event.title, 'Design review with Mina and Jordan');
    assert.equal(model.behind?.event.title, 'Standup');
    assert.equal(model.headline, '4 events · next at 2:00 PM');
    assert.equal(model.gaps[0].text, 'Free for 2 h 40 min');
  });

  test('an event under way pushes the first gap to its end; overlapping events never invent a gap', () => {
    const model = todayModel(
      [event('Workshop', at(9), at(12)), event('Lunch talk', at(11), at(11, 30)), event('Review', at(12, 15), at(13))],
      calendars,
      at(10),
    );
    assert.equal(model.current.length, 1);
    // The workshop runs to 12:00, so the 11:30 end of the talk inside it frees nothing.
    assert.deepEqual(model.gaps.map(g => g.text), []);
  });

  test('all-day events count and sit above the timeline; an empty day says so', () => {
    const allDay = event('Offsite', at(0), at(0, 0, 30), { allDay: true, start: { type: 'date', date: '2026-10-29' }, end: { type: 'date', date: '2026-10-30' } });
    const model = todayModel([allDay], calendars, NOW);
    assert.equal(model.allDay.length, 1);
    assert.equal(model.headline, '1 event · none left today');
    assert.equal(todayModel([], calendars, NOW).empty, true);
  });

  test('the agenda the component draws agrees with the model (gaps, rows, now line, fold)', () => {
    const events = [...busy(), event('Dinner', at(20), at(21))];
    const model = todayModel(events, calendars, NOW);
    const html = renderToStaticMarkup(
      createElement(Today, {
        model,
        onSelect: () => undefined,
        onOpenEvent: () => undefined,
        onOpenCalendar: () => undefined,
        onNewEvent: () => undefined,
      }),
    );
    const gaps = [...html.matchAll(/Free for [^<]+/g)].map(m => m[0]);
    assert.deepEqual(gaps, model.shownGaps.map(g => g.text));
    assert.match(html, /aria-label="Now, 10:00 AM"/);
    assert.match(html, /4 events · next at 11:00 AM|5 events · next at 11:00 AM/);
    assert.match(html, />1 more</);
    assert.match(html, />Open Calendar</);
    assert.doesNotMatch(html, /Declined sync|Focus time|Cancelled lunch/);
  });

  test('formatting', () => {
    assert.equal(formatDuration(165), '2 h 45 min');
    assert.equal(formatDuration(180), '3 h');
    assert.equal(formatDuration(45), '45 min');
    assert.equal(formatWhen(at(14), at(14, 30), false), 'Thu 2:00–2:30 PM');
    assert.equal(formatWhen(at(11, 30), at(12, 30), false), 'Thu 11:30 AM–12:30 PM');
    assert.equal(calendarColor({ id: 'x', colorTag: 'dusk' }), 'dusk');
    assert.equal(calendarColor({ id: 'x', colorTag: 'purple' }), calendarColor({ id: 'x' }));
  });
});
