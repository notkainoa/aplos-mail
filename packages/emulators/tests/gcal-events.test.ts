import assert from 'node:assert/strict';
import test from 'node:test';
import { ME, setupCal, timed } from './gcal-helpers';

/** An event as the JSON response carries it. */
interface EventJson {
  [field: string]: unknown;
  id?: string;
  status?: string;
  summary?: string;
  attendees?: GuestJson[];
}
/** An attendee as the JSON response carries it. */
interface GuestJson {
  [field: string]: unknown;
  email: string;
  responseStatus?: string;
  organizer?: boolean;
  self?: boolean;
  optional?: boolean;
}

test('an inserted event carries the full Google model', async () => {
  const t = await setupCal();
  const r = await t.call(t.events('primary'), {
    method: 'POST',
    body: {
      ...timed('Design review', '2026-11-04T09:00:00-08:00', '2026-11-04T10:00:00-08:00', {
        description: 'Walk through the new layout.',
        location: 'Room 4B',
        colorId: '5',
        transparency: 'transparent',
        visibility: 'private',
        extendedProperties: { private: { app: 'aplos' } },
        guestsCanModify: true,
        attendees: [
          { email: 'sam.ortiz@example.test' },
          { email: 'priya.nair@example.test', optional: true, displayName: 'Priya' },
        ],
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 15 }] },
      }),
    },
  });
  assert.equal(r.status, 200);
  const e = r.json;
  assert.equal(e.kind, 'calendar#event');
  assert.match(e.id, /^[a-v0-9]{26}$/);
  assert.match(e.etag, /^"\d+"$/);
  assert.equal(e.status, 'confirmed');
  assert.match(e.htmlLink, /^https:\/\/www\.google\.com\/calendar\/event\?eid=/);
  assert.equal(e.created, new Date(t.clock.now()).toISOString());
  assert.equal(e.updated, e.created);
  assert.deepEqual(e.creator, { email: ME, self: true });
  assert.deepEqual(e.organizer, { email: ME, self: true });
  assert.deepEqual(e.start, {
    dateTime: '2026-11-04T09:00:00-08:00',
    timeZone: 'America/Los_Angeles',
  });
  assert.equal(e.iCalUID, `${e.id}@google.com`);
  assert.equal(e.sequence, 0);
  assert.equal(e.transparency, 'transparent');
  assert.equal(e.visibility, 'private');
  assert.equal(e.guestsCanModify, true);
  assert.deepEqual(e.reminders, {
    useDefault: false,
    overrides: [{ method: 'popup', minutes: 15 }],
  });
  assert.deepEqual(e.extendedProperties, { private: { app: 'aplos' } });
  // The organizer is added as a guest who has already accepted; the others have not answered.
  assert.deepEqual(
    e.attendees.map((a: GuestJson) => [a.email, a.responseStatus, a.organizer, a.self]),
    [
      [ME, 'accepted', true, true],
      ['sam.ortiz@example.test', 'needsAction', undefined, undefined],
      ['priya.nair@example.test', 'needsAction', undefined, undefined],
    ],
  );
  assert.equal(e.attendees[2].optional, true);
  const read = await t.call(t.events('primary', e.id));
  assert.deepEqual(read.json, e);
  assert.equal(read.headers.get('etag'), e.etag);
});

test('the etag changes on every write, even one that changes nothing', async () => {
  const t = await setupCal();
  const created = (
    await t.call(t.events('primary'), {
      method: 'POST',
      body: timed('Plan', '2026-11-04T09:00:00', '2026-11-04T10:00:00'),
    })
  ).json;
  const etags = [created.etag];
  for (let i = 0; i < 3; i++) {
    const patched = await t.call(t.events('primary', created.id), {
      method: 'PATCH',
      body: { summary: 'Plan' },
    });
    etags.push(patched.json.etag);
  }
  assert.equal(new Set(etags).size, 4);
  const get = await t.call(t.events('primary', created.id), {
    headers: { 'if-none-match': etags.at(-1)! },
  });
  assert.equal(get.status, 304);
  assert.equal(
    (await t.call(t.events('primary', created.id), { headers: { 'if-none-match': etags[0] } }))
      .status,
    200,
  );
});

test('all-day events use date, and the end must come after the start', async () => {
  const t = await setupCal();
  const ok = await t.call(t.events('primary'), {
    method: 'POST',
    body: { summary: 'Offsite', start: { date: '2026-11-10' }, end: { date: '2026-11-11' } },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.start, { date: '2026-11-10' });
  const bad = await t.call(t.events('primary'), {
    method: 'POST',
    body: { summary: 'x', start: { date: '2026-11-10' }, end: { date: '2026-11-10' } },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.errors[0].reason, 'timeRangeEmpty');
  const mixed = await t.call(t.events('primary'), {
    method: 'POST',
    body: {
      summary: 'x',
      start: { date: '2026-11-10' },
      end: { dateTime: '2026-11-11T10:00:00Z' },
    },
  });
  assert.equal(mixed.status, 400);
});

test('invalid input is refused with Calendar-style 400s', async () => {
  const t = await setupCal();
  const post = (body: unknown) => t.call(t.events('primary'), { method: 'POST', body });
  assert.equal((await post({ summary: 'no times' })).json.error.errors[0].reason, 'required');
  assert.equal(
    (
      await post({
        start: { dateTime: '2026-11-04T09:00:00' },
        end: { dateTime: '2026-11-04T10:00:00' },
      })
    ).json.error.message,
    'Missing time zone definition for start time.',
  );
  assert.equal(
    (await post(timed('x', '2026-11-04T10:00:00', '2026-11-04T09:00:00'))).json.error.errors[0]
      .reason,
    'timeRangeEmpty',
  );
  assert.equal(
    (await post({ ...timed('x', '2026-11-04T09:00:00', '2026-11-04T10:00:00'), bogus: 1 })).status,
    400,
  );
  assert.equal(
    (
      await post({
        ...timed('x', '2026-11-04T09:00:00', '2026-11-04T10:00:00'),
        attendees: [{ email: 'nope' }],
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post({
        ...timed('x', '2026-11-04T09:00:00', '2026-11-04T10:00:00'),
        recurrence: ['RRULE:FREQ=HOURLY'],
      })
    ).json.error.message,
    'Invalid recurrence rule.',
  );
  const badZone = await post({
    summary: 'x',
    start: { dateTime: '2026-11-04T09:00:00', timeZone: 'Mars/Base' },
    end: { dateTime: '2026-11-04T10:00:00', timeZone: 'Mars/Base' },
  });
  assert.match(badZone.json.error.message, /Invalid time zone definition/);
  const parse = await t.h.emu.fetch(
    `https://www.googleapis.com/calendar/v3${t.events('primary')}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${t.h.token}`, 'content-type': 'application/json' },
      body: '{oops',
    },
  );
  assert.equal(parse.status, 400);
});

test('a client may choose the id; a repeat is 409 duplicate and a malformed one is 400', async () => {
  const t = await setupCal();
  const body = {
    id: 'aplos0event0001',
    ...timed('Mine', '2026-11-04T09:00:00', '2026-11-04T10:00:00'),
  };
  const first = await t.call(t.events('primary'), { method: 'POST', body });
  assert.equal(first.json.id, 'aplos0event0001');
  const again = await t.call(t.events('primary'), { method: 'POST', body });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.errors[0].reason, 'duplicate');
  assert.equal(
    (await t.call(t.events('primary'), { method: 'POST', body: { ...body, id: 'UPPER-case' } }))
      .status,
    400,
  );
});

test('events.list: maxResults defaults to 250, caps at 2500, and pages with a stable cursor', async () => {
  const t = await setupCal();
  t.emu.calendar.seed({ singleEvents: 0, invitations: 0 });
  for (let i = 0; i < 260; i++)
    t.emu.calendar.addEvent(
      'primary',
      timed(
        `Filler ${i}`,
        `2026-12-${String(1 + (i % 28)).padStart(2, '0')}T09:00:00`,
        `2026-12-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00`,
      ),
    );
  const first = await t.call(t.events('primary'));
  assert.equal(first.json.items.length, 250);
  assert.ok(first.json.nextPageToken);
  assert.equal(first.json.nextSyncToken, undefined);
  const second = await t.call(
    t.events('primary', undefined, { pageToken: first.json.nextPageToken }),
  );
  assert.ok(second.json.nextSyncToken);
  assert.equal(second.json.nextPageToken, undefined);
  const ids = [...first.json.items, ...second.json.items].map((e: EventJson) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  // maxResults over 2500 is clamped, 0 and junk are refused.
  assert.equal((await t.call(t.events('primary', undefined, { maxResults: 9999 }))).status, 200);
  assert.equal((await t.call(t.events('primary', undefined, { maxResults: 0 }))).status, 400);
  assert.equal((await t.call(t.events('primary', undefined, { maxResults: 'ten' }))).status, 400);
  assert.equal((await t.call(t.events('primary', undefined, { pageToken: 'junk' }))).status, 400);
  const small = await t.call(t.events('primary', undefined, { maxResults: 100 }));
  assert.equal(small.json.items.length, 100);
});

test('events.list envelope: kind, timeZone, accessRole and defaultReminders', async () => {
  const t = await setupCal();
  const r = await t.call(t.events('primary'));
  assert.equal(r.json.kind, 'calendar#events');
  assert.equal(r.json.timeZone, 'America/Los_Angeles');
  assert.equal(r.json.accessRole, 'owner');
  assert.deepEqual(r.json.items, []);
  assert.ok(r.json.nextSyncToken, 'an empty list still ends with a sync token');
});

test('timeMin and timeMax select by overlap; they need an offset', async () => {
  const t = await setupCal();
  const a = t.emu.calendar.addEvent(
    'primary',
    timed('A', '2026-11-04T09:00:00', '2026-11-04T10:00:00'),
  );
  const b = t.emu.calendar.addEvent(
    'primary',
    timed('B', '2026-11-05T09:00:00', '2026-11-05T10:00:00'),
  );
  const allDay = t.emu.calendar.addEvent('primary', {
    summary: 'C',
    start: { date: '2026-11-06' },
    end: { date: '2026-11-07' },
  });
  const list = async (q: Record<string, string>) =>
    (await t.call(t.events('primary', undefined, q))).json.items.map((e: EventJson) => e.id);
  assert.deepEqual(
    await list({ timeMin: '2026-11-04T10:00:00-08:00', timeMax: '2026-11-05T09:00:00-08:00' }),
    [],
  );
  assert.deepEqual(
    await list({ timeMin: '2026-11-04T09:30:00-08:00', timeMax: '2026-11-05T09:30:00-08:00' }),
    [a.id, b.id],
  );
  assert.deepEqual(await list({ timeMin: '2026-11-06T00:00:00-08:00' }), [allDay.id]);
  assert.deepEqual(await list({ timeMax: '2026-11-04T09:00:00-08:00' }), []);
  assert.equal(
    (await t.call(t.events('primary', undefined, { timeMin: '2026-11-04T09:00:00' }))).status,
    400,
  );
  assert.equal(
    (await t.call(t.events('primary', undefined, { timeMin: 'yesterday' }))).status,
    400,
  );
});

test('orderBy=startTime needs singleEvents=true; syncToken excludes timeMin, timeMax, updatedMin and orderBy', async () => {
  const t = await setupCal();
  const first = t.emu.calendar.addEvent(
    'primary',
    timed('Later', '2026-11-09T09:00:00', '2026-11-09T10:00:00'),
  );
  const second = t.emu.calendar.addEvent(
    'primary',
    timed('Sooner', '2026-11-03T09:00:00', '2026-11-03T10:00:00'),
  );
  const bad = await t.call(t.events('primary', undefined, { orderBy: 'startTime' }));
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.errors[0].reason, 'badRequest'); // Google's observed reason for this refusal (fidelity probe 03)
  const ordered = await t.call(
    t.events('primary', undefined, { orderBy: 'startTime', singleEvents: true }),
  );
  assert.deepEqual(
    ordered.json.items.map((e: EventJson) => e.id),
    [second.id, first.id],
  );
  assert.equal((await t.call(t.events('primary', undefined, { orderBy: 'sideways' }))).status, 400);
  const token = (await t.call(t.events('primary'))).json.nextSyncToken;
  for (const extra of <Record<string, string>[]>[
    { timeMin: '2026-11-01T00:00:00Z' },
    { timeMax: '2026-11-30T00:00:00Z' },
    { updatedMin: '2026-11-01T00:00:00Z' },
    { orderBy: 'updated' },
  ]) {
    const r = await t.call(t.events('primary', undefined, { syncToken: token, ...extra }));
    assert.equal(r.status, 400, JSON.stringify(extra));
  }
});

test('updatedMin filters on the last change and always includes deletions since then', async () => {
  const t = await setupCal();
  const old = t.emu.calendar.addEvent(
    'primary',
    timed('Old', '2026-11-04T09:00:00', '2026-11-04T10:00:00'),
  );
  const doomed = t.emu.calendar.addEvent(
    'primary',
    timed('Doomed', '2026-11-05T09:00:00', '2026-11-05T10:00:00'),
  );
  await t.clock.advance(1800_000);
  const cut = new Date(t.clock.now()).toISOString();
  await t.clock.advance(1000);
  const fresh = t.emu.calendar.addEvent(
    'primary',
    timed('Fresh', '2026-11-06T09:00:00', '2026-11-06T10:00:00'),
  );
  t.emu.calendar.removeEvent('primary', doomed.id);
  const r = await t.call(t.events('primary', undefined, { updatedMin: cut }));
  const byId = Object.fromEntries(r.json.items.map((e: EventJson) => [e.id, e]));
  assert.deepEqual(Object.keys(byId).sort(), [doomed.id, fresh.id].sort());
  assert.equal(byId[doomed.id].status, 'cancelled');
  assert.ok(!(old.id in byId));
});

test('deleted events are hidden unless showDeleted, and then come back as bare cancelled stubs', async () => {
  const t = await setupCal();
  const gone = t.emu.calendar.addEvent(
    'primary',
    timed('Gone', '2026-11-04T09:00:00', '2026-11-04T10:00:00', { description: 'private notes' }),
  );
  t.emu.calendar.removeEvent('primary', gone.id);
  assert.deepEqual((await t.call(t.events('primary'))).json.items, []);
  const shown = (await t.call(t.events('primary', undefined, { showDeleted: true }))).json.items;
  assert.equal(shown.length, 1);
  assert.equal(shown[0].status, 'cancelled');
  assert.equal(shown[0].id, gone.id);
  assert.equal(shown[0].summary, undefined, 'a cancelled stub keeps no content');
  assert.equal(shown[0].start, undefined);
  // events.get of a deleted event still answers (cancelled); deleting it again is 410.
  assert.equal((await t.call(t.events('primary', gone.id))).json.status, 'cancelled');
  const twice = await t.call(t.events('primary', gone.id), { method: 'DELETE' });
  assert.equal(twice.status, 410);
  assert.equal(twice.json.error.errors[0].reason, 'deleted');
});

test('incremental events sync returns changed and cancelled events since the token, over several pages', async () => {
  const t = await setupCal();
  const a = t.emu.calendar.addEvent(
    'primary',
    timed('A', '2026-11-04T09:00:00', '2026-11-04T10:00:00'),
  );
  const b = t.emu.calendar.addEvent(
    'primary',
    timed('B', '2026-11-05T09:00:00', '2026-11-05T10:00:00'),
  );
  const c = t.emu.calendar.addEvent(
    'primary',
    timed('C', '2026-11-06T09:00:00', '2026-11-06T10:00:00'),
  );
  const full = await t.call(t.events('primary'));
  assert.equal(full.json.items.length, 3);
  const token = full.json.nextSyncToken;
  assert.deepEqual(
    (await t.call(t.events('primary', undefined, { syncToken: token }))).json.items,
    [],
  );

  t.emu.calendar.editEvent('primary', a.id, { summary: 'A2' });
  t.emu.calendar.removeEvent('primary', b.id);
  const d = t.emu.calendar.addEvent(
    'primary',
    timed('D', '2026-11-07T09:00:00', '2026-11-07T10:00:00'),
  );
  const page1 = await t.call(t.events('primary', undefined, { syncToken: token, maxResults: 2 }));
  assert.equal(page1.json.items.length, 2);
  assert.equal(page1.json.nextSyncToken, undefined);
  const page2 = await t.call(
    t.events('primary', undefined, {
      syncToken: token,
      maxResults: 2,
      pageToken: page1.json.nextPageToken,
    }),
  );
  assert.equal(page2.json.items.length, 1);
  assert.ok(page2.json.nextSyncToken);
  const byId = Object.fromEntries(
    [...page1.json.items, ...page2.json.items].map((e: EventJson) => [e.id, e]),
  );
  assert.deepEqual(Object.keys(byId).sort(), [a.id, b.id, d.id].sort());
  assert.equal(byId[a.id].summary, 'A2');
  assert.equal(byId[b.id].status, 'cancelled');
  assert.ok(!(c.id in byId));
  // The token from the last page continues from there.
  assert.deepEqual(
    (await t.call(t.events('primary', undefined, { syncToken: page2.json.nextSyncToken }))).json
      .items,
    [],
  );
});

test('events sync tokens answer 410 after the horizon or an expire call, per calendar', async () => {
  const t = await setupCal({ calendar: { syncTokenHorizonMs: 2 * 3600_000 } });
  const gen = t.emu.calendar.seed();
  const primary = (await t.call(t.events('primary'))).json.nextSyncToken;
  const family = (await t.call(t.events(gen.calendars.family))).json.nextSyncToken;
  t.emu.calendar.expireSyncTokens({ calendarId: gen.calendars.family });
  assert.equal((await t.call(t.events('primary', undefined, { syncToken: primary }))).status, 200);
  const stale = await t.call(t.events(gen.calendars.family, undefined, { syncToken: family }));
  assert.equal(stale.status, 410);
  assert.equal(stale.json.error.errors[0].reason, 'fullSyncRequired');
  assert.equal(stale.json.error.message, 'Sync token is no longer valid, a full sync is required.');
  // A token for one calendar does not work on another.
  assert.equal(
    (await t.call(t.events(gen.calendars.family, undefined, { syncToken: primary }))).status,
    410,
  );
  // The horizon.
  await t.clock.advance(3 * 3600_000);
  await t.h.renew();
  assert.equal((await t.call(t.events('primary', undefined, { syncToken: primary }))).status, 410);
  // Expire everything for everyone.
  const fresh = (await t.call(t.events('primary'))).json.nextSyncToken;
  t.emu.calendar.expireSyncTokens();
  assert.equal((await t.call(t.events('primary', undefined, { syncToken: fresh }))).status, 410);
});

test('fields masks apply to events and invalid names are 400', async () => {
  const t = await setupCal();
  const gen = t.emu.calendar.seed();
  const r = await t.call(
    t.events('primary', undefined, {
      fields: 'items(id,summary,start/dateTime),nextSyncToken,nextPageToken',
      maxResults: 3,
    }),
  );
  assert.equal(r.status, 200);
  for (const item of r.json.items)
    assert.deepEqual(
      Object.keys(item).filter(k => !['id', 'summary', 'start'].includes(k)),
      [],
    );
  const one = await t.call(
    `${t.events('primary', gen.singleEventIds[0])}&fields=id,etag`.replace('&', '?'),
  );
  assert.deepEqual(Object.keys(one.json).sort(), ['etag', 'id']);
  assert.equal(
    (await t.call(t.events('primary', undefined, { fields: 'items(summry)' }))).status,
    400,
  );
});

test('events on a read-only shared calendar can be read but not written', async () => {
  const t = await setupCal();
  const gen = t.emu.calendar.seed();
  const list = await t.call(t.events(gen.calendars.readOnly));
  assert.equal(list.json.accessRole, 'reader');
  assert.equal(list.json.items.length, 2);
  const write = await t.call(t.events(gen.calendars.readOnly), {
    method: 'POST',
    body: timed('x', '2026-11-04T09:00:00', '2026-11-04T10:00:00'),
  });
  assert.equal(write.status, 403);
  assert.equal(write.json.error.errors[0].reason, 'forbidden');
  assert.equal(
    (await t.call(t.events(gen.calendars.readOnly, gen.readOnlyEventIds[0]), { method: 'DELETE' }))
      .status,
    403,
  );
  assert.equal((await t.call(t.events('nobody@example.test'))).status, 404);
});
