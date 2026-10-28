import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account, AppState, CalendarEvent, CalendarInfo } from '@aplos/contract/legacy/types';
import { createService } from '../src/main/service';
import { createGoogle } from '../src/main/google';
import { createGroq } from '../src/main/groq';
import {
  allDayLanes,
  calendarIndex,
  eventsOnDay,
  layoutDay,
  mergeCalendars,
  shiftAnchor,
  viewDays,
  visibleEvents,
} from '../src/renderer/legacy/calendarLayout';

const account = (id: string, color: string): Account => ({
  id,
  name: 'Alex',
  email: `${id}@example.test`,
  color,
  provider: 'google',
  connected: true,
  calendarConnected: true,
});
const work = account('work', '#718878'),
  home = account('home', '#b38b71');
const at = (day: string, time: string) => new Date(`${day}T${time}:00`).toISOString();
const event = (
  id: string,
  accountId: string,
  calendarId: string,
  start: string,
  end: string,
  allDay = false,
): CalendarEvent => ({
  id,
  accountId,
  calendarId,
  title: id,
  start,
  end,
  allDay,
  location: '',
  description: '',
  guests: [],
});

test('calendars from every account merge into one list; event-only calendars and the primary alias still resolve', () => {
  const listed: CalendarInfo[] = [
    { id: 'team@group', name: 'Team', accountId: 'work', color: '#8A74B0' },
    { id: 'alex@work', name: 'Alex', accountId: 'work', primary: true },
    { id: 'home-main', name: 'Home', accountId: 'home', primary: true, color: '#123456' },
    { id: 'stray', name: 'Gone', accountId: 'nobody' },
  ];
  const events = [
    event('a', 'work', 'primary', at('2026-10-21', '09:00'), at('2026-10-21', '10:00')),
    event(
      'b',
      'home',
      '/cal/fitness%20club/',
      at('2026-10-21', '09:00'),
      at('2026-10-21', '10:00'),
    ),
  ];
  const sources = mergeCalendars([work, home], listed, events);
  assert.deepEqual(
    sources.map(s => s.key),
    ['work/alex@work', 'work/team@group', 'home/home-main', 'home//cal/fitness%20club/'],
  );
  // Host colours are kept (normalized); a default calendar without one takes its account's colour; others get distinct colours.
  assert.equal(sources[0].color, '#718878');
  assert.equal(sources[1].color, '#8a74b0');
  assert.equal(sources[2].color, '#123456');
  assert.equal(sources[3].name, 'fitness club');
  assert.ok(/^#[0-9a-f]{6}$/.test(sources[3].color));
  assert.notEqual(sources[3].color, sources[2].color);
  const sourceOf = calendarIndex(sources);
  assert.equal(sourceOf(events[0])?.key, 'work/alex@work');
  // Offline: nothing listed, every calendar comes from its events.
  assert.deepEqual(
    mergeCalendars([work], [], events).map(s => [s.key, s.name, s.color]),
    [['work/primary', 'Calendar', '#718878']],
  );
});

test('visibility follows the account filter and hidden calendars, including events saved to "primary"', () => {
  const sources = mergeCalendars(
    [work, home],
    [
      { id: 'w', name: 'Work', accountId: 'work', primary: true },
      { id: 't', name: 'Team', accountId: 'work' },
      { id: 'h', name: 'Home', accountId: 'home', primary: true },
    ],
    [],
  );
  const sourceOf = calendarIndex(sources);
  const day = '2026-10-21';
  const events = [
    event('w1', 'work', 'w', at(day, '09:00'), at(day, '10:00')),
    event('w2', 'work', 'primary', at(day, '11:00'), at(day, '12:00')),
    event('t1', 'work', 't', at(day, '09:00'), at(day, '10:00')),
    event('h1', 'home', 'h', at(day, '09:00'), at(day, '10:00')),
  ];
  const ids = (accountId: string, hidden: string[]) =>
    visibleEvents(events, sourceOf, accountId, hidden).map(e => e.id);
  assert.deepEqual(ids('all', []), ['w1', 'w2', 't1', 'h1']);
  assert.deepEqual(ids('all', ['work/w']), ['t1', 'h1']);
  assert.deepEqual(ids('work', ['work/t']), ['w1', 'w2']);
  assert.deepEqual(ids('home', []), ['h1']);
});

test('overlapping events share columns, widen into free space, and all-day events stack into lanes', () => {
  const day = '2026-10-21';
  const placed = layoutDay(
    [
      event('a', work.id, 'w', at(day, '09:00'), at(day, '10:00')),
      event('b', work.id, 'w', at(day, '09:30'), at(day, '11:00')),
      event('c', work.id, 'w', at(day, '10:00'), at(day, '10:30')),
      event('d', work.id, 'w', at(day, '13:00'), at(day, '14:00')),
      event('night', work.id, 'w', at('2026-10-20', '23:00'), at(day, '01:00')),
      event('holiday', work.id, 'w', '2026-10-21', '2026-10-22', true),
    ],
    day,
  );
  const of = (id: string) => placed.find(p => p.event.id === id)!;
  assert.equal(placed.length, 5, 'all-day events are not placed on the time grid');
  assert.deepEqual([of('a').column, of('b').column, of('c').column], [0, 1, 0]);
  assert.deepEqual([of('a').columns, of('b').columns, of('c').columns], [2, 2, 2]);
  assert.deepEqual([of('d').column, of('d').columns, of('d').span], [0, 1, 1]);
  assert.deepEqual(
    [of('night').start, of('night').end],
    [0, 60],
    'an event from the night before is clipped to this day',
  );
  // A lone event beside a two-column run widens when nothing sits to its right.
  const wide = layoutDay(
    [
      event('long', work.id, 'w', at(day, '09:00'), at(day, '12:00')),
      event('short', work.id, 'w', at(day, '09:00'), at(day, '09:30')),
      event('later', work.id, 'w', at(day, '11:00'), at(day, '11:30')),
    ],
    day,
  );
  assert.equal(wide.find(p => p.event.id === 'later')!.span, 1);
  assert.equal(wide.find(p => p.event.id === 'later')!.column, 1);

  const week = viewDays('week', '2026-10-21');
  assert.deepEqual([week[0], week[6]], ['2026-10-18', '2026-10-24']);
  const { bars, lanes } = allDayLanes(
    [
      event('trip', home.id, 'h', '2026-10-16', '2026-10-20', true),
      event('offsite', work.id, 'w', '2026-10-22', '2026-10-24', true),
      event('birthday', home.id, 'h', '2026-10-22', '2026-10-23', true),
      event('cabin', home.id, 'h', '2026-10-23', '2026-10-26', true),
    ],
    week,
  );
  assert.equal(lanes, 2);
  assert.deepEqual(
    bars.map(b => [b.event.id, b.from, b.to, b.lane]),
    [
      ['trip', 0, 1, 0],
      ['offsite', 4, 5, 0],
      ['birthday', 4, 4, 1],
      ['cabin', 5, 6, 1],
    ],
  );
  assert.deepEqual(
    eventsOnDay([event('cabin', home.id, 'h', '2026-10-23', '2026-10-26', true)], '2026-10-25')
      .length,
    1,
  );
  assert.equal(shiftAnchor('month', '2027-01-31', 1), '2027-02-28');
});

test('the demo has several coloured calendars per account, every demo event belongs to one, and hidden calendars persist', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-calendar-'));
  const service = await createService({
    dataDir,
    google: await createGoogle({ dataDir, clientId: '' }),
    groq: createGroq({ apiKey: '' }),
  });
  try {
    const state = (await service.invoke('state.get')) as AppState;
    const list = (await service.invoke('calendar.list', { accountId: 'all' })) as CalendarInfo[];
    for (const id of ['work', 'personal']) {
      const own = list.filter(c => c.accountId === id);
      assert.ok(own.length >= 3);
      assert.equal(own.filter(c => c.primary).length, 1);
      assert.ok(own.every(c => /^#[0-9a-f]{6}$/.test(c.color!)));
    }
    const keys = new Set(list.map(c => c.accountId + '/' + c.id));
    assert.ok(state.events.length >= 20);
    assert.ok(state.events.every(e => keys.has(e.accountId + '/' + e.calendarId)));
    assert.equal(
      new Set(state.events.map(e => e.calendarId)).size,
      6,
      'every demo calendar has plans',
    );
    assert.deepEqual(
      ((await service.invoke('calendar.list', { accountId: 'personal' })) as CalendarInfo[]).map(
        c => c.name,
      ),
      ['Personal', 'Family', 'Fitness'],
    );
    const saved = (await service.invoke('settings.update', {
      patch: {
        hiddenCalendars: [
          'work/demo-work-team',
          'work/demo-work-team',
          'personal/demo-personal-fitness',
        ],
      },
    })) as AppState;
    assert.deepEqual(saved.settings.hiddenCalendars, [
      'work/demo-work-team',
      'personal/demo-personal-fitness',
    ]);
    await assert.rejects(
      service.invoke('settings.update', { patch: { hiddenCalendars: 'work/demo-work' } }),
      /hidden calendars/,
    );
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
