import test from 'node:test';
import assert from 'node:assert/strict';
import { OVERDUE_GRACE_MS } from '@aplos/contract/rules';
import { gate, inWorld, MIN, SEC, T0 } from './helpers';

const UNCERTAIN = 'We could not confirm this was sent. Check Sent, or Send anyway.';

test('killed between the marker and send: on restart it is uncertain, checked first and never re-sent', () =>
  inWorld(async w => {
    w.draft('d1');
    w.draft('d2');
    // The first send hangs without delivering: the process dies after committing `sending`, before any byte left.
    w.server.script.push({ result: 'hang', delivered: false });
    const lost = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    assert.equal(w.get(lost.id).state, 'sending');
    const other = await w.send(w.first, 'd2');
    w.first.kill();

    // Relaunch two minutes later: a fresh outbox on the same database file.
    await w.clock.advance(2 * MIN);
    const next = w.open();
    assert.equal(w.get(lost.id, next).state, 'uncertain', 'the start rule runs at start()');
    await w.settle();
    // The loop spaces two fires of one source by a second; the account's next send follows its findSent.
    await w.clock.advance(1 * SEC);
    await w.settle();
    const calls = w.server.calls.map(
      c => `${c.op}:${c.internetId === lost.internetId ? 'lost' : 'other'}`,
    );
    assert.deepEqual(
      calls,
      ['send:lost', 'findSent:lost', 'send:other'],
      'findSent before any other send',
    );
    assert.equal(w.get(other.id, next).state, 'sent');
    await w.clock.advance(60 * SEC);
    await w.settle();
    const u = w.get(lost.id, next);
    assert.equal(u.state, 'uncertain');
    assert.equal(u.problem?.message, UNCERTAIN);
    await w.clock.advance(24 * 60 * MIN);
    await w.settle();
    assert.equal(
      w.server.sends().filter(c => c.internetId === lost.internetId).length,
      1,
      'never re-sent',
    );
    assert.equal(
      w.server.deliveries.get(lost.internetId),
      undefined,
      'and never silently lost: the owner is asked',
    );

    await w.act(next, { type: 'sendAnyway', submissionId: lost.id });
    await w.settle();
    await w.clock.advance(1 * SEC);
    await w.settle();
    assert.equal(w.get(lost.id, next).state, 'sent');
    assert.equal(w.server.deliveries.get(lost.internetId), 1);
    assert.equal(w.server.worst(), 1);
  }));

test('killed between send and the sent commit: findSent finds it and it settles sent without a second delivery', () =>
  inWorld(async w => {
    w.draft('d1');
    // Delivered, then the process dies before the `sent` commit.
    w.server.script.push({ result: 'hang', delivered: true });
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).state, 'sending');
    w.first.kill();
    const next = w.open();
    await w.settle();
    const sent = w.get(s.id, next);
    assert.equal(sent.state, 'sent');
    assert.equal(w.raw(s.id)!.mime, null);
    assert.equal(w.server.sends().length, 1);
    assert.equal(w.server.worst(), 1);
  }));

test('a sending row found days late is uncertain, never suspended, however late', () =>
  inWorld(async w => {
    w.draft('d1');
    w.server.script.push({ result: 'hang', delivered: false });
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    w.first.kill();
    await w.clock.set(T0 + 3 * 24 * 60 * MIN);
    const next = w.open();
    await w.settle();
    assert.equal(w.get(s.id, next).state, 'uncertain');
    assert.equal(w.events('outbox.suspended').length, 0);
    assert.ok(T0 + 3 * 24 * 60 * MIN - s.notBefore > OVERDUE_GRACE_MS);
  }));

test('an outbox that never had start() called applies the start rule on its first fire', () =>
  inWorld(async w => {
    w.draft('d1');
    w.server.script.push({ result: 'hang', delivered: true });
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    w.first.kill();
    const next = w.open(false);
    next.loop.start();
    await w.settle();
    assert.equal(w.get(s.id, next).state, 'sent');
    assert.equal(w.server.worst(), 1);
  }));

test('wake applies the start rule to lost rows only, never to a send this instance is still awaiting', () =>
  inWorld(async w => {
    w.draft('d1');
    const g = gate();
    w.server.script.push({ wait: g.wait });
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    assert.equal(w.get(s.id).state, 'sending');
    w.first.outbox.wake();
    await w.clock.flush();
    assert.equal(w.get(s.id).state, 'sending', 'its own in-flight send is not lost');
    g.open();
    await w.settle();
    assert.equal(w.get(s.id).state, 'sent');
    assert.equal(w.server.calls.filter(c => c.op === 'findSent').length, 0);
  }));

test('a quit inside the undo window and a relaunch within the grace sends normally; past it, suspends', () =>
  inWorld(async w => {
    w.draft('d1');
    w.draft('d2');
    const soon = await w.send(w.first, 'd1');
    w.first.kill();
    await w.clock.set(T0 + 3 * MIN);
    const next = w.open();
    await w.settle();
    assert.equal(w.get(soon.id, next).state, 'sent', 'within the grace: sent');
    const late = await w.send(next, 'd2');
    next.kill();
    await w.clock.set(late.notBefore + OVERDUE_GRACE_MS + 1);
    const third = w.open();
    await w.settle();
    assert.equal(w.get(late.id, third).state, 'suspended');
    assert.equal(w.server.sends().length, 1);
  }));

test('killed during findSent itself: the row is still uncertain with its check due, so the next launch checks again', () =>
  inWorld(async w => {
    w.draft('d1');
    const never = gate();
    w.server.script.push({ result: 'lost', delivered: true });
    w.server.holdFindSent(never.wait);
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    assert.equal(w.get(s.id).state, 'uncertain');
    assert.equal(
      w.server.calls.filter(c => c.op === 'findSent').length,
      1,
      'the check started and hung',
    );
    w.first.kill();
    w.server.holdFindSent(undefined);
    const next = w.open();
    await w.settle();
    assert.equal(w.get(s.id, next).state, 'sent');
    assert.equal(w.server.sends().length, 1);
    assert.equal(w.server.worst(), 1);
  }));

test('a wall clock set back before the marker does not push findSent past the message it looks for', () =>
  inWorld(async w => {
    w.draft('d1');
    w.server.script.push({ result: 'hang', delivered: false });
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    const marker = w.get(s.id).attemptAt!;
    w.first.kill();
    await w.clock.set(marker - 60 * MIN);
    w.open();
    await w.settle();
    const check = w.server.calls.find(c => c.op === 'findSent')!;
    assert.ok(check.since! <= marker - 60 * MIN, `since ${check.since} is not after now`);
    assert.equal(w.server.sends().length, 1);
  }));

test('a wall clock set back between the two findSent checks does not postpone the second beyond 60 s (wake and relaunch)', () =>
  inWorld(async w => {
    w.draft('d1');
    w.server.script.push({ result: 'lost', delivered: false });
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    await w.settle();
    assert.equal(
      w.get(s.id).state,
      'uncertain',
      'first check found nothing; the second is due in 60 s',
    );
    assert.equal(w.get(s.id).problem, undefined);

    // Running: the owner sets the clock back an hour, the host reports it as a wake.
    await w.clock.set(w.clock.now() - 60 * MIN);
    w.first.outbox.wake();
    await w.settle();
    await w.clock.advance(61 * SEC);
    await w.settle();
    const asked = w.get(s.id);
    assert.equal(asked.state, 'uncertain');
    assert.equal(
      asked.problem?.reasonCode,
      'send.uncertain',
      'the owner is asked after the second check',
    );
    assert.equal(w.server.calls.filter(c => c.op === 'findSent').length, 2);
    assert.equal(w.server.sends().length, 1);
  }));

test('a launch with sending, uncertain, queued and overdue rows at once settles each by its own rule', () =>
  inWorld(async w => {
    for (const d of ['lost', 'unsure', 'soon', 'late']) w.draft(d);
    w.server.script.push(
      { result: 'lost', delivered: false },
      { result: 'hang', delivered: false },
    );
    const unsure = await w.send(w.first, 'unsure');
    await w.clock.advance(10 * SEC);
    await w.settle();
    await w.clock.advance(60 * SEC);
    await w.settle();
    const lost = await w.send(w.first, 'lost');
    await w.clock.advance(10 * SEC);
    await w.settle();
    const late = await w.send(w.first, 'late', { notBefore: T0 + 20 * MIN });
    const soon = await w.send(w.first, 'soon', { notBefore: T0 + 30 * MIN });
    w.first.kill();
    await w.clock.set(soon.notBefore + 1 * MIN);
    const next = w.open();
    await w.settle();
    await w.clock.advance(5 * SEC);
    await w.settle();
    assert.equal(w.get(lost.id, next).state, 'uncertain');
    assert.equal(w.get(unsure.id, next).state, 'uncertain');
    assert.equal(w.get(late.id, next).state, 'suspended');
    assert.equal(w.get(soon.id, next).state, 'sent', 'inside the grace');
    assert.equal(w.server.worst(), 1);
    const order = w.server.calls.map(
      c => c.op + ':' + (c.internetId === soon.internetId ? 'soon' : 'x'),
    );
    assert.ok(
      order.indexOf('findSent:x') < order.indexOf('send:soon'),
      'findSent before the account sends again',
    );
  }));

test('a fire re-run while a send is in flight (loop wake, an abandoned fire, minutes later) never sends it again', () =>
  inWorld(async w => {
    w.draft('d1');
    const g = gate();
    w.server.script.push({ wait: g.wait });
    const s = await w.send(w.first, 'd1');
    await w.clock.advance(10 * SEC);
    assert.equal(w.get(s.id).state, 'sending');
    for (let i = 0; i < 3; i++) {
      w.first.loop.wake();
      await w.clock.advance(2 * MIN);
      await w.settle();
    }
    assert.equal(w.get(s.id).state, 'sending', 'in flight is neither suspended nor lost');
    assert.equal(w.server.sends().length, 1);
    g.open();
    await w.settle();
    assert.equal(w.get(s.id).state, 'sent');
    assert.equal(w.server.worst(), 1);
  }));
