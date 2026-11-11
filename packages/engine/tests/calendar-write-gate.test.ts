import test from 'node:test';
import assert from 'node:assert/strict';
import { ContractError } from '@aplos/contract/contract-error';
import { NotSentError, type CalendarAdapter, type EventChange } from '../src/ports';
import { GOOGLE_CALENDAR_WRITE_SCOPE } from '../src/calendar/write-port';
import { ACCOUNT, FakeAdapter, connectResult, disk, settle, world } from './sync-actor-helpers';

// The write gate (prov-cal): event writes need a scope that reading does not, so a read-only grant is refused before
// any request goes out — with a reason the UI can turn into "Enable editing" — and the scope is only ever added by the
// owner's explicit re-consent, never by a write.

const MAIL = 'https://www.googleapis.com/auth/gmail.modify';
const CAL_LIST = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly';
const CAL_EVENTS = 'https://www.googleapis.com/auth/calendar.events.readonly';

const caps = (calendar: boolean) => ({
  labels: true,
  folders: false,
  drafts: true,
  serverSearch: true,
  calendar,
  filters: false,
  push: false,
  sendAs: true,
  unsubscribeHeaders: true,
  threading: 'native' as const,
});

const change: EventChange = {
  calendarRemoteId: 'primary',
  scope: 'occurrence',
  fields: { summary: 'Lunch' },
};

interface Calls {
  put: number;
  remove: number;
  rsvp: number;
}

function recordingCalendar(calls: Calls): CalendarAdapter {
  return {
    budget: 'gcal',
    plan: () => [],
    listCalendars: () => Promise.reject(new Error('unused')),
    syncStep: () => Promise.reject(new Error('unused')),
    put: () => {
      calls.put += 1;
      return Promise.resolve({ kind: 'saved', upserts: [], removals: [] });
    },
    remove: () => {
      calls.remove += 1;
      return Promise.resolve({ kind: 'saved', upserts: [], removals: [] });
    },
    rsvp: () => {
      calls.rsvp += 1;
      return Promise.resolve({ kind: 'saved', upserts: [], removals: [] });
    },
  };
}

function rig(scopes: string[]) {
  const calls: Calls = { put: 0, remove: 0, rsvp: 0 };
  const d = disk();
  const w = world(d, () => {
    const adapter = new FakeAdapter(() => [], {});
    (adapter as { calendar?: CalendarAdapter }).calendar = recordingCalendar(calls);
    return adapter;
  });
  w.store.commit({
    opId: 'grant',
    origin: 'system',
    writes: [
      { kind: 'account', id: ACCOUNT, grantedScopes: scopes, capabilities: caps(true) },
      ...(['primary', 'holidays'] as const).map(remoteId => ({
        kind: 'calendar' as const,
        accountId: ACCOUNT,
        remoteId,
        name: remoteId,
        hidden: false,
        readOnly: remoteId === 'holidays',
        selected: true,
      })),
    ],
  });
  return { calls, d, w };
}

const refusal = (error: unknown): boolean =>
  error instanceof ContractError &&
  error.type === 'permission' &&
  error.body.reasonCode === 'permission.calendarWrite';

test('the write scope here is the manifest entry marked deferred', () => {
  assert.equal(GOOGLE_CALENDAR_WRITE_SCOPE, 'https://www.googleapis.com/auth/calendar.events');
});

test('a read-only grant refuses put, remove and rsvp before the adapter and records the gap', async () => {
  const { calls, d, w } = rig([MAIL, CAL_LIST, CAL_EVENTS]);
  try {
    await w.host.start(ACCOUNT);
    await settle();
    assert.equal(w.host.status(ACCOUNT)!.missingPermissions, undefined);
    const port = w.host.calendarPort;
    await assert.rejects(port.put(ACCOUNT, change), refusal);
    await assert.rejects(
      port.remove(ACCOUNT, { calendarRemoteId: 'primary', remoteId: 'e1', scope: 'occurrence' }),
      refusal,
    );
    await assert.rejects(
      port.rsvp(
        ACCOUNT,
        { calendarRemoteId: 'primary', remoteId: 'e1', scope: 'occurrence' },
        'accepted',
        { notify: false },
      ),
      refusal,
    );
    assert.deepEqual(calls, { put: 0, remove: 0, rsvp: 0 });
    // The row is the opt-in "Enable editing" cue, and names exactly the one scope that would fix it.
    assert.deepEqual(w.host.status(ACCOUNT)!.missingPermissions, [
      {
        capability: 'calendarWrite',
        reasonCode: 'permission.calendarWrite',
        missingScopes: [GOOGLE_CALENDAR_WRITE_SCOPE],
      },
    ]);
    // Reading and mail are untouched.
    assert.notEqual(w.host.status(ACCOUNT)!.status.state, 'needsPermission');
    await w.kill();
  } finally {
    await d.cleanup();
  }
});

test('a grant holding the write scope reaches the adapter, once per call', async () => {
  const { calls, d, w } = rig([MAIL, CAL_LIST, GOOGLE_CALENDAR_WRITE_SCOPE]);
  try {
    await w.host.start(ACCOUNT);
    await settle();
    const result = await w.host.calendarPort.put(ACCOUNT, change);
    assert.equal(result.kind, 'saved');
    assert.deepEqual(calls, { put: 1, remove: 0, rsvp: 0 });
    assert.equal(w.host.status(ACCOUNT)!.missingPermissions, undefined);
    await w.kill();
  } finally {
    await d.cleanup();
  }
});

test('re-consent with the write scope clears the row; a reconnect that did not grant it keeps it', async () => {
  const { calls, d, w } = rig([MAIL, CAL_LIST, CAL_EVENTS]);
  try {
    await w.host.start(ACCOUNT);
    await settle();
    await assert.rejects(w.host.calendarPort.put(ACCOUNT, change), refusal);
    assert.equal(w.host.status(ACCOUNT)!.missingPermissions?.length, 1);

    // A plain reconnect that still reads only: the gap is cleared (the next refused write re-marks it).
    await w.host.reconnected(
      ACCOUNT,
      connectResult({ grantedScopes: [MAIL, CAL_LIST, CAL_EVENTS], capabilities: caps(true) }),
    );
    assert.equal(w.host.status(ACCOUNT)!.missingPermissions, undefined);
    await assert.rejects(w.host.calendarPort.put(ACCOUNT, change), refusal);
    assert.equal(w.host.status(ACCOUNT)!.missingPermissions?.length, 1);

    await w.host.reconnected(
      ACCOUNT,
      connectResult({
        grantedScopes: [MAIL, CAL_LIST, GOOGLE_CALENDAR_WRITE_SCOPE],
        capabilities: caps(true),
      }),
    );
    assert.equal(w.host.status(ACCOUNT)!.missingPermissions, undefined);
    assert.equal((await w.host.calendarPort.put(ACCOUNT, change)).kind, 'saved');
    assert.equal(calls.put, 1);
    await w.kill();
  } finally {
    await d.cleanup();
  }
});

test('an account that is not started is a provable non-write, not a permission gap', async () => {
  const { calls, d, w } = rig([MAIL, CAL_LIST, GOOGLE_CALENDAR_WRITE_SCOPE]);
  try {
    await assert.rejects(
      w.host.calendarPort.put(ACCOUNT, change),
      (error: unknown) => error instanceof NotSentError,
    );
    assert.equal(calls.put, 0);
    await w.kill();
  } finally {
    await d.cleanup();
  }
});

test('the port itself refuses a read-only or unknown calendar, for every caller', async () => {
  const { calls, d, w } = rig([MAIL, CAL_LIST, GOOGLE_CALENDAR_WRITE_SCOPE]);
  try {
    await w.host.start(ACCOUNT);
    await settle();
    await assert.rejects(
      w.host.calendarPort.put(ACCOUNT, { ...change, calendarRemoteId: 'holidays' }),
      (e: unknown) => e instanceof ContractError && e.body.reasonCode === 'calendar.readOnly',
    );
    await assert.rejects(
      w.host.calendarPort.put(ACCOUNT, { ...change, calendarRemoteId: 'someone-elses' }),
      (e: unknown) => e instanceof ContractError && e.type === 'notFound',
    );
    assert.equal(calls.put, 0);
    await w.kill();
  } finally {
    await d.cleanup();
  }
});

test('a calendar write chunk that fails to load answers a plain error, and the next write loads it again', async () => {
  const { lazyCalendarPort } = await import('../src/calendar/write-target');
  const real = await import('../src/calendar/write-port');
  let loads = 0;
  const port = lazyCalendarPort(
    () => undefined,
    () => {
      loads += 1;
      return loads === 1
        ? Promise.reject(new Error('chunk 404 /secret/path'))
        : Promise.resolve(real);
    },
  );
  await assert.rejects(
    port.put(ACCOUNT, change),
    (e: unknown) =>
      e instanceof ContractError &&
      e.type === 'unavailable' &&
      e.body.reasonCode === 'calendar.unavailable' &&
      !JSON.stringify(e.body).includes('secret'),
  );
  // Loaded this time: an account that is not started is a provable non-write (the real port answered).
  await assert.rejects(port.put(ACCOUNT, change), (e: unknown) => e instanceof NotSentError);
  assert.equal(loads, 2);
});
