import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuardedFetch, type GuardReason } from '../../../apps/desktop/scripts/live/guard';
import {
  assertRefused,
  CAL,
  GMAIL,
  guardFor,
  json,
  network,
  OTHER,
  refusal,
  SELF,
} from './live-guard-helpers';

/** Calendar and mail rules of the guard: run-scoped events, refusals and label moves. */

/** A tier M guard that has inserted event e1, so e1 counts as made by this run. */
async function guardWithRunEvent() {
  const net = network((_url, method) =>
    method === 'POST'
      ? { id: 'e1', extendedProperties: { private: { aplosLiveRun: 'run-test' } } }
      : {},
  );
  const guard = createGuardedFetch(net.fetchImpl, {
    tier: 'M',
    selfAddress: SELF,
    calendarRunId: 'run-test',
  });
  await guard(
    `${CAL}/calendars/primary/events?sendUpdates=none`,
    json({ summary: 'run event', extendedProperties: { private: { aplosLiveRun: 'run-test' } } }),
  );
  net.calls.length = 0;
  return { ...net, guard };
}

async function assertRefusedOnRunEvent(
  reason: GuardReason,
  url: string,
  init?: RequestInit,
): Promise<void> {
  const { guard, calls } = await guardWithRunEvent();
  const error = await refusal(guard, url, init);
  assert.equal(error.reason, reason, `${init?.method ?? 'GET'} ${url}`);
  assert.equal(calls.length, 0, 'nothing may be sent for a refused request');
}

test('calendar: attendees, notifications, RSVPs, calendar-list writes and replacing updates are refused', async () => {
  const q = '?sendUpdates=none';
  await assertRefused(
    'M',
    'calendar-attendees',
    `${CAL}/calendars/primary/events${q}`,
    json({ summary: 'x', attendees: [{ email: OTHER }] }),
  );
  await assertRefusedOnRunEvent(
    'calendar-attendees',
    `${CAL}/calendars/primary/events/e1${q}`,
    json({ attendees: [] }, 'PATCH'),
  );
  await assertRefusedOnRunEvent(
    'calendar-attendees',
    `${CAL}/calendars/primary/events/e1${q}`,
    json({ extendedProperties: { x: { attendees: 1 } } }, 'PATCH'),
  );
  await assertRefusedOnRunEvent(
    'calendar-rsvp',
    `${CAL}/calendars/primary/events/e1${q}`,
    json({ attendees: [{ email: SELF, responseStatus: 'accepted' }] }, 'PATCH'),
  );
  await assertRefused(
    'M',
    'calendar-send-updates',
    `${CAL}/calendars/primary/events?sendUpdates=all`,
    json({ summary: 'x' }),
  );
  await assertRefused(
    'M',
    'calendar-send-updates',
    `${CAL}/calendars/primary/events?sendUpdates=externalOnly`,
    json({ summary: 'x' }),
  );
  await assertRefused(
    'M',
    'calendar-send-updates',
    `${CAL}/calendars/primary/events`,
    json({ summary: 'x' }),
  );
  await assertRefused(
    'M',
    'calendar-send-updates',
    `${CAL}/calendars/primary/events?sendUpdates=none&sendNotifications=true`,
    json({ summary: 'x' }),
  );
  await assertRefused(
    'M',
    'calendar-send-updates',
    `${CAL}/calendars/primary/events?sendUpdates=none&sendNotifications=1`,
    json({ summary: 'x' }),
  );
  await assertRefusedOnRunEvent('calendar-send-updates', `${CAL}/calendars/primary/events/e1`, {
    method: 'DELETE',
  });
  await assertRefused(
    'M',
    'calendar-put-replaces',
    `${CAL}/calendars/primary/events/e1${q}`,
    json({ summary: 'x' }, 'PUT'),
  );
  await assertRefused(
    'M',
    'calendar-not-own',
    `${CAL}/calendars/${OTHER.replace('@', '%40')}/events${q}`,
    json({ summary: 'x' }),
  );
  await assertRefused('M', 'body-unparseable', `${CAL}/calendars/primary/events${q}`, {
    method: 'POST',
    body: 'not json',
  });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    await assertRefused(
      'M',
      'calendar-list-write',
      `${CAL}/users/me/calendarList`,
      json({ id: 'x' }, method),
    );
    await assertRefused(
      'M',
      'calendar-list-write',
      `${CAL}/users/me/calendarList/primary`,
      json({ hidden: true }, method),
    );
  }
  await assertRefused(
    'M',
    'unknown-endpoint',
    `${CAL}/calendars/primary/events/e1/move?destination=x`,
    json({}),
  );
  await assertRefused(
    'M',
    'unknown-endpoint',
    `${CAL}/calendars/primary/events/quickAdd?text=lunch`,
    json({}),
  );
});

test('calendar: only events this run inserted can be changed or deleted', async () => {
  const q = '?sendUpdates=none';
  await assertRefused(
    'M',
    'calendar-event-not-created-by-run',
    `${CAL}/calendars/primary/events/owners-event${q}`,
    json({ summary: 'x' }, 'PATCH'),
  );
  await assertRefused(
    'M',
    'calendar-event-not-created-by-run',
    `${CAL}/calendars/primary/events/owners-event${q}`,
    { method: 'DELETE' },
  );
  // A failed insert makes nothing deletable, and a deleted event is no longer one of ours.
  const failing = createGuardedFetch(async () => new Response('{"id":"e9"}', { status: 500 }), {
    tier: 'M',
    selfAddress: SELF,
    calendarRunId: 'run-test',
  });
  await failing(
    `${CAL}/calendars/primary/events${q}`,
    json({ summary: 'x', extendedProperties: { private: { aplosLiveRun: 'run-test' } } }),
  );
  await assert.rejects(failing(`${CAL}/calendars/primary/events/e9${q}`, { method: 'DELETE' }), {
    reason: 'calendar-event-not-created-by-run',
  });
  const { guard } = await guardWithRunEvent();
  await guard(`${CAL}/calendars/primary/events/e1${q}`, { method: 'DELETE' });
  await assert.rejects(guard(`${CAL}/calendars/primary/events/e1${q}`, { method: 'DELETE' }), {
    reason: 'calendar-event-not-created-by-run',
  });
});

test('calendar: plain event changes on the own calendar with sendUpdates=none are allowed', async () => {
  const { guard, calls } = guardFor('M', (_url, method) =>
    method === 'POST'
      ? { id: 'e1', extendedProperties: { private: { aplosLiveRun: 'run-test' } } }
      : {},
  );
  await guard(
    `${CAL}/calendars/primary/events?sendUpdates=none`,
    json({
      summary: 'Test event',
      start: {},
      end: {},
      extendedProperties: { private: { aplosLiveRun: 'run-test' } },
    }),
  );
  await guard(
    `${CAL}/calendars/${SELF.replace('@', '%40')}/events/e1?sendUpdates=none`,
    json({ summary: 'Renamed' }, 'PATCH'),
  );
  await guard(`${CAL}/calendars/primary/events/e1?sendUpdates=none`, { method: 'DELETE' });
  await guard(`${CAL}/calendars/primary/events`);
  await guard(`${CAL}/users/me/calendarList`);
  assert.equal(calls.length, 5);
  // The body that was checked is the body that was sent.
  assert.equal(
    String(calls[0]!.body),
    JSON.stringify({
      summary: 'Test event',
      start: {},
      end: {},
      extendedProperties: { private: { aplosLiveRun: 'run-test' } },
    }),
  );
});

test('mail: modify and batchModify cannot move mail to Spam or Trash', async () => {
  for (const label of ['SPAM', 'TRASH', 'trash']) {
    await assertRefused(
      'M',
      'label-spam-trash',
      `${GMAIL}/messages/m1/modify`,
      json({ addLabelIds: ['STARRED', label] }),
    );
    await assertRefused(
      'M',
      'label-spam-trash',
      `${GMAIL}/messages/batchModify`,
      json({ ids: ['m1'], addLabelIds: [label] }),
    );
    await assertRefused(
      'M',
      'label-spam-trash',
      `${GMAIL}/threads/t1/modify`,
      json({ addLabelIds: [label] }),
    );
  }
  await assertRefused(
    'M',
    'body-unparseable',
    `${GMAIL}/messages/m1/modify`,
    json({ addLabelIds: 'TRASH' }),
  );
  const { guard, calls } = guardFor('M');
  await guard(
    `${GMAIL}/messages/m1/modify`,
    json({ addLabelIds: ['STARRED'], removeLabelIds: ['INBOX', 'UNREAD', 'TRASH'] }),
  );
  assert.equal(calls.length, 1);
});

test('calendar writes are refused by default in every tier (agent test account rules)', async () => {
  for (const tier of ['M', 'S-self'] as const) {
    const net = network();
    const guard = createGuardedFetch(net.fetchImpl, { tier, selfAddress: SELF });
    await assert.rejects(
      guard(
        `${CAL}/calendars/primary/events?sendUpdates=none`,
        json({ summary: 'Test event', start: {}, end: {} }),
      ),
      { reason: 'calendar-write-not-allowed' },
    );
    assert.equal(net.calls.length, 0, `${tier}: nothing reached the network`);
  }
});

test('calendar (orchestrator 2026-10-28): run-scoped events only, tagged with the run id, no guests, no other fields', async () => {
  const q = '?sendUpdates=none';
  const tag = { extendedProperties: { private: { aplosLiveRun: 'run-test' } } };
  const meet = {
    conferenceData: {
      createRequest: { requestId: 'req-1', conferenceSolutionKey: { type: 'hangoutsMeet' } },
    },
  };
  // Insert: the tag is required and must be this run's; only the allowed fields; a new Meet room is fine.
  await assertRefused(
    'M',
    'calendar-run-id',
    `${CAL}/calendars/primary/events${q}`,
    json({ summary: 'x' }),
  );
  await assertRefused(
    'M',
    'calendar-run-id',
    `${CAL}/calendars/primary/events${q}`,
    json({ summary: 'x', extendedProperties: { private: { aplosLiveRun: 'other-run' } } }),
  );
  await assertRefused(
    'M',
    'calendar-run-id',
    `${CAL}/calendars/primary/events${q}`,
    json({
      summary: 'x',
      extendedProperties: { private: { aplosLiveRun: 'run-test', extra: '1' } },
    }),
  );
  await assertRefused(
    'M',
    'calendar-run-id',
    `${CAL}/calendars/primary/events${q}`,
    json({ summary: 'x', extendedProperties: { shared: { aplosLiveRun: 'run-test' } } }),
  );
  await assertRefused(
    'M',
    'calendar-field',
    `${CAL}/calendars/primary/events${q}`,
    json({ summary: 'x', location: 'y', ...tag }),
  );
  await assertRefused(
    'M',
    'calendar-field',
    `${CAL}/calendars/primary/events${q}`,
    json({ summary: 'x', guestsCanModify: true, ...tag }),
  );
  await assertRefused(
    'M',
    'calendar-field',
    `${CAL}/calendars/primary/events${q}`,
    json({ summary: 'x', ...tag, conferenceData: { conferenceId: 'abc', entryPoints: [] } }),
  );
  const { guard, calls } = guardFor('M', (_url, method) =>
    method === 'POST' ? { id: 'e1', ...tag } : {},
  );
  await guard(
    `${CAL}/calendars/primary/events${q}&conferenceDataVersion=1`,
    json({ summary: 'Run event', start: {}, end: {}, ...tag, ...meet }),
  );
  // Patch: rename, re-time and re-describe only; never the tag or the room.
  await guard(
    `${CAL}/calendars/primary/events/e1${q}`,
    json({ summary: 'Renamed', description: 'd', start: {}, end: {} }, 'PATCH'),
  );
  await assert.rejects(
    guard(
      `${CAL}/calendars/primary/events/e1${q}`,
      json({ extendedProperties: { private: { aplosLiveRun: 'x' } } }, 'PATCH'),
    ),
    { reason: 'calendar-field' },
  );
  await assert.rejects(
    guard(`${CAL}/calendars/primary/events/e1${q}`, json({ ...meet }, 'PATCH')),
    { reason: 'calendar-field' },
  );
  await assert.rejects(
    guard(`${CAL}/calendars/primary/events/e1${q}`, json({ colorId: '5' }, 'PATCH')),
    { reason: 'calendar-field' },
  );
  await guard(`${CAL}/calendars/primary/events/e1${q}`, { method: 'DELETE' });
  assert.equal(calls.length, 3);
  // An insert the server answers without this run's tag is never adopted.
  const untagged = guardFor('M', (_url, method) => (method === 'POST' ? { id: 'e2' } : {}));
  await untagged.guard(`${CAL}/calendars/primary/events${q}`, json({ summary: 'x', ...tag }));
  await assert.rejects(
    untagged.guard(`${CAL}/calendars/primary/events/e2${q}`, { method: 'DELETE' }),
    { reason: 'calendar-event-not-created-by-run' },
  );
  // No run id, or another tier: no calendar writes at all, deletes included.
  for (const [tier, runId] of [
    ['M', undefined],
    ['S-self', 'run-test'],
    ['R', 'run-test'],
  ] as const) {
    const net = network();
    const g = createGuardedFetch(net.fetchImpl, {
      tier,
      selfAddress: SELF,
      ...(runId ? { calendarRunId: runId } : {}),
    });
    await assert.rejects(
      g(`${CAL}/calendars/primary/events${q}`, json({ summary: 'x', ...tag })),
      (error: { reason: string }) =>
        ['calendar-write-not-allowed', 'tier-r-read-only'].includes(error.reason),
    );
    await assert.rejects(
      g(`${CAL}/calendars/primary/events/e1${q}`, { method: 'DELETE' }),
      (error: { reason: string }) =>
        [
          'calendar-write-not-allowed',
          'tier-r-read-only',
          'calendar-event-not-created-by-run',
        ].includes(error.reason),
    );
    assert.equal(net.calls.length, 0, `${tier}: nothing reached the network`);
  }
});
