import test from 'node:test';
import assert from 'node:assert/strict';
import { GMAIL_UNIT_COSTS, costOf } from '../src/gmail';
import { setup } from './gmail-helpers';

test('cost table matches the 2026 usage-limits page', () => {
  const expected: Record<string, [number, number?]> = {
    'gmail.users.getProfile': [1],
    'gmail.users.labels.list': [1],
    'gmail.users.history.list': [2],
    'gmail.users.messages.list': [5],
    'gmail.users.threads.list': [10],
    'gmail.users.messages.get': [20, 60],
    'gmail.users.threads.get': [40, 120],
    'gmail.users.messages.attachments.get': [20],
    'gmail.users.messages.modify': [5],
    'gmail.users.threads.modify': [10],
    'gmail.users.messages.batchModify': [50],
    'gmail.users.messages.trash': [20],
    'gmail.users.threads.trash': [20],
    'gmail.users.messages.insert': [25],
    'gmail.users.drafts.create': [10],
    'gmail.users.drafts.update': [15],
    'gmail.users.drafts.send': [100],
    'gmail.users.messages.send': [100],
    'gmail.users.settings.filters.create': [5],
    'gmail.users.settings.filters.list': [1],
    'gmail.users.settings.filters.delete': [5],
    'gmail.users.watch': [100],
  };
  for (const [method, [base, full]] of Object.entries(expected)) {
    assert.equal(costOf(method, 'metadata'), base, method);
    assert.equal(costOf(method, 'minimal'), base, method);
    assert.equal(costOf(method, 'full'), full ?? base, `${method} full`);
    assert.equal(costOf(method, 'raw'), full ?? base, `${method} raw`);
  }
  assert.equal(costOf('gmail.users.messages.get'), 60, 'format defaults to full, as in the API');
  assert.equal(costOf('gmail.users.messages.get', 'metadata', true), 5);
  assert.equal(costOf('gmail.users.threads.get', 'full', true), 10);
  assert.equal(costOf('gmail.users.messages.attachments.get', null, true), 5);
  assert.ok(Object.keys(GMAIL_UNIT_COSTS).length > 25);
  assert.throws(() => costOf('gmail.users.nope'), /No unit cost/);
});

test('the emulator charges the table price and logs the units', async () => {
  const { api, emu } = await setup({ threads: 5 });
  const list = await api('/messages?maxResults=1');
  const id = list.json.messages[0].id;
  await api(`/messages/${id}?format=metadata`);
  await api(`/messages/${id}?format=full`);
  await api(`/messages/${id}?format=raw`);
  const units = emu.log.filter(e => e.apiMethod.startsWith('gmail.')).map(e => e.units);
  assert.deepEqual(units, [5, 20, 60, 60]);
  assert.equal(emu.meter.unitsInWindow(), 145);
});

test('grandfathered projects pay the old prices', async () => {
  const { api, emu } = await setup({ threads: 3, grandfathered: true });
  const threadId = (await api('/threads?maxResults=1')).json.threads[0].id;
  await api(`/threads/${threadId}?format=full`);
  assert.deepEqual(
    emu.log.filter(e => e.service === 'gmail').map(e => e.units),
    [10, 10],
  );
});

test('a request that would pass the limit is refused, one that exactly fits is not', async () => {
  const { api, emu, clock } = await setup({ unitsPerMinute: 10 });
  assert.equal((await api('/messages')).status, 200); // 5
  assert.equal((await api('/messages')).status, 200); // 10, exactly the limit
  const refused = await api('/messages');
  assert.equal(refused.status, 403);
  assert.equal(emu.meter.unitsInWindow(), 10, 'a refused request costs nothing by default');
  assert.equal(emu.log.at(-1)!.units, 0);
  assert.equal(emu.log.at(-1)!.reason, 'rateLimitExceeded');
  // A cheaper call still fits after a partial wait? No: the window is full, so even 1 unit is refused.
  assert.equal((await api('/profile')).status, 403);
  await clock.advance(60_000);
  assert.equal((await api('/messages')).status, 200, 'units fall out of the window after 60 s');
});

test('units free up exactly 60 s after they were charged', async () => {
  const { api, clock } = await setup({ unitsPerMinute: 5 });
  assert.equal((await api('/messages')).status, 200);
  await clock.advance(59_999);
  assert.equal((await api('/messages')).status, 403);
  await clock.advance(1);
  assert.equal((await api('/messages')).status, 200);
});

test('chargeRefused counts refused requests against the window', async () => {
  const { api, emu } = await setup({ unitsPerMinute: 5, chargeRefused: true });
  await api('/messages');
  await api('/messages');
  assert.equal(emu.meter.unitsInWindow(), 10);
  assert.equal(emu.log.at(-1)!.units, 5);
  assert.equal(
    emu.meter.perMinuteSeries().reduce((s, m) => s + m.units, 0),
    5,
    'the series only counts accepted units',
  );
  assert.equal(emu.meter.peakWindow(), 10);
});

test('per-minute series and peak window track what was accepted', async () => {
  const { api, emu, clock } = await setup({ unitsPerMinute: 100 });
  const minute = Math.floor(clock.now() / 60_000) * 60_000;
  for (let i = 0; i < 4; i++) await api('/messages'); // 20 units in the first minute
  await clock.advanceTo(minute + 90_000);
  for (let i = 0; i < 2; i++) await api('/messages'); // 10 units in the second minute
  const series = emu.meter.perMinuteSeries();
  assert.deepEqual(
    series.map(s => s.units),
    [20, 10],
  );
  assert.equal(series[1].minuteStart - series[0].minuteStart, 60_000);
  // The first 20 units had left the 60 s window by the time the next 10 arrived.
  assert.equal(emu.meter.peakWindow(), 20);
  assert.equal(emu.meter.unitsInWindow(), 10);
});

test('0.2.3 first sync: 500 full threads at four in parallel hit the wall after about 50', async () => {
  const { api, emu } = await setup({ threads: 120, latencyMs: 150 });
  const ids = (await api('/threads?maxResults=120&includeSpamTrash=true')).json.threads.map(
    (t: { id: string }) => t.id,
  ) as string[];
  const outcomes: number[] = [];
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      outcomes.push((await api(`/threads/${id}?format=full`)).status);
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  const ok = outcomes.filter(s => s === 200).length;
  const refused = outcomes.filter(s => s === 403).length;
  // 6,000 units minus the 10-unit list, at 120 units each: 49 fit. Everything after is refused.
  assert.equal(ok, 49);
  assert.equal(refused, ids.length - 49);
  assert.equal(ids.length, 120);
  assert.ok(emu.meter.peakWindow() <= 6000);
});
