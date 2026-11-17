import assert from 'node:assert/strict';
import test from 'node:test';
import { inWorld, MIN, SEC, T0 } from './helpers';

/**
 * The Undo-send window is read exactly once, when a send is queued: `prepareSend` asks `OutboxDeps.settings` for
 * `undoSendSeconds` and stamps the deadline on the submission row (`not_before`). The runner only ever reads the row,
 * so a setting change applies to the next send, never to one already waiting, and a restart keeps the stored
 * deadline. The world's `settings` stub stands in for `storedUndoSeconds` on the live engine.
 */

test('a zero window is due at once: the deadline is now and one runner tick sends it once', () =>
  inWorld(
    async w => {
      w.draft('d1');
      const { submission: s, receipt } = await w.act(w.first, {
        type: 'send',
        draftId: 'd1',
        revision: 1,
      });
      assert.equal(s.state, 'queued');
      assert.equal(s.notBefore, T0, 'a zero window leaves no countdown');
      assert.equal(receipt.undoUntil, T0);
      const outbox = w.first.sources.get('outbox')!;
      assert.equal(await outbox.next(), T0, 'the deadline the row carries is now');
      await outbox.fire(w.clock.now());
      await w.settle();
      assert.equal(w.server.sends().length, 1, 'one tick, one send call');
      const sent = w.get(s.id);
      assert.equal(sent.state, 'sent');
      assert.equal(sent.sentAt, T0);
      assert.equal(w.server.worst(), 1);
    },
    { settings: () => ({ undoSendSeconds: 0 }) },
  ));

test('the window is taken at queue time: a settings change applies to the next send, not a waiting one', () => {
  let seconds = 20;
  return inWorld(
    async w => {
      w.draft('d1');
      w.draft('d2');
      const a = await w.send(w.first, 'd1');
      assert.equal(a.notBefore, T0 + 20 * SEC, 'queued under the 20 s window');
      seconds = 5;
      await w.clock.advance(1 * SEC);
      const t1 = w.clock.now();
      const b = await w.send(w.first, 'd2');
      assert.equal(b.notBefore, t1 + 5 * SEC, 'queued under the 5 s window');
      await w.clock.advance(t1 + 5 * SEC - w.clock.now());
      await w.settle();
      assert.equal(w.get(b.id).state, 'sent', 'B reached its deadline');
      assert.equal(w.get(a.id).state, 'queued', 'A still waits on the window it queued with');
      assert.deepEqual(
        w.server.sends().map(c => c.internetId),
        [b.internetId],
      );
      await w.clock.advance(T0 + 20 * SEC - w.clock.now());
      await w.settle();
      assert.equal(w.get(a.id).state, 'sent', 'A goes out at its stored deadline');
      assert.equal(w.server.worst(), 1);
    },
    { settings: () => ({ undoSendSeconds: seconds }) },
  );
});

test('a restart does not re-read the window: the deadline stays the one the row stored', () => {
  let seconds = 20;
  return inWorld(
    async w => {
      w.draft('d1');
      const s = await w.send(w.first, 'd1');
      assert.equal(s.notBefore, T0 + 20 * SEC);
      w.first.kill();
      seconds = 0;
      const next = w.open();
      await w.settle();
      assert.equal(w.get(s.id, next).state, 'queued');
      assert.equal(
        await next.sources.get('outbox')!.next(),
        T0 + 20 * SEC,
        'the deadline is the one the row stored, not the new setting',
      );
      await w.clock.advance(19 * SEC);
      await w.settle();
      assert.equal(w.server.sends().length, 0, 'nothing leaves before the stored deadline');
      await w.clock.advance(1 * SEC);
      await w.settle();
      assert.equal(w.get(s.id, next).state, 'sent', 'it leaves at the stored deadline');
      assert.equal(w.server.worst(), 1);
    },
    { settings: () => ({ undoSendSeconds: seconds }) },
  );
});

test('the settings are asked once per send: runner ticks and a restart never re-read them', () => {
  let reads = 0;
  return inWorld(
    async w => {
      w.draft('d1');
      const s = await w.send(w.first, 'd1');
      assert.equal(reads, 1, 'read once, when the send was queued');
      const outbox = w.first.sources.get('outbox')!;
      for (const at of [T0 + 1 * SEC, T0 + 10 * SEC, T0 + 19 * SEC]) {
        await w.clock.set(at);
        await outbox.fire(w.clock.now());
        await w.settle();
        assert.equal(w.get(s.id).state, 'queued');
      }
      assert.equal(reads, 1, 'runner ticks never re-read it');
      w.first.kill();
      const next = w.open();
      await w.settle();
      assert.equal(reads, 1, 'the restart never re-reads it');
      await w.clock.advance(1 * SEC);
      await w.settle();
      assert.equal(w.get(s.id, next).state, 'sent');
      assert.equal(reads, 1);
      assert.equal(w.server.worst(), 1);
    },
    {
      settings: () => {
        reads++;
        return { undoSendSeconds: 20 };
      },
    },
  );
});

test('send later with a zero window still schedules at the chosen time', () =>
  inWorld(
    async w => {
      w.draft('d1');
      const s = await w.send(w.first, 'd1', { notBefore: T0 + MIN });
      assert.equal(s.state, 'scheduled');
      assert.equal(s.notBefore, T0 + MIN);
      await w.settle();
      assert.equal(w.server.sends().length, 0, 'scheduled, not queued: nothing leaves now');
    },
    { settings: () => ({ undoSendSeconds: 0 }) },
  ));
