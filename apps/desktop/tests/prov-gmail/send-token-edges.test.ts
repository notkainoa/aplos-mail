/**
 * More edges of the Gmail send token (#226 follow-ups): the exact-token rule against near misses, the SENT rule on the
 * SENT-label listing path, and the 35 MiB boundary on the allowed side. The emulator's `sendIdentity: 'rewritten'` models
 * the live result (Gmail replaces the Message-ID and keeps the custom header).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { NotSentError } from '@aplos/engine/ports';
import { MAX_SEND_BYTES, withSendToken } from '../../src/host/providers/google/send';
import { ACCOUNT, sendWorld, submission, withMime, type SendWorld } from './send-rig';

const since = (world: SendWorld) => world.clock.now() - 60_000;

async function rewritingWorld(): Promise<SendWorld> {
  const world = await sendWorld();
  world.emu.settings.sendIdentity = 'rewritten';
  return world;
}

/** A message from the owner carrying `token` as its `X-Aplos-Send`, in `labelIds`. */
function addTokened(world: SendWorld, token: string, labelIds: string[]) {
  return world.emu.mailbox.addMessage({
    from: world.address,
    to: ['friend@example.test'],
    labelIds,
    headers: { 'X-Aplos-Send': token },
  });
}

const bareOf = (id: string) => id.replace(/^<|>$/g, '');

test('findSent: the match is the exact token, never a prefix, a suffix or a substring of it', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world);
  const mine = pinned.payload.internetId;
  const [local, domain] = bareOf(mine).split('@');
  const nearMisses = [
    // Well-formed tokens of OTHER submissions: mine is a prefix of one, one a prefix of mine, mine inside one.
    `<${bareOf(mine)}.evil>`,
    `<${local}@${domain.replace('.test', '')}>`,
    `<x-${bareOf(mine)}>`,
    `<${local}-2@${domain}>`,
    // Values that merely start with, or contain, mine but are not one well-formed token.
    `${mine} and more`,
    `junk ${mine}`,
    `${mine}${mine}`,
  ];
  for (const token of nearMisses) addTokened(world, token, ['SENT']);
  const missed = await world.port.findSent(ACCOUNT, mine, since(world));
  assert.equal(missed.kind, 'absent', 'a near miss was taken for our copy');
  // The control: the exact token (padding and case aside), among the same near misses, is found and is the one named.
  const exact = addTokened(world, ` ${mine.toUpperCase()} `, ['SENT']);
  const found = await world.port.findSent(ACCOUNT, mine, since(world));
  assert.equal(found.kind, 'found');
  assert.equal(found.kind === 'found' && found.remoteMessageId, exact.id);
});

test('findSent: a kept Message-ID that merely extends or truncates ours is never a match', async () => {
  const world = await sendWorld();
  const pinned = submission(world);
  const bare = bareOf(pinned.payload.internetId);
  for (const messageId of [`${bare}.evil`, bare.replace('.test', ''), `x-${bare}`])
    world.emu.mailbox.addMessage({
      from: world.address,
      to: ['friend@example.test'],
      messageId,
      labelIds: ['SENT'],
    });
  const missed = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.equal(missed.kind, 'absent');
  const exact = world.emu.mailbox.addMessage({
    from: world.address,
    to: ['friend@example.test'],
    messageId: bare,
    labelIds: ['SENT'],
  });
  const found = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.equal(found.kind === 'found' && found.remoteMessageId, exact.id);
});

test('findSent: our token on an Inbox copy is never found through the SENT-label listing either', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world);
  const token = pinned.payload.internetId;
  addTokened(world, token, ['INBOX']);
  // The newest-SENT listing path (no search): a listing that names the Inbox copy; the labels on the read must refuse it.
  world.bridge.rewriteQuery = () => 'in:inbox';
  world.bridge.listLabel = 'INBOX';
  assert.equal((await world.port.findSent(ACCOUNT, token, since(world))).kind, 'absent');
  // The control: the same token WITH the SENT label is found (only the label differs).
  world.bridge.rewriteQuery = undefined;
  world.bridge.listLabel = undefined;
  const sent = addTokened(world, token, ['SENT']);
  const found = await world.port.findSent(ACCOUNT, token, since(world));
  assert.equal(found.kind === 'found' && found.remoteMessageId, sent.id);
});

test('findSent: an Inbox copy that kept our Message-ID (no token) is never found when the search lets it through', async () => {
  const world = await sendWorld();
  const pinned = submission(world);
  world.emu.mailbox.addMessage({
    from: 'someone@example.test',
    to: [world.address],
    messageId: bareOf(pinned.payload.internetId),
    labelIds: ['INBOX'],
  });
  world.bridge.rewriteQuery = q => q.replace(' in:sent -in:drafts', ' in:inbox');
  const result = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.equal(result.kind, 'absent');
});

test('send token: a MIME exactly at the 35 MiB limit minus the token header goes; one byte more is refused before any request', async () => {
  const world = await rewritingWorld();
  const probe = submission(world);
  const tokenLength =
    withSendToken(probe.mime, probe.payload.internetId).length - probe.mime.length;
  assert.ok(tokenLength > 20, 'the token header has a length');
  const padded = (w: SendWorld, length: number) => {
    const pinned = submission(w);
    return {
      pinned,
      mime: Buffer.concat([pinned.mime, Buffer.alloc(length - pinned.mime.length, 0x41)]),
    };
  };

  const fits = padded(world, MAX_SEND_BYTES - tokenLength);
  await world.adapter.send(withMime(fits.pinned, fits.mime), world.ctx());
  assert.equal(
    world.bridge.uploads[0].raw.length,
    MAX_SEND_BYTES,
    'the upload is exactly the limit',
  );
  assert.equal(world.sentMessages().length, 1);

  const over = await rewritingWorld();
  const tooBig = padded(over, MAX_SEND_BYTES - tokenLength + 1);
  const error = await over.adapter
    .send(withMime(tooBig.pinned, tooBig.mime), over.ctx())
    .catch((e: unknown) => e);
  assert.ok(error instanceof NotSentError, `got ${String(error)}`);
  assert.equal(error.error.reason, 'messageTooLarge');
  assert.equal(over.gmailRequests(), 0);
  assert.equal(over.bridge.uploads.length, 0);
});
