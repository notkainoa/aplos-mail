/**
 * Blind fidelity probes for the Google Calendar emulator.
 *
 * Each probe sends one request (or a short sequence) that the real Google Calendar API v3 answers
 * in a specific, documented or widely observed way, and asserts that answer. They were written
 * from Google's documentation and observed behaviour, not from the emulator's code: a failing
 * probe is a fidelity gap the emulator's author must fix or justify.
 *
 * Sources, cited per probe:
 *   [list]      developers.google.com/workspace/calendar/api/v3/reference/events/list
 *   [sync]      developers.google.com/workspace/calendar/api/guides/sync
 *   [errors]    developers.google.com/workspace/calendar/api/guides/errors
 *   [quota]     developers.google.com/workspace/calendar/api/guides/quota
 *   [update]    developers.google.com/workspace/calendar/api/v3/reference/events/update
 *   [patch]     developers.google.com/workspace/calendar/api/guides/performance#patch
 *   [version]   developers.google.com/workspace/calendar/api/guides/version-resources (ETags, If-Match)
 *   [events]    developers.google.com/workspace/calendar/api/v3/reference/events (resource: id, attendees)
 *   [recur]     developers.google.com/workspace/calendar/api/guides/recurringevents
 *   [instances] developers.google.com/workspace/calendar/api/v3/reference/events/instances
 *   [calList]   developers.google.com/workspace/calendar/api/v3/reference/calendarList/list
 *   [auth]      developers.google.com/workspace/calendar/api/auth (scopes per method)
 *   [observed]  behaviour widely reported from live Google responses; noted as such
 *   [D11]       research/email-clients/protocols/proto-google.md §9 D11
 *
 * All data is synthetic (example.test, invented titles).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { SCOPE } from '../src/gmail';
import { ME, setupCal, timed, type CalHarness } from './gcal-helpers';
import type { GcalEvent, InvitationSpec } from '../src/gcal';

const LIST = '/users/me/calendarList';

/** An error body Google's API answers with. */
interface ApiJson {
  [field: string]: unknown;
  error?: {
    [field: string]: unknown;
    code?: number;
    message?: string;
    errors?: {
      reason?: string;
      domain?: string;
      message?: string;
    }[];
  };
}
/** An event as the JSON response carries it. */
interface EventJson {
  [field: string]: unknown;
  id?: string;
  status?: string;
  summary?: string;
  recurringEventId?: string;
  location?: string;
}
/** An attendee as the JSON response carries it. */
interface GuestJson {
  [field: string]: unknown;
  email: string;
  responseStatus?: string;
  organizer?: boolean;
  self?: boolean;
}
/** A calendarList entry as the JSON response carries it. */
interface EntryJson {
  [field: string]: unknown;
  id?: string;
  hidden?: boolean;
}

const reasonOf = (json: ApiJson): string | undefined => json?.error?.errors?.[0]?.reason;
const domainOf = (json: ApiJson): string | undefined => json?.error?.errors?.[0]?.domain;
const RATE_REASONS = ['rateLimitExceeded', 'userRateLimitExceeded'];

/** Inserts an event over REST and returns the created resource. */
async function insert(
  t: CalHarness,
  body: Record<string, unknown>,
  query: Record<string, string | number | boolean> = {},
): Promise<GcalEvent> {
  const r = await t.call(t.events('primary', undefined, query), { method: 'POST', body });
  assert.equal(r.status, 200, `insert failed: ${r.text}`);
  return r.json;
}

/** Pages through events.list to the end and returns the last page's nextSyncToken. */
async function fullSync(
  t: CalHarness,
  query: Record<string, string | number | boolean> = {},
): Promise<string> {
  let pageToken: string | undefined;
  for (;;) {
    const r = await t.call(
      t.events('primary', undefined, { ...query, ...(pageToken ? { pageToken } : {}) }),
    );
    assert.equal(r.status, 200, r.text);
    if (r.json.nextPageToken) {
      pageToken = r.json.nextPageToken;
      continue;
    }
    assert.ok(r.json.nextSyncToken, 'last page carries nextSyncToken');
    return r.json.nextSyncToken;
  }
}

function invitation(t: CalHarness, extra: Record<string, unknown> = {}): GcalEvent {
  const spec: InvitationSpec = {
    summary: 'Quarterly orchard review',
    organizer: { email: 'casey.rivera@example.test' },
    guests: ['lee.chen@example.test'],
    start: { dateTime: '2026-11-04T13:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-04T14:00:00-08:00', timeZone: 'America/Los_Angeles' },
    ...extra,
  };
  return t.emu.calendar.addInvitation(spec);
}

// ---------------------------------------------------------------------------------------------
// events.list parameter rules
// ---------------------------------------------------------------------------------------------

test('PROBE 01 syncToken with timeMin is refused 400 [list][sync]', async () => {
  const t = await setupCal();
  t.emu.calendar.addEvent(
    'primary',
    timed('Seed walk', '2026-11-04T09:00:00', '2026-11-04T10:00:00'),
  );
  const token = await fullSync(t);
  const r = await t.call(
    t.events('primary', undefined, { syncToken: token, timeMin: '2026-11-01T00:00:00Z' }),
  );
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.error.code, 400);
});

test('PROBE 02 syncToken with updatedMin, q, orderBy, timeMax, iCalUID or extended-property filters is refused 400 [list][sync]', async () => {
  const t = await setupCal();
  t.emu.calendar.addEvent(
    'primary',
    timed('Seed walk', '2026-11-04T09:00:00', '2026-11-04T10:00:00'),
  );
  const token = await fullSync(t);
  const extras: Record<string, string>[] = [
    { updatedMin: '2026-10-01T00:00:00Z' },
    { q: 'walk' },
    { orderBy: 'updated' },
    { timeMax: '2027-01-01T00:00:00Z' },
    { iCalUID: 'probe@example.test' },
    { privateExtendedProperty: 'k=v' },
    { sharedExtendedProperty: 'k=v' },
  ];
  const accepted: string[] = [];
  for (const extra of extras) {
    const r = await t.call(t.events('primary', undefined, { syncToken: token, ...extra }));
    if (r.status !== 400) accepted.push(`${Object.keys(extra)[0]} -> ${r.status}`);
  }
  assert.deepEqual(accepted, []);
});

test('PROBE 03 orderBy=startTime without singleEvents=true is 400 "The requested ordering is not available for the particular query." [list][observed message]', async () => {
  const t = await setupCal();
  const r = await t.call(t.events('primary', undefined, { orderBy: 'startTime' }));
  assert.equal(r.status, 400, r.text);
  assert.equal(reasonOf(r.json), 'badRequest');
  assert.match(r.json.error.message, /requested ordering is not available/);
});

test('PROBE 04 orderBy=startTime with singleEvents=true is allowed and ascending; orderBy=updated needs no singleEvents [list]', async () => {
  const t = await setupCal();
  t.emu.calendar.addEvent('primary', timed('Later', '2026-11-09T09:00:00', '2026-11-09T10:00:00'));
  t.emu.calendar.addEvent('primary', timed('Sooner', '2026-11-03T09:00:00', '2026-11-03T10:00:00'));
  const r = await t.call(
    t.events('primary', undefined, { singleEvents: true, orderBy: 'startTime' }),
  );
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(
    r.json.items.map((e: EventJson) => e.summary),
    ['Sooner', 'Later'],
  );
  assert.equal((await t.call(t.events('primary', undefined, { orderBy: 'updated' }))).status, 200);
});

test('PROBE 05 timeMin without a time zone offset is refused 400 ("mandatory time zone offset") [list]', async () => {
  const t = await setupCal();
  const r = await t.call(t.events('primary', undefined, { timeMin: '2026-11-01T00:00:00' }));
  assert.equal(r.status, 400, r.text);
});

test('PROBE 06 maxResults above 2500 is accepted and capped at 2500, not refused [list "The page size can never be larger than 2500 events"]', async () => {
  const t = await setupCal();
  for (let i = 0; i < 2510; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    t.emu.calendar.addEvent(
      'primary',
      timed(`Filler ${i}`, `2026-12-${day}T09:00:00`, `2026-12-${day}T10:00:00`),
    );
  }
  const r = await t.call(t.events('primary', undefined, { maxResults: 5000 }));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.items.length, 2500);
  assert.ok(r.json.nextPageToken, 'the rest is on a next page');
  assert.equal(r.json.nextSyncToken, undefined);
});

test('PROBE 07 nextSyncToken appears only on the last page [sync]', async () => {
  const t = await setupCal();
  for (let i = 0; i < 5; i++)
    t.emu.calendar.addEvent(
      'primary',
      timed(`Item ${i}`, `2026-11-0${i + 2}T09:00:00`, `2026-11-0${i + 2}T10:00:00`),
    );
  const first = await t.call(t.events('primary', undefined, { maxResults: 2 }));
  assert.equal(first.json.items.length, 2);
  assert.ok(first.json.nextPageToken);
  assert.equal(first.json.nextSyncToken, undefined);
  const second = await t.call(
    t.events('primary', undefined, { maxResults: 2, pageToken: first.json.nextPageToken }),
  );
  const third = await t.call(
    t.events('primary', undefined, { maxResults: 2, pageToken: second.json.nextPageToken }),
  );
  assert.equal(third.json.items.length, 1);
  assert.equal(third.json.nextPageToken, undefined);
  assert.ok(third.json.nextSyncToken);
});

test('PROBE 08 events.list on an unknown calendar is 404 notFound, domain global, "Not Found" [errors][observed]', async () => {
  const t = await setupCal();
  const r = await t.call(t.events('nobody.here@example.test'));
  assert.equal(r.status, 404, r.text);
  assert.equal(reasonOf(r.json), 'notFound');
  assert.equal(domainOf(r.json), 'global');
  assert.equal(r.json.error.message, 'Not Found');
});

// ---------------------------------------------------------------------------------------------
// Sync tokens and deletions
// ---------------------------------------------------------------------------------------------

test('PROBE 09 an invalidated syncToken is 410 fullSyncRequired, domain calendar [sync][errors]', async () => {
  const t = await setupCal();
  t.emu.calendar.addEvent(
    'primary',
    timed('Seed walk', '2026-11-04T09:00:00', '2026-11-04T10:00:00'),
  );
  const token = await fullSync(t);
  t.emu.calendar.expireSyncTokens({});
  const r = await t.call(t.events('primary', undefined, { syncToken: token }));
  assert.equal(r.status, 410, r.text);
  assert.equal(reasonOf(r.json), 'fullSyncRequired');
  assert.equal(domainOf(r.json), 'calendar');
  assert.equal(r.json.error.code, 410);
  assert.equal(r.json.error.message, 'Sync token is no longer valid, a full sync is required.');
});

test('PROBE 10 a deleted event comes back in incremental sync with status cancelled, even without showDeleted [sync][list]', async () => {
  const t = await setupCal();
  const doomed = t.emu.calendar.addEvent(
    'primary',
    timed('Doomed picnic', '2026-11-05T09:00:00', '2026-11-05T10:00:00'),
  );
  const token = await fullSync(t);
  assert.equal((await t.call(t.events('primary', doomed.id), { method: 'DELETE' })).status, 204);
  const r = await t.call(t.events('primary', undefined, { syncToken: token }));
  assert.equal(r.status, 200, r.text);
  const stub = r.json.items.find((e: EventJson) => e.id === doomed.id);
  assert.ok(stub, 'deleted event is in the incremental result');
  assert.equal(stub.status, 'cancelled');
  assert.ok(r.json.nextSyncToken);
});

test('PROBE 11 a plain list (no showDeleted) leaves deleted events out [list showDeleted default False]', async () => {
  const t = await setupCal();
  const doomed = t.emu.calendar.addEvent(
    'primary',
    timed('Doomed picnic', '2026-11-05T09:00:00', '2026-11-05T10:00:00'),
  );
  await t.call(t.events('primary', doomed.id), { method: 'DELETE' });
  const r = await t.call(t.events('primary'));
  assert.ok(!r.json.items.some((e: EventJson) => e.id === doomed.id));
  const shown = await t.call(t.events('primary', undefined, { showDeleted: true }));
  assert.equal(shown.json.items.find((e: EventJson) => e.id === doomed.id)?.status, 'cancelled');
});

test('PROBE 12 deleting an already deleted event is 410 "deleted" [errors][observed]', async () => {
  const t = await setupCal();
  const e = t.emu.calendar.addEvent(
    'primary',
    timed('Twice gone', '2026-11-05T09:00:00', '2026-11-05T10:00:00'),
  );
  assert.equal((await t.call(t.events('primary', e.id), { method: 'DELETE' })).status, 204);
  const again = await t.call(t.events('primary', e.id), { method: 'DELETE' });
  assert.equal(again.status, 410, again.text);
  assert.equal(reasonOf(again.json), 'deleted');
});

// ---------------------------------------------------------------------------------------------
// Writes: ETags, PUT vs PATCH, organizer rules
// ---------------------------------------------------------------------------------------------

test('PROBE 13 If-Match with a stale etag is 412 conditionNotMet; the current etag succeeds [version][errors]', async () => {
  const t = await setupCal();
  const e = await insert(t, timed('Etag check', '2026-11-04T09:00:00', '2026-11-04T10:00:00'));
  const moved = await t.call(t.events('primary', e.id), {
    method: 'PATCH',
    body: { location: 'Room 4' },
  });
  assert.equal(moved.status, 200);
  assert.notEqual(moved.json.etag, e.etag);
  const stale = await t.call(t.events('primary', e.id), {
    method: 'PATCH',
    body: { summary: 'Lost write' },
    headers: { 'if-match': e.etag },
  });
  assert.equal(stale.status, 412, stale.text);
  assert.equal(reasonOf(stale.json), 'conditionNotMet');
  const fresh = await t.call(t.events('primary', e.id), {
    method: 'PATCH',
    body: { summary: 'Kept write' },
    headers: { 'if-match': moved.json.etag },
  });
  assert.equal(fresh.status, 200);
});

test('PROBE 14 D11: PUT without conferenceData drops the Meet room and colour; PATCH of one field keeps them [update][D11]', async () => {
  const t = await setupCal();
  const meet = {
    conferenceId: 'abc-defg-hij',
    conferenceSolution: { key: { type: 'hangoutsMeet' }, name: 'Google Meet' },
    entryPoints: [
      {
        entryPointType: 'video',
        uri: 'https://meet.google.com/abc-defg-hij',
        label: 'meet.google.com/abc-defg-hij',
      },
    ],
  };
  // Created over REST with conferenceDataVersion=1, the only way a client can attach an existing conference.
  const seed = () =>
    insert(
      t,
      timed('Standup', '2026-11-04T09:00:00', '2026-11-04T10:00:00', {
        conferenceData: meet,
        colorId: '5',
        visibility: 'private',
      }),
      { conferenceDataVersion: 1 },
    );
  const a = await seed();
  assert.equal(
    a.conferenceData?.conferenceId,
    'abc-defg-hij',
    'precondition: the Meet room was stored',
  );
  const patched = await t.call(t.events('primary', a.id), {
    method: 'PATCH',
    body: { summary: 'Standup moved' },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.conferenceData?.conferenceId, 'abc-defg-hij');
  assert.equal(patched.json.colorId, '5');
  const b = await seed();
  const put = await t.call(t.events('primary', b.id), {
    method: 'PUT',
    body: timed('Standup moved', '2026-11-04T09:00:00', '2026-11-04T10:00:00'),
  });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.conferenceData, undefined);
  assert.equal(put.json.hangoutLink, undefined);
  assert.equal(put.json.colorId, undefined);
  assert.equal(put.json.visibility, undefined);
});

test('PROBE 14b insert without conferenceDataVersion=1 ignores conferenceData in the body [events/insert conferenceDataVersion "Version 0 ... ignores conference data"]', async () => {
  const t = await setupCal();
  const e = await insert(
    t,
    timed('No room', '2026-11-04T09:00:00', '2026-11-04T10:00:00', {
      conferenceData: {
        conferenceId: 'zzz-zzzz-zzz',
        conferenceSolution: { key: { type: 'hangoutsMeet' } },
        entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/zzz-zzzz-zzz' }],
      },
    }),
  );
  assert.equal(e.conferenceData, undefined);
});

test('PROBE 15 PATCH replaces the whole attendees array (no per-item merge) for the organizer [patch]', async () => {
  const t = await setupCal();
  const e = await insert(
    t,
    timed('Planning', '2026-11-04T09:00:00', '2026-11-04T10:00:00', {
      attendees: [
        { email: 'priya.nair@example.test' },
        { email: 'lee.chen@example.test' },
        { email: 'sam.ortiz@example.test' },
      ],
    }),
  );
  const r = await t.call(t.events('primary', e.id), {
    method: 'PATCH',
    body: { attendees: [{ email: 'lee.chen@example.test' }] },
  });
  assert.equal(r.status, 200, r.text);
  // Google may keep the organizer's own entry; the point is that the other guests are gone.
  assert.deepEqual(
    r.json.attendees.filter((a: GuestJson) => !a.organizer).map((a: GuestJson) => a.email),
    ['lee.chen@example.test'],
  );
});

test('PROBE 16 a guest changing the summary is 403 forbiddenForNonOrganizer [update][errors]', async () => {
  const t = await setupCal();
  const invite = invitation(t);
  const r = await t.call(t.events('primary', invite.id), {
    method: 'PATCH',
    body: { summary: 'Hijacked title' },
  });
  assert.equal(r.status, 403, r.text);
  assert.equal(reasonOf(r.json), 'forbiddenForNonOrganizer');
  assert.equal(r.json.error.code, 403);
});

test('PROBE 17 a guest PATCHing the full attendees list with only their own responseStatus changed succeeds [events attendees[].responseStatus][observed]', async () => {
  const t = await setupCal();
  const invite = invitation(t);
  const attendees = invite.attendees!.map(a => (a.self ? { ...a, responseStatus: 'accepted' } : a));
  const r = await t.call(t.events('primary', invite.id), { method: 'PATCH', body: { attendees } });
  assert.equal(r.status, 200, r.text);
  const mine = r.json.attendees.find((a: GuestJson) => a.email === ME);
  assert.equal(mine.responseStatus, 'accepted');
  assert.equal(
    r.json.attendees.find((a: GuestJson) => a.email === 'casey.rivera@example.test').responseStatus,
    'accepted',
  );
  assert.equal(
    r.json.attendees.find((a: GuestJson) => a.email === 'lee.chen@example.test').responseStatus,
    'needsAction',
  );
  assert.equal(r.json.summary, 'Quarterly orchard review');
});

test('PROBE 18 inserting a client id that exists is 409 duplicate [errors "409: The requested identifier already exists"]', async () => {
  const t = await setupCal();
  const body = timed('Fixed id', '2026-11-04T09:00:00', '2026-11-04T10:00:00', {
    id: 'aplosprobe0001',
  });
  await insert(t, body);
  const again = await t.call(t.events('primary'), { method: 'POST', body });
  assert.equal(again.status, 409, again.text);
  assert.equal(reasonOf(again.json), 'duplicate');
});

test('PROBE 19 a client id outside base32hex (a-v, 0-9) or shorter than 5 is refused 400 [events id]', async () => {
  const t = await setupCal();
  for (const id of ['UPPERCASE1', 'has-dash-01', 'wxyz12345', 'ab1']) {
    const r = await t.call(t.events('primary'), {
      method: 'POST',
      body: timed('Bad id', '2026-11-04T09:00:00', '2026-11-04T10:00:00', { id }),
    });
    assert.equal(r.status, 400, `${id} -> ${r.status}`);
  }
});

test('PROBE 20 PUT to an event id that does not exist is 404 notFound [errors]', async () => {
  const t = await setupCal();
  const r = await t.call(t.events('primary', 'neverexisted01'), {
    method: 'PUT',
    body: timed('Ghost', '2026-11-04T09:00:00', '2026-11-04T10:00:00'),
  });
  assert.equal(r.status, 404, r.text);
  assert.equal(reasonOf(r.json), 'notFound');
});

test('PROBE 21 insert without an end time is 400 required "Missing end time." [observed]', async () => {
  const t = await setupCal();
  const r = await t.call(t.events('primary'), {
    method: 'POST',
    body: { summary: 'Half event', start: { dateTime: '2026-11-04T09:00:00-08:00' } },
  });
  assert.equal(r.status, 400, r.text);
  assert.equal(reasonOf(r.json), 'required');
  assert.equal(r.json.error.message, 'Missing end time.');
});

// ---------------------------------------------------------------------------------------------
// Recurring events
// ---------------------------------------------------------------------------------------------

test('PROBE 22 editing an instance id creates an exception with recurringEventId and originalStartTime [recur][instances]', async () => {
  const t = await setupCal();
  const master = await insert(
    t,
    timed('Weekly sync', '2026-11-02T10:00:00', '2026-11-02T10:30:00', {
      recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'],
    }),
  );
  const instances = await t.call(`${t.events('primary', master.id)}/instances`);
  assert.equal(instances.status, 200, instances.text);
  assert.equal(instances.json.items.length, 4);
  const second = instances.json.items[1];
  // Instance ids are <masterId>_<original start in UTC, basic format>; 10:00 PST = 18:00Z.
  assert.equal(second.id, `${master.id}_20261109T180000Z`);
  assert.equal(second.recurringEventId, master.id);
  const r = await t.call(t.events('primary', second.id), {
    method: 'PATCH',
    body: {
      summary: 'Weekly sync (moved)',
      start: { dateTime: '2026-11-09T11:00:00-08:00' },
      end: { dateTime: '2026-11-09T11:30:00-08:00' },
    },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.id, second.id);
  assert.equal(r.json.recurringEventId, master.id);
  assert.equal(
    Date.parse(r.json.originalStartTime.dateTime),
    Date.parse('2026-11-09T10:00:00-08:00'),
  );
  const got = await t.call(t.events('primary', second.id));
  assert.equal(got.json.summary, 'Weekly sync (moved)');
  assert.equal(got.json.recurringEventId, master.id);
  // The other instances keep the series title.
  const after = await t.call(`${t.events('primary', master.id)}/instances`);
  assert.deepEqual(
    after.json.items.map((e: EventJson) => e.summary),
    ['Weekly sync', 'Weekly sync (moved)', 'Weekly sync', 'Weekly sync'],
  );
});

test('PROBE 23 an unedited instance can be fetched by its id with events.get [recur][observed]', async () => {
  const t = await setupCal();
  const master = await insert(
    t,
    timed('Daily check', '2026-11-02T08:00:00', '2026-11-02T08:15:00', {
      recurrence: ['RRULE:FREQ=DAILY;COUNT=3'],
    }),
  );
  const r = await t.call(t.events('primary', `${master.id}_20261103T160000Z`));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.recurringEventId, master.id);
  assert.equal(Date.parse(r.json.start.dateTime), Date.parse('2026-11-03T08:00:00-08:00'));
});

// ---------------------------------------------------------------------------------------------
// Scopes, credentials, quota
// ---------------------------------------------------------------------------------------------

test('PROBE 24 a write with only calendar.readonly is 403 insufficientPermissions; the read works [auth][errors]', async () => {
  const t = await setupCal({ scopes: ['openid', 'email', 'profile', SCOPE.calendarReadonly] });
  assert.equal((await t.call(t.events('primary'))).status, 200);
  const r = await t.call(t.events('primary'), {
    method: 'POST',
    body: timed('Not allowed', '2026-11-04T09:00:00', '2026-11-04T10:00:00'),
  });
  assert.equal(r.status, 403, r.text);
  assert.equal(reasonOf(r.json), 'insufficientPermissions');
  assert.equal(r.json.error.message, 'Request had insufficient authentication scopes.');
  assert.equal(r.json.error.status, 'PERMISSION_DENIED');
});

test('PROBE 25 an insufficient-scope 403 carries WWW-Authenticate error="insufficient_scope" [observed; RFC 6750 §3.1]', async () => {
  const t = await setupCal({
    scopes: ['openid', 'email', 'profile', SCOPE.calendarEventsReadonly],
  });
  const r = await t.call(t.events('primary'), {
    method: 'POST',
    body: timed('Not allowed', '2026-11-04T09:00:00', '2026-11-04T10:00:00'),
  });
  assert.equal(r.status, 403);
  assert.match(r.headers.get('www-authenticate') ?? '', /insufficient_scope/);
});

test('PROBE 26 calendar.events alone does not grant calendarList.list [auth calendarList.list scopes]', async () => {
  const t = await setupCal({ scopes: ['openid', 'email', 'profile', SCOPE.calendarEvents] });
  const r = await t.call(LIST);
  assert.equal(r.status, 403, r.text);
  assert.equal(reasonOf(r.json), 'insufficientPermissions');
});

test('PROBE 27 a bad bearer token is 401 authError, "Invalid Credentials", UNAUTHENTICATED, WWW-Authenticate invalid_token [errors 401][observed]', async () => {
  const t = await setupCal();
  const r = await t.call(t.events('primary'), { token: 'not-a-real-token' });
  assert.equal(r.status, 401, r.text);
  assert.equal(reasonOf(r.json), 'authError');
  assert.equal(r.json.error.errors[0].message, 'Invalid Credentials');
  assert.equal(r.json.error.status, 'UNAUTHENTICATED');
  assert.match(r.headers.get('www-authenticate') ?? '', /invalid_token/);
});

test('PROBE 28 the 601st request in a minute is refused with a usageLimits rate reason (403 or 429) [quota][errors]', async () => {
  const t = await setupCal();
  for (let i = 0; i < 600; i++)
    assert.equal((await t.call(`${LIST}?maxResults=1`)).status, 200, `request ${i + 1}`);
  const r = await t.call(LIST);
  assert.ok([403, 429].includes(r.status), `status ${r.status}`);
  assert.ok(RATE_REASONS.includes(reasonOf(r.json)!), String(reasonOf(r.json)));
  assert.equal(domainOf(r.json), 'usageLimits');
});

test('PROBE 29 anti-abuse refusal is 403 usageLimits quotaExceeded "Calendar usage limits exceeded." [errors]', async () => {
  const t = await setupCal();
  t.emu.setCalendarAbuse(true);
  const r = await t.call(t.events('primary'), {
    method: 'POST',
    body: timed('Too many', '2026-11-04T09:00:00', '2026-11-04T10:00:00'),
  });
  assert.equal(r.status, 403, r.text);
  assert.equal(reasonOf(r.json), 'quotaExceeded');
  assert.equal(domainOf(r.json), 'usageLimits');
  assert.equal(r.json.error.errors[0].message, 'Calendar usage limits exceeded.');
  assert.equal(r.json.error.code, 403);
  assert.equal(r.json.error.message, 'Calendar usage limits exceeded.');
});

// ---------------------------------------------------------------------------------------------
// calendarList
// ---------------------------------------------------------------------------------------------

test('PROBE 30 calendarList with showHidden=false leaves hidden calendars out; showHidden=true includes them [calList]', async () => {
  const t = await setupCal();
  const gen = t.emu.calendar.seed();
  const off = await t.call(`${LIST}?showHidden=false`);
  assert.equal(off.status, 200);
  assert.ok(!off.json.items.some((c: EntryJson) => c.id === gen.calendars.hidden));
  const on = await t.call(`${LIST}?showHidden=true`);
  assert.equal(on.json.items.find((c: EntryJson) => c.id === gen.calendars.hidden)?.hidden, true);
});

test('PROBE 31 calendarList syncToken refuses minAccessRole and showHidden=false with 400 [calList syncToken]', async () => {
  const t = await setupCal();
  t.emu.calendar.seed();
  let r = await t.call(LIST);
  while (r.json.nextPageToken)
    r = await t.call(`${LIST}?pageToken=${encodeURIComponent(r.json.nextPageToken)}`);
  const token = r.json.nextSyncToken;
  assert.ok(token);
  const q = (extra: string) => `${LIST}?syncToken=${encodeURIComponent(token)}&${extra}`;
  assert.equal((await t.call(q('minAccessRole=writer'))).status, 400, 'minAccessRole');
  assert.equal((await t.call(q('showHidden=false'))).status, 400, 'showHidden=false');
  assert.equal((await t.call(q('showDeleted=false'))).status, 400, 'showDeleted=false');
});

test('PROBE 32 calendarList maxResults above 250 is accepted, not refused [calList "never larger than 250 entries"]', async () => {
  const t = await setupCal();
  t.emu.calendar.seed();
  const r = await t.call(`${LIST}?maxResults=1000`);
  assert.equal(r.status, 200, r.text);
});
