import assert from 'node:assert/strict';
import test from 'node:test';
import type { Event } from '@aplos/contract';
import { Fixture, FixtureEngine } from '../src/engine';
import { handlers } from '../src/methods';
import { buildScenario } from '../src/scenarios';

// The stand-in's `Event/set` on a series seeded straight into the store (Event/set create cannot write a series).

const utc = (iso: string) => ({ type: 'utc' as const, utc: Date.parse(iso) });

function world() {
  const fx = new Fixture('demo', {});
  buildScenario(fx, 'demo');
  fx.scheduleLater(true);
  fx.handlers = handlers(fx);
  const base = fx.store.all('Event').find(e => e.can.edit && !e.recurring && !e.attendees.length)!;
  assert.ok(base, 'the demo has an editable event without guests');
  const make = (id: string, start: string, end: string, extra: Partial<Event> = {}): Event => ({
    ...base,
    id,
    recurring: true,
    exception: false,
    title: 'Standup',
    start: utc(start),
    end: utc(end),
    allDay: false,
    timeZone: 'America/New_York',
    ...extra,
  });
  const master = make('sm', '2026-10-27T14:00:00Z', '2026-10-27T14:30:00Z');
  const nov3 = make('sm@20261103', '2026-11-03T15:00:00Z', '2026-11-03T15:30:00Z', {
    seriesId: 'sm',
    originalStart: utc('2026-11-03T15:00:00Z'),
  });
  for (const row of [master, nov3]) fx.store.seed('Event', row);
  const session = new FixtureEngine(fx).connect();
  const set = (change: object) =>
    session.call('Event/set', { opId: `o${Math.random()}`, change, notify: false } as never);
  const row = (id: string) => fx.store.all('Event').find(e => e.id === id)!;
  return { fx, base, set, row };
}

test('scope series on an occurrence moves the whole series by the wall-clock difference', async () => {
  const { set, row } = world();
  await set({
    type: 'update',
    id: 'sm@20261103',
    scope: 'series',
    fields: { start: utc('2026-11-04T16:00:00Z'), end: utc('2026-11-04T16:30:00Z'), title: 'Sync' },
  });
  assert.deepEqual(row('sm@20261103').start, utc('2026-11-04T16:00:00Z'));
  assert.deepEqual(row('sm').start, utc('2026-10-28T15:00:00Z'), 'the master moved by +25 h wall');
  assert.deepEqual(row('sm').end, utc('2026-10-28T15:30:00Z'));
  assert.equal(row('sm').title, 'Sync');
  assert.equal(row('sm@20261103').title, 'Sync');
  assert.equal(row('sm@20261103').seriesId, 'sm', 'a row keeps what makes it part of a series');
  assert.equal(row('sm').recurring, true);
  assert.deepEqual(row('sm@20261103').originalStart, utc('2026-11-04T16:00:00Z'));
});

test('scope occurrence patches only that row and marks it an exception', async () => {
  const { set, row } = world();
  await set({
    type: 'update',
    id: 'sm@20261103',
    scope: 'occurrence',
    fields: { start: utc('2026-11-04T16:00:00Z'), end: utc('2026-11-04T16:30:00Z') },
  });
  assert.deepEqual(row('sm').start, utc('2026-10-27T14:00:00Z'), 'the master is untouched');
  assert.deepEqual(row('sm@20261103').start, utc('2026-11-04T16:00:00Z'));
  assert.equal(row('sm@20261103').exception, true);
  assert.equal(row('sm@20261103').seriesId, 'sm');
});

test('scope series on a single event is that one row, unchanged in kind', async () => {
  const { set, row, base } = world();
  await set({ type: 'update', id: base.id, scope: 'series', fields: { title: 'Solo' } });
  assert.equal(row(base.id).title, 'Solo');
  assert.equal(row(base.id).recurring, false);
  assert.equal(row('sm').title, 'Standup', 'another series is not touched');
});
