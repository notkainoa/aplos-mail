import test from 'node:test';
import assert from 'node:assert/strict';
import { StoreError, type EventRow, type StorePort } from '../../src/store';
import { ACCOUNT, T0, accountWrite, withStore } from './helpers';

const cal = {
  kind: 'calendar',
  accountId: ACCOUNT,
  remoteId: 'primary',
  name: 'Owner',
  hidden: false,
  readOnly: false,
} as const;
const row = (recurrenceId?: string): EventRow => ({
  recurrenceId,
  status: 'confirmed',
  allDay: false,
  startUtc: T0,
  endUtc: T0 + 3_600_000,
  data: '{}',
});
const event = (remoteId: string, rows: EventRow[]) =>
  ({ kind: 'event', accountId: ACCOUNT, calendarRemoteId: 'primary', remoteId, rows }) as const;
const setup = (store: StorePort) =>
  store.commit({ opId: 'setup', origin: 'sync', writes: [accountWrite, cal] });
const invalid = (e: unknown) => e instanceof StoreError && e.code === 'invalid';

test('the store refuses a recurrenceId that is not canonical, so one occurrence cannot get two rows (FR-20)', () => {
  withStore(store => {
    setup(store);
    // Timed UTC, all-day and floating are the three canonical forms.
    store.commit({
      opId: 'ok',
      origin: 'sync',
      writes: [
        event('e1', [row(), row('20261027T070000Z'), row('20261103'), row('20261110T090000')]),
      ],
    });
    assert.deepEqual(
      store.read(q =>
        q.all<{ r: string }>('SELECT recurrence_id AS r FROM events ORDER BY r').map(r => r.r),
      ),
      ['', '20261027T070000Z', '20261103', '20261110T090000'],
    );
    for (const bad of [
      '2026-10-27T09:00:00+02:00', // the same occurrence as 20261027T070000Z, written another way
      '2026-10-27',
      '20261027T0700Z',
      '20261027t070000z',
      '20261399T070000Z', // the pattern, but no real date
      '20261027T250000Z',
    ])
      assert.throws(
        () =>
          store.commit({
            opId: `bad-${bad}`,
            origin: 'sync',
            writes: [event('e1', [row(), row(bad)])],
          }),
        invalid,
        bad,
      );
    assert.equal(
      store.read(q => q.get<{ n: number }>('SELECT count(*) AS n FROM events')!.n),
      4,
      'a refused write changes nothing',
    );
  });
});

test('Event/hide has a store home: hide a resource or one occurrence, show it again, survive a refresh (R2G-4)', () => {
  withStore(store => {
    setup(store);
    store.commit({
      opId: 'e',
      origin: 'sync',
      writes: [event('e1', [row(), row('20261027T070000Z')])],
    });
    const hidden = () =>
      store.read(q =>
        q
          .all<{ id: string; r: string }>(
            'SELECT remote_id AS id, recurrence_id AS r FROM event_hidden ORDER BY id, r',
          )
          .map(r => `${r.id}@${r.r}`),
      );
    const hide = (opId: string, recurrenceId: string | undefined, isHidden = true) =>
      store.commit({
        opId,
        origin: 'local',
        writes: [
          {
            kind: 'eventHidden',
            accountId: ACCOUNT,
            calendarRemoteId: 'primary',
            remoteId: 'e1',
            recurrenceId,
            hidden: isHidden,
          },
        ],
      });
    const before = store.seq();
    // An unedited occurrence (no override row) can be hidden too.
    hide('h1', '20261103T070000Z');
    hide('h2', undefined);
    assert.deepEqual(hidden(), ['e1@', 'e1@20261103T070000Z']);
    const since = store.changesSince(before);
    assert.deepEqual(
      since.status === 'ok' && since.changes.map(c => `${c.type} ${c.id}`),
      [`Event ${ACCOUNT}:primary/e1`, `Event ${ACCOUNT}:primary/e1`],
      'each hide writes the resource Event change row',
    );
    // A provider refresh rewrites the rows; the hiding is Aplos-only and stays.
    store.commit({ opId: 'e2', origin: 'sync', writes: [event('e1', [row()])] });
    assert.deepEqual(hidden(), ['e1@', 'e1@20261103T070000Z']);
    hide('s1', undefined, false);
    assert.deepEqual(hidden(), ['e1@20261103T070000Z']);
    assert.throws(() => hide('bad', '2026-11-03'), invalid, 'occurrence ids are canonical too');
    assert.throws(
      () =>
        store.commit({
          opId: 'missing',
          origin: 'local',
          writes: [
            {
              kind: 'eventHidden',
              accountId: ACCOUNT,
              calendarRemoteId: 'primary',
              remoteId: 'nope',
              hidden: true,
            },
          ],
        }),
      (e: unknown) => e instanceof StoreError && e.code === 'notFound',
    );
    // The resource going away at the provider takes its hidden rows with it.
    store.commit({
      opId: 'gone',
      origin: 'sync',
      writes: [
        { kind: 'eventDelete', accountId: ACCOUNT, calendarRemoteId: 'primary', remoteId: 'e1' },
      ],
    });
    assert.deepEqual(hidden(), []);
  });
});
