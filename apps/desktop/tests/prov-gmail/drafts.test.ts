/**
 * prov-gmail-write drafts: `saveDraft` and `deleteDraft` on the Gmail emulator (google/drafts.ts). The emulator has no
 * `/upload/` endpoints for drafts, so `draft-bridge.ts` parses the upload protocol and replays it on the JSON routes.
 * Each test fails on the broken version it names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFaultInjector } from '@aplos/emulators';
import { PausedError, ProviderError, type DraftUpload } from '@aplos/engine/ports';
import { mimeOf, saved, apiCalls, setup, uncertainCreate, uploadedBytes } from './draft-rig';

const CRLF = '\r\n';

// ---- the round trip ----

test('prov-gmail-drafts create then replace: one remote copy, the new message id is the next precondition', async () => {
  const s = await setup();
  const first = saved(await s.r.adapter.saveDraft(s.upload({ body: 'First text.' }), s.r.ctx()));
  assert.equal(s.remoteDrafts().length, 1);
  assert.match(s.remoteDrafts()[0].text, /First text\./);
  assert.equal(s.remoteDrafts()[0].messageId, first.remoteMessageId);

  const next = s.upload(
    { body: 'Second text.' },
    { remoteDraftId: first.remoteDraftId, baseRemoteMessageId: first.remoteMessageId },
  );
  const second = saved(await s.r.adapter.saveDraft(next, s.r.ctx()));
  assert.equal(second.remoteDraftId, first.remoteDraftId, 'the same draft is replaced');
  assert.notEqual(second.remoteMessageId, first.remoteMessageId, 'Gmail issued a new message id');
  assert.equal(second.revision, next.revision);
  assert.equal(s.remoteDrafts().length, 1, 'replaced, not duplicated');
  assert.match(s.remoteDrafts()[0].text, /Second text\./);
  assert.doesNotMatch(s.remoteDrafts()[0].text, /First text\./);

  // The returned id is accepted as the base of the next save: the precondition chain holds.
  const third = s.upload(
    { body: 'Third text.' },
    { remoteDraftId: second.remoteDraftId, baseRemoteMessageId: second.remoteMessageId },
  );
  saved(await s.r.adapter.saveDraft(third, s.r.ctx()));
  assert.match(s.remoteDrafts()[0].text, /Third text\./);
});

test('prov-gmail-drafts pacing: governed on the opFlush lane, create is a write, update an idempotentWrite at 15 units', async () => {
  const s = await setup();
  const first = saved(await s.r.adapter.saveDraft(s.upload(), s.r.ctx()));
  const created = apiCalls(s);
  const create = created.find(c => c.method === 'gmail.drafts.create')!;
  assert.equal(create.cost, 10);
  assert.equal(create.kind, 'write', 'a create is never re-sent by the governor');
  const before = created.length;
  await s.r.adapter.saveDraft(
    s.upload(
      {},
      { remoteDraftId: first.remoteDraftId, baseRemoteMessageId: first.remoteMessageId },
    ),
    s.r.ctx(),
  );
  const replace = apiCalls(s, before);
  assert.deepEqual(
    replace.map(c => [c.method, c.cost, c.kind]),
    [
      ['gmail.drafts.get', 20, 'read'],
      ['gmail.drafts.update', 15, 'idempotentWrite'],
      // The copy's Message-ID as Gmail shows it (`copyInternetId`), one metadata read after the write.
      ['gmail.drafts.get', 20, 'read'],
    ],
  );
  assert.ok(apiCalls(s).every(c => c.lane === 'opFlush'));
});

test('prov-gmail-drafts reply threading: threadId is passed, In-Reply-To and References are the engine bytes', async () => {
  const s = await setup();
  const parent = s.r.emu.mailbox.addMessage({
    subject: 'Lunch plans',
    text: 'Where?',
    labelIds: ['INBOX'],
    from: 'friend@example.test',
    messageId: '<parent-1@example.test>',
  });
  const upload = s.upload({
    subject: 'Re: Lunch plans',
    inReplyTo: '<parent-1@example.test>',
    references: '<root@example.test> <parent-1@example.test>',
    body: 'Noon works.',
  });
  const result = saved(
    await s.r.adapter.saveDraft({ ...upload, remoteThreadId: parent.threadId }, s.r.ctx()),
  );
  const sent = s.bridge.uploads.at(-1)!;
  assert.deepEqual(sent.metadata, { message: { threadId: parent.threadId } });
  assert.ok(
    sent.raw.equals(uploadedBytes(upload)),
    'the bytes are not rewritten (only the token is added)',
  );
  const remote = s.r.emu.mailbox.getMessage(result.remoteMessageId)!;
  assert.equal(remote.threadId, parent.threadId, 'the draft sits in the conversation');
  const text = s.remoteDrafts()[0].text;
  assert.match(text, /In-Reply-To: <parent-1@example\.test>/);
  assert.match(text, /References: <root@example\.test> <parent-1@example\.test>/);
});

// ---- two devices ----

test('prov-gmail-drafts a stale base is a conflict and the remote text is untouched', async () => {
  const s = await setup();
  const first = saved(await s.r.adapter.saveDraft(s.upload({ body: 'Mine v1.' }), s.r.ctx()));
  // The phone edits the draft: same draft id, a new message id.
  const { mime } = mimeOf(s.r.account.address, { body: 'Phone edit, do not lose me.' });
  const phone = s.r.emu.mailbox.updateDraft(first.remoteDraftId, mime);
  const writes = s.r.emu.log.filter(e => e.apiMethod === 'gmail.users.drafts.update').length;

  const stale = s.upload(
    { body: 'Mine v2.' },
    { remoteDraftId: first.remoteDraftId, baseRemoteMessageId: first.remoteMessageId },
  );
  const result = await s.r.adapter.saveDraft(stale, s.r.ctx());
  assert.deepEqual(result, { kind: 'conflict', remoteMessageId: phone.message.id });
  assert.equal(
    s.r.emu.log.filter(e => e.apiMethod === 'gmail.users.drafts.update').length,
    writes,
    'no drafts.update was sent',
  );
  assert.equal(s.remoteDrafts().length, 1);
  assert.match(s.remoteDrafts()[0].text, /Phone edit, do not lose me\./);
  assert.doesNotMatch(s.remoteDrafts()[0].text, /Mine v2\./);
  assert.equal(s.bridge.uploads.length, 1, 'only the first create ever uploaded');
});

test('prov-gmail-drafts an update whose answer was lost is a conflict about our own text, never adopted (safe by design)', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const first = saved(await s.r.adapter.saveDraft(s.upload({ body: 'v1' }), s.r.ctx()));
  const next = s.upload(
    { body: 'v2' },
    { remoteDraftId: first.remoteDraftId, baseRemoteMessageId: first.remoteMessageId },
  );
  faults.dropAfterNext({ apiMethod: 'gmail.users.drafts.update' });
  await assert.rejects(s.r.adapter.saveDraft(next, s.r.ctx()), ProviderError);
  assert.match(s.remoteDrafts()[0].text, /v2/, 'the write did land');
  const landed = s.remoteDrafts()[0].messageId;
  // The engine still holds the old base and asks again: a changed id is a conflict, with the id it found.
  assert.deepEqual(await s.r.adapter.saveDraft(next, s.r.ctx()), {
    kind: 'conflict',
    remoteMessageId: landed,
  });
  // The same after a new revision: a conflict, and nothing is written over the copy.
  const newer = s.upload(
    { body: 'v3' },
    { remoteDraftId: first.remoteDraftId, baseRemoteMessageId: first.remoteMessageId },
  );
  assert.equal((await s.r.adapter.saveDraft(newer, s.r.ctx())).kind, 'conflict');
  assert.equal(s.bridge.uploads.length, 2, 'no upload after the lost ack');
  assert.match(s.remoteDrafts()[0].text, /v2/);
});

test('prov-gmail-drafts a phone edit that keeps our Message-ID header is still a conflict and is not overwritten', async () => {
  const s = await setup();
  const first = saved(await s.r.adapter.saveDraft(s.upload({ body: 'v1' }), s.r.ctx()));
  const next = s.upload(
    { body: 'v2' },
    { remoteDraftId: first.remoteDraftId, baseRemoteMessageId: first.remoteMessageId },
  );
  // The other client edits the text and keeps the very Message-ID (and token) this upload will carry.
  const { mime } = mimeOf(s.r.account.address, {
    id: next.internetId,
    token: next.internetId,
    body: 'Phone text.',
  });
  s.r.emu.mailbox.updateDraft(first.remoteDraftId, mime);
  const result = await s.r.adapter.saveDraft(next, s.r.ctx());
  assert.equal(result.kind, 'conflict');
  assert.match(s.remoteDrafts()[0].text, /Phone text\./);
  assert.equal(s.bridge.uploads.length, 1);
});

// ---- gone ----

test('prov-gmail-drafts a draft deleted elsewhere is gone and never recreated', async () => {
  const s = await setup();
  const first = saved(await s.r.adapter.saveDraft(s.upload({ body: 'v1' }), s.r.ctx()));
  s.r.emu.mailbox.deleteDraft(first.remoteDraftId);
  const result = await s.r.adapter.saveDraft(
    s.upload(
      {},
      { remoteDraftId: first.remoteDraftId, baseRemoteMessageId: first.remoteMessageId },
    ),
    s.r.ctx(),
  );
  assert.deepEqual(result, { kind: 'gone' });
  assert.equal(s.remoteDrafts().length, 0, 'nothing was recreated');
  assert.equal(s.bridge.uploads.length, 1);
});

test('prov-gmail-drafts a draft sent from another device is gone, and the sent message is untouched', async () => {
  const s = await setup();
  const first = saved(await s.r.adapter.saveDraft(s.upload({ body: 'Final words.' }), s.r.ctx()));
  const sentMessage = s.r.emu.mailbox.sendDraft(first.remoteDraftId);
  const rawBefore = s.r.emu.mailbox.rawOf(sentMessage.id);
  const result = await s.r.adapter.saveDraft(
    s.upload(
      {},
      { remoteDraftId: first.remoteDraftId, baseRemoteMessageId: first.remoteMessageId },
    ),
    s.r.ctx(),
  );
  assert.deepEqual(result, { kind: 'gone' });
  assert.equal(s.remoteDrafts().length, 0);
  assert.ok(s.r.emu.mailbox.rawOf(sentMessage.id).equals(rawBefore), 'the sent message is intact');
  assert.ok(s.r.emu.mailbox.getMessage(sentMessage.id)!.labelIds.includes('SENT'));
  assert.equal(s.bridge.uploads.length, 1);
});

test('prov-gmail-drafts a copy that is addressable but no longer a draft (SENT, no DRAFT label) is gone and is not written', async () => {
  const s = await setup();
  const first = saved(await s.r.adapter.saveDraft(s.upload({ body: 'v1' }), s.r.ctx()));
  s.bridge.rewriteDraftGet = json => {
    const message = json.message as Record<string, unknown>;
    return { ...json, message: { ...message, labelIds: ['SENT'] } };
  };
  const result = await s.r.adapter.saveDraft(
    s.upload(
      {},
      { remoteDraftId: first.remoteDraftId, baseRemoteMessageId: first.remoteMessageId },
    ),
    s.r.ctx(),
  );
  assert.deepEqual(result, { kind: 'gone' });
  assert.equal(s.bridge.uploads.length, 1, 'no update was sent');
  // Missing the DRAFT label alone is also not a draft.
  s.bridge.rewriteDraftGet = json => {
    const message = json.message as Record<string, unknown>;
    return { ...json, message: { ...message, labelIds: ['INBOX'] } };
  };
  const result2 = await s.r.adapter.saveDraft(
    s.upload(
      {},
      { remoteDraftId: first.remoteDraftId, baseRemoteMessageId: first.remoteMessageId },
    ),
    s.r.ctx(),
  );
  assert.deepEqual(result2, { kind: 'gone' });
  assert.equal(s.bridge.uploads.length, 1);
});

test('prov-gmail-drafts a draft deleted between the read and the write is gone (confirmed by a re-read), not recreated', async () => {
  const s = await setup();
  const made = saved(await s.r.adapter.saveDraft(s.upload({ body: 'v1' }), s.r.ctx()));
  s.bridge.beforeDelivery = () => s.r.emu.mailbox.deleteDraft(made.remoteDraftId);
  const result = await s.r.adapter.saveDraft(
    s.upload({}, { remoteDraftId: made.remoteDraftId, baseRemoteMessageId: made.remoteMessageId }),
    s.r.ctx(),
  );
  assert.deepEqual(result, { kind: 'gone' });
  assert.equal(s.bridge.uploads.filter(u => u.draftId === undefined).length, 1, 'no second create');
  assert.equal(s.remoteDrafts().length, 0);
});

test('prov-gmail-drafts a 404 on update while the draft still exists is uncertain, never gone', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const made = saved(await s.r.adapter.saveDraft(s.upload({ body: 'v1' }), s.r.ctx()));
  faults.failNext(
    { apiMethod: 'gmail.users.drafts.update' },
    { status: 404, reason: 'notFound', message: 'Requested entity was not found.' },
  );
  const error = await s.r.adapter
    .saveDraft(
      s.upload(
        {},
        { remoteDraftId: made.remoteDraftId, baseRemoteMessageId: made.remoteMessageId },
      ),
      s.r.ctx(),
    )
    .catch((e: unknown) => e);
  assert.ok(error instanceof ProviderError, 'thrown, not a result');
  assert.equal(error.error.class, 'transient');
  assert.equal(error.error.uncertain, true);
  assert.equal(s.remoteDrafts().length, 1, 'the copy is still there');
});

test('prov-gmail-drafts a trashed draft is gone; a reply without labelIds is invalid, not "not a draft"', async () => {
  const s = await setup({ adapter: { deleteDrafts: true } });
  const first = saved(await s.r.adapter.saveDraft(s.upload({ body: 'v1' }), s.r.ctx()));
  const again = () =>
    s.upload(
      {},
      { remoteDraftId: first.remoteDraftId, baseRemoteMessageId: first.remoteMessageId },
    );
  const relabel = (labelIds?: string[]) => (json: Record<string, unknown>) => {
    const { labelIds: _dropped, ...rest } = json.message as Record<string, unknown>;
    return { ...json, message: { ...rest, ...(labelIds ? { labelIds } : {}) } };
  };
  s.bridge.rewriteDraftGet = relabel(['DRAFT', 'TRASH']);
  assert.deepEqual(await s.r.adapter.saveDraft(again(), s.r.ctx()), { kind: 'gone' });
  await s.r.adapter.deleteDraft(first.remoteDraftId, s.r.ctx(), first.remoteMessageId);
  assert.equal(s.bridge.count('DELETE', /\/drafts\//), 0, 'a trashed draft is not deleted either');

  s.bridge.rewriteDraftGet = relabel();
  const save = await s.r.adapter.saveDraft(again(), s.r.ctx()).catch((e: unknown) => e);
  assert.ok(save instanceof ProviderError);
  assert.equal(save.error.reason, 'invalidResponse');
  const del = await s.r.adapter
    .deleteDraft(first.remoteDraftId, s.r.ctx(), first.remoteMessageId)
    .catch((e: unknown) => e);
  assert.ok(del instanceof ProviderError);
  assert.equal(s.bridge.count('DELETE', /\/drafts\//), 0);
  assert.equal(s.bridge.uploads.length, 1);
  assert.equal(s.remoteDrafts().length, 1);
});

// ---- uncertain create ----

test('prov-gmail-drafts an uncertain create is recognised by its Message-ID and never duplicated', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  // An unrelated draft from a phone must never be mistaken for ours.
  s.r.emu.mailbox.createDraftElsewhere({ subject: 'Phone draft', text: 'Not ours.' });
  const upload = s.upload({ body: 'Created once.' });
  faults.dropAfterNext({ apiMethod: 'gmail.users.drafts.create' });
  // The reply is lost AND the immediate re-check fails too: the engine gets an uncertain error.
  faults.failNext(
    { apiMethod: 'gmail.users.drafts.list', after: 2 },
    { status: 503, reason: 'backendError', message: 'Backend Error' },
  );
  let thrown: unknown;
  await s.r.adapter.saveDraft(upload, s.r.ctx()).catch((e: unknown) => (thrown = e));
  assert.ok(thrown instanceof ProviderError);
  assert.equal(thrown.error.uncertain, true);
  assert.equal(s.remoteDrafts().filter(d => d.text.includes('Created once.')).length, 1);

  // The engine retries the same revision with the same Message-ID.
  const retried = saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
  const ours = s.remoteDrafts().filter(d => d.text.includes('Created once.'));
  assert.equal(ours.length, 1, 'still one copy');
  assert.equal(retried.remoteDraftId, ours[0].id);
  assert.equal(retried.remoteMessageId, ours[0].messageId);
  assert.equal(s.bridge.uploads.length, 1, 'the retry uploaded nothing');
});

test('prov-gmail-drafts an uncertain create that the immediate re-check finds is answered at once', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  faults.dropAfterNext({ apiMethod: 'gmail.users.drafts.create' });
  const result = saved(await s.r.adapter.saveDraft(s.upload({ body: 'Found.' }), s.r.ctx()));
  assert.equal(s.remoteDrafts().length, 1);
  assert.equal(result.remoteMessageId, s.remoteDrafts()[0].messageId);
});

test('prov-gmail-drafts a create that Gmail refused is not uncertain, and a 5xx on a create is', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  faults.failNext(
    { apiMethod: 'gmail.users.drafts.create' },
    { status: 400, reason: 'invalidArgument', message: 'Invalid To header' },
  );
  const refused = await s.r.adapter.saveDraft(s.upload(), s.r.ctx()).catch((e: unknown) => e);
  assert.ok(refused instanceof ProviderError);
  assert.equal(refused.error.class, 'permanent');
  assert.notEqual(refused.error.uncertain, true);

  faults.failNext(
    { apiMethod: 'gmail.users.drafts.create' },
    { status: 503, reason: 'backendError', message: 'Backend Error' },
  );
  const flaky = await s.r.adapter.saveDraft(s.upload(), s.r.ctx()).catch((e: unknown) => e);
  assert.ok(flaky instanceof ProviderError);
  assert.equal(flaky.error.class, 'transient');
  assert.equal(flaky.error.uncertain, true, 'a 5xx may have stored the draft');
});

// ---- deleteDraft ----

test('prov-gmail-drafts deleteDraft removes the copy; a missing draft is success with no delete request', async () => {
  const s = await setup({ adapter: { deleteDrafts: true } });
  const first = saved(await s.r.adapter.saveDraft(s.upload(), s.r.ctx()));
  await s.r.adapter.deleteDraft(first.remoteDraftId, s.r.ctx(), first.remoteMessageId);
  assert.equal(s.remoteDrafts().length, 0);
  assert.equal(s.r.emu.mailbox.getMessage(first.remoteMessageId), undefined);
  const deletes = s.bridge.count('DELETE', /\/drafts\//);
  await s.r.adapter.deleteDraft(first.remoteDraftId, s.r.ctx(), first.remoteMessageId);
  assert.equal(s.bridge.count('DELETE', /\/drafts\//), deletes, 'the second call only looked');
});

test('prov-gmail-drafts deleteDraft of a draft that was sent does nothing', async () => {
  const s = await setup({ adapter: { deleteDrafts: true } });
  const first = saved(await s.r.adapter.saveDraft(s.upload({ body: 'Out.' }), s.r.ctx()));
  const sentMessage = s.r.emu.mailbox.sendDraft(first.remoteDraftId);
  await s.r.adapter.deleteDraft(first.remoteDraftId, s.r.ctx(), first.remoteMessageId);
  assert.ok(s.r.emu.mailbox.getMessage(sentMessage.id), 'the sent message survives');
  assert.equal(s.bridge.count('DELETE', /\/drafts\//), 0);

  // The draft id still resolves but the message is no longer a draft: also nothing.
  const other = saved(await s.r.adapter.saveDraft(s.upload({ body: 'Stay.' }), s.r.ctx()));
  s.bridge.rewriteDraftGet = json => {
    const message = json.message as Record<string, unknown>;
    return { ...json, message: { ...message, labelIds: ['SENT'] } };
  };
  await s.r.adapter.deleteDraft(other.remoteDraftId, s.r.ctx(), other.remoteMessageId);
  assert.equal(s.bridge.count('DELETE', /\/drafts\//), 0, 'no DELETE for a non-draft');
  assert.equal(s.remoteDrafts().length, 1);
});

// ---- refusals before any request ----

test('prov-gmail-drafts Bcc (or any header the writer does not produce) is refused with no request', async () => {
  const s = await setup();
  const refuse = async (extra: string[], reason: string, over: Partial<DraftUpload> = {}) => {
    const error = await s.r.adapter
      .saveDraft(s.upload({ extra }, over), s.r.ctx())
      .catch((e: unknown) => e);
    assert.ok(error instanceof ProviderError, `${reason} refused`);
    assert.equal(error.error.class, 'permanent');
    assert.equal(error.error.reason, reason);
  };
  await refuse(['Bcc: hidden@example.test'], 'bccInDraft');
  await refuse(['bcc: hidden@example.test'], 'bccInDraft');
  await refuse(['Reply-To: elsewhere@example.test'], 'unexpectedHeader');
  await refuse(['To: second@example.test'], 'duplicateHeader');
  await refuse(['X-Evil: a\nBcc: hidden@example.test'], 'bareLineBreak');
  // A replace is refused before its drafts.get as well.
  await refuse(['Bcc: hidden@example.test'], 'bccInDraft', {
    remoteDraftId: 'r1abc',
    baseRemoteMessageId: 'a1',
  });
  const wrongId = await s.r.adapter
    .saveDraft({ ...s.upload(), internetId: '<someone-else@aplos.test>' }, s.r.ctx())
    .catch((e: unknown) => e);
  assert.ok(wrongId instanceof ProviderError);
  assert.equal(wrongId.error.reason, 'messageIdMismatch');
  assert.equal(s.bridge.requests.length, 0, 'nothing reached the network');
  assert.equal(s.r.governor.calls.length, 0, 'nothing was governed');
  assert.equal(s.remoteDrafts().length, 0);
});

test('prov-gmail-drafts an oversize draft is refused as permanent with no request', async () => {
  const s = await setup();
  const huge = s.upload();
  const padding = Buffer.alloc(35 * 1024 * 1024 + 1, 0x61);
  const error = await s.r.adapter
    .saveDraft({ ...huge, mime: Buffer.concat([Buffer.from(huge.mime), padding]) }, s.r.ctx())
    .catch((e: unknown) => e);
  assert.ok(error instanceof ProviderError);
  assert.equal(error.error.class, 'permanent');
  assert.equal(error.error.reason, 'messageTooLarge');
  assert.equal(s.bridge.requests.length, 0);
  assert.equal(s.r.governor.calls.length, 0);
});

test('prov-gmail-drafts the 35 MB limit: accepted at exactly the limit, refused one byte over with no request', async () => {
  const s = await setup();
  const limit = 35 * 1024 * 1024;
  const base = s.upload({ body: '' });
  // The limit is on what goes up: the engine's MIME plus the `X-Aplos-Draft` token line.
  const token = uploadedBytes(base).length - base.mime.length;
  const pad = (bytes: number) => Buffer.concat([Buffer.from(base.mime), Buffer.alloc(bytes, 0x61)]);
  const atLimit = pad(limit - token - base.mime.length);
  assert.equal(uploadedBytes({ ...base, mime: atLimit }).length, limit);
  const over = await s.r.adapter
    .saveDraft({ ...base, mime: pad(limit - token - base.mime.length + 1) }, s.r.ctx())
    .catch((e: unknown) => e);
  assert.ok(over instanceof ProviderError);
  assert.equal(over.error.reason, 'messageTooLarge');
  assert.equal(s.bridge.requests.length, 0);
  assert.equal(s.r.governor.calls.length, 0);
  saved(await s.r.adapter.saveDraft({ ...base, mime: atLimit }, s.r.ctx()));
  assert.equal(s.bridge.uploads.at(-1)!.uploadType, 'resumable');
  assert.equal(s.bridge.uploads.at(-1)!.raw.length, limit);
});

// ---- the upload path ----

test('prov-gmail-drafts a small draft is a multipart upload; a large one is resumable and arrives byte for byte', async () => {
  const s = await setup();
  const small = s.upload({ body: 'tiny' });
  const a = saved(await s.r.adapter.saveDraft(small, s.r.ctx()));
  assert.equal(s.bridge.uploads.at(-1)!.uploadType, 'multipart');
  assert.ok(s.bridge.uploads.at(-1)!.raw.equals(uploadedBytes(small)));

  const line = 'a'.repeat(74) + CRLF;
  const big = s.upload({ body: line.repeat(Math.ceil((5.5 * 1024 * 1024) / line.length)) });
  assert.ok(big.mime.length > 5 * 1024 * 1024);
  const requestsBefore = s.bridge.requests.length;
  const b = saved(
    await s.r.adapter.saveDraft(
      { ...big, remoteDraftId: a.remoteDraftId, baseRemoteMessageId: a.remoteMessageId },
      s.r.ctx(),
    ),
  );
  const upload = s.bridge.uploads.at(-1)!;
  assert.equal(upload.uploadType, 'resumable');
  assert.equal(upload.httpMethod, 'PUT');
  assert.equal(upload.draftId, a.remoteDraftId);
  assert.ok(upload.raw.equals(uploadedBytes(big)), 'every byte arrived');
  const uploadRequests = s.bridge.requests
    .slice(requestsBefore)
    .filter(r => r.path.startsWith('/upload/'));
  assert.equal(uploadRequests.length, 2, 'a session request, then the bytes');
  assert.equal(b.remoteDraftId, a.remoteDraftId);
  assert.equal(s.remoteDrafts().length, 1);
});

test('prov-gmail-drafts a resumable session URI that is not Google over HTTPS is not followed', async () => {
  const s = await setup();
  s.bridge.sessionLocation = 'https://evil.example/s';
  const line = 'a'.repeat(74) + CRLF;
  const big = s.upload({ body: line.repeat(Math.ceil((5.5 * 1024 * 1024) / line.length)) });
  const error = await s.r.adapter.saveDraft(big, s.r.ctx()).catch((e: unknown) => e);
  assert.ok(error instanceof ProviderError);
  assert.equal(error.error.reason, 'invalidUploadSession');
  assert.equal(s.bridge.uploads.length, 0);
  assert.ok(!s.bridge.requests.some(r => r.path === '/s'), 'the hostile URI was never requested');
  assert.equal(s.remoteDrafts().length, 0);
});

// ---- error classes ----

test('prov-gmail-drafts 429 pauses (throttle, zero requests while paused); 5xx on an update is transient and nothing is lost', async () => {
  const faults = createFaultInjector();
  const s = await setup({ adapter: { deleteDrafts: true }, emulator: { faults } });
  const first = saved(await s.r.adapter.saveDraft(s.upload({ body: 'v1' }), s.r.ctx()));
  const base = { remoteDraftId: first.remoteDraftId, baseRemoteMessageId: first.remoteMessageId };

  faults.failNext(
    { apiMethod: 'gmail.users.drafts.update' },
    { status: 503, reason: 'backendError', message: 'Backend Error' },
  );
  const flaky = await s.r.adapter
    .saveDraft(s.upload({ body: 'v2' }, base), s.r.ctx())
    .catch(e => e);
  assert.ok(flaky instanceof ProviderError);
  assert.equal(flaky.error.class, 'transient');
  assert.notEqual(flaky.error.uncertain, true, 'an update by id is idempotent');
  assert.match(s.remoteDrafts()[0].text, /v1/, 'the remote text is still the old one');

  faults.failNext(
    { apiMethod: 'gmail.users.drafts.update' },
    {
      status: 429,
      reason: 'rateLimitExceeded',
      message: 'Rate limit exceeded',
      retryAfterSeconds: 30,
    },
  );
  const limited = await s.r.adapter
    .saveDraft(s.upload({ body: 'v2' }, base), s.r.ctx())
    .catch(e => e);
  assert.ok(limited instanceof ProviderError);
  assert.equal(limited.error.class, 'throttle');
  const logged = s.r.emu.log.length;
  const paused = await s.r.adapter
    .saveDraft(s.upload({ body: 'v2' }, base), s.r.ctx())
    .catch(e => e);
  assert.ok(paused instanceof PausedError);
  assert.equal(s.r.emu.log.length, logged, 'no request while paused');
  await s.r.adapter.deleteDraft(first.remoteDraftId, s.r.ctx(), first.remoteMessageId).then(
    () => assert.fail('a paused delete must not go out'),
    (e: unknown) => assert.ok(e instanceof PausedError),
  );
  assert.equal(s.r.emu.log.length, logged);

  // After the pause the same save goes through.
  await s.r.clock.advance(31_000);
  saved(await s.r.adapter.saveDraft(s.upload({ body: 'v2' }, base), s.r.ctx()));
  assert.match(s.remoteDrafts()[0].text, /v2/);
});

test('prov-gmail-drafts a create refused with 429 stops: the engine learns of the pause, not an uncertain write', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  faults.failNext(
    { apiMethod: 'gmail.users.drafts.create' },
    { status: 429, reason: 'rateLimitExceeded', message: 'Rate limit exceeded' },
  );
  const error = await s.r.adapter.saveDraft(s.upload(), s.r.ctx()).catch((e: unknown) => e);
  assert.ok(error instanceof ProviderError);
  assert.equal(error.error.class, 'throttle');
  assert.notEqual(error.error.uncertain, true);
  assert.equal(s.remoteDrafts().length, 0);
});

// ---- PORT GAP 3 (closed by #153): removal is guarded by the expected message id ----

test('prov-gmail-drafts deleteDraft without an expected message id never deletes and sends no request', async () => {
  const s = await setup({ adapter: { deleteDrafts: undefined } });
  const first = saved(await s.r.adapter.saveDraft(s.upload({ body: 'Mine.' }), s.r.ctx()));
  const { mime } = mimeOf(s.r.account.address, { body: 'Phone edit, newer than the last poll.' });
  s.r.emu.mailbox.updateDraft(first.remoteDraftId, mime);
  const requests = s.bridge.requests.length;
  await s.r.adapter.deleteDraft(first.remoteDraftId, s.r.ctx());
  assert.equal(s.bridge.requests.length, requests, 'resolved without a request');
  assert.equal(s.remoteDrafts().length, 1);
  assert.match(s.remoteDrafts()[0].text, /Phone edit/);
});

test('prov-gmail-drafts deleteDraft with a stale expected message id keeps the phone edit', async () => {
  const s = await setup();
  const first = saved(await s.r.adapter.saveDraft(s.upload({ body: 'Mine.' }), s.r.ctx()));
  const { mime } = mimeOf(s.r.account.address, { body: 'Phone edit, newer than the last poll.' });
  const phone = s.r.emu.mailbox.updateDraft(first.remoteDraftId, mime);
  assert.notEqual(phone.message.id, first.remoteMessageId);
  await s.r.adapter.deleteDraft(first.remoteDraftId, s.r.ctx(), first.remoteMessageId);
  assert.equal(s.bridge.count('DELETE', /\/drafts\//), 0, 'no DELETE went out');
  assert.equal(s.remoteDrafts().length, 1);
  assert.match(s.remoteDrafts()[0].text, /Phone edit/);
  // Naming the phone's version (the engine adopted it) deletes it.
  await s.r.adapter.deleteDraft(first.remoteDraftId, s.r.ctx(), phone.message.id);
  assert.equal(s.remoteDrafts().length, 0);
});

test('prov-gmail-drafts deleteDraft with a matching id deletes; a 404 on the delete is success', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const first = saved(await s.r.adapter.saveDraft(s.upload({ body: 'Mine.' }), s.r.ctx()));
  // The draft vanishes between the get and the delete (deleted on another device): the DELETE answers 404.
  faults.failNext(
    { apiMethod: 'gmail.users.drafts.delete' },
    { status: 404, reason: 'notFound', message: 'Requested entity was not found.' },
  );
  await s.r.adapter.deleteDraft(first.remoteDraftId, s.r.ctx(), first.remoteMessageId);
  assert.equal(s.bridge.count('DELETE', /\/drafts\//), 1, 'the delete went out');
  const again = await s.r.adapter.deleteDraft(
    first.remoteDraftId,
    s.r.ctx(),
    first.remoteMessageId,
  );
  assert.equal(again, undefined);
  assert.equal(s.remoteDrafts().length, 0, 'the second call deleted it for real');
});

test('prov-gmail-drafts deleteDrafts: false turns even a guarded removal off', async () => {
  const s = await setup({ adapter: { deleteDrafts: false } });
  const first = saved(await s.r.adapter.saveDraft(s.upload({ body: 'Mine.' }), s.r.ctx()));
  const requests = s.bridge.requests.length;
  await s.r.adapter.deleteDraft(first.remoteDraftId, s.r.ctx(), first.remoteMessageId);
  assert.equal(s.bridge.requests.length, requests);
  assert.equal(s.remoteDrafts().length, 1);
});

// ---- the create lookup: search lag, sent or deleted elsewhere ----

test('prov-gmail-drafts search lag: a copy the q search cannot see yet is found in the newest drafts, not duplicated', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  s.bridge.blindSearch = true;
  const upload = s.upload({ body: 'Lagging.' });
  faults.dropAfterNext({ apiMethod: 'gmail.users.drafts.create' });
  const first = saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
  const again = saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
  assert.equal(s.remoteDrafts().length, 1, 'one copy');
  assert.equal(first.remoteDraftId, again.remoteDraftId);
  assert.equal(s.bridge.uploads.length, 1);
});

test('prov-gmail-drafts a created draft sent from the phone before the retry is gone, not created again', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const upload = await uncertainCreate(s, faults);
  const sentMessage = s.r.emu.mailbox.sendDraft(s.remoteDrafts()[0].id);
  assert.deepEqual(await s.r.adapter.saveDraft(upload, s.r.ctx()), { kind: 'gone' });
  assert.equal(s.remoteDrafts().length, 0, 'no draft came back');
  assert.equal(s.bridge.uploads.length, 1, 'nothing was created again');
  assert.ok(s.r.emu.mailbox.getMessage(sentMessage.id)!.labelIds.includes('SENT'));
});

test('prov-gmail-drafts a created draft trashed from the phone before the retry is gone, not created again', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const upload = await uncertainCreate(s, faults);
  s.r.emu.mailbox.trashMessage(s.remoteDrafts()[0].messageId);
  assert.deepEqual(await s.r.adapter.saveDraft(upload, s.r.ctx()), { kind: 'gone' });
  assert.equal(s.bridge.uploads.length, 1);
});

test('prov-gmail-drafts known limit: a created draft hard-deleted elsewhere leaves nothing to find and is created again', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const upload = await uncertainCreate(s, faults);
  s.r.emu.mailbox.deleteDraft(s.remoteDrafts()[0].id);
  saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
  assert.equal(s.bridge.uploads.length, 2);
});
