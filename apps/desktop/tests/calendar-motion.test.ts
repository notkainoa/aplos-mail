import test from 'node:test';
import assert from 'node:assert/strict';
import type { CalendarEvent } from '@aplos/contract/legacy/types';
import {
  openingHour,
  resist,
  swipeDecision,
  swipeThreshold,
  zoomHour,
  zoomScroll,
  hourLimits,
} from '../src/renderer/legacy/calendarMotion';
import {
  clashes,
  emailContext,
  planKey,
  plansToReview,
} from '../src/renderer/legacy/calendarLayout';

test('a period swipe turns the page by distance or a quick flick, and otherwise settles back', () => {
  const width = 800;
  const limit = swipeThreshold(width);
  assert.equal(limit, 160);
  assert.equal(swipeThreshold(200), 60);
  // Content moved left (negative) shows what comes next.
  assert.equal(swipeDecision(-limit, 0, width), 1);
  assert.equal(swipeDecision(limit + 1, 0, width), -1);
  assert.equal(
    swipeDecision(-limit + 1, 0, width),
    0,
    'short of the threshold and slow: spring back',
  );
  assert.equal(
    swipeDecision(-limit / 2, -0.8, width),
    1,
    'a flick in the same direction turns from a third of the way',
  );
  assert.equal(swipeDecision(-limit / 4, -0.8, width), 0, 'a flick that barely moved does not');
  assert.equal(swipeDecision(-limit / 2, 0.8, width), 0, 'pulling back before letting go cancels');
  assert.equal(swipeDecision(0, 2, width), 0);
  // One to one up to the threshold, then resisting but still moving the same way.
  assert.equal(resist(-100, width), -100);
  const far = resist(-600, width);
  assert.ok(far < -limit && far > -600);
  assert.ok(resist(-700, width) < far);
});

test('pinch zoom stays within limits and keeps the time under the pointer in place', () => {
  assert.ok(zoomHour(48, -50) > 48);
  assert.ok(zoomHour(48, 50) < 48);
  assert.equal(zoomHour(100, -500), hourLimits.max);
  assert.equal(zoomHour(30, 500), hourLimits.min);
  const bodyTop = 80,
    pointerY = 300,
    scrollTop = 400,
    from = 48,
    to = 72;
  const before = (scrollTop + pointerY - bodyTop) / from;
  const next = zoomScroll({ scrollTop, pointerY, bodyTop, from, to });
  assert.equal((next + pointerY - bodyTop) / to, before);
  assert.equal(
    zoomScroll({ scrollTop: 0, pointerY: 10, bodyTop: 80, from: 48, to: 30 }),
    0,
    'over the header the grid scales from the top',
  );
  assert.equal(zoomScroll({ scrollTop: 40, pointerY: 10, bodyTop: 80, from: 48, to: 96 }), 80);
  // Opening: now, or the first plan when it is earlier, a little above.
  assert.equal(openingHour(13, 7), 6.25);
  assert.equal(openingHour(9, 11), 8.25);
  assert.equal(openingHour(undefined, 10), 9.25);
  assert.equal(openingHour(undefined, undefined), 7.25);
});

const at = (day: string, time: string) => new Date(`${day}T${time}:00`).toISOString();
const event = (
  id: string,
  start: string,
  end: string,
  patch: Partial<CalendarEvent> = {},
): CalendarEvent => ({
  id,
  accountId: 'work',
  calendarId: 'demo-work',
  title: id,
  start,
  end,
  allDay: false,
  location: '',
  description: '',
  guests: [],
  ...patch,
});

test('Today follows the open email: a new plan becomes a ghost on its day with its clashes, a saved one is shown instead', () => {
  const day = '2026-10-23';
  const events = [
    event('standup', at(day, '09:00'), at(day, '09:15')),
    event('review', at(day, '14:00'), at(day, '15:00'), { threadId: 'review' }),
    event('polish', at(day, '14:00'), at(day, '16:30')),
    event('cabin', day, '2026-10-26', { allDay: true }),
    event('later', at(day, '15:00'), at(day, '16:00')),
  ];
  const plan = {
    title: 'Garden morning',
    start: at('2026-10-24', '10:00'),
    end: at('2026-10-24', '11:00'),
    allDay: false,
  };
  assert.deepEqual(emailContext('garden', events, [plan]), { day: '2026-10-24', proposal: plan });
  // A plan already on the calendar is not proposed again; its saved event is shown instead.
  const repeat = { title: 'Review', start: at(day, '14:00'), end: at(day, '15:00') };
  assert.deepEqual(emailContext('review', events, [repeat]), { day, saved: events[1] });
  assert.equal(emailContext('review', events, undefined)?.saved?.id, 'review');
  assert.equal(emailContext(undefined, events, [plan]), undefined);
  assert.equal(
    emailContext('none', events, [{ title: 'No time yet' }]),
    undefined,
    'a plan without a start and end is not drawn',
  );
  assert.equal(
    emailContext('none', events, [
      { title: 'Backwards', start: at(day, '11:00'), end: at(day, '10:00') },
    ]),
    undefined,
  );
  // Clashes: overlapping timed plans only; touching ends do not clash, all-day plans never do.
  const proposal = { start: at(day, '14:30'), end: at(day, '15:00') };
  assert.deepEqual(
    clashes(proposal, events).map(e => e.id),
    ['review', 'polish'],
  );
  assert.deepEqual(clashes({ start: at(day, '09:15'), end: at(day, '10:00') }, events), []);
  assert.deepEqual(clashes({ ...proposal, allDay: true }, events), []);
  assert.deepEqual(
    clashes({ id: 'review', start: at(day, '14:00'), end: at(day, '15:00') }, events).map(
      e => e.id,
    ),
    ['polish'],
    'an event never clashes with itself',
  );
});

test('a plan sent to Today for review: the chosen one first, gone after Not now, and never offered again once added', () => {
  const at = (day: string, time: string) => new Date(`${day}T${time}:00`).toISOString();
  const garden = {
    title: 'Garden morning',
    start: at('2026-10-24', '10:00'),
    end: at('2026-10-24', '11:00'),
  };
  const supper = {
    title: 'Harvest supper',
    start: at('2026-10-24', '18:00'),
    end: at('2026-10-24', '20:00'),
  };
  const found = { found: [garden, supper], dismissed: false };
  assert.deepEqual(plansToReview(found, undefined, new Set()), [garden, supper]);
  // "Add to calendar" on the second plan in the reader shows that one, even though Groq listed it second.
  assert.equal(
    emailContext('garden', [], plansToReview(found, supper, new Set()))?.proposal,
    supper,
  );
  assert.equal(
    plansToReview({ ...found, dismissed: true }, supper, new Set()),
    undefined,
    'Not now hides the chosen plan too',
  );
  assert.equal(plansToReview(undefined, undefined, new Set()), undefined);
  // Added at another time with a new title, the saved event no longer looks like the plan; the next plan follows.
  const saved: CalendarEvent = {
    id: 's',
    accountId: 'personal',
    calendarId: 'demo-personal',
    title: 'Herb beds',
    start: at('2026-10-24', '11:00'),
    end: at('2026-10-24', '12:30'),
    allDay: false,
    location: '',
    description: '',
    guests: [],
    threadId: 'garden',
  };
  assert.equal(
    emailContext('garden', [saved], plansToReview(found, garden, new Set()))?.proposal,
    garden,
    'without the record it would come back',
  );
  assert.equal(
    emailContext('garden', [saved], plansToReview(found, garden, new Set([planKey(garden)])))
      ?.proposal,
    supper,
  );
  assert.deepEqual(
    emailContext(
      'garden',
      [saved],
      plansToReview(found, garden, new Set([planKey(garden), planKey(supper)])),
    ),
    { day: '2026-10-24', saved },
  );
});

test('a found plan written with a local offset still matches the same event saved in UTC under another title', () => {
  const saved: CalendarEvent = {
    id: 'r',
    accountId: 'work',
    calendarId: 'demo-work',
    title: 'Project review',
    start: '2026-10-23T21:00:00.000Z',
    end: '2026-10-23T22:00:00.000Z',
    allDay: false,
    location: '',
    description: '',
    guests: [],
    threadId: 'review',
  };
  const plan = {
    title: 'Friday review: agenda and room',
    start: '2026-10-23T14:00:00-07:00',
    end: '2026-10-23T15:00:00-07:00',
    allDay: false,
  };
  assert.deepEqual(emailContext('review', [saved], [plan]), {
    day: emailContext('review', [saved], undefined)!.day,
    saved,
  });
  assert.equal(
    emailContext(
      'review',
      [saved],
      [{ ...plan, start: '2026-10-23T15:00:00-07:00', end: '2026-10-23T16:00:00-07:00' }],
    )?.proposal?.title,
    plan.title,
    'an hour later is a different plan',
  );
});
