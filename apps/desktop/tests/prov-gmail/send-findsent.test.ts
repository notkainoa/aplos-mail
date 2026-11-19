/**
 * `findSent` on the Gmail emulator past the plain search: a second page, a miss then a hit, and the recent-SENT
 * fallback for a just-sent message the search index has not caught up with (found, never a DRAFT, "absent" only for a
 * listing that is provably complete, and thrown when the listing is partial or the fallback itself fails).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { RECENT_EXTRA_PAGES, RECENT_SENT } from '../../src/host/providers/google/send';
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

function addSent(world: SendWorld, messageId: string, internalDate?: number) {
  return world.emu.mailbox.addMessage({
    from: world.address,
    to: ['friend@example.test'],
    messageId: `${messageId}@mail.example.test`,
    labelIds: ['SENT'],
    ...(internalDate === undefined ? {} : { internalDate }),
  });
}

/** `count` newer sends after the copy's own, each a second apart inside the window. */
function addNewer(world: SendWorld, count: number, from: number): void {
  for (let i = 0; i < count; i++) addSent(world, `newer-${i}`, from + 1_000 * (i + 1));
}

const gets = (world: SendWorld) =>
  world.emu.log.filter(e => e.apiMethod === 'gmail.users.messages.get').length;

test('findSent fallback: the copy, 8th newest among recent sends, is found', async () => {
  const world = await sendWorld();
  const at = world.clock.now();
  const copy = addSent(world, 'x-8', at);
  addNewer(world, 7, at);
  lagging(world);
  const result = await world.port.findSent(ACCOUNT, '<x-8@mail.example.test>', at - 60_000);
  assert.deepEqual(result, {
    kind: 'found',
    remoteMessageId: copy.id,
    remoteThreadId: copy.threadId,
  });
});

test('findSent fallback: more newer sends than the pages cap reads hide the copy, so it is thrown (sentListingPartial), never "absent"', async () => {
  const world = await sendWorld();
  const at = world.clock.now();
  const pages = (RECENT_EXTRA_PAGES + 1) * RECENT_SENT;
  addSent(world, 'x-12', at);
  addNewer(world, pages + 2, at);
  lagging(world);
  const error = await rejection(
    world.port.findSent(ACCOUNT, '<x-12@mail.example.test>', at - 60_000),
  );
  assert.equal(classOf(error)?.reason, 'sentListingPartial');
  assert.equal(gets(world), pages);
});

test('findSent fallback: 12 newer sends push the copy onto the second page, where it is found', async () => {
  const world = await sendWorld();
  const at = world.clock.now();
  const copy = addSent(world, 'x-12b', at);
  addNewer(world, 12, at);
  lagging(world);
  const result = await world.port.findSent(ACCOUNT, '<x-12b@mail.example.test>', at - 60_000);
  assert.deepEqual(result, {
    kind: 'found',
    remoteMessageId: copy.id,
    remoteThreadId: copy.threadId,
  });
});

test('findSent fallback: a full first page, then a page reaching an older candidate, is complete, so absent', async () => {
  const world = await sendWorld();
  const at = world.clock.now();
  addNewer(world, RECENT_SENT + 2, at);
  addNewer(world, 3, at - 86_400_000);
  lagging(world);
  const result = await world.port.findSent(ACCOUNT, '<x-16@mail.example.test>', at - 60_000);
  assert.equal(result.kind, 'absent');
  assert.equal(gets(world), RECENT_SENT + 5);
});

test('findSent fallback: the copy dated a day before since, among the newest 10, is found (the date never discards a copy)', async () => {
  const world = await sendWorld();
  const at = world.clock.now();
  const copy = addSent(world, 'x-17', at - 86_400_000);
  addNewer(world, 3, at);
  lagging(world);
  const result = await world.port.findSent(ACCOUNT, '<x-17@mail.example.test>', at);
  assert.deepEqual(result, {
    kind: 'found',
    remoteMessageId: copy.id,
    remoteThreadId: copy.threadId,
  });
});

test('findSent fallback: a short listing, none of it this mail, is complete, so absent', async () => {
  const world = await sendWorld();
  const at = world.clock.now();
  addNewer(world, 3, at);
  lagging(world);
  const result = await world.port.findSent(ACCOUNT, '<x-13@mail.example.test>', at - 60_000);
  assert.equal(result.kind, 'absent');
  assert.equal(gets(world), 3);
});

test('findSent fallback: a full listing that reaches a candidate older than the window is complete, so absent', async () => {
  const world = await sendWorld();
  const at = world.clock.now();
  addNewer(world, RECENT_SENT - 1, at);
  addSent(world, 'old-copy', at - 86_400_000);
  lagging(world);
  const result = await world.port.findSent(ACCOUNT, '<x-14@mail.example.test>', at - 60_000);
  assert.equal(result.kind, 'absent');
  assert.equal(gets(world), RECENT_SENT);
});

test('findSent fallback: the first older candidate does not end the read (no reliance on order or the clock)', async () => {
  const world = await sendWorld();
  const at = world.clock.now();
  addNewer(world, 2, at);
  addNewer(world, 12, at - 86_400_000);
  lagging(world);
  const result = await world.port.findSent(ACCOUNT, '<x-15@mail.example.test>', at - 60_000);
  assert.equal(result.kind, 'absent');
  assert.equal(gets(world), RECENT_SENT);
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
