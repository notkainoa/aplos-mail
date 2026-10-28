import type { Calendar, Event, EventTime } from '@aplos/contract';
import { addDays, atLocal, weekday } from '../time';

/**
 * The demo's calendars and the week's events, from Aplos's own original demo
 * (`packages/engine/src/legacy/demo.ts`), in the engine's zone. The content is part of the demo
 * dataset: `demoData` folds these rows into its output.
 */
export function demoCalendars(
  accounts: { work: string; personal: string },
  today: string,
  zone: string,
): { calendars: Calendar[]; events: Event[] } {
  const calendars: Calendar[] = [];
  const events: Event[] = [];
  const cal = (
    accountId: string,
    key: string,
    name: string,
    colorTag: string,
    primary = false,
  ): Calendar => ({
    id: `${accountId}:cal-${key}`,
    accountId,
    name,
    colorTag,
    primary,
    readOnly: false,
    shown: true,
    providerHidden: false,
    timeZone: zone,
  });
  calendars.push(
    cal(accounts.work, 'work', 'Work', 'slate', true),
    cal(accounts.work, 'team', 'Team', 'violet'),
    cal(accounts.work, 'focus', 'Focus time', 'teal'),
    ...(accounts.personal !== accounts.work
      ? [cal(accounts.personal, 'personal', 'Personal', 'clay', true)]
      : [cal(accounts.personal, 'personal', 'Personal', 'clay')]),
    cal(accounts.personal, 'family', 'Family', 'ochre'),
    cal(accounts.personal, 'fitness', 'Fitness', 'green'),
  );
  const weekStart = addDays(today, -weekday(today));
  const at = (d: number, h: number, m = 0): EventTime => ({
    type: 'utc',
    utc: atLocal(addDays(weekStart, d), h, m, zone),
  });
  const allDay = (d: number): EventTime => ({ type: 'date', date: addDays(weekStart, d) });
  type Plan = [
    key: string,
    slot: 'work' | 'personal',
    calendar: string,
    title: string,
    start: EventTime,
    end: EventTime,
    extra?: { location?: string; description?: string; guests?: string[] },
  ];
  const plans: Plan[] = [
    ...[1, 2, 3, 4, 5].map((d): Plan => [
      `standup-${d}`,
      'work',
      'team',
      'Standup',
      at(d, 9),
      at(d, 9, 15),
      { location: 'Video call' },
    ]),
    [
      'planning',
      'work',
      'team',
      'Weekly planning',
      at(1, 9, 30),
      at(1, 10, 15),
      { description: 'Pick the three things that matter this week.' },
    ],
    [
      'critique',
      'work',
      'work',
      'Design critique',
      at(1, 13),
      at(1, 14),
      {
        location: 'Studio, second floor',
        guests: ['jordan@studio.example', 'nadia@studio.example'],
      },
    ],
    [
      'layouts',
      'work',
      'work',
      'Layout review with Jordan',
      at(2, 10),
      at(2, 11),
      { guests: ['jordan@studio.example'] },
    ],
    ['brief', 'work', 'focus', 'Write the project brief', at(2, 10), at(2, 12)],
    ['one-on-one', 'work', 'team', '1:1 with Nadia', at(2, 14, 30), at(2, 15)],
    [
      'deep-work',
      'work',
      'focus',
      'Focus block',
      at(3, 9),
      at(3, 11, 30),
      { description: 'Notifications off.' },
    ],
    [
      'welcome-lunch',
      'work',
      'team',
      'Welcome lunch for new starters',
      at(3, 12),
      at(3, 13),
      { location: 'Green Table', guests: ['leah@studio.example'] },
    ],
    [
      'invoice-check',
      'work',
      'work',
      'Invoice check-in with Drew',
      at(4, 16),
      at(4, 16, 30),
      { location: 'Phone' },
    ],
    ['retro', 'work', 'team', 'Team retro', at(5, 10), at(5, 10, 45)],
    ['polish', 'work', 'focus', 'Prototype polish', at(5, 14), at(5, 16, 30)],
    ['offsite', 'work', 'work', 'Offsite prep', allDay(4), allDay(6)],
    [
      'run',
      'personal',
      'fitness',
      'Run club',
      at(1, 18, 30),
      at(1, 19, 30),
      { location: 'River path' },
    ],
    [
      'dinner',
      'personal',
      'personal',
      'Dinner with Sam',
      at(2, 19),
      at(2, 21),
      { location: 'Lantern Kitchen', guests: ['sam@friends.example'] },
    ],
    ['swim', 'personal', 'fitness', 'Morning swim', at(3, 7), at(3, 8)],
    [
      'dentist',
      'personal',
      'personal',
      'Dentist',
      at(3, 12, 30),
      at(3, 13, 15),
      { location: 'Bright Smile Dental' },
    ],
    ['yoga', 'personal', 'fitness', 'Yoga', at(4, 18), at(4, 19)],
    ['birthday', 'personal', 'family', 'Rosa’s birthday', allDay(4), allDay(5)],
    [
      'cabin',
      'personal',
      'family',
      'Cabin weekend',
      allDay(5),
      allDay(8),
      { location: 'Pine Hollow', guests: ['sam@friends.example'] },
    ],
    [
      'market',
      'personal',
      'personal',
      'Farmers market',
      at(0, 10),
      at(0, 11, 30),
      { location: 'Cedar Square' },
    ],
  ];
  const can = { edit: true, move: true, delete: true, rsvp: false, editGuests: true };
  for (const [key, slot, calendar, title, start, end, extra = {}] of plans) {
    const accountId = accounts[slot];
    const self = {
      address: slot === 'work' ? 'alex@studio.example' : 'alex@home.example',
      name: 'Alex Morgan',
      response: 'accepted',
      organizer: true,
      self: true,
    };
    events.push({
      id: `${accountId}:ev-${key}`,
      rev: 1,
      accountId,
      calendarId: `${accountId}:cal-${calendar}`,
      recurring: false,
      exception: false,
      title,
      start,
      end,
      allDay: start.type === 'date',
      timeZone: zone,
      ...(extra.location ? { location: extra.location } : {}),
      ...(extra.description ? { description: extra.description } : {}),
      organizer: self,
      attendees: extra.guests
        ? [
            self,
            ...extra.guests.map(address => ({
              address,
              response: 'accepted',
              organizer: false,
              self: false,
            })),
          ]
        : [],
      myResponse: 'accepted',
      status: 'confirmed',
      can,
      sync: 'synced',
    });
  }
  // An invitation from mail, so RSVP has something to answer.
  const theo = {
    address: 'theo@studio.example',
    name: 'Theo Kim',
    response: 'accepted',
    organizer: true,
    self: false,
  };
  events.push({
    id: `${accounts.work}:ev-review`,
    rev: 1,
    accountId: accounts.work,
    calendarId: `${accounts.work}:cal-work`,
    recurring: false,
    exception: false,
    title: 'Project review',
    start: { type: 'utc', utc: atLocal(addDays(today, 2), 14, 0, zone) },
    end: { type: 'utc', utc: atLocal(addDays(today, 2), 15, 0, zone) },
    allDay: false,
    timeZone: zone,
    location: 'Oak room',
    description: 'Review the prototype and agree on next steps.',
    organizer: theo,
    attendees: [
      theo,
      {
        address: 'alex@studio.example',
        name: 'Alex Morgan',
        response: 'needsAction',
        organizer: false,
        self: true,
      },
    ],
    myResponse: 'needsAction',
    status: 'confirmed',
    can: { edit: false, move: false, delete: true, rsvp: true, editGuests: false },
    sync: 'synced',
    invite: {
      threadId: `${accounts.work}:review`,
      messageId: `${accounts.work}:review.m1`,
      fromName: 'Theo Kim',
    },
  });
  return { calendars, events };
}
