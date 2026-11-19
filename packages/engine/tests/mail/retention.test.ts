import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { storedBody } from '../../src/mail/render';
import { IDS, mailWorld, type World } from './harness';

// What the privacy page says about stored message text (apps/web claims.json `retention-default`): sync keeps only a
// message's subject, sender and Gmail's preview; the full text is stored once the message is opened (or loaded ahead,
// `MessageBody/prefetch`) and is then kept. The engine has no body eviction yet (the `retention` settings are stored
// but nothing acts on them), so this test is the tripwire: when eviction lands it fails, and the site copy and the
// claim must change with it.

const DAY = 24 * 60 * 60_000;

async function withWorld(fn: (w: World) => Promise<void>) {
  const world = await mailWorld();
  try {
    await fn(world);
  } finally {
    await world.cleanup();
  }
}

describe('stored message text (retention-default)', () => {
  it('a synced message has its subject, sender and preview but no text until it is opened', () =>
    withWorld(async w => {
      const ref = w.refOf(IDS.remote);
      assert.equal(storedBody(w.engine.services, ref), undefined, 'sync stores no text');
      const row = w.store.read(q =>
        q.get<{ subject: string; snippet: string }>(
          'SELECT subject, snippet FROM messages WHERE remote_id = ?',
          'r3',
        ),
      );
      assert.deepEqual({ ...row }, { subject: 'Subject t3', snippet: 'Snippet r3' });

      await w.windowA.call('MessageBody/get', { messageId: IDS.remote });
      assert.deepEqual(w.calls.opened, ['acct-1 t3 interactive'], 'opening fetched it from Google');
      assert.ok(storedBody(w.engine.services, ref), 'opening stored the text');
    }));

  it('opened text is kept, whatever the age and the retention settings', () =>
    withWorld(async w => {
      await w.windowA.call('MessageBody/get', { messageId: IDS.remote });
      await w.windowA.call('Settings/set', {
        opId: 'short-retention',
        patch: { retention: { bodyDays: 7, maxBodyBytes: 1 } },
      });
      w.clock.advance(400 * DAY);
      await new Promise(resolve => setImmediate(resolve));

      for (const id of [IDS.rich, IDS.plain, IDS.remote, IDS.other])
        assert.ok(storedBody(w.engine.services, w.refOf(id)), `${id} still has its text`);
      await w.windowA.call('MessageBody/get', { messageId: IDS.remote });
      assert.equal(w.calls.opened.length, 1, 'served from the Mac, not fetched again');
    }));
});
