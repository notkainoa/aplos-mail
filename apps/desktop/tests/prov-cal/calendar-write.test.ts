import test from 'node:test';
import assert from 'node:assert/strict';
import { SCOPE } from '@aplos/emulators';
import { ContractError } from '@aplos/contract/contract-error';
import type { CalendarWriteResult, EventFacts } from '@aplos/engine/ports';
import { GMAIL_SCOPES } from '../prov-gmail/harness';
import { eventIdForOp } from '../../../../packages/engine/src/calendar/event-id';
import { READ_SCOPES, writeRig } from './rig';

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

test('create writes one event to the named calendar, commits it locally and emails nobody by default', async () => {
  const r = await writeRig();
  await r.seedCalendars();
  const result = saved(
    await r.port.put(r.account.id, {
      calendarRemoteId: r.calendarId,
      scope: 'occurrence',
      fields: {
        summary: 'Lunch',
        start: START,
        end: END,
        attendees: [
          {
            address: 'friend@example.test',
            response: 'needsAction',
            organizer: false,
            self: false,
          },
        ],
      },
    }),
  );
  const [made] = result.upserts;
  assert.equal(made?.summary, 'Lunch');
  const remote = r.emu.calendar.getEvent(r.calendarId, made!.remoteId);
  assert.equal(remote?.summary, 'Lunch');
  assert.equal(remote?.start.timeZone, 'America/Los_Angeles');
  // The saved event is in the local store at once, without waiting for a sync.
  assert.deepEqual(
    r.events().map(e => e.remote_id),
    [made!.remoteId],
  );
  // Guests are invited but not emailed: sendUpdates=none unless the caller asked.
  const sends = r.emu.calendar.sentUpdates.filter(u => u.eventId === made!.remoteId);
  assert.ok(sends.every(u => u.recipients.length === 0));
  const insert = r.requests.find(q => q.method === 'POST')!;
  assert.match(insert.url, /sendUpdates=none/);
  r.close();
});

test('create with notify emails the guests (sendUpdates=all)', async () => {
  const r = await writeRig();
  await r.seedCalendars();
  const result = saved(
    await r.port.put(r.account.id, {
      calendarRemoteId: r.calendarId,
      scope: 'occurrence',
      notify: true,
      fields: {
        summary: 'Review',
        start: START,
        end: END,
        attendees: [
          {
            address: 'friend@example.test',
            response: 'needsAction',
            organizer: false,
            self: false,
          },
        ],
      },
    }),
  );
  const sent = r.emu.calendar.sentUpdates.filter(u => u.eventId === result.upserts[0]!.remoteId);
  assert.ok(sent.some(u => u.recipients.includes('friend@example.test')));
  r.close();
});

test('a create sent twice with the same id makes one event: the 409 is answered by reading it back', async () => {
  const r = await writeRig();
  await r.seedCalendars();
  const change = {
    calendarRemoteId: r.calendarId,
    newRemoteId: await eventIdForOp(r.account.id, 'op-1'),
    scope: 'occurrence' as const,
    fields: { summary: 'Once', start: START, end: END },
  };
  const first = saved(await r.port.put(r.account.id, change));
  const second = saved(await r.port.put(r.account.id, change));
  assert.equal(first.upserts[0]!.remoteId, second.upserts[0]!.remoteId);
  const onCalendar = (await r.remoteEvents()).filter(e => e.summary === 'Once');
  assert.equal(onCalendar.length, 1);
  assert.equal(r.events().length, 1);
  r.close();
});

test('edit sends only the changed fields with If-Match, and keeps the rest', async () => {
  const r = await writeRig();
  const cal = r.calendarId;
  const seeded = r.emu.calendar.addEvent(cal, {
    summary: 'Standup',
    location: 'Room 4',
    description: 'Daily',
    start: { dateTime: '2026-11-12T09:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-12T09:30:00-08:00', timeZone: 'America/Los_Angeles' },
  });
  await r.seedCalendars();
  const result = saved(
    await r.port.put(r.account.id, {
      calendarRemoteId: cal,
      remoteId: seeded.id,
      etag: seeded.etag,
      scope: 'series',
      fields: { summary: 'Standup (renamed)' },
    }),
  );
  assert.equal(result.upserts[0]!.summary, 'Standup (renamed)');
  const now = r.emu.calendar.getEvent(cal, seeded.id)!;
  assert.equal(now.summary, 'Standup (renamed)');
  assert.equal(now.location, 'Room 4');
  assert.equal(now.description, 'Daily');
  const patch = r.requests.find(q => q.method === 'PATCH')!;
  assert.equal(patch.ifMatch, seeded.etag);
  assert.deepEqual(JSON.parse(patch.body!), { summary: 'Standup (renamed)' });
  r.close();
});

test('a stale etag is a conflict that carries the newer event and commits it; nothing is overwritten', async () => {
  const r = await writeRig();
  const cal = r.calendarId;
  const seeded = r.emu.calendar.addEvent(cal, {
    summary: 'Planning',
    start: { dateTime: '2026-11-12T09:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-12T10:00:00-08:00', timeZone: 'America/Los_Angeles' },
  });
  await r.seedCalendars();
  // Someone else changes it after our last sync.
  r.emu.calendar.editEvent(cal, seeded.id, { summary: 'Planning (theirs)' });
  const result = await r.port.put(r.account.id, {
    calendarRemoteId: cal,
    remoteId: seeded.id,
    etag: seeded.etag,
    scope: 'series',
    fields: { summary: 'Planning (mine)' },
  });
  assert.equal(result.kind, 'conflict');
  const current = (result as { current?: EventFacts }).current;
  assert.equal(current?.summary, 'Planning (theirs)');
  assert.equal(r.emu.calendar.getEvent(cal, seeded.id)!.summary, 'Planning (theirs)');
  // The refetched copy is what the local calendar shows now.
  assert.match(r.events().find(e => e.remote_id === seeded.id)!.data, /Planning \(theirs\)/);
  r.close();
});

test('editing one occurrence writes an exception; the series is untouched, and series scope edits the master', async () => {
  const r = await writeRig();
  const cal = r.calendarId;
  const master = r.emu.calendar.addEvent(cal, {
    summary: 'Daily',
    start: { dateTime: '2026-11-09T09:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-09T09:30:00-08:00', timeZone: 'America/Los_Angeles' },
    recurrence: ['RRULE:FREQ=DAILY;COUNT=5'],
  });
  await r.seedCalendars();
  const occurrence = saved(
    await r.port.put(r.account.id, {
      calendarRemoteId: cal,
      remoteId: master.id,
      recurrenceId: '20261110T170000Z',
      scope: 'occurrence',
      fields: { summary: 'Daily (just today)' },
    }),
  );
  const exception = occurrence.upserts[0]!;
  assert.equal(exception.masterRemoteId, master.id);
  assert.equal(exception.recurrenceId, '20261110T170000Z');
  assert.equal(r.emu.calendar.getEvent(cal, master.id)!.summary, 'Daily');
  const rows = r.events();
  assert.ok(
    rows.some(e => e.master_remote_id === master.id && e.recurrence_id === '20261110T170000Z'),
  );

  saved(
    await r.port.put(r.account.id, {
      calendarRemoteId: cal,
      remoteId: master.id,
      recurrenceId: '20261110T170000Z',
      scope: 'series',
      fields: { location: 'Cafe' },
    }),
  );
  assert.equal(r.emu.calendar.getEvent(cal, master.id)!.location, 'Cafe');
  r.close();
});

test('delete removes a single event locally and is safe to repeat; one occurrence becomes a cancelled exception', async () => {
  const r = await writeRig();
  const cal = r.calendarId;
  const one = r.emu.calendar.addEvent(cal, {
    summary: 'Dentist',
    start: { dateTime: '2026-11-13T09:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-13T10:00:00-08:00', timeZone: 'America/Los_Angeles' },
  });
  const series = r.emu.calendar.addEvent(cal, {
    summary: 'Gym',
    start: { dateTime: '2026-11-09T07:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-09T08:00:00-08:00', timeZone: 'America/Los_Angeles' },
    recurrence: ['RRULE:FREQ=DAILY;COUNT=4'],
  });
  await r.seedCalendars();
  // Pull both into the local store the way a sync would.
  saved(
    await r.port.put(r.account.id, {
      calendarRemoteId: cal,
      remoteId: one.id,
      scope: 'series',
      fields: { location: 'x' },
    }),
  );
  saved(
    await r.port.put(r.account.id, {
      calendarRemoteId: cal,
      remoteId: series.id,
      scope: 'series',
      fields: { location: 'y' },
    }),
  );

  const gone = saved(
    await r.port.remove(r.account.id, { calendarRemoteId: cal, remoteId: one.id, scope: 'series' }),
  );
  assert.deepEqual(gone.removals, [one.id]);
  assert.equal(r.emu.calendar.getEvent(cal, one.id)?.status, 'cancelled');
  assert.ok(!r.events().some(e => e.remote_id === one.id));
  // Again: already gone is the state the caller wanted.
  saved(
    await r.port.remove(r.account.id, { calendarRemoteId: cal, remoteId: one.id, scope: 'series' }),
  );

  const occ = saved(
    await r.port.remove(r.account.id, {
      calendarRemoteId: cal,
      remoteId: series.id,
      recurrenceId: '20261111T150000Z',
      scope: 'occurrence',
    }),
  );
  assert.equal(occ.upserts[0]?.status, 'cancelled');
  assert.equal(r.emu.calendar.getEvent(cal, series.id)!.status, 'confirmed');
  r.close();
});

test('rsvp changes only my answer, keeps every other guest, and tells the organizer only when asked', async () => {
  const r = await writeRig();
  const cal = r.calendarId;
  const invite = r.emu.calendar.addInvitation({
    summary: 'Board',
    start: { dateTime: '2026-11-12T13:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-12T14:00:00-08:00', timeZone: 'America/Los_Angeles' },
    organizer: { email: 'boss@example.test' },
    guests: ['peer@example.test'],
  });
  await r.seedCalendars();
  const result = saved(
    await r.port.rsvp(
      r.account.id,
      { calendarRemoteId: cal, remoteId: invite.id, scope: 'series' },
      'accepted',
      { notify: false },
    ),
  );
  assert.equal(result.upserts[0]!.attendees.find(a => a.self)?.response, 'accepted');
  const remote = r.emu.calendar.getEvent(cal, invite.id)!;
  const answers = Object.fromEntries(
    (remote.attendees ?? []).map(a => [a.email, a.responseStatus]),
  );
  assert.equal(answers['boss@example.test'], 'accepted');
  assert.equal(answers['peer@example.test'], 'needsAction');
  assert.equal(answers[r.account.address], 'accepted');
  assert.match(r.requests.filter(q => q.method === 'PATCH').at(-1)!.url, /sendUpdates=none/);

  await r.port.rsvp(
    r.account.id,
    { calendarRemoteId: cal, remoteId: invite.id, scope: 'series' },
    'declined',
    { notify: true },
  );
  assert.match(r.requests.filter(q => q.method === 'PATCH').at(-1)!.url, /sendUpdates=all/);
  r.close();
});

test('rsvp to an event I am not a guest of is refused without a write', async () => {
  const r = await writeRig();
  const mine = r.emu.calendar.addEvent(r.calendarId, {
    summary: 'Solo',
    start: { dateTime: '2026-11-12T09:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-12T10:00:00-08:00', timeZone: 'America/Los_Angeles' },
  });
  await r.seedCalendars();
  await assert.rejects(
    r.port.rsvp(
      r.account.id,
      { calendarRemoteId: r.calendarId, remoteId: mine.id, scope: 'series' },
      'accepted',
      { notify: false },
    ),
    (e: unknown) => e instanceof ContractError && e.body.reasonCode === 'event.notAGuest',
  );
  assert.equal(r.requests.filter(q => q.method === 'PATCH').length, 0);
  r.close();
});

test('this-and-following is not offered: it is refused before any request', async () => {
  const r = await writeRig();
  await r.seedCalendars();
  const before = r.requests.length;
  await assert.rejects(
    r.port.remove(r.account.id, {
      calendarRemoteId: r.calendarId,
      remoteId: 'x',
      recurrenceId: '20261110T170000Z',
      scope: 'following',
    }),
    (e: unknown) => e instanceof ContractError && e.type === 'unsupported',
  );
  assert.equal(r.requests.length, before);
  r.close();
});

test('a read-only grant writes nothing: refused before the request, with the Enable-editing reason', async () => {
  const r = await writeRig({ scopes: [...GMAIL_SCOPES, ...READ_SCOPES] });
  await r.seedCalendars();
  const before = r.requests.length;
  await assert.rejects(
    r.port.put(r.account.id, {
      calendarRemoteId: r.calendarId,
      scope: 'occurrence',
      fields: { summary: 'x', start: START, end: END },
    }),
    (e: unknown) =>
      e instanceof ContractError &&
      e.type === 'permission' &&
      e.body.reasonCode === 'permission.calendarWrite',
  );
  assert.equal(r.requests.length, before);
  assert.equal(r.refused(), 1);
  assert.equal((await r.remoteEvents()).length, 0);
  r.close();
});

test('a grant the emulator no longer honours (scope revoked since) is the same permission answer', async () => {
  // The account row still says it holds the write scope, but the token only reads.
  const r = await writeRig({ scopes: [...GMAIL_SCOPES, ...READ_SCOPES] });
  r.account.grantedScopes = [...r.account.grantedScopes, SCOPE.calendarEvents];
  await r.seedCalendars();
  await assert.rejects(
    r.port.put(r.account.id, {
      calendarRemoteId: r.calendarId,
      scope: 'occurrence',
      fields: { summary: 'x', start: START, end: END },
    }),
    (e: unknown) => e instanceof ContractError && e.body.reasonCode === 'permission.calendarWrite',
  );
  assert.equal(r.refused(), 1);
  r.close();
});

test('another account cannot reach this calendar through the port', async () => {
  const r = await writeRig();
  await assert.rejects(
    r.port.put('some-other-account', {
      calendarRemoteId: r.calendarId,
      scope: 'occurrence',
      fields: { summary: 'x', start: START, end: END },
    }),
    (e: unknown) => e instanceof Error && e.name === 'NotSentError',
  );
  assert.equal(r.requests.length, 0);
  r.close();
});

test('adding a guest keeps the answers the others already gave', async () => {
  const r = await writeRig();
  const cal = r.calendarId;
  const seeded = r.emu.calendar.addEvent(cal, {
    summary: 'Offsite',
    start: { dateTime: '2026-11-12T09:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-12T10:00:00-08:00', timeZone: 'America/Los_Angeles' },
    attendees: [{ email: 'peer@example.test', responseStatus: 'accepted' }],
  });
  await r.seedCalendars();
  saved(
    await r.port.put(r.account.id, {
      calendarRemoteId: cal,
      remoteId: seeded.id,
      scope: 'series',
      fields: {
        attendees: [
          { address: 'peer@example.test', response: 'needsAction', organizer: false, self: false },
          { address: 'new@example.test', response: 'needsAction', organizer: false, self: false },
        ],
      },
    }),
  );
  const answers = Object.fromEntries(
    (r.emu.calendar.getEvent(cal, seeded.id)!.attendees ?? []).map(a => [
      a.email,
      a.responseStatus,
    ]),
  );
  assert.equal(answers['peer@example.test'], 'accepted');
  assert.equal(answers['new@example.test'], 'needsAction');
  r.close();
});

test('a refused write never lets Google quote the event into the log or the error', async () => {
  const r = await writeRig();
  await r.seedCalendars();
  r.forced.push({
    status: 400,
    body: JSON.stringify({
      error: {
        code: 400,
        message: 'Invalid value for summary: Secret merger plan',
        errors: [{ reason: 'invalid' }],
      },
    }),
  });
  await assert.rejects(
    r.port.put(r.account.id, {
      calendarRemoteId: r.calendarId,
      scope: 'occurrence',
      fields: { summary: 'Secret merger plan', start: START, end: END },
    }),
    (e: unknown) =>
      e instanceof ContractError &&
      e.body.reasonCode === 'calendar.rejected' &&
      !JSON.stringify(e.body).includes('Secret'),
  );
  assert.ok(!r.logLines().includes('Secret'));
  r.close();
});

test('the all-day flag must agree with the shape of the times', async () => {
  const r = await writeRig();
  await r.seedCalendars();
  await assert.rejects(
    r.port.put(r.account.id, {
      calendarRemoteId: r.calendarId,
      scope: 'occurrence',
      fields: { summary: 'x', allDay: true, start: START, end: END },
    }),
    (e: unknown) => e instanceof ContractError && e.body.reasonCode === 'event.allDayMismatch',
  );
  assert.equal(r.requests.filter(q => q.method === 'POST').length, 0);
  r.close();
});

test('an edit of an event deleted elsewhere says it is gone, not that it changed', async () => {
  const r = await writeRig();
  const cal = r.calendarId;
  const seeded = r.emu.calendar.addEvent(cal, {
    summary: 'Gone soon',
    start: { dateTime: '2026-11-12T09:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-12T10:00:00-08:00', timeZone: 'America/Los_Angeles' },
  });
  await r.seedCalendars();
  r.emu.calendar.removeEvent(cal, seeded.id);
  const answer = await r.port
    .put(r.account.id, {
      calendarRemoteId: cal,
      remoteId: seeded.id,
      etag: seeded.etag,
      scope: 'series',
      fields: { summary: 'Too late' },
    })
    .then(
      v => v,
      (e: unknown) => e,
    );
  // Either a conflict that shows the cancelled copy or an honest "no longer on the calendar": never a silent save.
  assert.ok(
    (answer instanceof ContractError && answer.body.reasonCode === 'calendar.eventGone') ||
      (typeof answer === 'object' &&
        answer !== null &&
        (answer as { kind?: string }).kind === 'conflict'),
    JSON.stringify(answer),
  );
  r.close();
});

test('a create whose answer is lost is reported uncertain, and replaying the same op makes one event', async () => {
  const r = await writeRig();
  await r.seedCalendars();
  const change = {
    calendarRemoteId: r.calendarId,
    newRemoteId: await eventIdForOp(r.account.id, 'op-lost'),
    scope: 'occurrence' as const,
    notify: true,
    fields: {
      summary: 'Dinner',
      start: START,
      end: END,
      attendees: [
        {
          address: 'friend@example.test',
          response: 'needsAction' as const,
          organizer: false,
          self: false,
        },
      ],
    },
  };
  // The POST lands on Google, then the connection drops before the answer arrives.
  r.faults.push('dropAnswer');
  await assert.rejects(
    r.port.put(r.account.id, change),
    (e: unknown) => e instanceof ContractError && e.body.reasonCode === 'calendar.uncertain',
  );
  assert.equal((await r.remoteEvents()).filter(e => e.summary === 'Dinner').length, 1);
  // The caller replays the same op: it names the same event, finds it, and does not invite twice.
  const again = saved(await r.port.put(r.account.id, change));
  assert.equal(again.upserts[0]!.summary, 'Dinner');
  assert.equal((await r.remoteEvents()).filter(e => e.summary === 'Dinner').length, 1);
  assert.equal(r.emu.calendar.sentUpdates.filter(u => u.recipients.length > 0).length, 1);
  r.close();
});

test('a write that never gets an answer is cut off by its deadline and reported uncertain', async () => {
  const r = await writeRig({ writeTimeoutMs: 40 });
  const seeded = r.emu.calendar.addEvent(r.calendarId, {
    summary: 'Slow',
    start: { dateTime: '2026-11-12T09:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-12T10:00:00-08:00', timeZone: 'America/Los_Angeles' },
  });
  await r.seedCalendars();
  r.faults.push('hang');
  await assert.rejects(
    r.port.put(r.account.id, {
      calendarRemoteId: r.calendarId,
      remoteId: seeded.id,
      scope: 'series',
      fields: { summary: 'Slow (renamed)' },
    }),
    (e: unknown) => e instanceof ContractError && e.body.reasonCode === 'calendar.uncertain',
  );
  r.close();
});

test('an occurrence with no stored exception is edited against the version just read, not blind', async () => {
  const r = await writeRig();
  const cal = r.calendarId;
  const master = r.emu.calendar.addEvent(cal, {
    summary: 'Daily',
    start: { dateTime: '2026-11-09T09:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-09T09:30:00-08:00', timeZone: 'America/Los_Angeles' },
    recurrence: ['RRULE:FREQ=DAILY;COUNT=5'],
  });
  await r.seedCalendars();
  saved(
    await r.port.put(r.account.id, {
      calendarRemoteId: cal,
      remoteId: master.id,
      recurrenceId: '20261111T170000Z',
      scope: 'occurrence',
      fields: { summary: 'Daily (mine)' },
    }),
  );
  const patch = r.requests.filter(q => q.method === 'PATCH').at(-1)!;
  assert.ok(patch.ifMatch, 'the patch carries the instance version it just read');
  r.close();
});

test('a delete whose first send landed and whose retry meets 412 is saved, not a conflict', async () => {
  const r = await writeRig();
  const cal = r.calendarId;
  const one = r.emu.calendar.addEvent(cal, {
    summary: 'Cancelled twice',
    start: { dateTime: '2026-11-13T09:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-13T10:00:00-08:00', timeZone: 'America/Los_Angeles' },
  });
  await r.seedCalendars();
  r.emu.calendar.removeEvent(cal, one.id);
  r.forced.push({
    status: 412,
    body: JSON.stringify({
      error: { code: 412, message: 'Precondition Failed', errors: [{ reason: 'conditionNotMet' }] },
    }),
  });
  const gone = saved(
    await r.port.remove(r.account.id, {
      calendarRemoteId: cal,
      remoteId: one.id,
      etag: one.etag,
      scope: 'series',
    }),
  );
  assert.deepEqual(gone.removals, [one.id]);
  r.close();
});

test('adding a guest keeps the resource, comment and extra guests Google holds for the others', async () => {
  const r = await writeRig();
  const cal = r.calendarId;
  const seeded = r.emu.calendar.addEvent(cal, {
    summary: 'Panel',
    start: { dateTime: '2026-11-12T09:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-12T10:00:00-08:00', timeZone: 'America/Los_Angeles' },
    attendees: [
      {
        email: 'peer@example.test',
        responseStatus: 'accepted',
        comment: 'bringing a friend',
        additionalGuests: 1,
      },
    ],
  });
  await r.seedCalendars();
  saved(
    await r.port.put(r.account.id, {
      calendarRemoteId: cal,
      remoteId: seeded.id,
      scope: 'series',
      fields: {
        attendees: [
          { address: 'peer@example.test', response: 'needsAction', organizer: false, self: false },
          { address: 'new@example.test', response: 'needsAction', organizer: false, self: false },
        ],
      },
    }),
  );
  const sent = JSON.parse(r.requests.filter(q => q.method === 'PATCH').at(-1)!.body!) as {
    attendees: Record<string, unknown>[];
  };
  const peer = sent.attendees.find(a => a.email === 'peer@example.test')!;
  assert.equal(peer.comment, 'bringing a friend');
  assert.equal(peer.additionalGuests, 1);
  assert.equal(peer.responseStatus, 'accepted');
  r.close();
});

test('deleting one occurrence with no stored exception is guarded by the version just read', async () => {
  const r = await writeRig();
  const cal = r.calendarId;
  const series = r.emu.calendar.addEvent(cal, {
    summary: 'Gym',
    start: { dateTime: '2026-11-09T07:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-09T08:00:00-08:00', timeZone: 'America/Los_Angeles' },
    recurrence: ['RRULE:FREQ=DAILY;COUNT=4'],
  });
  await r.seedCalendars();
  saved(
    await r.port.remove(r.account.id, {
      calendarRemoteId: cal,
      remoteId: series.id,
      recurrenceId: '20261111T150000Z',
      scope: 'occurrence',
    }),
  );
  const del = r.requests.filter(q => q.method === 'DELETE').at(-1)!;
  assert.ok(del.ifMatch, 'the delete carries the instance version it just read, not nothing');
  r.close();
});

test('an RSVP still saves when another guest answered since the last sync', async () => {
  const r = await writeRig();
  const cal = r.calendarId;
  const invite = r.emu.calendar.addInvitation({
    summary: 'All hands',
    start: { dateTime: '2026-11-12T13:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-12T14:00:00-08:00', timeZone: 'America/Los_Angeles' },
    organizer: { email: 'boss@example.test' },
    guests: ['peer@example.test'],
  });
  await r.seedCalendars();
  const before = invite.etag;
  r.emu.calendar.respond(cal, invite.id, 'peer@example.test', 'accepted');
  const result = saved(
    await r.port.rsvp(
      r.account.id,
      { calendarRemoteId: cal, remoteId: invite.id, scope: 'series', etag: before },
      'declined',
      { notify: false },
    ),
  );
  assert.equal(result.upserts[0]!.attendees.find(a => a.self)?.response, 'declined');
  const answers = Object.fromEntries(
    (r.emu.calendar.getEvent(cal, invite.id)!.attendees ?? []).map(a => [
      a.email,
      a.responseStatus,
    ]),
  );
  assert.equal(answers['peer@example.test'], 'accepted', 'the other guest’s answer is untouched');
  r.close();
});

test('a stale edit whose event is gone says gone; a failed read-back is still just a conflict', async () => {
  const r = await writeRig();
  const cal = r.calendarId;
  const seeded = r.emu.calendar.addEvent(cal, {
    summary: 'Briefing',
    start: { dateTime: '2026-11-12T09:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-12T10:00:00-08:00', timeZone: 'America/Los_Angeles' },
  });
  await r.seedCalendars();
  const stale = {
    status: 412,
    body: JSON.stringify({
      error: { code: 412, message: 'x', errors: [{ reason: 'conditionNotMet' }] },
    }),
  };
  const gone = {
    status: 404,
    body: JSON.stringify({ error: { code: 404, message: 'x', errors: [{ reason: 'notFound' }] } }),
  };
  const edit = () =>
    r.port.put(r.account.id, {
      calendarRemoteId: cal,
      remoteId: seeded.id,
      etag: seeded.etag,
      scope: 'series',
      fields: { summary: 'Late' },
    });
  r.forced.push(stale);
  r.forcedReads.push(gone);
  await assert.rejects(
    edit(),
    (e: unknown) => e instanceof ContractError && e.body.reasonCode === 'calendar.eventGone',
  );
  r.forced.push(stale);
  r.forcedReads.push({ status: 500, body: '{}' });
  assert.equal((await edit()).kind, 'conflict');
  r.close();
});

test('the gate decides from the account’s granted scopes, whatever the actor says', async () => {
  const r = await writeRig({ scopes: [...GMAIL_SCOPES, ...READ_SCOPES], actorRefuses: false });
  await r.seedCalendars();
  const before = r.requests.length;
  await assert.rejects(
    r.port.put(r.account.id, {
      calendarRemoteId: r.calendarId,
      scope: 'occurrence',
      fields: { summary: 'x', start: START, end: END },
    }),
    (e: unknown) => e instanceof ContractError && e.body.reasonCode === 'permission.calendarWrite',
  );
  assert.equal(r.requests.length, before, 'nothing went out');
  r.close();
});
