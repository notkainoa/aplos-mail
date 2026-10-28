/**
 * Gate for the prov-emu lane: the UNMODIFIED 0.2.3 calendar client (createGoogle in
 * apps/desktop/src/main/google.ts) must show its field defects on the Calendar emulator
 * (proto-google.md section 9: D11, D12, D24).
 *
 * - D11: saveEvent is an events.update PUT carrying only title, description, location, times and
 *   guest emails, so Google clears everything else on the event (Meet room, reminders, colour,
 *   time zone) and resets every guest's answer.
 * - D12: listEvents re-reads the calendar list and every calendar in full, expanded with
 *   singleEvents=true over -30 days to +1 year, on every poll. No sync token is ever kept.
 * - D24: listCalendars drops Google's hidden and selected flags, so a calendar the user switched off
 *   in Google Calendar is fetched and shown like any other.
 *
 * prov-calendar inverts the legacy tests once the new adapter lands. Each one has a control: a
 * correct client on the same emulator gets the right result, so the failure comes from the client.
 *
 * 0.2.3 computes its event window from the real Date, so the emulator's clock starts at the real
 * now (seeded events are relative to the clock and must fall inside that window).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeClock } from '../src/kit/clock';
import { createGmailEmulator, SCOPE, type GmailEmulator } from '../src/gmail';
import type { GcalEvent } from '../src/gcal';
import { createGoogle } from '../../../apps/desktop/src/main/google';
// eslint-disable-next-line aplos/boundaries -- this gate test exercises the unmodified 0.2.3 calendar client on purpose
import type { Account, CalendarEvent } from '@aplos/contract/legacy/types';

const CAL = 'https://www.googleapis.com/calendar/v3';
const CLIENT_ID = 'legacy-gcal-client.apps.example.test';
const CLIENT_SECRET = 'legacy-gcal-secret';
/** The scopes 0.2.3 asks for at connect (google.ts connect()). */
const LEGACY_SCOPES = [
  'openid',
  'email',
  'profile',
  SCOPE.gmailModify,
  SCOPE.gmailSettingsBasic,
  SCOPE.calendarList,
  SCOPE.calendarEvents,
];
const ZONE = 'America/Los_Angeles';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const GUESTS = ['sam.ortiz@example.test', 'priya.nair@example.test', 'lee.chen@example.test'];

/** One Calendar call as the adapter made it. Kept in memory for assertions; never printed. */
interface Observed {
  method: string;
  url: URL;
  status: number;
  /** Rows in the response's `items`, for list calls. */
  items?: number;
  ifMatch: boolean;
}

interface Rig {
  clock: FakeClock;
  emu: GmailEmulator;
  account: Account;
  adapter: Awaited<ReturnType<typeof createGoogle>>;
  /** Access token for the control calls a correct client would make. */
  token: string;
  observed: Observed[];
  /** A raw Calendar call with the signed-in token, as a correct client would make it. */
  call(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<{ status: number; json: Record<string, unknown> }>;
  dispose(): Promise<void>;
}

/** An emulator with the legacy adapter wired to it, set up the way legacy-gmail-d1.test.ts does. */
async function rig(): Promise<Rig> {
  const clock = new FakeClock({ start: Date.now() });
  const emu = createGmailEmulator({ clock, latencyMs: 0 });
  emu.oauth.addClient(CLIENT_ID, CLIENT_SECRET);
  const session = await emu.oauth.signIn({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    scopes: LEGACY_SCOPES,
    fetch: emu.fetch,
  });
  const user = emu.users()[0];
  const account: Account = {
    id: `google-${user.sub}`,
    name: user.name,
    email: user.email,
    provider: 'google',
    preset: 'gmail',
    color: '#738c80',
    connected: true,
    calendarConnected: true,
  };

  // Tokens the emulator issued, stored where the adapter reads them. `expiresAt` uses the real clock
  // because the adapter checks expiry with the real Date.now().
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-legacy-gcal-'));
  const encrypt = (value: string) => Buffer.from(value, 'utf8');
  const decrypt = (value: Buffer) => value.toString('utf8');
  const stored = {
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    expiresAt: Date.now() + 365 * DAY,
  };
  await writeFile(
    join(dataDir, 'google-tokens.enc.json'),
    JSON.stringify({ [account.id]: encrypt(JSON.stringify(stored)).toString('base64') }),
    { mode: 0o600 },
  );

  const observed: Observed[] = [];
  const watched: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const response = await emu.fetch(input, init);
    if (url.href.startsWith(CAL)) {
      const body =
        response.ok && response.status !== 204
          ? await response
              .clone()
              .json()
              .catch(() => undefined)
          : undefined;
      const headers = new Headers(init?.headers);
      observed.push({
        method: init?.method ?? 'GET',
        url,
        status: response.status,
        ...(Array.isArray(body?.items) ? { items: body.items.length } : {}),
        ifMatch: headers.has('if-match'),
      });
    }
    return response;
  };

  const adapter = await createGoogle({
    dataDir,
    encrypt,
    decrypt,
    fetch: watched,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    sleep: ms => clock.sleep(ms),
  });
  return {
    clock,
    emu,
    account,
    adapter,
    token: session.accessToken,
    observed,
    async call(path, init = {}) {
      const headers: Record<string, string> = { authorization: `Bearer ${session.accessToken}` };
      if (init.body !== undefined) headers['content-type'] = 'application/json';
      const response = await emu.fetch(`${CAL}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
      const text = await response.text();
      return { status: response.status, json: text ? JSON.parse(text) : undefined };
    },
    async dispose() {
      adapter.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

const enc = encodeURIComponent;
/** Requests the emulator logged for one Calendar API method since `from` (a log seq). */
const logged = (emu: GmailEmulator, apiMethod: string, from = 0) =>
  emu.log.filter(e => e.seq > from && e.service === 'gcal' && e.apiMethod === apiMethod);
const lastSeq = (emu: GmailEmulator) => emu.log.at(-1)?.seq ?? 0;

// ---------- D11 ----------

/**
 * An event with everything a 0.2.3 save would wipe: a Meet room (conferenceData and hangoutLink),
 * custom reminders, a colour, a zone, and three guests who have answered.
 */
function richEvent(r: Rig): GcalEvent {
  const start = Math.ceil(r.clock.now() / HOUR) * HOUR + 3 * DAY;
  const created = r.emu.calendar.addEvent(
    'primary',
    {
      summary: 'Quarterly planning',
      description: 'Agenda: goals, staffing, budget.',
      location: 'Room 4B',
      start: { dateTime: new Date(start).toISOString(), timeZone: ZONE },
      end: { dateTime: new Date(start + HOUR).toISOString(), timeZone: ZONE },
      colorId: '5',
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 5 },
          { method: 'email', minutes: 60 },
        ],
      },
      attendees: GUESTS.map(email => ({ email })),
      conferenceData: {
        createRequest: { requestId: 'legacy-d11', conferenceSolutionKey: { type: 'hangoutsMeet' } },
      },
    },
    { conferenceDataVersion: 1 },
  );
  r.emu.calendar.respond('primary', created.id, GUESTS[0], 'accepted');
  r.emu.calendar.respond('primary', created.id, GUESTS[1], 'declined');
  r.emu.calendar.respond('primary', created.id, GUESTS[2], 'tentative');
  const before = r.emu.calendar.getEvent('primary', created.id)!;
  // The seed itself must hold what the test says is lost.
  assert.ok(before.conferenceData?.conferenceId && before.hangoutLink);
  assert.equal(before.reminders?.useDefault, false);
  assert.deepEqual(answers(before), ['accepted', 'declined', 'tentative']);
  return before;
}

/** The guests' answers, in GUESTS order. */
const answers = (event: GcalEvent) =>
  GUESTS.map(email => event.attendees?.find(a => a.email === email)?.responseStatus);

test("D11 0.2.3 saving an event wipes its Meet link and guests' answers (asserts the old failure)", async () => {
  const r = await rig();
  try {
    const before = richEvent(r);
    // The user opens the event in 0.2.3 (its own event model, read through listEvents) and renames it.
    const listed = (await r.adapter.listEvents(r.account)).find(e => e.remoteId === before.id);
    assert.ok(listed, 'the event is in the 0.2.3 calendar view');
    for (const guest of GUESTS) assert.ok(listed.guests.includes(guest));
    const from = lastSeq(r.emu);
    r.observed.length = 0;
    const saved = await r.adapter.saveEvent(r.account, {
      ...listed,
      title: 'Quarterly planning (moved rooms)',
    } satisfies CalendarEvent);
    assert.equal(saved.title, 'Quarterly planning (moved rooms)');

    // One write, and it was a full replace without an ETag.
    assert.deepEqual(
      r.observed.map(o => o.method),
      ['PUT'],
    );
    assert.equal(
      r.observed[0].ifMatch,
      false,
      'no If-Match, so a concurrent edit would be overwritten too',
    );
    assert.equal(logged(r.emu, 'calendar.events.update', from).length, 1);
    assert.equal(logged(r.emu, 'calendar.events.patch', from).length, 0);

    const after = r.emu.calendar.getEvent('primary', before.id)!;
    assert.equal(after.summary, 'Quarterly planning (moved rooms)');
    // The Meet room is gone: Google drops conferenceData on a PUT without conferenceDataVersion=1.
    assert.equal(after.conferenceData, undefined);
    assert.equal(after.hangoutLink, undefined);
    // So are the custom reminders, the colour and the zone.
    assert.deepEqual(after.reminders, { useDefault: true });
    assert.equal(after.colorId, undefined);
    assert.equal(after.start.timeZone, undefined);
    // Every guest's answer is back to "no reply yet".
    assert.deepEqual(answers(after), ['needsAction', 'needsAction', 'needsAction']);
    // Identity survives; only the content was replaced.
    assert.equal(after.id, before.id);
    assert.equal(after.created, before.created);
    // The request log saw the whole exchange and still holds no titles, places or addresses.
    const log = JSON.stringify(r.emu.log);
    for (const secret of [
      'Quarterly planning',
      'Room 4B',
      'Agenda',
      ...GUESTS,
      r.account.email,
      before.id,
    ])
      assert.equal(log.includes(secret), false);
  } finally {
    await r.dispose();
  }
});

test('D11 control: a raw PATCH of the title keeps the Meet link and the answers byte-identical', async () => {
  const r = await rig();
  try {
    const before = richEvent(r);
    const patched = await r.call(`/calendars/primary/events/${enc(before.id)}?sendUpdates=none`, {
      method: 'PATCH',
      body: { summary: 'Quarterly planning (moved rooms)' },
    });
    assert.equal(patched.status, 200);
    const after = r.emu.calendar.getEvent('primary', before.id)!;
    assert.equal(after.summary, 'Quarterly planning (moved rooms)');
    assert.equal(JSON.stringify(after.conferenceData), JSON.stringify(before.conferenceData));
    assert.equal(after.hangoutLink, before.hangoutLink);
    assert.equal(JSON.stringify(after.attendees), JSON.stringify(before.attendees));
    // Nothing else moved either, apart from the bookkeeping a title change bumps.
    const rest: Record<string, unknown> = { ...after };
    delete rest.summary;
    delete rest.etag;
    delete rest.updated;
    delete rest.sequence;
    const was: Record<string, unknown> = { ...before };
    delete was.summary;
    delete was.etag;
    delete was.updated;
    delete was.sequence;
    assert.deepEqual(rest, was);
  } finally {
    await r.dispose();
  }
});

// ---------- D12 ----------

interface Poll {
  requests: Observed[];
  /** Rows the server sent, over every calendar. */
  rows: number;
  /** Events the adapter returned. */
  events: CalendarEvent[];
}

async function legacyPoll(r: Rig): Promise<Poll> {
  r.observed.length = 0;
  const events = await r.adapter.listEvents(r.account);
  const requests = [...r.observed];
  return { requests, rows: requests.reduce((sum, o) => sum + (o.items ?? 0), 0), events };
}

test('D12 0.2.3 re-reads every calendar in full on every poll (asserts the old failure)', async () => {
  const r = await rig();
  try {
    const seeded = r.emu.calendar.seed();
    const visible = r.emu.calendar.listCalendars().filter(c => !c.hidden && !c.deleted);
    const first = await legacyPoll(r);
    await r.clock.advance(10 * 60_000); // 0.2.3 polls calendars every 10 minutes; nothing changes in between.
    const second = await legacyPoll(r);

    for (const poll of [first, second]) {
      // The calendar list, then one full events.list per calendar (each fits one 2,500-row page).
      assert.equal(poll.requests.length, 1 + visible.length);
      assert.equal(poll.requests[0].url.pathname, '/calendar/v3/users/me/calendarList');
      for (const o of poll.requests) {
        assert.equal(o.status, 200);
        assert.equal(o.url.searchParams.has('syncToken'), false, 'no sync token is ever sent');
      }
      for (const o of poll.requests.slice(1)) {
        const q = o.url.searchParams;
        assert.equal(q.get('singleEvents'), 'true');
        assert.equal(q.get('orderBy'), 'startTime');
        // -30 days to +1 year: a 13-month window, re-expanded every time.
        const span = (Date.parse(q.get('timeMax')!) - Date.parse(q.get('timeMin')!)) / DAY;
        assert.ok(span >= 394 && span <= 397, `window of ${span} days`);
      }
    }
    // The second poll pays the same and gets every row again, though nothing changed.
    assert.equal(second.requests.length, first.requests.length);
    assert.equal(second.rows, first.rows);
    assert.ok(first.rows > 60, `rows per poll: ${first.rows}`);
    assert.deepEqual(
      second.events.map(e => e.id),
      first.events.map(e => e.id),
    );
    // The weekly series alone is re-sent as about 56 separate instances each time.
    const weekly = second.events.filter(e => e.remoteId?.startsWith(`${seeded.weekly.masterId}_`));
    assert.ok(weekly.length >= 50, `weekly instances re-sent: ${weekly.length}`);
  } finally {
    await r.dispose();
  }
});

test('D12 control: a sync-token poll with no changes costs one request per calendar and sends no rows', async () => {
  const r = await rig();
  try {
    r.emu.calendar.seed();
    // A correct client's first sync: the list and each calendar once, keeping the tokens.
    const list = await r.call('/users/me/calendarList');
    const calendars: { id: string }[] = list.json.items as { id: string }[];
    let listToken: string = list.json.nextSyncToken as string;
    const tokens = new Map<string, string>();
    for (const c of calendars) {
      const full = await r.call(`/calendars/${enc(c.id)}/events?maxResults=2500`);
      assert.equal(full.status, 200);
      assert.equal(full.json.nextPageToken, undefined);
      tokens.set(c.id, full.json.nextSyncToken as string);
    }
    await r.clock.advance(10 * 60_000);

    for (let round = 0; round < 2; round++) {
      const from = lastSeq(r.emu);
      const listDelta = await r.call(`/users/me/calendarList?syncToken=${enc(listToken)}`);
      assert.equal(listDelta.status, 200);
      assert.deepEqual(listDelta.json.items, []);
      listToken = listDelta.json.nextSyncToken as string;
      for (const c of calendars) {
        const delta = await r.call(
          `/calendars/${enc(c.id)}/events?syncToken=${enc(tokens.get(c.id)!)}`,
        );
        assert.equal(delta.status, 200);
        assert.deepEqual(delta.json.items, []);
        assert.ok(delta.json.nextSyncToken);
        tokens.set(c.id, delta.json.nextSyncToken as string);
      }
      assert.equal(
        logged(r.emu, 'calendar.events.list', from).length,
        calendars.length,
        'one events.list per calendar',
      );
      assert.equal(logged(r.emu, 'calendar.calendarList.list', from).length, 1);
    }
  } finally {
    await r.dispose();
  }
});

// ---------- D24 ----------

test('D24 0.2.3 ignores hidden and deselected calendars (asserts the old failure)', async () => {
  const r = await rig();
  try {
    const seeded = r.emu.calendar.seed();
    const { unselected, hidden } = seeded.calendars;
    const calendars = await r.adapter.listCalendars(r.account);

    // The client's calendar model has no room for either flag.
    for (const c of calendars) {
      for (const key of Object.keys(c))
        assert.ok(
          ['id', 'name', 'accountId', 'color', 'primary'].includes(key),
          `unexpected key ${key}`,
        );
    }
    // A calendar switched off in Google Calendar comes back like any other...
    const off = calendars.find(c => c.id === unselected);
    assert.ok(off, 'the deselected calendar is listed');
    assert.equal('selected' in off, false);
    // ...and its events are fetched and shown in the 0.2.3 view.
    r.observed.length = 0;
    const events = await r.adapter.listEvents(r.account);
    assert.ok(
      r.observed.some(o => o.url.pathname === `/calendar/v3/calendars/${enc(unselected)}/events`),
      'the deselected calendar is fetched',
    );
    assert.ok(
      events.some(e => e.calendarId === unselected),
      'its events are in the view',
    );
    // The hidden one is missing only because Google leaves hidden entries out unless showHidden=true;
    // 0.2.3 never asks, so it cannot offer the calendar at all, not even as a switched-off entry.
    assert.equal(
      calendars.some(c => c.id === hidden),
      false,
    );
    assert.ok(r.observed.every(o => !o.url.searchParams.has('showHidden')));
    assert.equal(
      events.some(e => e.calendarId === hidden),
      false,
    );
  } finally {
    await r.dispose();
  }
});

test('D24 control: the calendar list carries the hidden and selected flags', async () => {
  const r = await rig();
  try {
    const seeded = r.emu.calendar.seed();
    const { family, hidden, unselected, readOnly } = seeded.calendars;
    const all = await r.call('/users/me/calendarList?showHidden=true');
    assert.equal(all.status, 200);
    /** A calendarList entry as the JSON response carries it. */
    interface EntryJson {
      [field: string]: unknown;
      id: string;
      hidden?: boolean;
      selected?: boolean;
    }
    const byId = new Map<string, EntryJson>((all.json.items as EntryJson[]).map(c => [c.id, c]));
    // Google leaves false flags out, so an absent `selected` means switched off.
    for (const id of [seeded.primaryId, family, readOnly])
      assert.equal(byId.get(id)!.selected, true, 'a shown calendar says so');
    assert.equal(byId.get(unselected)!.selected, undefined);
    assert.equal(byId.get(unselected)!.hidden, undefined);
    assert.equal(byId.get(hidden)!.hidden, true);
    assert.equal(byId.get(hidden)!.selected, undefined);
    // Without showHidden the hidden entry is left out, as on Google.
    const shown = await r.call('/users/me/calendarList');
    assert.equal(
      (shown.json.items as EntryJson[]).some(c => c.id === hidden),
      false,
    );
    assert.equal(
      (shown.json.items as EntryJson[]).some(c => c.id === unselected),
      true,
    );
  } finally {
    await r.dispose();
  }
});
