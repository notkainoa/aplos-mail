/**
 * The Gmail send transport (`google/send.ts`) on the Gmail emulator with the real governor. Each rule has a test that
 * fails on a version that breaks it: pinned bytes only, `drafts.send` only for a provably pinned draft, proof-only
 * `NotSentError`, uncertain after the request left, never retried, resumable above 5 MB, and header injection refused.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { NotSentError, PausedError, ProviderError } from '@aplos/engine/ports';
import {
  MAX_SEND_BYTES,
  RESUMABLE_ABOVE_BYTES,
  bccHeader,
  sentQuery,
} from '../../src/host/providers/google/send';
import {
  ACCOUNT,
  assertNothingReached,
  classOf,
  headerEndOf,
  redirectingGmail,
  sendWorld,
  submission,
  withMime,
  type RedirectAt,
  type SendWorld,
} from './send-rig';

const isUncertain = (error: unknown) =>
  !(error instanceof NotSentError) &&
  !(error instanceof PausedError) &&
  (!(error instanceof ProviderError) || error.error.uncertain === true);

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the send to reject');
}

const since = (world: SendWorld) => world.clock.now() - 5 * 60_000;

/** The `drafts.send` route, off by default until the live gate (TODO(live) in send.ts). */
const DRAFTS_ON = { useDraftsSend: true };

// ---------------------------------------------------------------- pinned bytes

/** What goes on the wire: the pinned bytes with the adapter's `X-Aplos-Send` token as the first header. */
const onTheWire = (pinned: ReturnType<typeof submission>): Buffer =>
  Buffer.concat([Buffer.from(`X-Aplos-Send: ${pinned.payload.internetId}\r\n`), pinned.mime]);

test('send: the pinned MIME leaves byte for byte, with its thread and a receipt for the Sent copy', async () => {
  const world = await sendWorld();
  const pinned = submission(world);
  const thread = world.emu.mailbox.addMessage({
    from: 'friend@example.test',
    to: [world.address],
    subject: 'Quarterly numbers',
  });
  const receipt = await world.adapter.send(
    { ...pinned.payload, remoteThreadId: thread.threadId },
    world.ctx(),
  );
  assert.equal(world.bridge.uploads.length, 1);
  const [upload] = world.bridge.uploads;
  assert.equal(upload.endpoint, 'messages');
  assert.equal(upload.uploadType, 'multipart');
  assert.deepEqual(upload.metadata, { threadId: thread.threadId });
  assert.ok(upload.raw.equals(onTheWire(pinned)), 'the uploaded bytes are the pinned bytes');
  const [sent] = world.sentMessages();
  assert.ok(sent.raw.equals(onTheWire(pinned)), 'Gmail stored the pinned bytes');
  assert.equal(receipt.remoteMessageId, sent.id);
  assert.equal(receipt.remoteThreadId, thread.threadId);
  assert.equal(receipt.draftConsumed, undefined);
});

test('send: envelope-only recipients become one Bcc line before the blank line; nothing else changes', async () => {
  const world = await sendWorld();
  const pinned = submission(world, {
    bcc: [{ address: 'hidden@example.test' }, { address: 'quiet@example.test' }],
  });
  assert.doesNotMatch(pinned.mime.toString('latin1'), /^Bcc:/im, 'the outbox never writes Bcc');
  await world.adapter.send(pinned.payload, world.ctx());
  const end = headerEndOf(pinned.mime);
  const expected = Buffer.concat([
    Buffer.from(`X-Aplos-Send: ${pinned.payload.internetId}\r\n`),
    pinned.mime.subarray(0, end),
    Buffer.from('\r\nBcc: hidden@example.test, quiet@example.test'),
    pinned.mime.subarray(end),
  ]);
  assert.ok(world.bridge.uploads[0].raw.equals(expected));
});

test('send: a long Bcc list is folded at commas, every line within 76 characters', () => {
  const addresses = Array.from({ length: 12 }, (_, i) => `person-number-${i}@example.test`);
  const header = bccHeader(addresses);
  const lines = header.split('\r\n');
  assert.ok(lines.length > 1);
  assert.ok(lines.every(l => l.length <= 76));
  assert.ok(lines.slice(1).every(l => l.startsWith(' ')));
  assert.equal(header.replace(/\r\n/g, ''), `Bcc: ${addresses.join(', ')}`);
});

// ---------------------------------------------------------------- drafts.send

test('send: drafts.send for a draft that is provably the pinned revision, carrying the pinned bytes', async () => {
  const world = await sendWorld(DRAFTS_ON);
  const pinned = submission(world);
  const draft = world.emu.mailbox.createDraft(pinned.mime);
  const receipt = await world.adapter.send(
    { ...pinned.payload, remoteDraftId: draft.id, baseRemoteMessageId: draft.message.id },
    world.ctx(),
  );
  assert.equal(world.bridge.uploads[0].endpoint, 'drafts');
  assert.equal(world.bridge.uploads[0].metadata.id, draft.id);
  assert.equal(receipt.draftConsumed, true);
  assert.equal(world.emu.mailbox.listDrafts().length, 0, 'the copy on other devices is gone');
  const [sent] = world.sentMessages();
  assert.ok(sent.raw.equals(onTheWire(pinned)));
  assert.equal(receipt.remoteMessageId, sent.id);
});

test('send: a draft edited on another device is left in place and the pinned bytes go as a new message', async () => {
  const world = await sendWorld(DRAFTS_ON);
  const pinned = submission(world);
  const draft = world.emu.mailbox.createDraft(pinned.mime);
  const phone = submission(world, { subject: 'Edited on the phone' });
  const edited = world.emu.mailbox.updateDraft(draft.id, phone.mime);
  // The phone's copy as Gmail stored it (with Gmail's own Message-ID when the emulator rewrites draft ids).
  const phoneCopy = world.emu.mailbox.rawOf(edited.message.id);
  const receipt = await world.adapter.send(
    { ...pinned.payload, remoteDraftId: draft.id, baseRemoteMessageId: draft.message.id },
    world.ctx(),
  );
  assert.equal(world.bridge.uploads[0].endpoint, 'messages');
  assert.equal(receipt.draftConsumed, undefined);
  const [kept] = world.emu.mailbox.listDrafts();
  assert.equal(kept.id, draft.id);
  assert.ok(
    world.emu.mailbox.rawOf(kept.message.id).equals(phoneCopy),
    "the phone's edit survives",
  );
  assert.ok(world.sentMessages()[0].raw.equals(onTheWire(pinned)));
});

test('send: no precondition, no drafts.send (and no drafts.get either)', async () => {
  const world = await sendWorld(DRAFTS_ON);
  const pinned = submission(world);
  const draft = world.emu.mailbox.createDraft(pinned.mime);
  await world.adapter.send({ ...pinned.payload, remoteDraftId: draft.id }, world.ctx());
  assert.equal(world.bridge.uploads[0].endpoint, 'messages');
  assert.equal(world.emu.log.filter(e => e.apiMethod === 'gmail.users.drafts.get').length, 0);
  assert.equal(world.emu.mailbox.listDrafts().length, 1);
});

test('send: a phone edit landing between the draft read and drafts.send still sends the pinned bytes', async () => {
  const world = await sendWorld(DRAFTS_ON);
  const pinned = submission(world);
  const draft = world.emu.mailbox.createDraft(pinned.mime);
  const phone = submission(world, { subject: 'Edited mid-send' });
  world.bridge.beforeDelivery = () => {
    world.emu.mailbox.updateDraft(draft.id, phone.mime);
  };
  await world.adapter.send(
    { ...pinned.payload, remoteDraftId: draft.id, baseRemoteMessageId: draft.message.id },
    world.ctx(),
  );
  const [sent] = world.sentMessages();
  assert.ok(
    sent.raw.equals(onTheWire(pinned)),
    'the upload carries the pinned bytes, not the draft as it is now',
  );
});

test('send: a remote draft that is gone and not (yet) in Sent is uncertain: nothing is sent, findSent decides', async () => {
  const world = await sendWorld(DRAFTS_ON);
  const pinned = submission(world);
  const draft = world.emu.mailbox.createDraft(pinned.mime);
  // A phone may just have sent it (the Sent search lags), or deleted it: a pinned send here could be a second copy.
  world.emu.mailbox.deleteDraft(draft.id);
  const error = await rejection(
    world.adapter.send(
      { ...pinned.payload, remoteDraftId: draft.id, baseRemoteMessageId: draft.message.id },
      world.ctx(),
    ),
  );
  assert.ok(isUncertain(error), `got ${String(error)}`);
  assert.equal(classOf(error)?.reason, 'draftGone');
  assert.equal(world.sendRequests(), 0);
  assert.equal(world.bridge.uploads.length, 0);
});

test('send: with drafts.send off (the default), even a provably pinned draft goes as the pinned MIME, unread', async () => {
  const world = await sendWorld();
  const pinned = submission(world);
  const draft = world.emu.mailbox.createDraft(pinned.mime);
  const receipt = await world.adapter.send(
    { ...pinned.payload, remoteDraftId: draft.id, baseRemoteMessageId: draft.message.id },
    world.ctx(),
  );
  assert.equal(world.bridge.uploads[0].endpoint, 'messages');
  assert.equal(world.emu.log.filter(e => e.apiMethod === 'gmail.users.drafts.get').length, 0);
  assert.equal(receipt.draftConsumed, undefined, 'the engine removes the remote draft itself');
  assert.equal(world.emu.mailbox.listDrafts().length, 1);
  assert.ok(world.sentMessages()[0].raw.equals(onTheWire(pinned)));
});

test('send: with drafts.send off, a gone remote draft is not read either: the pinned MIME is sent once', async () => {
  const world = await sendWorld();
  const pinned = submission(world);
  const draft = world.emu.mailbox.createDraft(pinned.mime);
  world.emu.mailbox.deleteDraft(draft.id);
  await world.adapter.send(
    { ...pinned.payload, remoteDraftId: draft.id, baseRemoteMessageId: draft.message.id },
    world.ctx(),
  );
  assert.equal(world.sendRequests(), 1);
});

test('send: a 4xx from drafts.send (flag on) proves nothing left: NotSentError', async () => {
  const world = await sendWorld(DRAFTS_ON);
  const pinned = submission(world);
  const draft = world.emu.mailbox.createDraft(pinned.mime);
  world.faults.failNext(
    { apiMethod: 'gmail.users.drafts.send' },
    { status: 400, reason: 'invalidArgument' },
  );
  const error = await rejection(
    world.adapter.send(
      { ...pinned.payload, remoteDraftId: draft.id, baseRemoteMessageId: draft.message.id },
      world.ctx(),
    ),
  );
  assert.ok(error instanceof NotSentError, `got ${String(error)}`);
  assert.equal(world.sentMessages().length, 0);
});

test('send: a remote draft already used up (its mail is in Sent) is never sent again and never "failed"', async () => {
  const world = await sendWorld(DRAFTS_ON);
  // The Sent lookup of the drafts.send route searches by Message-ID (`sentCopy`), which only answers when the draft
  // kept ours: pinned to 'kept'. Where the provider replaces it (Gmail), the same case is the uncertain outcome of the
  // next test (nothing sent, findSent decides); the route is off until the live gate (send.ts TODO(live)).
  world.emu.settings.draftIdentity = 'kept';
  const pinned = submission(world);
  const draft = world.emu.mailbox.createDraft(pinned.mime);
  // An earlier attempt (or another device) sent it: the draft id now 404s.
  const out = world.emu.mailbox.sendDraft(draft.id);
  const receipt = await world.adapter.send(
    { ...pinned.payload, remoteDraftId: draft.id, baseRemoteMessageId: draft.message.id },
    world.ctx(),
  );
  assert.equal(world.sendRequests(), 0, 'no second copy');
  assert.equal(world.bridge.uploads.length, 0);
  assert.equal(receipt.remoteMessageId, out.id);
});

test('send: a drafts.send 404 (the draft vanished between the read and the send) is uncertain, not failed', async () => {
  const world = await sendWorld(DRAFTS_ON);
  const pinned = submission(world);
  const draft = world.emu.mailbox.createDraft(pinned.mime);
  world.bridge.beforeDelivery = () => {
    world.emu.mailbox.deleteDraft(draft.id);
  };
  const error = await rejection(
    world.adapter.send(
      { ...pinned.payload, remoteDraftId: draft.id, baseRemoteMessageId: draft.message.id },
      world.ctx(),
    ),
  );
  assert.ok(isUncertain(error), `got ${String(error)}`);
});

// ---------------------------------------------------------------- outcomes by proof

test('send: the daily sending limit (429 "Mail sending") is NotSentError send_limit with the time it ends', async () => {
  const world = await sendWorld({ sendLimitPerDay: 1 });
  world.emu.setSendsToday(1);
  const error = await rejection(world.adapter.send(submission(world).payload, world.ctx()));
  assert.ok(error instanceof NotSentError, `got ${String(error)}`);
  assert.equal(error.error.class, 'send_limit');
  assert.ok((error.error.resumeAt ?? 0) > world.clock.now());
  assert.equal(world.sentMessages().length, 0);
  // The governor now blocks sends: the next one is refused with no request at all.
  const before = world.gmailRequests();
  const again = await rejection(world.adapter.send(submission(world).payload, world.ctx()));
  assert.ok(again instanceof PausedError || again instanceof NotSentError);
  assert.equal(classOf(again)?.class ?? (again as PausedError).cls, 'send_limit');
  assert.equal(world.gmailRequests(), before);
});

test('send: 403 "Daily user sending quota exceeded" is send_limit too', async () => {
  const world = await sendWorld();
  world.faults.failNext(
    { apiMethod: 'gmail.users.messages.send' },
    { status: 403, reason: 'userRateLimitExceeded', message: 'Daily user sending quota exceeded.' },
  );
  const error = await rejection(world.adapter.send(submission(world).payload, world.ctx()));
  assert.ok(error instanceof NotSentError);
  assert.equal(error.error.class, 'send_limit');
});

for (const [name, spec, cls] of [
  ['permission', { status: 403, reason: 'insufficientPermissions' }, 'permission'],
  ['a 400', { status: 400, reason: 'invalidArgument', message: 'Invalid To header' }, 'permanent'],
  ['a 413', { status: 413, reason: 'uploadTooLarge' }, 'permanent'],
  ['a 404 on messages.send', { status: 404, reason: 'notFound' }, 'permanent'],
  ['a plain 429', { status: 429, reason: 'rateLimitExceeded' }, 'throttle'],
] as const) {
  test(`send: ${name} refusal proves nothing left: NotSentError ${cls}, sent once, never retried`, async () => {
    const world = await sendWorld();
    world.faults.failNext({ apiMethod: 'gmail.users.messages.send' }, spec);
    const error = await rejection(world.adapter.send(submission(world).payload, world.ctx()));
    assert.ok(error instanceof NotSentError, `got ${String(error)}`);
    assert.equal(error.error.class, cls);
    assert.equal(world.sendRequests(), 1);
  });
}

for (const status of [408, 409, 499]) {
  test(`send: a ${status} is not a known refusal: uncertain, never retried`, async () => {
    const world = await sendWorld();
    world.faults.failNext(
      { apiMethod: 'gmail.users.messages.send' },
      { status, reason: `status_${status}` },
    );
    const error = await rejection(world.adapter.send(submission(world).payload, world.ctx()));
    assert.ok(isUncertain(error), `got ${String(error)}`);
    assert.equal(world.sendRequests(), 1);
  });
}

test('send: a 5xx after the request left is uncertain and never retried', async () => {
  const world = await sendWorld();
  world.faults.failNext(
    { apiMethod: 'gmail.users.messages.send' },
    { status: 503, reason: 'backendError' },
    { times: 5 },
  );
  const error = await rejection(world.adapter.send(submission(world).payload, world.ctx()));
  assert.ok(isUncertain(error), `got ${String(error)}`);
  assert.equal(world.sendRequests(), 1);
});

test('send: a timeout after the request left is uncertain (the slot is released)', async () => {
  const world = await sendWorld();
  world.bridge.failNext = 'hang';
  const error = await rejection(world.adapter.send(submission(world).payload, world.ctx()));
  assert.ok(isUncertain(error), `got ${String(error)}`);
  assert.equal(classOf(error)?.reason, 'timeout');
  // The account's one in-flight slot is free again: the next call goes out.
  await world.adapter.send(submission(world).payload, world.ctx());
  assert.equal(world.sentMessages().length, 1);
});

test('send: accepted by Gmail, then the answer timed out: uncertain, never re-sent, findSent finds that copy', async () => {
  const world = await sendWorld();
  const pinned = submission(world);
  world.bridge.failNext = 'acceptThenHang';
  const error = await rejection(world.adapter.send(pinned.payload, world.ctx()));
  assert.ok(isUncertain(error), `got ${String(error)}`);
  assert.equal(classOf(error)?.reason, 'timeout');
  assert.equal(world.sendRequests(), 1, 'never re-sent');
  const [sent] = world.sentMessages();
  const result = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.deepEqual(result, {
    kind: 'found',
    remoteMessageId: sent.id,
    remoteThreadId: sent.threadId,
  });
});

test('send: a 401 is refreshed once and re-sent once (it proved nothing left); one copy goes', async () => {
  const world = await sendWorld();
  const pinned = submission(world);
  world.faults.failNext(
    { apiMethod: 'gmail.users.messages.send' },
    { status: 401, reason: 'authError' },
  );
  const tokenCalls = () => world.emu.log.filter(e => e.service !== 'gmail').length;
  const before = tokenCalls();
  const receipt = await world.adapter.send(pinned.payload, world.ctx());
  assert.equal(tokenCalls(), before + 1, 'one forced refresh');
  assert.equal(world.sendRequests(), 2, 'the refused request, then the one re-send');
  const sent = world.sentMessages();
  assert.equal(sent.length, 1);
  assert.equal(receipt.remoteMessageId, sent[0].id);
  assert.equal(world.bridge.uploads.length, 2);
  assert.ok(world.bridge.uploads.every(u => u.raw.equals(onTheWire(pinned))));
});

test('send: a second 401 after the refresh is NotSentError auth, with no third request', async () => {
  const world = await sendWorld();
  world.faults.failNext(
    { apiMethod: 'gmail.users.messages.send' },
    { status: 401, reason: 'authError' },
    { times: 2 },
  );
  const error = await rejection(world.adapter.send(submission(world).payload, world.ctx()));
  assert.ok(error instanceof NotSentError, `got ${String(error)}`);
  assert.equal(error.error.class, 'auth');
  assert.equal(world.sendRequests(), 2);
  assert.equal(world.sentMessages().length, 0);
});

test('send: a refused connection proves nothing left: NotSentError', async () => {
  const world = await sendWorld();
  world.bridge.failNext = 'refused';
  const error = await rejection(world.adapter.send(submission(world).payload, world.ctx()));
  assert.ok(error instanceof NotSentError, `got ${String(error)}`);
  assert.equal(world.sendRequests(), 0);
});

test('send: a 200 from a proxy or captive portal (no Message id) is uncertain, never sent', async () => {
  const world = await sendWorld();
  const pinned = submission(world);
  world.bridge.failNext = 'portal';
  const error = await rejection(world.adapter.send(pinned.payload, world.ctx()));
  assert.ok(isUncertain(error), `got ${String(error)}`);
  assert.equal(world.sentMessages().length, 0);
  const result = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.equal(result.kind, 'absent');
});

test('send: a 200 whose body does not parse is uncertain; findSent then finds the accepted copy', async () => {
  const world = await sendWorld();
  const pinned = submission(world);
  world.bridge.failNext = 'corrupt';
  const error = await rejection(world.adapter.send(pinned.payload, world.ctx()));
  assert.ok(isUncertain(error), `got ${String(error)}`);
  const result = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.equal(result.kind, 'found');
});

// ---------------------------------------------------------------- redirects and logs

const BIG = () => new Uint8Array(RESUMABLE_ABOVE_BYTES).fill(0x44);

for (const [name, big, at] of [
  ['the multipart POST', false, 'send'],
  ['the resumable PUT', true, 'send'],
] as const) {
  for (const status of [307, 308] as const) {
    test(`send: a ${status} on ${name} is never followed: uncertain, and the redirect target receives nothing`, async () => {
      const world = await sendWorld();
      // Real sockets: time moves only when the test says so, so the send timeout cannot fire first.
      world.clock.auto(false);
      const gmail = await redirectingGmail(status, at satisfies RedirectAt);
      world.bridge.uploadVia = gmail.fetch;
      try {
        const attachments = big
          ? [{ name: 'scan.bin', mime: 'application/octet-stream', bytes: BIG() }]
          : [];
        const pinned = submission(world, { attachments });
        const error = await rejection(world.adapter.send(pinned.payload, world.ctx()));
        assert.ok(isUncertain(error), `got ${String(error)}`);
        assert.equal(classOf(error)?.status, status);
        assertNothingReached(gmail);
      } finally {
        await gmail.close();
      }
    });
  }
}

test('send: a 307 on the resumable session open proves nothing left, and is not followed either', async () => {
  const world = await sendWorld();
  world.clock.auto(false);
  const gmail = await redirectingGmail(307, 'initiate');
  world.bridge.uploadVia = gmail.fetch;
  try {
    const attachments = [{ name: 'scan.bin', mime: 'application/octet-stream', bytes: BIG() }];
    const pinned = submission(world, { attachments });
    const error = await rejection(world.adapter.send(pinned.payload, world.ctx()));
    assert.ok(error instanceof NotSentError, `got ${String(error)}`);
    assertNothingReached(gmail);
  } finally {
    await gmail.close();
  }
});

const SECRET = 'Invalid To header: secret-recipient@example.test';

for (const [name, apiMethod, options] of [
  ['messages.send', 'gmail.users.messages.send', {}],
  ['drafts.send', 'gmail.users.drafts.send', DRAFTS_ON],
] as const) {
  test(`send: a ${name} refusal is logged without Gmail's own text (it can quote the message)`, async () => {
    const world = await sendWorld(options);
    const pinned = submission(world);
    const draft = world.emu.mailbox.createDraft(pinned.mime);
    const payload =
      apiMethod === 'gmail.users.drafts.send'
        ? { ...pinned.payload, remoteDraftId: draft.id, baseRemoteMessageId: draft.message.id }
        : pinned.payload;
    world.faults.failNext(
      { apiMethod },
      { status: 400, reason: 'invalidArgument', message: SECRET },
    );
    const error = await rejection(world.adapter.send(payload, world.ctx()));
    assert.ok(error instanceof NotSentError, `got ${String(error)}`);
    const refused = world.events.filter(e => e.name === 'sync.gmail.request_refused');
    assert.equal(refused.length, 1);
    const logged = (refused[0].fields as { error: Record<string, unknown> }).error;
    assert.equal(logged.status, 400);
    assert.equal(logged.method, `gmail.${name}`);
    assert.equal('providerMessage' in logged, false);
    assert.doesNotMatch(JSON.stringify(world.events), /secret-recipient|Invalid To header/);
  });
}

// ---------------------------------------------------------------- kill points: no duplicate

test('send killed before the request: NotSentError or PausedError, nothing reached Gmail, findSent absent', async () => {
  const world = await sendWorld();
  const pinned = submission(world);
  const stop = new AbortController();
  stop.abort(new Error('actor stopped'));
  const error = await rejection(world.adapter.send(pinned.payload, world.ctx(stop.signal)));
  assert.ok(error instanceof NotSentError || error instanceof PausedError, `got ${String(error)}`);
  assert.equal(world.sendRequests(), 0);
  const result = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.equal(result.kind, 'absent');
});

test('send killed after the request left (connection reset, Gmail never applied it): uncertain, findSent absent', async () => {
  const world = await sendWorld();
  const pinned = submission(world);
  world.faults.dropNext({ apiMethod: 'gmail.users.messages.send' });
  const error = await rejection(world.adapter.send(pinned.payload, world.ctx()));
  assert.ok(isUncertain(error), `got ${String(error)}`);
  assert.equal(world.sendRequests(), 1, 'never re-sent');
  const result = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.equal(result.kind, 'absent');
});

test('send killed after acceptance (Gmail applied it, the reply was lost): uncertain, findSent finds that copy', async () => {
  const world = await sendWorld();
  const pinned = submission(world);
  world.faults.dropAfterNext({ apiMethod: 'gmail.users.messages.send' });
  const error = await rejection(world.adapter.send(pinned.payload, world.ctx()));
  assert.ok(isUncertain(error), `got ${String(error)}`);
  assert.equal(world.sendRequests(), 1, 'never re-sent');
  const [sent] = world.sentMessages();
  const result = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.deepEqual(result, {
    kind: 'found',
    remoteMessageId: sent.id,
    remoteThreadId: sent.threadId,
  });
});

test('drafts.send killed after acceptance: findSent finds the sent message; nothing is left in Drafts', async () => {
  const world = await sendWorld(DRAFTS_ON);
  const pinned = submission(world);
  const draft = world.emu.mailbox.createDraft(pinned.mime);
  world.faults.dropAfterNext({ apiMethod: 'gmail.users.drafts.send' });
  const error = await rejection(
    world.adapter.send(
      { ...pinned.payload, remoteDraftId: draft.id, baseRemoteMessageId: draft.message.id },
      world.ctx(),
    ),
  );
  assert.ok(isUncertain(error), `got ${String(error)}`);
  assert.equal(world.sendRequests(), 1);
  const result = await world.port.findSent(ACCOUNT, pinned.payload.internetId, since(world));
  assert.equal(result.kind, 'found');
  assert.equal(world.emu.mailbox.listDrafts().length, 0);
});

// ---------------------------------------------------------------- large mail

test('send: above 5 MB the upload is resumable (session, then one PUT of the pinned bytes)', async () => {
  const world = await sendWorld();
  const big = new Uint8Array(RESUMABLE_ABOVE_BYTES).fill(0x41);
  const pinned = submission(world, {
    attachments: [{ name: 'scan.bin', mime: 'application/octet-stream', bytes: big }],
  });
  assert.ok(pinned.mime.length > RESUMABLE_ABOVE_BYTES);
  await world.adapter.send(pinned.payload, world.ctx());
  assert.equal(world.bridge.uploads[0].uploadType, 'resumable');
  assert.ok(world.bridge.uploads[0].raw.equals(onTheWire(pinned)));
  assert.ok(world.sentMessages()[0].raw.equals(onTheWire(pinned)));
  assert.equal(world.sendRequests(), 1);
});

test('send: a resumable session that fails to open proves nothing left, even on a dropped connection', async () => {
  const world = await sendWorld();
  const big = new Uint8Array(RESUMABLE_ABOVE_BYTES).fill(0x42);
  const pinned = submission(world, {
    attachments: [{ name: 'scan.bin', mime: 'application/octet-stream', bytes: big }],
  });
  world.bridge.failNext = 'dropInitiate';
  const error = await rejection(world.adapter.send(pinned.payload, world.ctx()));
  assert.ok(error instanceof NotSentError, `got ${String(error)}`);
  assert.equal(world.sendRequests(), 0);
});

test('send: a 4xx on the resumable PUT proves nothing left: NotSentError', async () => {
  const world = await sendWorld();
  const big = new Uint8Array(RESUMABLE_ABOVE_BYTES).fill(0x43);
  const pinned = submission(world, {
    attachments: [{ name: 'scan.bin', mime: 'application/octet-stream', bytes: big }],
  });
  world.faults.failNext(
    { apiMethod: 'gmail.users.messages.send' },
    { status: 400, reason: 'invalidArgument' },
  );
  const error = await rejection(world.adapter.send(pinned.payload, world.ctx()));
  assert.ok(error instanceof NotSentError, `got ${String(error)}`);
  assert.equal(world.bridge.uploads[0].uploadType, 'resumable');
  assert.equal(world.sentMessages().length, 0);
});

test('send: mail over 35 MB is refused before anything leaves', async () => {
  const world = await sendWorld();
  const pinned = submission(world);
  const end = headerEndOf(pinned.mime);
  const huge = Buffer.concat([
    pinned.mime.subarray(0, end + 4),
    Buffer.alloc(MAX_SEND_BYTES, 0x41),
  ]);
  const error = await rejection(world.adapter.send(withMime(pinned, huge), world.ctx()));
  assert.ok(error instanceof NotSentError);
  assert.equal(error.error.reason, 'messageTooLarge');
  assert.equal(world.gmailRequests(), 0);
});

// ---------------------------------------------------------------- header safety

/** The pinned MIME with `edit` applied to its header text (the bytes an injection would have produced). */
function edited(pinned: ReturnType<typeof submission>, edit: (head: string) => string): Buffer {
  const end = headerEndOf(pinned.mime);
  const head = pinned.mime.subarray(0, end).toString('latin1');
  return Buffer.concat([Buffer.from(edit(head), 'latin1'), pinned.mime.subarray(end)]);
}

const subjectLine = /^Subject: .*$/m;

for (const [name, edit, reason] of [
  [
    'a Bcc smuggled through the subject',
    (h: string) => h.replace(subjectLine, s => `${s}\r\nBcc: evil@attacker.example`),
    'unexpectedHeader',
  ],
  [
    'a second To',
    (h: string) => h.replace(subjectLine, s => `${s}\r\nTo: evil@attacker.example`),
    'duplicateHeader',
  ],
  [
    'a Cc the envelope does not hold',
    (h: string) => h.replace(subjectLine, s => `${s}\r\nCc: evil@attacker.example`),
    'recipientNotInEnvelope',
  ],
  [
    'a Reply-To',
    (h: string) => h.replace(subjectLine, s => `${s}\r\nReply-To: evil@attacker.example`),
    'unexpectedHeader',
  ],
  [
    'a bare LF',
    (h: string) => h.replace(subjectLine, s => `${s}\nBcc: evil@attacker.example`),
    'bareLineBreak',
  ],
  [
    'a bare CR',
    (h: string) => h.replace(subjectLine, s => `${s}\rBcc: evil@attacker.example`),
    'bareLineBreak',
  ],
  ['a NUL', (h: string) => h.replace(subjectLine, s => `${s}\0`), 'controlCharacter'],
  [
    'a display name that breaks the line',
    (h: string) =>
      h.replace(/^To: .*$/m, 'To: "A\r\nBcc: evil@attacker.example" <friend@example.test>'),
    'unexpectedHeader',
  ],
  [
    'another From',
    (h: string) => h.replace(/^From: .*$/m, 'From: boss@example.test'),
    'wrongSender',
  ],
  [
    'a second From address',
    (h: string) => h.replace(/^From: (.*)$/m, (_l, v: string) => `From: ${v}, boss@example.test`),
    'wrongSender',
  ],
  [
    'an X-Aplos-Send token inside the pinned bytes (only the adapter writes it, on the wire)',
    (h: string) => h.replace(subjectLine, s => `${s}\r\nX-Aplos-Send: <token@mail.example.test>`),
    'unexpectedHeader',
  ],
  [
    'an x-aplos-send token with the header name in lower case',
    (h: string) => h.replace(subjectLine, s => `${s}\r\nx-aplos-send: <token@mail.example.test>`),
    'unexpectedHeader',
  ],
  [
    'an X-Aplos-Draft token (the draft identity never leaves in sent mail)',
    (h: string) => h.replace(subjectLine, s => `${s}\r\nX-Aplos-Draft: <token@mail.example.test>`),
    'unexpectedHeader',
  ],
  [
    'a Sender header',
    (h: string) => h.replace(subjectLine, s => `${s}\r\nSender: boss@example.test`),
    'unexpectedHeader',
  ],
  [
    'another Message-ID',
    (h: string) => h.replace(/^Message-ID: .*$/m, 'Message-ID: <other@mail.example.test>'),
    'messageIdMismatch',
  ],
  [
    'a group address',
    (h: string) => h.replace(/^To: .*$/m, 'To: undisclosed:friend@example.test;'),
    'unreadableAddress',
  ],
] as const) {
  test(`send: header injection is refused, not fixed up: ${name}`, async () => {
    const world = await sendWorld();
    const pinned = submission(world);
    const error = await rejection(
      world.adapter.send(withMime(pinned, edited(pinned, edit)), world.ctx()),
    );
    assert.ok(error instanceof NotSentError, `got ${String(error)}`);
    assert.equal(error.error.class, 'permanent');
    assert.equal(error.error.reason, reason);
    assert.equal(world.gmailRequests(), 0, 'not one request');
  });
}

test('send: an envelope From that is not the account is refused', async () => {
  const world = await sendWorld();
  const pinned = submission(world);
  const payload = {
    ...pinned.payload,
    envelope: { ...pinned.payload.envelope, from: 'boss@example.test' },
  };
  const error = await rejection(world.adapter.send(payload, world.ctx()));
  assert.ok(error instanceof NotSentError);
  assert.equal(error.error.reason, 'wrongSender');
});

test('send: real outbox MIME with folding, encoded words, a reply and attachments passes untouched', async () => {
  const world = await sendWorld();
  const pinned = submission(world, {
    subject: `Ünïcödé subject ${'and a very long tail of words '.repeat(6)}`,
    to: Array.from({ length: 6 }, (_, i) => ({
      address: `friend${i}@example.test`,
      name: `Friend, Number ${i}`,
    })),
    cc: [{ address: 'copy@example.test', name: 'Zoë' }],
    inReplyTo: '<parent-1@mail.example.test>',
    references: ['<root-1@mail.example.test>', '<parent-1@mail.example.test>'],
    attachments: [{ name: 'notes.txt', mime: 'text/plain', bytes: new TextEncoder().encode('hi') }],
  });
  assert.match(pinned.mime.toString('latin1'), /\r\n /, 'the writer folded a header');
  await world.adapter.send(pinned.payload, world.ctx());
  assert.ok(world.bridge.uploads[0].raw.equals(onTheWire(pinned)));
});

// ---------------------------------------------------------------- findSent

test('findSent: Sent only, never Drafts, bounded three days before since', () => {
  const at = Date.UTC(2026, 9, 28, 0, 30, 0);
  assert.equal(
    sentQuery('<abc.123@mail.example>', at),
    'rfc822msgid:abc.123@mail.example in:sent -in:drafts after:2026/10/25',
  );
  assert.throws(() => sentQuery('<a b@x>', at), ProviderError);
  assert.throws(() => sentQuery('<a{b}@x>', at), ProviderError);
  assert.throws(() => sentQuery('no-brackets@x', at), ProviderError);
});

test('findSent: a search that fails is thrown, never "absent"', async () => {
  const world = await sendWorld();
  world.faults.failNext(
    { apiMethod: 'gmail.users.messages.list' },
    { status: 500, reason: 'backendError' },
    { times: 10 },
  );
  await assert.rejects(world.port.findSent(ACCOUNT, '<x-1@mail.example.test>', since(world)));
});

test('findSent: a hit that vanished before its labels were read is thrown, never "absent"', async () => {
  const world = await sendWorld();
  world.emu.mailbox.addMessage({
    from: world.address,
    to: ['friend@example.test'],
    messageId: 'x-2@mail.example.test',
    labelIds: ['SENT'],
  });
  world.faults.failNext(
    { apiMethod: 'gmail.users.messages.get' },
    { status: 404, reason: 'notFound' },
  );
  await assert.rejects(world.port.findSent(ACCOUNT, '<x-2@mail.example.test>', since(world)));
});

test('findSent: a Sent copy whose internalDate predates since (a sent draft keeps its date) is found', async () => {
  const world = await sendWorld();
  const m = world.emu.mailbox.addMessage({
    from: world.address,
    to: ['friend@example.test'],
    messageId: 'x-4@mail.example.test',
    labelIds: ['SENT'],
    internalDate: world.clock.now() - 2 * 86_400_000,
  });
  const result = await world.port.findSent(ACCOUNT, '<x-4@mail.example.test>', since(world));
  assert.deepEqual(result, { kind: 'found', remoteMessageId: m.id, remoteThreadId: m.threadId });
});

test('findSent: a trashed Sent copy still counts as sent', async () => {
  const world = await sendWorld();
  const m = world.emu.mailbox.addMessage({
    from: world.address,
    to: ['friend@example.test'],
    messageId: 'x-3@mail.example.test',
    labelIds: ['SENT', 'TRASH'],
  });
  const result = await world.port.findSent(ACCOUNT, '<x-3@mail.example.test>', since(world));
  assert.deepEqual(result, { kind: 'found', remoteMessageId: m.id, remoteThreadId: m.threadId });
});
