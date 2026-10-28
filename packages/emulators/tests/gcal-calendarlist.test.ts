import assert from 'node:assert/strict';
import test from 'node:test';
import { ME, setupCal } from './gcal-helpers';

const LIST = '/users/me/calendarList';

/** A calendarList entry as the JSON response carries it. */
interface EntryJson {
  [field: string]: unknown;
  id?: string;
  summary?: string;
  summaryOverride?: string;
  accessRole?: string;
  selected?: boolean;
  hidden?: boolean;
  deleted?: boolean;
  primary?: boolean;
  backgroundColor?: string;
  timeZone?: string;
  etag?: string;
}

async function seeded() {
  const t = await setupCal();
  const gen = t.emu.calendar.seed();
  return { t, gen };
}

test('entries carry the fields clients read, and Google leaves false flags out', async () => {
  const { t, gen } = await seeded();
  const r = await t.call(`${LIST}?showHidden=true`);
  assert.equal(r.status, 200);
  assert.equal(r.json.kind, 'calendar#calendarList');
  const primary = r.json.items.find((i: EntryJson) => i.id === ME);
  assert.equal(primary.kind, 'calendar#calendarListEntry');
  assert.equal(primary.primary, true);
  assert.equal(primary.accessRole, 'owner');
  assert.equal(primary.selected, true);
  assert.equal(primary.timeZone, 'America/Los_Angeles');
  assert.match(primary.etag, /^"/);
  assert.match(primary.backgroundColor, /^#[0-9a-f]{6}$/);
  assert.equal(primary.hidden, undefined);
  assert.equal(primary.deleted, undefined);
  const family = r.json.items.find((i: EntryJson) => i.id === gen.calendars.family);
  assert.equal(family.primary, undefined);
  assert.equal(family.summary, 'Family');
  const readOnly = r.json.items.find((i: EntryJson) => i.id === gen.calendars.readOnly);
  assert.equal(readOnly.accessRole, 'reader');
});

test('hidden calendars are left out unless showHidden is set; unselected ones are listed with selected missing', async () => {
  const { t, gen } = await seeded();
  const plain = await t.call(LIST);
  const ids = plain.json.items.map((i: EntryJson) => i.id);
  assert.ok(!ids.includes(gen.calendars.hidden));
  assert.ok(ids.includes(gen.calendars.unselected));
  const unselected = plain.json.items.find((i: EntryJson) => i.id === gen.calendars.unselected);
  assert.equal(unselected.selected, undefined);
  const withHidden = await t.call(`${LIST}?showHidden=true`);
  const hidden = withHidden.json.items.find((i: EntryJson) => i.id === gen.calendars.hidden);
  assert.equal(hidden.hidden, true);
  assert.equal(withHidden.json.items.length, plain.json.items.length + 1);
});

test('helpers hide, deselect and delete calendars; showDeleted brings deleted entries back', async () => {
  const { t, gen } = await seeded();
  t.emu.calendar.hideCalendar(gen.calendars.family);
  t.emu.calendar.deselectCalendar(gen.primaryId);
  t.emu.calendar.deleteCalendar(gen.calendars.unselected);
  const plain = (await t.call(LIST)).json.items.map((i: EntryJson) => i.id);
  assert.ok(!plain.includes(gen.calendars.family));
  assert.ok(!plain.includes(gen.calendars.unselected));
  assert.equal(
    (await t.call(LIST)).json.items.find((i: EntryJson) => i.id === gen.primaryId).selected,
    undefined,
  );
  const all = (await t.call(`${LIST}?showHidden=true&showDeleted=true`)).json.items;
  assert.equal(all.find((i: EntryJson) => i.id === gen.calendars.unselected).deleted, true);
  assert.throws(() => t.emu.calendar.deleteCalendar(gen.primaryId), /primary/);
  // A deleted calendar's events are gone.
  assert.equal((await t.call(t.events(gen.calendars.unselected))).status, 404);
});

test('minAccessRole filters by role rank', async () => {
  const { t, gen } = await seeded();
  const writers = (await t.call(`${LIST}?minAccessRole=writer&showHidden=true`)).json.items.map(
    (i: EntryJson) => i.id,
  );
  assert.ok(!writers.includes(gen.calendars.readOnly));
  assert.ok(writers.includes(gen.primaryId));
  const readers = (await t.call(`${LIST}?minAccessRole=reader`)).json.items.map(
    (i: EntryJson) => i.id,
  );
  assert.ok(readers.includes(gen.calendars.readOnly));
  assert.equal((await t.call(`${LIST}?minAccessRole=boss`)).status, 400);
});

test('maxResults and pageToken page the list; the sync token comes only with the last page', async () => {
  const { t } = await seeded();
  const first = await t.call(`${LIST}?maxResults=2&showHidden=true`);
  assert.equal(first.json.items.length, 2);
  assert.ok(first.json.nextPageToken);
  assert.equal(first.json.nextSyncToken, undefined);
  const seen = [...first.json.items.map((i: EntryJson) => i.id)];
  let page = first;
  while (page.json.nextPageToken) {
    page = await t.call(
      `${LIST}?maxResults=2&showHidden=true&pageToken=${page.json.nextPageToken}`,
    );
    seen.push(...page.json.items.map((i: EntryJson) => i.id));
  }
  assert.equal(new Set(seen).size, seen.length);
  assert.equal(seen.length, 5);
  assert.ok(page.json.nextSyncToken);
  assert.equal((await t.call(`${LIST}?maxResults=0`)).status, 400);
});

test('incremental sync returns only changed entries, hidden and deleted ones included', async () => {
  const { t, gen } = await seeded();
  const full = await t.call(LIST);
  const token = full.json.nextSyncToken;
  const none = await t.call(`${LIST}?syncToken=${token}`);
  assert.deepEqual(none.json.items, []);
  assert.ok(none.json.nextSyncToken);

  t.emu.calendar.hideCalendar(gen.calendars.family);
  t.emu.calendar.deleteCalendar(gen.calendars.unselected);
  const added = t.emu.calendar.addCalendar({ summary: 'Book club', accessRole: 'writer' });
  const changes = await t.call(`${LIST}?syncToken=${none.json.nextSyncToken}`);
  const byId = Object.fromEntries(changes.json.items.map((i: EntryJson) => [i.id, i]));
  assert.equal(Object.keys(byId).length, 3);
  assert.equal(byId[gen.calendars.family].hidden, true);
  assert.equal(byId[gen.calendars.unselected].deleted, true);
  assert.equal(byId[added.id].accessRole, 'writer');
});

test('a calendar renamed by its owner is not a calendar-list change; an override rename is', async () => {
  const { t, gen } = await seeded();
  const token = (await t.call(LIST)).json.nextSyncToken;
  t.emu.calendar.renameCalendar(gen.calendars.family, 'Family and friends');
  assert.deepEqual((await t.call(`${LIST}?syncToken=${token}`)).json.items, []);
  t.emu.calendar.updateCalendar(gen.calendars.family, { summaryOverride: 'Home' });
  const changed = (await t.call(`${LIST}?syncToken=${token}`)).json.items;
  assert.equal(changed.length, 1);
  assert.equal(changed[0].summary, 'Family and friends');
  assert.equal(changed[0].summaryOverride, 'Home');
});

test('a bad, foreign or expired sync token is 410 fullSyncRequired', async () => {
  const { t } = await seeded();
  const token = (await t.call(LIST)).json.nextSyncToken;
  const garbage = await t.call(`${LIST}?syncToken=not-a-token`);
  assert.equal(garbage.status, 410);
  assert.equal(garbage.json.error.errors[0].reason, 'fullSyncRequired');
  assert.equal(
    garbage.json.error.message,
    'Sync token is no longer valid, a full sync is required.',
  );
  assert.equal(t.emu.log.at(-1)!.reason, 'fullSyncRequired');

  // The expire helper kills tokens of one list kind only.
  t.emu.calendar.expireSyncTokens({ kind: 'events' });
  assert.equal((await t.call(`${LIST}?syncToken=${token}`)).status, 200);
  t.emu.calendar.expireSyncTokens({ kind: 'calendarList' });
  assert.equal((await t.call(`${LIST}?syncToken=${token}`)).status, 410);

  // After a full sync the new token works again.
  const fresh = (await t.call(LIST)).json.nextSyncToken;
  assert.equal((await t.call(`${LIST}?syncToken=${fresh}`)).status, 200);
});

test('a sync token older than the horizon is refused', async () => {
  const t = await setupCal({ calendar: { syncTokenHorizonMs: 3600_000 * 24 } });
  const token = (await t.call(LIST)).json.nextSyncToken;
  await t.clock.advance(23 * 3600_000);
  await t.h.renew();
  assert.equal((await t.call(`${LIST}?syncToken=${token}`)).status, 200);
  await t.clock.advance(2 * 3600_000);
  await t.h.renew();
  assert.equal((await t.call(`${LIST}?syncToken=${token}`)).status, 410);
});

test('syncToken cannot be combined with minAccessRole, showDeleted=false or showHidden=false', async () => {
  const t = await setupCal();
  const token = (await t.call(LIST)).json.nextSyncToken;
  for (const extra of ['minAccessRole=reader', 'showDeleted=false', 'showHidden=false']) {
    const r = await t.call(`${LIST}?syncToken=${token}&${extra}`);
    assert.equal(r.status, 400, extra);
  }
  assert.equal(
    (await t.call(`${LIST}?syncToken=${token}&showDeleted=true&showHidden=true`)).status,
    200,
  );
});

test('calendarList.get returns one entry, hidden ones too; unknown ids are 404', async () => {
  const { t, gen } = await seeded();
  const hidden = await t.call(`${LIST}/${encodeURIComponent(gen.calendars.hidden)}`);
  assert.equal(hidden.status, 200);
  assert.equal(hidden.json.hidden, true);
  assert.equal((await t.call(`${LIST}/primary`)).json.id, ME);
  assert.equal((await t.call(`${LIST}/nobody%40example.test`)).status, 404);
});

test('fields masks apply to the calendar list and unknown names are 400', async () => {
  const { t } = await seeded();
  const r = await t.call(`${LIST}?fields=items(id,hidden,selected),nextSyncToken`);
  assert.deepEqual(
    Object.keys(r.json.items[0])
      .sort()
      .filter(k => !['id', 'hidden', 'selected'].includes(k)),
    [],
  );
  assert.ok(r.json.nextSyncToken);
  const bad = await t.call(`${LIST}?fields=items(idd)`);
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.errors[0].reason, 'invalidParameter');
});
