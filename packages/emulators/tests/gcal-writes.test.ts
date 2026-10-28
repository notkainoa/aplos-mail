import assert from 'node:assert/strict';
import test from 'node:test';
import { ME, setupCal, timed, type CalHarness } from './gcal-helpers';

const GUESTS = ['sam.ortiz@example.test', 'priya.nair@example.test'];
const MEET = {
  createRequest: { requestId: 'req-1', conferenceSolutionKey: { type: 'hangoutsMeet' } },
};

/** An event as the JSON response carries it. */
interface EventJson {
  [field: string]: unknown;
  id: string;
  status?: string;
  summary?: string;
  etag?: string;
  sequence?: number;
  start: { [field: string]: unknown; date?: string; dateTime?: string };
  end: { [field: string]: unknown; date?: string; dateTime?: string };
  attendees?: GuestJson[];
  recurringEventId?: string;
  originalStartTime?: { [field: string]: unknown; date?: string; dateTime?: string };
}
/** An attendee as the JSON response carries it. */
interface GuestJson {
  [field: string]: unknown;
  email: string;
  responseStatus?: string;
  organizer?: boolean;
  self?: boolean;
}
/** What 0.2.3's saveEvent sends; it needs this shape from the event it saved. */
interface SaveJson {
  [field: string]: unknown;
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  attendees?: { email: string }[];
}

/** An event with everything a PUT from 0.2.3 would wipe: a Meet room, RSVPs, reminders, colour, visibility. */
async function richEvent(t: CalHarness) {
  const created = await t.call(t.events('primary', undefined, { conferenceDataVersion: 1 }), {
    method: 'POST',
    body: timed('Product demo', '2026-11-04T14:00:00', '2026-11-04T15:00:00', {
      description: 'Demo of the new flow.',
      location: 'Room 4B',
      colorId: '7',
      visibility: 'private',
      transparency: 'transparent',
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 5 }] },
      attendees: GUESTS.map(email => ({ email })),
      conferenceData: MEET,
      extendedProperties: { private: { aplos: 'keep' } },
    }),
  });
  assert.equal(created.status, 200);
  t.emu.calendar.respond('primary', created.json.id, GUESTS[0], 'accepted');
  t.emu.calendar.respond('primary', created.json.id, GUESTS[1], 'declined');
  return (await t.call(t.events('primary', created.json.id))).json;
}

/** What 0.2.3 sends when the user saves an event (apps/desktop/src/main/google.ts saveEvent). */
const legacySave = (event: SaveJson) => ({
  summary: `${event.summary} (edited)`,
  description: event.description,
  location: event.location,
  start: { dateTime: new Date(event.start!.dateTime!).toISOString() },
  end: { dateTime: new Date(event.end!.dateTime!).toISOString() },
  attendees: (event.attendees ?? []).map(a => ({ email: a.email })),
});

test('D11: a PUT wipes the Meet link, reminders, colour, visibility and every RSVP', async () => {
  const t = await setupCal();
  const before = await richEvent(t);
  assert.ok(before.hangoutLink);
  assert.equal(before.conferenceData.entryPoints[0].uri, before.hangoutLink);
  assert.deepEqual(
    before.attendees.map((a: GuestJson) => a.responseStatus),
    ['accepted', 'accepted', 'declined'],
  );

  const put = await t.call(`${t.events('primary', before.id)}?sendUpdates=none`, {
    method: 'PUT',
    body: legacySave(before),
  });
  assert.equal(put.status, 200);
  const after = put.json;
  assert.equal(after.conferenceData, undefined);
  assert.equal(after.hangoutLink, undefined);
  assert.equal(after.colorId, undefined);
  assert.equal(after.visibility, undefined);
  assert.equal(after.transparency, undefined);
  assert.equal(after.extendedProperties, undefined);
  assert.deepEqual(after.reminders, { useDefault: true });
  assert.deepEqual(
    after.attendees.filter((a: GuestJson) => !a.organizer).map((a: GuestJson) => a.responseStatus),
    ['needsAction', 'needsAction'],
  );
  // What survives: identity, creator and the fields that were sent.
  assert.equal(after.id, before.id);
  assert.equal(after.created, before.created);
  assert.equal(after.summary, 'Product demo (edited)');
  assert.equal(after.location, 'Room 4B');
  assert.notEqual(after.etag, before.etag);
});

test('D11: a PATCH of one field keeps the Meet link, RSVPs and everything else', async () => {
  const t = await setupCal();
  const before = await richEvent(t);
  const patch = await t.call(`${t.events('primary', before.id)}?sendUpdates=none`, {
    method: 'PATCH',
    body: { summary: 'Product demo v2' },
  });
  assert.equal(patch.status, 200);
  const summary = patch.json.summary;
  const sequence = patch.json.sequence;
  const rest = { ...patch.json };
  delete rest.summary;
  delete rest.etag;
  delete rest.updated;
  delete rest.sequence;
  const was = { ...before };
  delete was.summary;
  delete was.etag;
  delete was.updated;
  delete was.sequence;
  assert.equal(summary, 'Product demo v2');
  assert.deepEqual(rest, was);
  assert.equal(sequence, before.sequence + 1, 'a new title is a significant change');
});

test('D11: a PUT keeps a Meet room only with conferenceDataVersion=1 and the data sent again', async () => {
  const t = await setupCal();
  const before = await richEvent(t);
  const body = { ...legacySave(before), conferenceData: before.conferenceData };
  // Version 0 (the default) ignores conferenceData in the body, so the room is lost.
  assert.equal(
    (await t.call(t.events('primary', before.id), { method: 'PUT', body })).json.conferenceData,
    undefined,
  );
  const again = await richEvent(t);
  // Version 1 but nothing sent: also lost.
  const lost = await t.call(`${t.events('primary', again.id)}?conferenceDataVersion=1`, {
    method: 'PUT',
    body: legacySave(again),
  });
  assert.equal(lost.json.conferenceData, undefined);
  // Version 1 and resent: kept, hangoutLink included.
  const third = await richEvent(t);
  const kept = await t.call(`${t.events('primary', third.id)}?conferenceDataVersion=1`, {
    method: 'PUT',
    body: { ...legacySave(third), conferenceData: third.conferenceData },
  });
  assert.equal(kept.json.conferenceData.conferenceId, third.conferenceData.conferenceId);
  assert.equal(kept.json.hangoutLink, third.hangoutLink);
});

test('conferenceDataVersion: 0 ignores a createRequest, 1 creates a Meet room, 2 is refused', async () => {
  const t = await setupCal();
  const body = timed('Call', '2026-11-04T09:00:00', '2026-11-04T09:30:00', {
    conferenceData: MEET,
  });
  const v0 = await t.call(t.events('primary'), { method: 'POST', body });
  assert.equal(v0.json.conferenceData, undefined);
  const v1 = await t.call(t.events('primary', undefined, { conferenceDataVersion: 1 }), {
    method: 'POST',
    body,
  });
  assert.match(v1.json.conferenceData.conferenceId, /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/);
  assert.equal(v1.json.conferenceData.conferenceSolution.name, 'Google Meet');
  assert.equal(v1.json.conferenceData.createRequest.status.statusCode, 'success');
  assert.equal(
    v1.json.hangoutLink,
    `https://meet.google.com/${v1.json.conferenceData.conferenceId}`,
  );
  assert.equal(
    (
      await t.call(t.events('primary', undefined, { conferenceDataVersion: 2 }), {
        method: 'POST',
        body,
      })
    ).status,
    400,
  );
  // A patch adds a room to an event that has none, and a later patch without it leaves it alone.
  const patched = await t.call(t.events('primary', v0.json.id, { conferenceDataVersion: 1 }), {
    method: 'PATCH',
    body: { conferenceData: MEET },
  });
  assert.ok(patched.json.hangoutLink);
  const quiet = await t.call(t.events('primary', v0.json.id), {
    method: 'PATCH',
    body: { location: 'Online' },
  });
  assert.equal(quiet.json.hangoutLink, patched.json.hangoutLink);
});

test('PATCH replaces arrays whole, merges objects, and null removes a field', async () => {
  const t = await setupCal();
  const e = await richEvent(t);
  const r = await t.call(t.events('primary', e.id), {
    method: 'PATCH',
    body: {
      attendees: [{ email: GUESTS[0] }],
      extendedProperties: { private: { other: 'x' } },
      reminders: { overrides: [{ method: 'email', minutes: 60 }] },
      location: null,
    },
  });
  assert.deepEqual(
    r.json.attendees.map((a: GuestJson) => [a.email, a.responseStatus]),
    [
      [ME, 'accepted'],
      [GUESTS[0], 'needsAction'],
    ],
  );
  assert.deepEqual(r.json.extendedProperties.private, { aplos: 'keep', other: 'x' });
  assert.deepEqual(r.json.reminders, {
    useDefault: false,
    overrides: [{ method: 'email', minutes: 60 }],
  });
  assert.equal(r.json.location, undefined);
  assert.equal(r.json.description, 'Demo of the new flow.');
});

test('If-Match with a stale etag is 412 conditionNotMet; the current etag and * pass', async () => {
  const t = await setupCal();
  const e = (
    await t.call(t.events('primary'), {
      method: 'POST',
      body: timed('Plan', '2026-11-04T09:00:00', '2026-11-04T10:00:00'),
    })
  ).json;
  const other = await t.call(t.events('primary', e.id), {
    method: 'PATCH',
    body: { summary: 'Edited elsewhere' },
  });
  const stale = await t.call(t.events('primary', e.id), {
    method: 'PATCH',
    body: { summary: 'Mine' },
    headers: { 'if-match': e.etag },
  });
  assert.equal(stale.status, 412);
  assert.equal(stale.json.error.errors[0].reason, 'conditionNotMet');
  assert.equal(stale.json.error.message, 'Precondition Failed');
  assert.equal(t.emu.log.at(-1)!.reason, 'conditionNotMet');
  assert.equal((await t.call(t.events('primary', e.id))).json.summary, 'Edited elsewhere');
  const put = await t.call(t.events('primary', e.id), {
    method: 'PUT',
    body: timed('Mine', '2026-11-04T09:00:00', '2026-11-04T10:00:00'),
    headers: { 'if-match': e.etag },
  });
  assert.equal(put.status, 412);
  assert.equal(
    (await t.call(t.events('primary', e.id), { method: 'DELETE', headers: { 'if-match': e.etag } }))
      .status,
    412,
  );
  const ok = await t.call(t.events('primary', e.id), {
    method: 'PATCH',
    body: { summary: 'Mine' },
    headers: { 'if-match': other.json.etag },
  });
  assert.equal(ok.status, 200);
  assert.equal(
    (
      await t.call(t.events('primary', e.id), {
        method: 'PATCH',
        body: { summary: 'Star' },
        headers: { 'if-match': '*' },
      })
    ).status,
    200,
  );
});

test("forbiddenForNonOrganizer: a guest cannot save another person's event the 0.2.3 way", async () => {
  const t = await setupCal();
  const invite = t.emu.calendar.addInvitation({
    summary: 'Roadmap review',
    organizer: { email: 'casey.rivera@example.test' },
    guests: ['lee.chen@example.test'],
    start: { dateTime: '2026-11-04T13:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-04T14:00:00-08:00', timeZone: 'America/Los_Angeles' },
  });
  assert.equal(invite.organizer.self, undefined);
  assert.deepEqual(
    invite.attendees!.map(a => [a.email, a.responseStatus, !!a.self]),
    [
      ['casey.rivera@example.test', 'accepted', false],
      [ME, 'needsAction', true],
      ['lee.chen@example.test', 'needsAction', false],
    ],
  );
  const put = await t.call(t.events('primary', invite.id), {
    method: 'PUT',
    body: legacySave(invite),
  });
  assert.equal(put.status, 403);
  assert.equal(put.json.error.errors[0].reason, 'forbiddenForNonOrganizer');
  assert.equal(t.emu.log.at(-1)!.reason, 'forbiddenForNonOrganizer');
  const patch = (body: unknown) =>
    t.call(t.events('primary', invite.id), { method: 'PATCH', body });
  for (const body of [
    { summary: 'Mine now' },
    { location: 'Over here' },
    { description: 'x' },
    { start: { dateTime: '2026-11-04T12:00:00-08:00', timeZone: 'America/Los_Angeles' } },
    { attendees: [{ email: ME, responseStatus: 'accepted' }, { email: 'new.guest@example.test' }] },
    { attendees: [{ email: 'lee.chen@example.test', responseStatus: 'accepted' }] },
    { status: 'cancelled' },
    { guestsCanModify: true },
  ]) {
    const r = await patch(body);
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.equal(r.json.error.errors[0].reason, 'forbiddenForNonOrganizer');
  }
  assert.equal(t.emu.calendar.getEvent('primary', invite.id)!.summary, 'Roadmap review');
});

test('a guest may answer for themselves and change personal fields only', async () => {
  const t = await setupCal();
  const invite = t.emu.calendar.addInvitation({
    summary: 'Roadmap review',
    organizer: { email: 'casey.rivera@example.test' },
    guests: ['lee.chen@example.test'],
    start: { dateTime: '2026-11-04T13:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-04T14:00:00-08:00', timeZone: 'America/Los_Angeles' },
  });
  // The RSVP patch sends only the guest's own entry; the others are kept as they were.
  const rsvp = await t.call(`${t.events('primary', invite.id)}?sendUpdates=all`, {
    method: 'PATCH',
    body: { attendees: [{ email: ME, responseStatus: 'tentative' }] },
  });
  assert.equal(rsvp.status, 200);
  assert.deepEqual(
    rsvp.json.attendees.map((a: GuestJson) => [a.email, a.responseStatus]),
    [
      ['casey.rivera@example.test', 'accepted'],
      [ME, 'tentative'],
      ['lee.chen@example.test', 'needsAction'],
    ],
  );
  assert.deepEqual(
    t.emu.calendar.sentUpdates.map(u => [u.action, u.recipients]),
    [['rsvp', ['casey.rivera@example.test']]],
  );
  const personal = await t.call(t.events('primary', invite.id), {
    method: 'PATCH',
    body: {
      colorId: '3',
      transparency: 'transparent',
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 1 }] },
    },
  });
  assert.equal(personal.status, 200);
  assert.equal(personal.json.colorId, '3');
  assert.equal(personal.json.summary, 'Roadmap review');
  // Deleting an invitation removes it from this calendar.
  assert.equal((await t.call(t.events('primary', invite.id), { method: 'DELETE' })).status, 204);
});

test('guestsCanModify lets a guest change the shared fields', async () => {
  const t = await setupCal();
  const invite = t.emu.calendar.addInvitation({
    summary: 'Open agenda',
    organizer: { email: 'casey.rivera@example.test' },
    guestsCanModify: true,
    start: { dateTime: '2026-11-04T13:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-04T14:00:00-08:00', timeZone: 'America/Los_Angeles' },
  });
  const r = await t.call(t.events('primary', invite.id), {
    method: 'PATCH',
    body: { summary: 'Agenda set' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.summary, 'Agenda set');
});

test('sendUpdates is recorded, never delivered: all, externalOnly, none, and quiet edits', async () => {
  const t = await setupCal({
    users: [
      { sub: '1', email: ME, name: 'Test User' },
      { sub: '2', email: 'priya.nair@example.test', name: 'Priya' },
    ],
  });
  const body = timed('Planning', '2026-11-04T09:00:00', '2026-11-04T10:00:00', {
    attendees: [{ email: 'priya.nair@example.test' }, { email: 'outside.guest@example.test' }],
  });
  const send = (mode?: string) =>
    t.call(t.events('primary', undefined, mode ? { sendUpdates: mode } : {}), {
      method: 'POST',
      body,
    });
  const a = (await send('all')).json;
  await send('externalOnly');
  await send('none');
  await send();
  const log = t.emu.calendar.sentUpdates;
  assert.deepEqual(
    log.map(u => [u.action, u.sendUpdates, u.recipients]),
    [
      ['created', 'all', ['priya.nair@example.test', 'outside.guest@example.test']],
      // priya has a Google account in this emulator, so only the outside guest would get mail.
      ['created', 'externalOnly', ['outside.guest@example.test']],
      ['created', 'none', []],
      ['created', 'none', []],
    ],
  );
  assert.equal(log[0].eventId, a.id);
  assert.equal(log[0].calendarId, ME);
  log.length = 0;
  // A colour change tells nobody; a new time tells everybody; a delete cancels for everybody.
  await t.call(`${t.events('primary', a.id)}?sendUpdates=all`, {
    method: 'PATCH',
    body: { colorId: '2' },
  });
  assert.equal(log.length, 0);
  await t.call(`${t.events('primary', a.id)}?sendUpdates=all`, {
    method: 'PATCH',
    body: {
      start: { dateTime: '2026-11-04T11:00:00-08:00' },
      end: { dateTime: '2026-11-04T12:00:00-08:00' },
    },
  });
  assert.deepEqual(
    log.map(u => [u.action, u.recipients.length]),
    [['updated', 2]],
  );
  await t.call(`${t.events('primary', a.id)}?sendUpdates=externalOnly`, { method: 'DELETE' });
  assert.deepEqual(log.at(-1)!.recipients, ['outside.guest@example.test']);
  assert.equal(log.at(-1)!.action, 'cancelled');
  assert.equal(
    t.emu.log.filter(e => e.service !== 'gcal' && e.apiMethod.includes('send')).length,
    0,
  );
});

test('the sequence number grows only on significant changes', async () => {
  const t = await setupCal();
  const e = (
    await t.call(t.events('primary'), {
      method: 'POST',
      body: timed('Plan', '2026-11-04T09:00:00', '2026-11-04T10:00:00'),
    })
  ).json;
  const color = await t.call(t.events('primary', e.id), {
    method: 'PATCH',
    body: { colorId: '4' },
  });
  assert.equal(color.json.sequence, 0);
  const moved = await t.call(t.events('primary', e.id), {
    method: 'PATCH',
    body: { location: 'Room 9' },
  });
  assert.equal(moved.json.sequence, 1);
});

test('deleting a recurring master cancels the whole series, exceptions included', async () => {
  const t = await setupCal();
  const gen = t.emu.calendar.seed();
  const token = (await t.call(t.events('primary'))).json.nextSyncToken;
  const del = await t.call(t.events('primary', gen.weekly.masterId), { method: 'DELETE' });
  assert.equal(del.status, 204);
  const changes = (await t.call(t.events('primary', undefined, { syncToken: token }))).json.items;
  const byId = Object.fromEntries(changes.map((e: EventJson) => [e.id, e]));
  assert.equal(byId[gen.weekly.masterId].status, 'cancelled');
  assert.equal(byId[gen.weekly.overrideId].status, 'cancelled');
  assert.equal(byId[gen.weekly.overrideId].recurringEventId, gen.weekly.masterId);
  const visible = await t.call(
    t.events('primary', undefined, {
      singleEvents: true,
      timeMin: '2026-10-01T00:00:00-07:00',
      timeMax: '2027-01-01T00:00:00-08:00',
    }),
  );
  assert.ok(!visible.json.items.some((e: EventJson) => e.recurringEventId === gen.weekly.masterId));
});

test('editing one occurrence creates an override; the master and the other occurrences stay', async () => {
  const t = await setupCal();
  const master = (
    await t.call(t.events('primary'), {
      method: 'POST',
      body: timed('Standup', '2026-11-02T09:00:00', '2026-11-02T09:15:00', {
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4'],
        attendees: [{ email: GUESTS[0] }],
      }),
    })
  ).json;
  const instanceId = `${master.id}_20261109T170000Z`;
  const patched = await t.call(t.events('primary', instanceId), {
    method: 'PATCH',
    body: { summary: 'Standup (long)', end: { dateTime: '2026-11-09T09:45:00-08:00' } },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json.id, instanceId);
  assert.equal(patched.json.recurringEventId, master.id);
  assert.deepEqual(patched.json.originalStartTime, {
    dateTime: '2026-11-09T09:00:00-08:00',
    timeZone: 'America/Los_Angeles',
  });
  assert.equal(patched.json.recurrence, undefined);
  assert.equal(patched.json.end.dateTime, '2026-11-09T09:45:00-08:00');
  assert.equal(patched.json.attendees.length, 2, 'the override starts as a copy of the occurrence');
  // The master is untouched.
  const after = (await t.call(t.events('primary', master.id))).json;
  assert.equal(after.etag, master.etag);
  assert.equal(after.summary, 'Standup');
  // Listing without expansion returns the master and the exception; with expansion four occurrences, one changed.
  const raw = (await t.call(t.events('primary'))).json.items;
  assert.deepEqual(raw.map((e: EventJson) => e.id).sort(), [instanceId, master.id].sort());
  const expanded = (await t.call(t.events('primary', undefined, { singleEvents: true }))).json
    .items;
  assert.deepEqual(
    expanded.map((e: EventJson) => e.summary),
    ['Standup', 'Standup (long)', 'Standup', 'Standup'],
  );
  // A second patch edits the stored override (no new one), and a PUT replaces it.
  const second = await t.call(t.events('primary', instanceId), {
    method: 'PATCH',
    body: { location: 'Room 2' },
  });
  assert.equal(second.json.summary, 'Standup (long)');
  assert.equal(second.json.location, 'Room 2');
  // An id that is not an occurrence of the series is 404.
  assert.equal(
    (
      await t.call(t.events('primary', `${master.id}_20261110T170000Z`), {
        method: 'PATCH',
        body: {},
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await t.call(t.events('primary', `${master.id}_20261207T170000Z`), {
        method: 'PATCH',
        body: {},
      })
    ).status,
    404,
    'past COUNT',
  );
});

test('deleting one occurrence leaves a cancelled stub; deleting it again is 410', async () => {
  const t = await setupCal();
  const master = (
    await t.call(t.events('primary'), {
      method: 'POST',
      body: timed('Standup', '2026-11-02T09:00:00', '2026-11-02T09:15:00', {
        recurrence: ['RRULE:FREQ=DAILY;COUNT=3'],
      }),
    })
  ).json;
  const token = (await t.call(t.events('primary'))).json.nextSyncToken;
  const id = `${master.id}_20261103T170000Z`;
  assert.equal((await t.call(t.events('primary', id), { method: 'DELETE' })).status, 204);
  const expanded = (await t.call(t.events('primary', undefined, { singleEvents: true }))).json
    .items;
  assert.equal(expanded.length, 2);
  const withDeleted = (
    await t.call(t.events('primary', undefined, { singleEvents: true, showDeleted: true }))
  ).json.items;
  const stub = withDeleted.find((e: EventJson) => e.id === id);
  assert.equal(stub.status, 'cancelled');
  assert.equal(stub.recurringEventId, master.id);
  assert.equal(
    stub.originalStartTime.dateTime,
    '2026-11-02T09:00:00-08:00'.replace('11-02', '11-03'),
  );
  assert.equal((await t.call(t.events('primary', id), { method: 'DELETE' })).status, 410);
  // The master's etag did not move, and sync reports just the stub.
  assert.equal((await t.call(t.events('primary', master.id))).json.etag, master.etag);
  const changes = (await t.call(t.events('primary', undefined, { syncToken: token }))).json.items;
  assert.deepEqual(
    changes.map((e: EventJson) => [e.id, e.status]),
    [[id, 'cancelled']],
  );
});

test('moving or re-ruling the series retires its exceptions', async () => {
  const t = await setupCal();
  const master = (
    await t.call(t.events('primary'), {
      method: 'POST',
      body: timed('Standup', '2026-11-02T09:00:00', '2026-11-02T09:15:00', {
        recurrence: ['RRULE:FREQ=DAILY;COUNT=5'],
      }),
    })
  ).json;
  const id = `${master.id}_20261103T170000Z`;
  await t.call(t.events('primary', id), { method: 'PATCH', body: { summary: 'One-off' } });
  const token = (await t.call(t.events('primary'))).json.nextSyncToken;
  await t.call(t.events('primary', master.id), {
    method: 'PATCH',
    body: { recurrence: ['RRULE:FREQ=DAILY;COUNT=6'] },
  });
  const changes = (await t.call(t.events('primary', undefined, { syncToken: token }))).json.items;
  assert.deepEqual(
    changes.map((e: EventJson) => [e.id, e.status]).sort(),
    [
      [id, 'cancelled'],
      [master.id, 'confirmed'],
    ].sort(),
  );
  // The retired exception no longer overrides: that day is a plain occurrence again.
  const expanded = (await t.call(t.events('primary', undefined, { singleEvents: true }))).json
    .items;
  assert.equal(expanded.length, 6);
  assert.ok(expanded.every((e: EventJson) => e.summary === 'Standup'));
});
