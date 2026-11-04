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
import {
  isSentCopy,
  MAX_SEND_BYTES,
  withSendToken,
  type Candidate,
} from '../../src/host/providers/google/send';
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

// ---- one pass: the engine's own re-check after 60 s covers the index lag ----

test('findSent: a copy the index shows only later is absent now and found by the next ask (the engine asks again after 60 s)', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world);
  const first = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.equal(first.kind, 'absent');
  await world.adapter.send(pinned.payload, world.ctx());
  await world.clock.advance(60_000);
  const second = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.equal(second.kind, 'found');
});

test('findSent: one pass, no waiting inside the call (it never sleeps)', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world);
  const start = world.clock.now();
  const result = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.equal(result.kind, 'absent');
  assert.ok(
    world.clock.now() - start < 3_000,
    `the call moved the clock by ${world.clock.now() - start} ms`,
  );
});

test('findSent: an error in the pass is thrown, never absent', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world);
  world.faults.failNext(
    { apiMethod: 'gmail.users.messages.list' },
    { status: 500, reason: 'backendError', message: 'Backend Error' },
    { times: 50 },
  );
  const error = await world.port
    .findSent(ACCOUNT, pinned.payload.internetId, since(world))
    .catch((e: unknown) => e);
  assert.ok(error instanceof Error);
  assert.ok(classOf(error), 'a classified provider error');
});

// ---- the two tests that were too weak, and the size after the token ----

test('findSent: our token on a message WITHOUT the SENT label is never a copy, even when the search lists it', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world);
  const token = pinned.payload.internetId;
  world.emu.mailbox.addMessage({
    from: 'someone@example.test',
    to: [world.address],
    labelIds: ['INBOX'],
    headers: { 'X-Aplos-Send': token },
  });
  // The search is widened to every message, so the INBOX message IS a candidate; only the label rule can refuse it.
  world.bridge.rewriteQuery = q =>
    q.replace(/rfc822msgid:\S+/, '').replace(/in:sent|-in:drafts/g, '');
  const result = await world.port.findSent(ACCOUNT, token, since(world));
  assert.equal(result.kind, 'absent');
  // The same rule, directly: SENT required, DRAFT refused, for the token and for the Message-ID.
  const headers = (name: string, value: string) => ({ payload: { headers: [{ name, value }] } });
  const withLabels = (labelIds: string[], name: string): Candidate => ({
    labelIds,
    ...headers(name, token),
  });
  for (const name of ['X-Aplos-Send', 'Message-ID']) {
    assert.equal(isSentCopy(withLabels(['SENT'], name), token), true, `${name} with SENT`);
    assert.equal(isSentCopy(withLabels(['INBOX'], name), token), false, `${name} without SENT`);
    assert.equal(isSentCopy(withLabels([], name), token), false, `${name} with no labels`);
    assert.equal(
      isSentCopy(withLabels(['SENT', 'DRAFT'], name), token),
      false,
      `${name} on a DRAFT`,
    );
  }
});

test('findSent: a token that only shares a prefix or differs only in the domain is not ours', async () => {
  const world = await rewritingWorld();
  const ours = '<aaaaaa1111bbbb@mail.example.test>';
  const pinned = submission(world, { messageId: ours });
  for (const near of [
    '<aaaaaa2222bbbb@mail.example.test>', // the same first characters
    '<aaaaaa1111bbbb@other.example.test>', // the same local part, another domain
    '<aaaaaa1111bbb@mail.example.test>', // one character short
    '<aaaaaa1111bbbbb@mail.example.test>', // one character long
  ]) {
    world.emu.mailbox.addMessage({
      from: world.address,
      to: ['friend@example.test'],
      labelIds: ['SENT'],
      headers: { 'X-Aplos-Send': near },
    });
  }
  const result = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.equal(result.kind, 'absent');
  // And the exact token, in the same mailbox, is found (the case and the brackets are not part of identity).
  const mine = world.emu.mailbox.addMessage({
    from: world.address,
    to: ['friend@example.test'],
    labelIds: ['SENT'],
    headers: { 'X-Aplos-Send': ours.toUpperCase() },
  });
  const found = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.deepEqual(found, {
    kind: 'found',
    remoteMessageId: mine.id,
    remoteThreadId: mine.threadId,
  });
});

test('send token: the 35 MiB limit holds for what goes up, token included', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world);
  // A message that fits the limit by itself and not with the token line added.
  const padded = Buffer.concat([
    pinned.mime,
    Buffer.alloc(MAX_SEND_BYTES - pinned.mime.length, 0x61),
  ]);
  assert.equal(padded.length, MAX_SEND_BYTES);
  const error = await world.adapter
    .send({ ...pinned.payload, mime: padded }, world.ctx())
    .catch((e: unknown) => e);
  assert.equal(classOf(error)?.reason, 'messageTooLarge');
  assert.equal(world.sendRequests(), 0, 'nothing was sent');
});

// ---- edges: a token only from a well-formed id, a candidate only inside the window ----

test('send token: an id that is not a plain <local@domain> never becomes a header (no CR/LF injection, no stray bytes)', () => {
  const raw = Buffer.from('Subject: x\r\n\r\nbody');
  for (const id of [
    '<a@mail.example.test>\r\nBcc: evil@attacker.example',
    '<a@mail.example.test>\nBcc: evil@attacker.example',
    '<a@mail.example.test>\n',
    '<a@mail.example.test>\r\n',
    '\r\n<a@mail.example.test>',
    '<a b@mail.example.test>',
    '<a\t@mail.example.test>',
    '<a\0@mail.example.test>',
    '<a"@mail.example.test>',
    '<a<b@mail.example.test>',
    '<a>b@mail.example.test>',
    '<@mail.example.test>',
    '<a@>',
    '<a>',
    'a@mail.example.test',
    '',
    `<${'a'.repeat(257)}@mail.example.test>`,
    '<\u00e9@mail.example.test>',
    '<a@m\u00e4il.example.test>',
  ]) {
    assert.equal(withSendToken(raw, id), raw, `no token for ${JSON.stringify(id)}`);
  }
  // The id the outbox really makes (32 hex) and a shorter well-formed one both get exactly one header line.
  for (const id of [`<${'ab'.repeat(16)}@mail.example.test>`, '<Short.id-1@mail.example.test>']) {
    const out = Buffer.from(withSendToken(raw, id)).toString('latin1');
    assert.equal(out, `X-Aplos-Send: ${id}\r\n${raw.toString('latin1')}`);
  }
});

test('send token: a payload whose internetId carries a CR/LF is refused before anything is sent, never written as a header', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world);
  const evil = '<a@mail.example.test>\r\nBcc: evil@attacker.example';
  const error = await world.adapter
    .send({ ...pinned.payload, internetId: evil }, world.ctx())
    .catch((e: unknown) => e);
  assert.ok(error instanceof Error);
  assert.equal(world.sendRequests(), 0, 'no request left');
  assert.equal(world.bridge.uploads.length, 0);
});

test('send token: a well-formed id that is not the outbox 32-hex form is written as it is and found by it', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world, { messageId: '<Odd.Id-7@mail.example.test>' });
  await world.adapter.send(pinned.payload, world.ctx());
  assert.equal(
    headerLines(world.bridge.uploads[0].raw)[0],
    'X-Aplos-Send: <Odd.Id-7@mail.example.test>',
  );
  const result = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.equal(result.kind, 'found');
});

test('findSent: a copy carrying our token but older than the window (since minus 3 days) is not ours; inside the slack it is', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world);
  const at = world.clock.now();
  const add = (date: number) =>
    world.emu.mailbox.addMessage({
      from: world.address,
      to: ['friend@example.test'],
      labelIds: ['SENT'],
      internalDate: date,
      headers: { 'X-Aplos-Send': pinned.payload.internetId },
    });
  add(at - 10 * 86_400_000);
  const old = await world.port.findSent(ACCOUNT, pinned.payload.internetId, at - 60_000);
  assert.equal(old.kind, 'absent', 'ten days before the attempt');
  const inside = add(at - 2 * 86_400_000);
  const found = await world.port.findSent(ACCOUNT, pinned.payload.internetId, at - 60_000);
  assert.deepEqual(found, {
    kind: 'found',
    remoteMessageId: inside.id,
    remoteThreadId: inside.threadId,
  });
});
