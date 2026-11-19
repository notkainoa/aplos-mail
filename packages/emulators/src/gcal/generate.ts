import { Random, mixSeed } from '../gmail/rng';
import {
  deleteEvent,
  insertEvent,
  insertInvitation,
  patchEvent,
  seriesOf,
  type WriteOptions,
} from './events';
import { occurrences, type Occurrence } from './rrule';
import type { CalendarRecord, CalendarStore } from './store';
import type { GcalEvent } from './types';
import {
  civilOfDay,
  dateOfDay,
  dayOfCivil,
  isoInZone,
  localParts,
  localToUtc,
  weekdayOfDay,
} from './tz';

/**
 * A seeded calendar set for tests: a primary calendar plus four secondary ones (one hidden, one not
 * selected, one read-only and shared by someone else), single and all-day events, a weekly meeting
 * with a moved and a cancelled occurrence, events with Meet links, and invitations from others.
 * Every name and address is invented. Dates are relative to the clock, so a series always has past
 * and future occurrences.
 */
export interface GenerateCalendarsOptions {
  /** Test user (email or sub); the first user when omitted. */
  user?: string;
  seed?: number;
  /** Timed single events on the primary calendar. Default 10. */
  singleEvents?: number;
  /** Invitations from other organizers. Default 3. */
  invitations?: number;
}

export interface GeneratedCalendars {
  primaryId: string;
  /** Ids of the secondary calendars by role. */
  calendars: { family: string; hidden: string; unselected: string; readOnly: string };
  weekly: {
    masterId: string;
    /** The occurrence that was moved and retitled. */
    overrideId: string;
    /** The occurrence that was deleted. */
    cancelledId: string;
    timeZone: string;
  };
  singleEventIds: string[];
  allDayEventIds: string[];
  meetEventIds: string[];
  invitationIds: string[];
  readOnlyEventIds: string[];
}

const ZONE = 'America/Los_Angeles';
const HOUR = 3_600_000;
const TITLES = [
  'Dentist appointment',
  'Lunch with Sam',
  'Design review',
  'Piano lesson',
  'Budget check-in',
  'Dog groomer',
  'Quarterly planning',
  'Coffee with Priya',
  'Library return',
  'Garden club',
  'Invoice review',
  'Bike service',
  'Reading hour',
  'Team retro',
];
const PLACES = ['Room 4B', 'Harbor Cafe', 'Studio 2', 'Main Street Library', 'Online'];
const COLLEAGUES = [
  'sam.ortiz@example.test',
  'priya.nair@example.test',
  'lee.chen@example.test',
  'jo.baker@example.test',
];
const ORGANIZERS = [
  { email: 'casey.rivera@example.test', displayName: 'Casey Rivera' },
  { email: 'morgan.fox@example.test', displayName: 'Morgan Fox' },
  { email: 'robin.diaz@example.test', displayName: 'Robin Diaz' },
];

/** The local date (as a day number) `offset` days from today. */
function dayFromToday(now: number, offset: number): number {
  const p = localParts(now, ZONE);
  return dayOfCivil(p.y, p.mo, p.d) + offset;
}

function at(day: number, hour: number, minute = 0): number {
  const c = civilOfDay(day);
  return localToUtc({ y: c.y, mo: c.mo, d: c.d, h: hour, mi: minute, s: 0 }, ZONE);
}

const zoned = (ms: number) => ({ dateTime: isoInZone(ms, ZONE), timeZone: ZONE });

export function generateCalendars(
  store: CalendarStore,
  options: GenerateCalendarsOptions = {},
): GeneratedCalendars {
  const random = new Random(mixSeed(options.seed ?? 1, 4242));
  const now = store.now();
  const opts: WriteOptions = { sendUpdates: 'none', conferenceDataVersion: 1, trusted: true };

  const primary = store.addCalendar({
    id: store.owner.email,
    summary: store.owner.name,
    primary: true,
    timeZone: ZONE,
    accessRole: 'owner',
    selected: true,
    backgroundColor: '#9fe1e7',
  });
  const family = store.addCalendar({
    summary: 'Family',
    timeZone: ZONE,
    selected: true,
    backgroundColor: '#f83a22',
  });
  const hidden = store.addCalendar({
    summary: 'Side project',
    timeZone: ZONE,
    hidden: true,
    selected: false,
    backgroundColor: '#b99aff',
  });
  const unselected = store.addCalendar({
    summary: 'Reading club',
    timeZone: ZONE,
    selected: false,
    backgroundColor: '#fad165',
  });
  const shared = store.addCalendar({
    id: 'team.holidays@example.test',
    summary: 'Team holidays',
    timeZone: ZONE,
    accessRole: 'reader',
    selected: true,
    backgroundColor: '#16a765',
  });

  const insert = (cal: CalendarRecord, body: Record<string, unknown>) =>
    insertEvent(store, cal, body, opts).id;

  // Weekly planning sync: Mondays 10:00-10:30, starting two Mondays ago so it crosses the autumn DST change.
  const today = dayFromToday(now, 0);
  const lastMonday = today - ((weekdayOfDay(today) + 6) % 7);
  const startDay = lastMonday - 14;
  const masterId = insert(primary, {
    summary: 'Weekly planning sync',
    description: 'Standing agenda: blockers, priorities, plans for the week.',
    start: zoned(at(startDay, 10)),
    end: zoned(at(startDay, 10, 30)),
    recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
    attendees: COLLEAGUES.slice(0, 3).map((email, i) => ({
      email,
      responseStatus: (['accepted', 'tentative', 'needsAction'] as const)[i],
    })),
    conferenceData: {
      createRequest: { requestId: 'gen-weekly', conferenceSolutionKey: { type: 'hangoutsMeet' } },
    },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
    colorId: '9',
  });
  const master = primary.events.get(masterId)!.event;
  const [, , third, fourth] = takeOccurrences(master, 4);
  const overrideId = `${masterId}_${third.key}`;
  patchEvent(
    store,
    primary,
    overrideId,
    {
      summary: 'Weekly planning sync (moved)',
      start: zoned(third.startMs + HOUR),
      end: zoned(third.startMs + HOUR + 30 * 60_000),
    },
    opts,
  );
  const cancelledId = `${masterId}_${fourth.key}`;
  deleteEvent(store, primary, cancelledId, opts);

  const singleEventIds: string[] = [];
  for (let i = 0; i < (options.singleEvents ?? 10); i++) {
    const day = today + random.int(-10, 20);
    const hour = random.int(8, 17);
    const minutes = random.pick([30, 60, 90]);
    singleEventIds.push(
      insert(primary, {
        summary: TITLES[i % TITLES.length],
        location: random.pick(PLACES),
        start: zoned(at(day, hour)),
        end: zoned(at(day, hour) + minutes * 60_000),
      }),
    );
  }

  const allDayEventIds = [
    insert(primary, {
      summary: 'Offsite day',
      start: { date: dateOfDay(today + 3) },
      end: { date: dateOfDay(today + 4) },
      transparency: 'transparent',
    }),
    insert(primary, {
      summary: 'Trip to Lake Town',
      start: { date: dateOfDay(today + 12) },
      end: { date: dateOfDay(today + 15) },
    }),
    insert(family, {
      summary: 'Grandma visiting',
      start: { date: dateOfDay(today + 6) },
      end: { date: dateOfDay(today + 8) },
    }),
  ];

  // Two single events that carry a Google Meet room.
  const meetEventIds = [1, 2].map(n =>
    insert(primary, {
      summary: n === 1 ? 'Product demo' : 'Mentoring call',
      start: zoned(at(today + n * 2, 14)),
      end: zoned(at(today + n * 2, 15)),
      attendees: [
        { email: COLLEAGUES[n], responseStatus: 'accepted' },
        { email: COLLEAGUES[n + 1] },
      ],
      conferenceData: {
        createRequest: {
          requestId: `gen-meet-${n}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    }),
  );

  // Events on the other calendars, so every one has something in it.
  insert(unselected, {
    summary: 'Book swap',
    start: zoned(at(today + 5, 18)),
    end: zoned(at(today + 5, 20)),
  });
  insert(hidden, {
    summary: 'Prototype checkpoint',
    start: zoned(at(today + 4, 11)),
    end: zoned(at(today + 4, 12)),
  });
  const readOnlyEventIds = [
    insert(shared, {
      summary: 'Company holiday',
      start: { date: dateOfDay(today + 9) },
      end: { date: dateOfDay(today + 10) },
    }),
    insert(shared, {
      summary: 'Team offsite planning',
      start: zoned(at(today + 7, 9)),
      end: zoned(at(today + 7, 10)),
    }),
  ];

  const invitationIds: string[] = [];
  for (let i = 0; i < (options.invitations ?? 3); i++) {
    const organizer = ORGANIZERS[i % ORGANIZERS.length];
    const day = today + 1 + i * 2;
    const event = insertInvitation(store, primary, {
      organizer,
      fields: {
        summary: ['Kickoff workshop', 'Roadmap review', 'Vendor intro call'][i % 3],
        start: zoned(at(day, 13)),
        end: zoned(at(day, 14)),
        attendees: [
          { email: organizer.email, responseStatus: 'accepted' },
          { email: store.owner.email, responseStatus: 'needsAction' },
          ...(i % 2 === 0
            ? [{ email: COLLEAGUES[i % COLLEAGUES.length], responseStatus: 'accepted' as const }]
            : []),
        ],
      },
    });
    invitationIds.push(event.id);
  }

  return {
    primaryId: primary.id,
    calendars: {
      family: family.id,
      hidden: hidden.id,
      unselected: unselected.id,
      readOnly: shared.id,
    },
    weekly: { masterId, overrideId, cancelledId, timeZone: ZONE },
    singleEventIds,
    allDayEventIds,
    meetEventIds,
    invitationIds,
    readOnlyEventIds,
  };
}

/** The first `count` occurrences of a master, for picking the ones to edit. */
function takeOccurrences(master: GcalEvent, count: number): Occurrence[] {
  const out: Occurrence[] = [];
  for (const occ of occurrences(seriesOf(master, ZONE))) {
    out.push(occ);
    if (out.length >= count) break;
  }
  return out;
}
