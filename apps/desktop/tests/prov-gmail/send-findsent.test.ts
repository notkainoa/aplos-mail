/**
 * `findSent` on the Gmail emulator past the plain search: a second page, a miss then a hit, and the recent-SENT
 * fallback for a just-sent message the search index has not caught up with (found, never a DRAFT, bounded, and
 * thrown rather than "absent" when the fallback itself fails).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { RECENT_SENT } from '../../src/host/providers/google/send';
import { ACCOUNT, classOf, sendWorld, submission, type SendWorld } from './send-rig';

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected findSent to reject');
}

const since = (world: SendWorld) => world.clock.now() - 5 * 60_000;

test('findSent: more hits than one page, none of them this mail, is thrown (sentSearchPartial), never "absent"', async () => {
  const world = await sendWorld();
  for (let i = 0; i < 11; i++)
    world.emu.mailbox.addMessage({
      from: world.address,
      to: ['friend@example.test'],
      messageId: `other-${i}@mail.example.test`,
      labelIds: ['SENT'],
    });
  // A search that matched too much: the first page holds no copy, and a second page exists.
  world.bridge.rewriteQuery = q => q.replace(/^rfc822msgid:\S+ /, '');
  const error = await rejection(
    world.port.findSent(ACCOUNT, '<x-5@mail.example.test>', since(world)),
  );
  assert.equal(classOf(error)?.reason, 'sentSearchPartial');
});

test('findSent: absent at the first check, found at the re-check once the copy shows up', async () => {
  const world = await sendWorld();
  const id = '<x-6@mail.example.test>';
  const first = await world.port.findSent(ACCOUNT, id, since(world));
  assert.equal(first.kind, 'absent');
  await world.clock.advance(60_000);
  const m = world.emu.mailbox.addMessage({
    from: world.address,
    to: ['friend@example.test'],
    messageId: 'x-6@mail.example.test',
    labelIds: ['SENT'],
  });
  const second = await world.port.findSent(ACCOUNT, id, since(world));
  assert.deepEqual(second, { kind: 'found', remoteMessageId: m.id, remoteThreadId: m.threadId });
});

/** The search index has not caught up with a send yet: `rfc822msgid:` finds nothing. */
const lagging = (world: SendWorld) => {
  world.bridge.rewriteQuery = q => q.replace('rfc822msgid:', 'rfc822msgid:not-indexed-yet.');
};

test('findSent: a just-sent message the search does not see yet is found among the newest SENT', async () => {
  const world = await sendWorld();
  const pinned = submission(world);
  const at = since(world);
  await world.adapter.send(pinned.payload, world.ctx());
  lagging(world);
  const [sent] = world.sentMessages();
  const result = await world.port.findSent(ACCOUNT, pinned.payload.internetId, at);
  assert.deepEqual(result, {
    kind: 'found',
    remoteMessageId: sent.id,
    remoteThreadId: sent.threadId,
  });
});

test('findSent fallback: a DRAFT carrying the Message-ID, even labelled SENT, is never found', async () => {
  const world = await sendWorld();
  world.emu.mailbox.addMessage({
    from: world.address,
    to: ['friend@example.test'],
    messageId: 'x-7@mail.example.test',
    labelIds: ['SENT', 'DRAFT'],
  });
  lagging(world);
  const result = await world.port.findSent(ACCOUNT, '<x-7@mail.example.test>', since(world));
  assert.equal(result.kind, 'absent');
});

test('findSent fallback: bounded to the newest few SENT, and stops at the first one older than since', async () => {
  const world = await sendWorld();
  const old = world.clock.now() - 86_400_000;
  world.emu.mailbox.addMessage({
    from: world.address,
    to: ['friend@example.test'],
    messageId: 'x-8@mail.example.test',
    labelIds: ['SENT'],
    internalDate: old,
  });
  for (let i = 0; i < RECENT_SENT + 2; i++)
    world.emu.mailbox.addMessage({
      from: world.address,
      to: ['friend@example.test'],
      messageId: `newer-${i}@mail.example.test`,
      labelIds: ['SENT'],
      internalDate: old + 1_000 * (i + 1),
    });
  lagging(world);
  const gets = () => world.emu.log.filter(e => e.apiMethod === 'gmail.users.messages.get').length;
  // Since now: the newest SENT are a day old, so the first one read ends the fallback.
  const recent = await world.port.findSent(ACCOUNT, '<x-8@mail.example.test>', world.clock.now());
  assert.equal(recent.kind, 'absent');
  assert.equal(gets(), 1);
  // Since a day back: all are recent enough, but only the newest RECENT_SENT are read, and the copy is not among them.
  const wide = await world.port.findSent(ACCOUNT, '<x-8@mail.example.test>', old - 60_000);
  assert.equal(wide.kind, 'absent');
  assert.equal(gets(), 1 + RECENT_SENT);
});

test('findSent fallback: a listing that fails is thrown, never "absent"', async () => {
  const world = await sendWorld();
  lagging(world);
  world.bridge.failSentListing = true;
  await assert.rejects(world.port.findSent(ACCOUNT, '<x-9@mail.example.test>', since(world)));
});

test('findSent fallback: a candidate that vanished before it was read is thrown, never "absent"', async () => {
  const world = await sendWorld();
  world.emu.mailbox.addMessage({
    from: world.address,
    to: ['friend@example.test'],
    messageId: 'x-10@mail.example.test',
    labelIds: ['SENT'],
  });
  lagging(world);
  world.faults.failNext(
    { apiMethod: 'gmail.users.messages.get' },
    { status: 404, reason: 'notFound' },
  );
  const error = await rejection(
    world.port.findSent(ACCOUNT, '<x-10@mail.example.test>', since(world)),
  );
  assert.equal(classOf(error)?.reason, 'sentHitVanished');
});
