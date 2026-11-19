import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '@aplos/contract/contract-error';
import type { CalendarWriteResult } from '@aplos/engine/ports';
import { eventIdForOp } from '../../../../packages/engine/src/calendar/event-id';
import { writeRig } from './rig';

// Google Calendar writes (prov-cal): create, edit, delete and RSVP through the engine's CalendarPort over the
// Calendar emulator and the real store. Nothing here touches a real calendar.

const START = {
  type: 'floating',
  local: '2026-11-12T10:00:00',
  timeZone: 'America/Los_Angeles',
} as const;
const END = {
  type: 'floating',
  local: '2026-11-12T11:00:00',
  timeZone: 'America/Los_Angeles',
} as const;

const saved = (r: CalendarWriteResult) => {
  assert.equal(r.kind, 'saved');
  return r as Extract<CalendarWriteResult, { kind: 'saved' }>;
};

// More Google Calendar write cases (prov-cal), split from calendar-write.test.ts to stay under the file-size cap.

test('a guest’s RSVP sends only their own answer, so other guests cannot be raced or re-sent', async () => {
  const r = await writeRig();
  const invite = r.emu.calendar.addInvitation({
    summary: 'Review',
    start: { dateTime: '2026-11-12T13:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-12T14:00:00-08:00', timeZone: 'America/Los_Angeles' },
    organizer: { email: 'boss@example.test' },
    guests: ['peer@example.test'],
  });
  await r.seedCalendars();
  saved(
    await r.port.rsvp(
      r.account.id,
      { calendarRemoteId: r.calendarId, remoteId: invite.id, scope: 'series' },
      'accepted',
      { notify: true },
    ),
  );
  const patch = r.requests.filter(q => q.method === 'PATCH').at(-1)!;
  assert.deepEqual(JSON.parse(patch.body!), {
    attendeesOmitted: true,
    attendees: [{ email: r.account.address, responseStatus: 'accepted' }],
  });
  assert.match(patch.url, /sendUpdates=all/, 'a guest still tells the organizer when asked');
  r.close();
});

test('the organizer answering their own event keeps the list and tells nobody', async () => {
  const r = await writeRig();
  const mine = r.emu.calendar.addEvent(r.calendarId, {
    summary: 'Mine',
    start: { dateTime: '2026-11-12T09:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-12T10:00:00-08:00', timeZone: 'America/Los_Angeles' },
    attendees: [
      { email: r.account.address, responseStatus: 'needsAction' },
      { email: 'peer@example.test', responseStatus: 'accepted' },
    ],
  });
  await r.seedCalendars();
  saved(
    await r.port.rsvp(
      r.account.id,
      { calendarRemoteId: r.calendarId, remoteId: mine.id, scope: 'series' },
      'accepted',
      { notify: true },
    ),
  );
  const patch = r.requests.filter(q => q.method === 'PATCH').at(-1)!;
  assert.match(patch.url, /sendUpdates=none/);
  const body = JSON.parse(patch.body!) as { attendees: { email: string }[] };
  assert.equal(body.attendees.length, 2, 'the whole list, not the guest-only shortcut');
  r.close();
});

test('a create that meets a deleted event with the same id says so instead of answering saved with nothing', async () => {
  const r = await writeRig();
  await r.seedCalendars();
  const change = {
    calendarRemoteId: r.calendarId,
    newRemoteId: await eventIdForOp(r.account.id, 'op-reused'),
    scope: 'occurrence' as const,
    fields: { summary: 'Once', start: START, end: END },
  };
  const made = saved(await r.port.put(r.account.id, change));
  saved(
    await r.port.remove(r.account.id, {
      calendarRemoteId: r.calendarId,
      remoteId: made.upserts[0]!.remoteId,
      scope: 'series',
    }),
  );
  await assert.rejects(
    r.port.put(r.account.id, change),
    (e: unknown) => e instanceof ContractError && e.body.reasonCode === 'calendar.opReused',
  );
  r.close();
});

test('a delete whose answer is lost is reported uncertain, and repeating it is safe', async () => {
  const r = await writeRig();
  const cal = r.calendarId;
  const one = r.emu.calendar.addEvent(cal, {
    summary: 'Lost answer',
    start: { dateTime: '2026-11-13T09:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-13T10:00:00-08:00', timeZone: 'America/Los_Angeles' },
  });
  await r.seedCalendars();
  // The DELETE lands on Google, then the connection drops before the answer arrives.
  r.faults.push('dropAnswer');
  await assert.rejects(
    r.port.remove(r.account.id, { calendarRemoteId: cal, remoteId: one.id, scope: 'series' }),
    (e: unknown) => e instanceof ContractError && e.body.reasonCode === 'calendar.uncertain',
  );
  assert.equal(r.emu.calendar.getEvent(cal, one.id)?.status, 'cancelled');
  // Trying again finds it already gone, which is what was wanted.
  const again = saved(
    await r.port.remove(r.account.id, { calendarRemoteId: cal, remoteId: one.id, scope: 'series' }),
  );
  assert.deepEqual(again.removals, [one.id]);
  r.close();
});

test('a guest’s RSVP names the account address when Google’s own entry for them has no email', async () => {
  const r = await writeRig();
  const invite = r.emu.calendar.addInvitation({
    summary: 'No email',
    start: { dateTime: '2026-11-12T13:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-12T14:00:00-08:00', timeZone: 'America/Los_Angeles' },
    organizer: { email: 'boss@example.test' },
  });
  await r.seedCalendars();
  // The answer arrives with the owner's own entry stripped of its address.
  r.forcedReads.push({
    status: 200,
    body: JSON.stringify({
      id: invite.id,
      etag: invite.etag,
      organizer: { email: 'boss@example.test' },
      attendees: [
        { self: true, responseStatus: 'needsAction' },
        { email: 'boss@example.test', responseStatus: 'accepted' },
      ],
    }),
  });
  await r.port.rsvp(
    r.account.id,
    { calendarRemoteId: r.calendarId, remoteId: invite.id, scope: 'series' },
    'accepted',
    { notify: false },
  );
  const patch = r.requests.filter(q => q.method === 'PATCH').at(-1)!;
  const body = JSON.parse(patch.body!) as { attendees: { email?: string }[] };
  assert.equal(body.attendees[0]!.email, r.account.address);
  r.close();
});
