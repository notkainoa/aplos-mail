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
import { NotSentError } from '@aplos/engine/ports';
import { MAX_SEND_BYTES, withSendToken } from '../../src/host/providers/google/send';
import {
  ACCOUNT,
  classOf,
  headerEndOf,
  sendWorld,
  submission,
  withMime,
  type SendWorld,
} from './send-rig';

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

/** A message from the owner carrying `token` as its `X-Aplos-Send`, in `labelIds`. */
function addTokened(world: SendWorld, token: string, labelIds: string[]) {
  return world.emu.mailbox.addMessage({
    from: world.address,
    to: ['friend@example.test'],
    labelIds,
    headers: { 'X-Aplos-Send': token },
  });
}

test('findSent: our token on a DRAFT (even one labelled SENT) is never found', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world);
  addTokened(world, pinned.payload.internetId, ['SENT', 'DRAFT']);
  const result = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.equal(result.kind, 'absent');
});

test('findSent: our token on a message WITHOUT the SENT label (an Inbox copy) is never found, by search or by listing', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world);
  const token = pinned.payload.internetId;
  addTokened(world, token, ['INBOX']);
  // The search path: a search that lets the Inbox copy through (the labels on the metadata read must still refuse it).
  world.bridge.rewriteQuery = () => 'in:inbox';
  assert.equal((await world.port.findSent(ACCOUNT, token, since(world))).kind, 'absent');
  // The newest-SENT listing path: a listing that names the Inbox copy.
  world.bridge.rewriteQuery = undefined;
  world.bridge.listLabel = 'INBOX';
  assert.equal((await world.port.findSent(ACCOUNT, token, since(world))).kind, 'absent');
  // The control: the same token WITH the SENT label is found (only the label differs).
  world.bridge.listLabel = undefined;
  const sent = addTokened(world, token, ['SENT']);
  const found = await world.port.findSent(ACCOUNT, token, since(world));
  assert.equal(found.kind, 'found');
  assert.equal(found.kind === 'found' && found.remoteMessageId, sent.id);
});

test('findSent: an Inbox copy that kept our Message-ID (no token) is never found when the search lets it through', async () => {
  const world = await sendWorld();
  const pinned = submission(world);
  world.emu.mailbox.addMessage({
    from: 'someone@example.test',
    to: [world.address],
    messageId: pinned.payload.internetId.replace(/^<|>$/g, ''),
    labelIds: ['INBOX'],
  });
  world.bridge.rewriteQuery = q => q.replace(' in:sent -in:drafts', ' in:inbox');
  const result = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.equal(result.kind, 'absent');
});

test('findSent: the match is the exact token, never a prefix, a suffix or a substring of it', async () => {
  const world = await rewritingWorld();
  const pinned = submission(world);
  const mine = pinned.payload.internetId;
  const bare = mine.replace(/^<|>$/g, '');
  const [local, domain] = bare.split('@');
  const nearMisses = [
    // Well-formed tokens of OTHER submissions: mine is a prefix of this one, this one a prefix of mine, mine inside this one.
    `<${bare}.evil>`,
    `<${local}@${domain.replace('.test', '')}>`,
    `<x-${bare}>`,
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
  const bare = pinned.payload.internetId.replace(/^<|>$/g, '');
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

// ---- the engine's pinned bytes never carry the token; the adapter alone adds it ----

/** The pinned MIME with `line` added to its header block, right after the Subject line. */
function withHeaderLine(pinned: ReturnType<typeof submission>, line: string): Buffer {
  const end = headerEndOf(pinned.mime);
  const head = pinned.mime.subarray(0, end).toString('latin1');
  const edited = head.replace(/^Subject: .*$/m, s => `${s}\r\n${line}`);
  return Buffer.concat([Buffer.from(edited, 'latin1'), pinned.mime.subarray(end)]);
}

for (const [name, line] of [
  ['the token of this very submission', (id: string) => `X-Aplos-Send: ${id}`],
  ['another submission token', () => 'X-Aplos-Send: <someone-else@mail.example.test>'],
  ['the header name in lower case', (id: string) => `x-aplos-send: ${id}`],
  ['a draft token', (id: string) => `X-Aplos-Draft: ${id}`],
] as const)
  test(`send token: pinned bytes that already carry ${name} are refused, nothing leaves`, async () => {
    const world = await rewritingWorld();
    const pinned = submission(world);
    const mime = withHeaderLine(pinned, line(pinned.payload.internetId));
    const error = await world.adapter.send(withMime(pinned, mime), world.ctx()).catch(e => e);
    assert.ok(error instanceof NotSentError, `got ${String(error)}`);
    assert.equal(error.error.reason, 'unexpectedHeader');
    assert.equal(world.gmailRequests(), 0);
    assert.equal(world.bridge.uploads.length, 0);
    assert.equal(world.sentMessages().length, 0);
  });

// ---- the 35 MiB limit counts the token header the adapter adds ----

/** The submission with its body padded so the pinned MIME is exactly `mimeLength` bytes. */
function paddedTo(world: SendWorld, mimeLength: number) {
  const pinned = submission(world);
  const filler = mimeLength - pinned.mime.length;
  assert.ok(filler > 0);
  return { pinned, mime: Buffer.concat([pinned.mime, Buffer.alloc(filler, 0x41)]) };
}

test('send token: a MIME exactly at the 35 MiB limit minus the token header goes; one byte more is refused before any request', async () => {
  const world = await rewritingWorld();
  const probe = submission(world);
  const tokenLength =
    withSendToken(probe.mime, probe.payload.internetId).length - probe.mime.length;
  assert.ok(tokenLength > 20, 'the token header has a length');

  const fits = paddedTo(world, MAX_SEND_BYTES - tokenLength);
  await world.adapter.send(withMime(fits.pinned, fits.mime), world.ctx());
  assert.equal(
    world.bridge.uploads[0].raw.length,
    MAX_SEND_BYTES,
    'the upload is exactly the limit',
  );
  assert.equal(world.sentMessages().length, 1);

  const over = await rewritingWorld();
  const tooBig = paddedTo(over, MAX_SEND_BYTES - tokenLength + 1);
  const error = await over.adapter
    .send(withMime(tooBig.pinned, tooBig.mime), over.ctx())
    .catch(e => e);
  assert.ok(error instanceof NotSentError, `got ${String(error)}`);
  assert.equal(error.error.reason, 'messageTooLarge');
  assert.equal(over.gmailRequests(), 0);
  assert.equal(over.bridge.uploads.length, 0);
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
