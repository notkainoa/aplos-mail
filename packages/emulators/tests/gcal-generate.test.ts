import assert from 'node:assert/strict';
import test from 'node:test';
import { ME, setupCal, timed } from './gcal-helpers';

/** An event as the JSON response carries it. */
interface EventJson {
  [field: string]: unknown;
  id: string;
  summary?: string;
  etag: string;
  status: string;
  recurrence?: string[];
  start: { [field: string]: unknown; date?: string; dateTime?: string; timeZone?: string };
  organizer: { email: string; self?: boolean };
  creator: { email: string };
  hangoutLink?: string;
  attendees?: GuestJson[];
  conferenceData?: {
    [field: string]: unknown;
    entryPoints: { entryPointType?: string; uri?: string }[];
    conferenceSolution: { key: { type?: string } };
  };
}
/** An attendee as the JSON response carries it. */
interface GuestJson {
  [field: string]: unknown;
  email: string;
  responseStatus?: string;
  organizer?: boolean;
  self?: boolean;
}

const ALL_TIME = {
  singleEvents: true,
  timeMin: '2026-09-01T00:00:00-07:00',
  timeMax: '2027-02-01T00:00:00-08:00',
};

test('the generator builds the whole set: calendars, singles, all-day, weekly series, Meet links, invitations', async () => {
  const t = await setupCal();
  const gen = t.emu.calendar.seed();
  const entries = Object.fromEntries(t.emu.calendar.listCalendars().map(e => [e.id, e]));
  assert.equal(Object.keys(entries).length, 5);
  assert.equal(entries[gen.primaryId].primary, true);
  assert.equal(entries[gen.calendars.hidden].hidden, true);
  assert.equal(entries[gen.calendars.unselected].selected, undefined);
  assert.equal(entries[gen.calendars.readOnly].accessRole, 'reader');
  assert.equal(entries[gen.calendars.family].selected, true);
  assert.equal(gen.primaryId, ME);

  const events = (await t.call(t.events('primary', undefined, { showDeleted: true }))).json
    .items as EventJson[];
  const byId = new Map(events.map(e => [e.id, e]));
  assert.equal(gen.singleEventIds.length, 10);
  for (const id of gen.singleEventIds) assert.ok(byId.get(id)!.start.dateTime);
  for (const id of gen.allDayEventIds.slice(0, 2)) assert.ok(byId.get(id)!.start.date);

  // The weekly meeting: a master with a rule, one moved occurrence, one cancelled.
  const master = byId.get(gen.weekly.masterId)!;
  assert.deepEqual(master.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO']);
  assert.equal(byId.get(gen.weekly.overrideId)!.summary, 'Weekly planning sync (moved)');
  assert.equal(byId.get(gen.weekly.cancelledId)!.status, 'cancelled');
  assert.equal(master.start.timeZone, 'America/Los_Angeles');
  const weekdays = (
    await t.call(`${t.events('primary', gen.weekly.masterId)}/instances?maxResults=40`)
  ).json.items;
  assert.ok(
    weekdays.some((e: EventJson) => e.start.dateTime?.endsWith('-07:00')) &&
      weekdays.some((e: EventJson) => e.start.dateTime?.endsWith('-08:00')),
    'the series crosses the DST change',
  );

  // Meet links: conferenceData and hangoutLink agree.
  for (const id of [gen.weekly.masterId, ...gen.meetEventIds]) {
    const e = byId.get(id)!;
    assert.equal(e.conferenceData!.conferenceSolution.key.type, 'hangoutsMeet');
    assert.equal(e.conferenceData!.entryPoints[0].entryPointType, 'video');
    assert.equal(e.hangoutLink, e.conferenceData!.entryPoints[0].uri);
    assert.match(e.hangoutLink!, /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  }

  // Invitations: somebody else organises, the user is a needsAction guest.
  assert.equal(gen.invitationIds.length, 3);
  for (const id of gen.invitationIds) {
    const e = byId.get(id)!;
    assert.notEqual(e.organizer.email, ME);
    assert.equal(e.organizer.self, undefined);
    assert.equal(e.creator.email, e.organizer.email);
    const me = e.attendees!.find(a => a.self)!;
    assert.equal(me.email, ME);
    assert.equal(me.responseStatus, 'needsAction');
    assert.equal(e.attendees!.find(a => a.organizer)!.responseStatus, 'accepted');
  }
  // Events on the other calendars.
  assert.equal((await t.call(t.events(gen.calendars.hidden))).json.items.length, 1);
  assert.equal((await t.call(t.events(gen.calendars.readOnly))).json.items.length, 2);
});

test('the same seed gives the same data, a different seed gives different data', async () => {
  const snapshot = async (seed: number) => {
    const t = await setupCal({ seed });
    t.emu.calendar.seed({ seed });
    const items = (await t.call(t.events('primary', undefined, { showDeleted: true }))).json
      .items as EventJson[];
    return items.map(e => [e.id, e.summary, e.start?.dateTime ?? e.start?.date, e.etag]);
  };
  assert.deepEqual(await snapshot(3), await snapshot(3));
  assert.notDeepEqual(await snapshot(3), await snapshot(4));
});

test('all generated data is synthetic: example.test addresses and invented titles only', async () => {
  const t = await setupCal();
  t.emu.calendar.seed();
  const events = (await t.call(t.events('primary', undefined, { ...ALL_TIME, maxResults: 2500 })))
    .json.items as EventJson[];
  const emails = new Set<string>();
  for (const e of events) for (const a of e.attendees ?? []) emails.add(a.email);
  for (const email of emails) assert.match(email, /@example\.test$/, email);
  for (const e of t.emu.calendar.listCalendars())
    assert.ok(
      e.id === ME || e.id.endsWith('@example.test') || e.id.endsWith('@group.calendar.google.com'),
    );
});

test('the request log holds no titles, descriptions, attendees, addresses, ids or tokens', async () => {
  const t = await setupCal();
  const gen = t.emu.calendar.seed();
  const secrets = [
    'Quarterly secret offsite',
    'confidential agenda text',
    'Secret Room 12',
    'guest.zeta@example.test',
    'Zeta Guest',
  ];
  const created = await t.call(
    t.events('primary', undefined, { sendUpdates: 'all', conferenceDataVersion: 1 }),
    {
      method: 'POST',
      body: timed(secrets[0], '2026-11-12T09:00:00', '2026-11-12T10:00:00', {
        description: secrets[1],
        location: secrets[2],
        attendees: [{ email: secrets[3], displayName: secrets[4] }],
        conferenceData: {
          createRequest: {
            requestId: 'secret-request-id',
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      }),
    },
  );
  const id = created.json.id;
  const sync = (await t.call(t.events('primary'))).json.nextSyncToken;
  await t.call(t.events('primary', id), {
    method: 'PUT',
    body: timed(secrets[0], '2026-11-12T09:00:00', '2026-11-12T10:00:00'),
    headers: { 'if-match': '"stale"' },
  });
  await t.call(t.events('primary', id), { method: 'PATCH', body: { summary: secrets[0] } });
  await t.call(t.events('primary', undefined, { syncToken: sync, fields: 'items(id,summary)' }));
  await t.call(t.events('primary', undefined, { syncToken: 'garbage-secret-token' }));
  await t.call(t.events('primary', undefined, { fields: 'items(summry)' }));
  await t.call(`${t.events('primary', gen.weekly.masterId)}/instances?maxResults=3`);
  await t.call(`/users/me/calendarList?showHidden=true`);
  await t.call(t.events(gen.calendars.readOnly), {
    method: 'POST',
    body: timed(secrets[0], '2026-11-12T09:00:00', '2026-11-12T10:00:00'),
  });
  await t.call(t.events('primary', gen.invitationIds[0]), {
    method: 'PUT',
    body: timed(secrets[0], '2026-11-12T09:00:00', '2026-11-12T10:00:00'),
  });
  await t.call(t.events('primary', id), { method: 'DELETE' });
  t.emu.setCalendarAbuse(true);
  await t.call(t.events('primary'), {
    method: 'POST',
    body: timed(secrets[0], '2026-11-12T09:00:00', '2026-11-12T10:00:00'),
  });

  const log = JSON.stringify(t.emu.log);
  const events = (
    await t.call(t.events('primary', undefined, { showDeleted: true, maxResults: 2500 }))
  ).json.items as EventJson[];
  const forbidden = [
    ...secrets,
    'garbage-secret-token',
    'secret-request-id',
    'example.test',
    '@',
    'Bearer',
    sync,
    id,
    created.json.etag,
    gen.weekly.masterId,
    ...events.map(e => e.summary).filter(Boolean),
    ...events.flatMap(e => (e.attendees ?? []).map((a: GuestJson) => a.email)),
    'meet.google.com',
  ];
  for (const word of forbidden) assert.ok(!log.includes(word), `log leaks ${word}`);
  // It does say what happened.
  const gcal = t.emu.log.filter(e => e.service === 'gcal');
  assert.ok(gcal.length > 10);
  assert.deepEqual(
    new Set(gcal.map(e => e.apiMethod)),
    new Set([
      'calendar.events.insert',
      'calendar.events.list',
      'calendar.events.update',
      'calendar.events.patch',
      'calendar.events.instances',
      'calendar.calendarList.list',
      'calendar.events.delete',
    ]),
  );
  assert.ok(gcal.some(e => e.reason === 'conditionNotMet'));
  assert.ok(gcal.some(e => e.reason === 'forbiddenForNonOrganizer'));
  assert.ok(gcal.some(e => e.reason === 'forbidden'));
  assert.ok(gcal.some(e => e.reason === 'fullSyncRequired'));
  assert.ok(gcal.some(e => e.reason === 'quotaExceeded'));
  assert.ok(gcal.some(e => e.reason === 'invalidParameter'));
  for (const entry of gcal)
    assert.deepEqual(
      Object.keys(entry)
        .sort()
        .filter(
          k =>
            ![
              'seq',
              'at',
              'service',
              'apiMethod',
              'httpMethod',
              'units',
              'status',
              'inFlight',
              'account',
              'reason',
              'fault',
              'batch',
            ].includes(k),
        ),
      [],
    );
});

test('a client can run the per-calendar sync the plan describes: one token per calendar, failures isolated', async () => {
  const t = await setupCal();
  const gen = t.emu.calendar.seed();
  const list = (await t.call('/users/me/calendarList')).json.items as EventJson[];
  const tokens: Record<string, string> = {};
  for (const cal of list)
    tokens[cal.id] = (
      await t.call(
        t.events(cal.id, undefined, { singleEvents: true, timeMin: '2026-09-01T00:00:00-07:00' }),
      )
    ).json.nextSyncToken;
  assert.equal(Object.keys(tokens).length, list.length);
  t.emu.calendar.editEvent('primary', gen.singleEventIds[0], { summary: 'Changed' });
  t.emu.calendar.expireSyncTokens({ calendarId: gen.calendars.family });
  const results: Record<string, number> = {};
  for (const cal of list)
    results[cal.id] = (
      await t.call(t.events(cal.id, undefined, { singleEvents: true, syncToken: tokens[cal.id] }))
    ).status;
  assert.equal(results[gen.calendars.family], 410);
  assert.equal(results[gen.primaryId], 200);
  assert.equal(Object.values(results).filter(s => s === 410).length, 1);
});
