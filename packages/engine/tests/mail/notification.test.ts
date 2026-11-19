import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KEEP_DONE_MS } from '../../src/outbox/notifications';
import { IDS, mailWorld, type World } from './harness';

// `Message.notification`: what the notifier did with a message, read from the outbox row (the reader's bell).

async function withWorld(fn: (w: World) => Promise<void>) {
  const world = await mailWorld();
  try {
    await fn(world);
  } finally {
    await world.cleanup();
  }
}

const notificationsOf = async (w: World, ids: string[]) => {
  const { list } = (await w.windowA.call('Message/get', { ids })) as {
    list: { id: string; notification?: string }[];
  };
  return Object.fromEntries(list.map(m => [m.id, m.notification]));
};

const seedRow = (w: World, id: string, state: string) =>
  w.rawSql(
    'INSERT INTO notifications(message_id, state, created_at) VALUES(?, ?, 1)',
    w.refOf(id).rowId,
    state,
  );

describe('Message.notification', () => {
  it('maps the outbox row: queued, claimed and posted are sent, dropped is suppressed, no row is none', () =>
    withWorld(async w => {
      seedRow(w, IDS.rich, 'pending');
      seedRow(w, IDS.plain, 'posted');
      seedRow(w, IDS.remote, 'dropped');
      assert.deepEqual(await notificationsOf(w, [IDS.rich, IDS.plain, IDS.remote, IDS.other]), {
        [IDS.rich]: 'sent',
        [IDS.plain]: 'sent',
        [IDS.remote]: 'suppressed',
        [IDS.other]: 'none',
      });
      w.rawSql(
        "UPDATE notifications SET state = 'claimed' WHERE message_id = ?",
        w.refOf(IDS.rich).rowId,
      );
      assert.equal((await notificationsOf(w, [IDS.rich]))[IDS.rich], 'sent');
    }));

  it('makes no claim for mail older than the 30 days the outbox keeps', () =>
    withWorld(async w => {
      w.clock.advance(KEEP_DONE_MS + 60 * 60_000);
      const result = await notificationsOf(w, [IDS.rich]);
      assert.equal(result[IDS.rich], undefined);
      seedRow(w, IDS.rich, 'posted');
      assert.equal(
        (await notificationsOf(w, [IDS.rich]))[IDS.rich],
        'sent',
        'a kept row still speaks',
      );
    }));
});
