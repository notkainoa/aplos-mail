/**
 * prov-gmail `X-Aplos-Send`: Gmail replaces the Message-ID of a message it sends (live finding 2026-11-05) but keeps a
 * custom header, so `findSent` recovers an uncertain send by the token the adapter wrote (plans/providers/findsent-token.md).
 * The emulator's `sendIdentity: 'rewritten'` models the live result (set on the world's live settings).
 *
 * Rules: the token is the submission's own Message-ID value, written once as the first header of what goes on the wire;
 * the engine's pinned bytes are untouched and still REFUSE the header; a copy is ours only with the SENT label, no DRAFT
 * label and OUR token (or, where Gmail kept it, our Message-ID); a copy under another token, or none, is never found.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { FIND_SENT_RETRY, withSendToken } from '../../src/host/providers/google/send';
import { ACCOUNT, classOf, sendWorld, submission, type SendWorld } from './send-rig';

const since = (world: SendWorld) => world.clock.now() - 60_000;

async function rewritingWorld(): Promise<SendWorld> {
  const world = await sendWorld();
  world.emu.settings.sendIdentity = 'rewritten';
  return world;
}

const headerLines = (raw: Buffer): string[] =>
  raw
    .subarray(0, raw.indexOf('\r\n\r\n'))
    .toString('latin1')
    .replace(/\r\n[ \t]+/g, ' ')
    .split('\r\n');

test('send token: the upload carries exactly one X-Aplos-Send, the first header, equal to the submission Message-ID; the pinned bytes follow unchanged', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world);
  await world.adapter.send(pinned.payload, world.ctx());
  const raw = world.bridge.uploads[0].raw;
  const lines = headerLines(raw);
  assert.equal(lines[0], `X-Aplos-Send: ${pinned.payload.internetId}`);
  assert.equal(lines.filter(l => /^x-aplos-send:/i.test(l)).length, 1);
  assert.ok(
    raw.subarray(raw.indexOf('\r\n') + 2).equals(pinned.mime),
    'the rest is the pinned bytes',
  );
  const [sent] = world.sentMessages();
  assert.notEqual(
    headerLines(sent.raw).find(l => /^message-id:/i.test(l)),
    `Message-ID: ${pinned.payload.internetId}`,
    'the emulator replaced the Message-ID like Gmail',
  );
});

test('send token: a token that is not well-formed is not written', () => {
  const raw = Buffer.from('Subject: x\r\n\r\nbody');
  assert.equal(withSendToken(raw, 'no-brackets@mail.example.test'), raw);
  assert.equal(withSendToken(raw, '<a b@mail.example.test>'), raw);
});

test('findSent (rewritten Message-ID): the sent copy is found by its token, though our Message-ID finds nothing', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world);
  await world.adapter.send(pinned.payload, world.ctx());
  const [sent] = world.sentMessages();
  const result = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.deepEqual(result, {
    kind: 'found',
    remoteMessageId: sent.id,
    remoteThreadId: sent.threadId,
  });
});

test('findSent: a sent message without our token (a rewritten id, no header) is never found', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world);
  // Sent by another path: the same bytes, no token. Gmail gave it its own Message-ID.
  world.emu.mailbox.sendRaw(pinned.mime);
  const result = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.equal(result.kind, 'absent');
});

test("findSent: another submission's token is never ours", async () => {
  const world = await rewritingWorld();
  const mine = submission(world);
  const other = submission(world);
  assert.notEqual(mine.payload.internetId, other.payload.internetId);
  await world.adapter.send(other.payload, world.ctx());
  const result = await world.port.findSent(ACCOUNT, mine.payload.internetId, since(world));
  assert.equal(result.kind, 'absent');
});

test('findSent: our token on a DRAFT, or on a message without the SENT label, is never found', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world);
  const token = pinned.payload.internetId;
  world.emu.mailbox.addMessage({
    from: world.address,
    to: ['friend@example.test'],
    labelIds: ['SENT', 'DRAFT'],
    headers: { 'X-Aplos-Send': token },
  });
  world.emu.mailbox.addMessage({
    from: 'someone@example.test',
    to: [world.address],
    labelIds: ['INBOX'],
    headers: { 'X-Aplos-Send': token },
  });
  const result = await world.port.findSent(ACCOUNT, token, since(world));
  assert.equal(result.kind, 'absent');
});

test('findSent: a message carrying our token twice (not one value) is not a match', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world);
  const raw = Buffer.from(
    [
      `From: ${world.address}`,
      'To: friend@example.test',
      'Subject: twice',
      `X-Aplos-Send: ${pinned.payload.internetId}`,
      `X-Aplos-Send: ${pinned.payload.internetId}`,
      '',
      'body',
    ].join('\r\n'),
  );
  world.emu.mailbox.insertRaw(raw, ['SENT'], undefined, 'receivedTime');
  const result = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.equal(result.kind, 'absent');
});

// ---- the look-again bound ----

test('findSent: a copy that only shows on the third look is found; the waits are the bound, not more', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world);
  const start = world.clock.now();
  const attempt = world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  // The copy appears between the first and second look (the index lags a send by seconds).
  const appears = world.clock
    .sleep(FIND_SENT_RETRY.waitMs + 500)
    .then(() => world.adapter.send(pinned.payload, world.ctx()));
  const [result] = await Promise.all([attempt, appears]);
  assert.equal(result.kind, 'found');
  assert.ok(world.clock.now() - start <= FIND_SENT_RETRY.looks * FIND_SENT_RETRY.waitMs + 60_000);
});

test('findSent: a copy that never shows is absent after the looks, each wait the configured one', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world);
  const jumps = world.clock.jumps.length;
  const result = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.equal(result.kind, 'absent');
  const waited = world.clock.jumps.slice(jumps).reduce((sum, j) => sum + (j.to - j.from), 0);
  assert.ok(waited >= FIND_SENT_RETRY.looks * FIND_SENT_RETRY.waitMs, `waited ${waited} ms`);
  assert.ok(waited < FIND_SENT_RETRY.looks * FIND_SENT_RETRY.waitMs + 10_000);
});

test('findSent: an old attempt (the lag is long over) answers after one pass, no waiting', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world);
  const jumps = world.clock.jumps.length;
  const old = world.clock.now() - 2 * FIND_SENT_RETRY.recentMs;
  const result = await world.port.findSent(ACCOUNT, pinned.payload.internetId, old);
  assert.equal(result.kind, 'absent');
  const waited = world.clock.jumps.slice(jumps).reduce((sum, j) => sum + (j.to - j.from), 0);
  assert.ok(waited < FIND_SENT_RETRY.waitMs, 'no look-again wait');
});

test('findSent: an error in a look is thrown at once, not retried', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world);
  world.faults.failNext(
    { apiMethod: 'gmail.users.messages.list' },
    { status: 500, reason: 'backendError', message: 'Backend Error' },
    { times: 50 },
  );
  const before = world.gmailRequests();
  const error = await world.port
    .findSent(ACCOUNT, pinned.payload.internetId, since(world))
    .catch((e: unknown) => e);
  assert.ok(error instanceof Error);
  assert.ok(classOf(error), 'a classified provider error');
  assert.ok(world.gmailRequests() - before <= 6, 'not repeated for each look');
});
