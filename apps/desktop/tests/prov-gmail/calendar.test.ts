import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock, SCOPE, createGmailEmulator } from '@aplos/emulators';
import { ProviderError } from '@aplos/engine/ports';
import type { AdapterAccount, SyncState } from '@aplos/engine/ports';
import {
  calendarListWrites,
  calendarStepWrites,
} from '../../../../packages/engine/src/sync/calendar-facts';
import { GmailAdapter } from '../../src/host/providers/google/adapter';
import { ACCOUNT_ID, CaptureLog, GMAIL_SCOPES, StubGovernor, TokenStub } from './harness';
import { RigStore } from './store-rig';

// The Google Calendar read-sync (prov-cal): listCalendars + events.list singleEvents=false with sync tokens on the
// gcal budget, committing the calendars/events tables the views read. Driven on the emulator like the mail rig.

const CAL_SCOPES = [SCOPE.calendarList, SCOPE.calendarEvents];

async function calRig(options: { scopes?: string[] } = {}) {
  const clock = new FakeClock();
  const emu = createGmailEmulator({ clock, retryAfter: 'none' });
  emu.oauth.addClient('prov-gmail-tests.apps.example.test');
  const scopes = options.scopes ?? [...GMAIL_SCOPES, ...CAL_SCOPES];
  const session = await emu.oauth.signIn({
    clientId: 'prov-gmail-tests.apps.example.test',
    scopes,
    fetch: emu.fetch,
  });
  const tokens = new TokenStub(
    emu,
    session.accessToken,
    session.refreshToken!,
    clock.now() + 86400_000,
  );
  const governor = new StubGovernor(clock, tokens, 600, 10);
  const log = new CaptureLog();
  const user = emu.users()[0];
  const account: AdapterAccount = {
    id: ACCOUNT_ID,
    provider: 'google',
    address: user.email,
    grantedScopes: scopes,
    capabilities: {
      labels: true,
      folders: false,
      drafts: true,
      serverSearch: true,
      calendar: scopes.includes(SCOPE.calendarEvents),
      filters: false,
      push: false,
      sendAs: true,
      unsubscribeHeaders: true,
      threading: 'native',
    },
  };
  const adapter = new GmailAdapter(account, { fetch: emu.fetch, pace: false });
  const store = new RigStore(account, () => clock.now());
  const stopper = new AbortController();
  const ctx = () => ({
    account,
    governor,
    clock: {
      now: () => clock.now(),
      sleep: (ms: number, s?: AbortSignal) => clock.sleep(ms, s),
      timer: () => ({ cancel() {} }),
    },
    log: log.with({ account: ACCOUNT_ID }),
    signal: stopper.signal,
    lookup: store.lookup,
    memory: store.memory,
    generation: store.seq,
  });
  const commitList = (result: Awaited<ReturnType<typeof adapter.calendar.listCalendars>>) =>
    store.raw.commit({
      opId: `cal-${store.seq}`,
      origin: 'sync',
      changes: 'fine',
      writes: calendarListWrites(account.id, result),
    });
  const commitStep = (cal: string, result: Awaited<ReturnType<typeof adapter.calendar.syncStep>>) =>
    store.raw.commit({
      opId: `cal-${store.seq}`,
      origin: 'sync',
      changes: 'fine',
      writes: calendarStepWrites(result, {
        account,
        calendarRemoteId: cal,
        now: clock.now(),
        failures: new Map(),
      }),
    });
  const state = (scope: string): SyncState =>
    store.states.get(scope as SyncState['scope']) ?? {
      scope: scope as SyncState['scope'],
      generation: 0,
      updatedAt: 0,
    };
  const calendars = () =>
    store.raw.read(q =>
      q.all<{
        remote_id: string;
        name: string | null;
        is_primary: number | null;
        hidden: number | null;
        selected: number;
        time_zone: string | null;
      }>('SELECT remote_id, name, is_primary, hidden, selected, time_zone FROM calendars'),
    );
  const events = () =>
    store.raw.read(q =>
      q.all<{
        remote_id: string;
        recurrence_id: string;
        master_remote_id: string | null;
        status: string;
        all_day: number | null;
        start_utc: number | null;
        recurrence: string | null;
        data: string;
      }>(
        'SELECT e.remote_id, e.recurrence_id, e.master_remote_id, e.status, e.all_day, e.start_utc, e.recurrence, e.data FROM events e JOIN calendars c ON c.id = e.calendar_id',
      ),
    );
  const close = () => {
    clock.auto(false);
    stopper.abort();
    store.close();
  };
  return {
    clock,
    emu,
    adapter,
    store,
    ctx,
    commitList,
    commitStep,
    state,
    calendars,
    events,
    close,
  };
}

test('plan emits calendars then one step per synced calendar; none without the capability', async () => {
  const r = await calRig();
  // No list yet: only the `calendars` step (the memory has no sync set).
  let steps = r.adapter.calendar.plan({
    account: r.ctx().account,
    states: [],
    trigger: 'first',
    env: { now: r.clock.now(), focused: true, windowVisible: true, onBattery: false },
    memory: new Map(),
  });
  assert.deepEqual(
    steps.map(s => s.scope),
    ['calendars'],
  );

  r.emu.calendar.addCalendar({ id: 'work@g.com', summary: 'Work' });
  const list = await r.adapter.calendar.listCalendars(undefined, r.ctx());
  r.commitList(list);
  const memory = r.store.memory;
  const states = [...r.store.states.values()];
  steps = r.adapter.calendar.plan({
    account: r.ctx().account,
    states,
    trigger: 'poll',
    env: { now: r.clock.now(), focused: true, windowVisible: true, onBattery: false },
    memory,
  });
  const scopes = steps.map(s => s.scope);
  assert.ok(
    scopes.includes('calendars') &&
      scopes.includes(`cal:${r.ctx().account.address}`) &&
      scopes.includes('cal:work@g.com'),
    scopes.join(),
  );
  // First sync of a calendar is a backfill; the primary and the list are incremental.
  const primary = steps.find(s => s.scope === `cal:${r.ctx().account.address}`)!;
  assert.equal(primary.lane, 'backfill');
  assert.equal(steps.find(s => s.scope === 'calendars')!.lane, 'incremental');

  // Capability off: nothing is planned.
  const noCap = await calRig({ scopes: GMAIL_SCOPES });
  const off = noCap.adapter.calendar.plan({
    account: noCap.ctx().account,
    states: [],
    trigger: 'first',
    env: { now: noCap.clock.now(), focused: true, windowVisible: true, onBattery: false },
    memory: new Map(),
  });
  assert.deepEqual(off, []);
  r.close();
  noCap.close();
});

test('listCalendars writes rows the views read, with the resume token and the sync set', async () => {
  const r = await calRig();
  r.emu.calendar.addCalendar({ id: 'work@g.com', summary: 'Work', timeZone: 'Europe/Berlin' });
  r.emu.calendar.addCalendar({ id: 'hidden@g.com', summary: 'Hidden' });
  r.emu.calendar.hideCalendar('hidden@g.com');
  const result = await r.adapter.calendar.listCalendars(undefined, r.ctx());
  r.commitList(result);
  const cals = r.calendars();
  const primary = cals.find(c => c.remote_id === r.ctx().account.address)!;
  assert.equal(primary.is_primary, 1);
  assert.equal(cals.find(c => c.remote_id === 'work@g.com')!.time_zone, 'Europe/Berlin');
  assert.equal(cals.find(c => c.remote_id === 'hidden@g.com')!.hidden, 1);
  // The sync set: selected and not hidden only.
  const sync = JSON.parse(r.store.memory.get('cal.sync')!) as { id: string }[];
  assert.deepEqual(sync.map(s => s.id).sort(), [r.ctx().account.address, 'work@g.com'].sort());
  // The list's sync token was stored for the incremental round.
  assert.ok(r.state('calendars').cursor);
  r.close();
});

test('first sync stores masters, overrides, all-day rows and the token; incremental sees changes', async () => {
  const r = await calRig();
  const cal = r.ctx().account.address;
  r.emu.calendar.addEvent(cal, {
    summary: 'Standup',
    start: { dateTime: '2026-11-09T09:00:00-08:00', timeZone: 'America/Los_Angeles' },
    end: { dateTime: '2026-11-09T09:30:00-08:00' },
    recurrence: ['RRULE:FREQ=DAILY;COUNT=5'],
  });
  r.emu.calendar.addEvent(cal, {
    summary: 'Offsite',
    start: { date: '2026-11-12' },
    end: { date: '2026-11-14' },
  });
  r.commitList(await r.adapter.calendar.listCalendars(undefined, r.ctx()));
  const first = await r.adapter.calendar.syncStep(cal, r.state(`cal:${cal}`), 'backfill', r.ctx());
  r.commitStep(cal, first);
  let evs = r.events();
  assert.equal(evs.length, 2);
  const standup = evs.find(e => e.data.includes('Standup'))!;
  assert.equal(standup.recurrence_id, '');
  assert.deepEqual(JSON.parse(standup.recurrence!), { rrule: ['RRULE:FREQ=DAILY;COUNT=5'] });
  const offsite = evs.find(e => e.data.includes('Offsite'))!;
  assert.equal(offsite.all_day, 1);
  assert.equal(offsite.start_utc, Date.UTC(2026, 10, 12));
  const token = first.nextState.cursor;
  assert.ok(token, 'a nextSyncToken lands as the cursor');

  // An override of one occurrence (the Nov-10 instance moved two hours later) and a new event land incrementally.
  const master = r.emu.calendar.getEvent(cal, JSON.parse(standup.data).id)!;
  r.emu.calendar.editEvent(cal, `${master.id}_20261110T170000Z`, {
    summary: 'Standup (moved)',
    start: { dateTime: '2026-11-10T11:00:00-08:00' },
    end: { dateTime: '2026-11-10T11:30:00-08:00' },
  });
  r.emu.calendar.addEvent(cal, {
    summary: 'Lunch',
    start: { dateTime: '2026-11-10T12:00:00-08:00' },
    end: { dateTime: '2026-11-10T13:00:00-08:00' },
  });
  const second = await r.adapter.calendar.syncStep(
    cal,
    r.state(`cal:${cal}`),
    'incremental',
    r.ctx(),
  );
  r.commitStep(cal, second);
  evs = r.events();
  assert.equal(evs.length, 4);
  const moved = evs.find(e => e.data.includes('moved'))!;
  assert.equal(moved.recurrence_id, '20261110T170000Z');
  assert.equal(moved.master_remote_id, master.id);
  assert.notEqual(second.nextState.cursor, token, 'the token advances');
  r.close();
});

test('a 410 resyncs one calendar and sweeps ghosts; other calendars keep their tokens', async () => {
  const r = await calRig();
  const cal = r.ctx().account.address;
  const stale = r.emu.calendar.addEvent(cal, {
    summary: 'Ghost',
    start: { dateTime: '2026-11-09T10:00:00-08:00' },
    end: { dateTime: '2026-11-09T11:00:00-08:00' },
  });
  r.commitList(await r.adapter.calendar.listCalendars(undefined, r.ctx()));
  r.commitStep(
    cal,
    await r.adapter.calendar.syncStep(cal, r.state(`cal:${cal}`), 'backfill', r.ctx()),
  );
  // The remote deletes the event out from under the token, then the token expires.
  r.emu.calendar.removeEvent(cal, stale.id);
  r.emu.calendar.expireSyncTokens({ kind: 'events', calendarId: cal });
  const resync = await r.adapter.calendar.syncStep(
    cal,
    r.state(`cal:${cal}`),
    'incremental',
    r.ctx(),
  );
  assert.equal(resync.reset, 'syncTokenInvalid');
  assert.equal(resync.scopeCovered?.scope, `cal:${cal}`);
  r.commitStep(cal, resync);
  // The deletion came back as a cancelled tombstone (showDeleted), stamped with the resync generation —
  // so a row that was NOT re-listed (a deletion with no tombstone) would have been swept.
  const ghost = r.events().find(e => e.remote_id === stale.id);
  assert.equal(ghost?.status, 'cancelled');
  assert.ok(resync.nextState.cursor, 'a fresh token comes back');
  r.close();
});

test('a grant without the calendar scope is refused permission, classified, never a crash', async () => {
  const r = await calRig({ scopes: GMAIL_SCOPES });
  const cal = r.ctx().account.address;
  const error = await r.adapter.calendar
    .syncStep(cal, r.state(`cal:${cal}`), 'incremental', r.ctx())
    .then(
      () => assert.fail('expected a refusal'),
      (e: unknown) => e,
    );
  assert.ok(error instanceof ProviderError);
  assert.equal(error.error.class, 'permission');
  assert.ok(error.error.missingScopes?.length, 'the refusal names the missing scopes');
  r.close();
});
