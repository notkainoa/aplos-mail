/**
 * prov-gmail drafts, the `X-Aplos-Draft` identity token (google/draft-token.ts, plans/engine/draft-identity.md item 3).
 * Real Gmail replaces the Message-ID of every draft it saves through the API; the emulator does the same with
 * `draftIdentity: 'rewritten'`, and `dropDraftHeaders` also drops the token. Every test here sets the mode itself, so
 * the file means the same with or without `APLOS_EMU_DRAFT_IDENTITY`.
 *
 * Rules: the token FINDS and NAMES our copy, the content proves it. With the token kept, a lost-reply create is adopted
 * and a later revision replaces the same copy; with it dropped, only the content-matched fallback (bytes equal to an
 * upload this adapter recorded) adopts, else a visible duplicate; a forged token on other content is a conflict, never
 * adopted or replaced; nothing is ever deleted.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFaultInjector, type GmailEmulatorOptions } from '@aplos/emulators';
import { ProviderError, type DraftUpload, type RemoteDraftFact } from '@aplos/engine/ports';
import { rawIdentity, sameDraftContent } from '../../src/host/providers/google/draft-compare';
import { checkDraftMime } from '../../src/host/providers/google/draft-mime';
import {
  identityOf,
  isDraftToken,
  withDraftToken,
} from '../../src/host/providers/google/draft-token';
import { mimeOf, saved, setup, uncertainCreate, uploadedBytes, type Setup } from './draft-rig';
import { sendWorld, submission } from './send-rig';

const REWRITTEN: Partial<GmailEmulatorOptions> = {
  draftIdentity: 'rewritten',
  dropDraftHeaders: [],
};
const DROPPED: Partial<GmailEmulatorOptions> = {
  draftIdentity: 'rewritten',
  dropDraftHeaders: ['X-Aplos-Draft'],
};

async function world(mode: Partial<GmailEmulatorOptions>) {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults, ...mode } });
  return { s, faults };
}

/** The header block of a stored draft, unfolded lines. */
const headLines = (text: string): string[] =>
  text
    .slice(0, text.indexOf('\r\n\r\n'))
    .replace(/\r\n[ \t]+/g, ' ')
    .split('\r\n');

const headerValues = (text: string, name: string): string[] =>
  headLines(text)
    .filter(l => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))
    .map(l => l.slice(name.length + 1).trim());

// ---- (a) Gmail rewrites the Message-ID, the token is kept ----

test('token: what goes up carries exactly one X-Aplos-Draft equal to the upload Message-ID, as the first header', async () => {
  const { s } = await world(REWRITTEN);
  const upload = s.upload({ body: 'Tokened.' });
  saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
  const raw = s.bridge.uploads[0].raw;
  assert.ok(
    raw.equals(
      Buffer.concat([Buffer.from(`X-Aplos-Draft: ${upload.internetId}\r\n`), upload.mime]),
    ),
  );
  const stored = s.remoteDrafts()[0].text;
  assert.deepEqual(headerValues(stored, 'X-Aplos-Draft'), [upload.internetId], 'Gmail kept it');
  assert.notDeepEqual(
    headerValues(stored, 'Message-ID'),
    [upload.internetId],
    'Gmail replaced ours',
  );
});

test('token (rewritten, kept): a lost-reply create is adopted by its token, no duplicate, nothing written again', async () => {
  const { s, faults } = await world(REWRITTEN);
  const upload = await uncertainCreate(s, faults);
  const [copy] = s.remoteDrafts();
  const result = saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
  assert.equal(result.remoteDraftId, copy.id);
  assert.equal(result.remoteMessageId, copy.messageId);
  assert.equal(result.copyInternetId, headerValues(copy.text, 'Message-ID')[0], "Gmail's id");
  assert.equal(s.remoteDrafts().length, 1, 'one copy');
  assert.equal(s.bridge.uploads.length, 1, 'the retry uploaded nothing');
});

test('token (rewritten, kept): a lost-reply create, then revision 2 replaces the same copy via supersedes', async () => {
  const { s, faults } = await world(REWRITTEN);
  const first = await uncertainCreate(s, faults);
  const draftId = s.remoteDrafts()[0].id;
  const next = s.upload({ body: 'Revision two.' }, { supersedes: [first.internetId] });
  const result = saved(await s.r.adapter.saveDraft(next, s.r.ctx()));
  assert.equal(result.remoteDraftId, draftId, 'the earlier copy was replaced');
  assert.equal(s.remoteDrafts().length, 1, 'one draft total');
  assert.match(s.remoteDrafts()[0].text, /Revision two\./);
  assert.deepEqual(headerValues(s.remoteDrafts()[0].text, 'X-Aplos-Draft'), [next.internetId]);
  assert.equal(s.bridge.uploads.length, 2, 'one create, one update');
});

for (const [name, move] of [
  ['sent', (s: Setup) => s.r.emu.mailbox.sendDraft(s.remoteDrafts()[0].id)],
  ['trashed', (s: Setup) => s.r.emu.mailbox.trashMessage(s.remoteDrafts()[0].messageId)],
] as const) {
  test(`token (rewritten, kept): a lost-reply create ${name} from the phone before the retry is gone (Sent/Trash scan)`, async () => {
    const { s, faults } = await world(REWRITTEN);
    const upload = await uncertainCreate(s, faults);
    move(s);
    assert.deepEqual(await s.r.adapter.saveDraft(upload, s.r.ctx()), { kind: 'gone' });
    assert.equal(s.bridge.uploads.length, 1, 'nothing was created again');
  });
}

test('token (rewritten, kept) known limit: a copy beyond the newest page and not yet searchable is created again, nothing else touched', async () => {
  const { s, faults } = await world(REWRITTEN);
  const upload = await uncertainCreate(s, faults);
  s.bridge.blindSearch = true;
  for (let i = 0; i < 11; i++)
    s.r.emu.mailbox.createDraftElsewhere({ subject: `Phone ${i}`, text: 'Not ours.' });
  const before = s.remoteDrafts().map(d => [d.id, d.messageId, d.text]);
  saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
  const after = s.remoteDrafts();
  assert.equal(after.length, before.length + 1, 'a visible duplicate');
  for (const [id, messageId, text] of before) {
    const kept = after.find(d => d.id === id);
    assert.deepEqual([kept?.messageId, kept?.text], [messageId, text], 'untouched');
  }
});

// ---- (b) Gmail rewrites the Message-ID AND drops the token ----

test('token (dropped): a lost-reply create is adopted only by the content-matched fallback against the recorded upload', async () => {
  const { s, faults } = await world(DROPPED);
  const upload = await uncertainCreate(s, faults);
  const [copy] = s.remoteDrafts();
  assert.deepEqual(headerValues(copy.text, 'X-Aplos-Draft'), [], 'Gmail dropped the token');
  const result = saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
  assert.equal(result.remoteDraftId, copy.id);
  assert.equal(result.copyInternetId, headerValues(copy.text, 'Message-ID')[0]);
  assert.equal(s.remoteDrafts().length, 1);
  assert.equal(s.bridge.uploads.length, 1);
});

test('token (dropped): a phone edit of the lost copy is never adopted or overwritten; the retry makes a visible duplicate', async () => {
  const { s, faults } = await world(DROPPED);
  const upload = await uncertainCreate(s, faults);
  const remote = s.remoteDrafts()[0];
  const { mime } = mimeOf(s.r.account.address, { id: upload.internetId, body: 'Phone text.' });
  const phone = s.r.emu.mailbox.updateDraft(remote.id, mime);
  const result = saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
  assert.notEqual(result.remoteDraftId, remote.id, 'not adopted');
  const drafts = s.remoteDrafts();
  assert.equal(drafts.length, 2, 'a duplicate, never an overwrite');
  const kept = drafts.find(d => d.id === remote.id);
  assert.equal(kept?.messageId, phone.message.id, 'the phone copy was not written');
  assert.match(kept!.text, /Phone text\./);
});

test('token (dropped): a copy nobody recorded (a restart) is never adopted: a plain create next to it', async () => {
  const { s } = await world(DROPPED);
  const upload = s.upload({ body: 'Before the restart.' });
  const old = s.r.emu.mailbox.createDraft(uploadedBytes(upload));
  const result = saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
  assert.notEqual(result.remoteDraftId, old.id);
  assert.equal(s.remoteDrafts().length, 2);
  assert.ok(s.remoteDrafts().some(d => d.id === old.id && d.messageId === old.message.id));
});

test('token (dropped): revision 2 after a lost create cannot prove the earlier copy: a duplicate, the copy untouched', async () => {
  const { s, faults } = await world(DROPPED);
  const first = await uncertainCreate(s, faults);
  const remote = s.remoteDrafts()[0];
  const next = s.upload({ body: 'Revision two.' }, { supersedes: [first.internetId] });
  saved(await s.r.adapter.saveDraft(next, s.r.ctx()));
  const drafts = s.remoteDrafts();
  assert.equal(drafts.length, 2);
  const kept = drafts.find(d => d.id === remote.id);
  assert.equal(kept?.messageId, remote.messageId, 'never replaced without proof');
  assert.equal(s.bridge.uploads.length, 2, 'two creates, no update');
});

// ---- (c) a forged or copied token proves nothing ----

for (const mode of [REWRITTEN, { draftIdentity: 'kept' as const }]) {
  test(`token (${mode.draftIdentity}): a foreign draft carrying our token with other content is a conflict, never adopted`, async () => {
    const { s } = await world(mode);
    const upload = s.upload({ body: 'Ours.' });
    const foreign = s.r.emu.mailbox.createDraftElsewhere({
      subject: 'Draft subject',
      text: 'Forged.',
      headers: { 'X-Aplos-Draft': upload.internetId },
    });
    const result = await s.r.adapter.saveDraft(upload, s.r.ctx());
    assert.deepEqual(result, {
      kind: 'conflict',
      remoteDraftId: foreign.draftId,
      remoteMessageId: foreign.messageId,
      remoteInternetId: upload.internetId,
    });
    assert.equal(s.bridge.uploads.length, 0, 'nothing was written');
    assert.equal(s.remoteDrafts()[0].messageId, foreign.messageId);
  });
}

test('token (rewritten): a foreign draft with a copied earlier token is a conflict for supersedes, never replaced', async () => {
  const { s, faults } = await world(REWRITTEN);
  const first = await uncertainCreate(s, faults);
  // Our copy is gone (hard-deleted elsewhere); another draft carries its token with other content.
  s.r.emu.mailbox.deleteDraft(s.remoteDrafts()[0].id);
  const foreign = s.r.emu.mailbox.createDraftElsewhere({
    subject: 'Draft subject',
    text: 'Copied header.',
    headers: { 'X-Aplos-Draft': first.internetId },
  });
  const next = s.upload({ body: 'Revision two.' }, { supersedes: [first.internetId] });
  const result = await s.r.adapter.saveDraft(next, s.r.ctx());
  assert.equal(result.kind, 'conflict');
  if (result.kind !== 'conflict') return;
  assert.equal(result.remoteDraftId, foreign.draftId);
  assert.equal(s.bridge.uploads.length, 1, 'nothing was written');
  assert.equal(s.remoteDrafts().length, 1);
  assert.equal(s.remoteDrafts()[0].messageId, foreign.messageId);
});

// ---- (d) history facts report the token ----

async function factFor(s: Setup, remoteDraftId: string): Promise<RemoteDraftFact> {
  const from = s.r.store.commits.length;
  for (let i = 0; i < 50; i++) {
    await s.r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 1 });
    if (!/^pass:/.test(s.r.store.states.get('history')?.phase ?? '')) break;
  }
  const facts = s.r.store.commits.slice(from).flatMap(c => c.result.drafts ?? []);
  return facts.find(f => f.remoteDraftId === remoteDraftId) as RemoteDraftFact;
}

async function historyWorld(mode: Partial<GmailEmulatorOptions>) {
  const s = await setup({ threads: 60, emulator: mode });
  await s.r.drive({
    until: () => s.r.store.states.get('window:inbox')?.phase === 'done',
    maxSteps: 300,
  });
  await s.r.clock.advance(60_000);
  return s;
}

test("token (d): the history fact for our own copy names the token as internetId, not Gmail's Message-ID", async () => {
  const s = await historyWorld(REWRITTEN);
  const upload = s.upload({ body: 'History.' });
  const result = saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
  const fact = await factFor(s, result.remoteDraftId);
  assert.ok(fact, 'a fact was reported');
  assert.equal(fact.internetId, upload.internetId);
  assert.notEqual(result.copyInternetId, undefined);
  assert.notEqual(fact.internetId, result.copyInternetId);
});

for (const [name, token] of [
  ['malformed', 'not a token'],
  ['two ids', '<a@x.test> <b@x.test>'],
  ['no angle brackets', 'a@x.test'],
] as const) {
  test(`token (d): a fact whose X-Aplos-Draft is ${name} falls back to the Message-ID`, async () => {
    const s = await historyWorld({ draftIdentity: 'kept' });
    const phone = s.r.emu.mailbox.createDraftElsewhere({
      subject: 'Phone',
      text: 'Phone text.',
      messageId: 'phone-1@example.test',
      headers: { 'X-Aplos-Draft': token },
    });
    const fact = await factFor(s, phone.draftId);
    assert.equal(fact.internetId, '<phone-1@example.test>');
  });
}

test('token (d): identityOf takes exactly one well-formed token, else the Message-ID', () => {
  const mid = { name: 'Message-ID', value: ' <m@gmail.test> ' };
  const tok = (value: string) => ({ name: 'x-aplos-draft', value });
  assert.equal(identityOf([mid, tok(' <t1@aplos.test> ')]), '<t1@aplos.test>');
  assert.equal(identityOf([mid, tok('<t1@aplos.test>'), tok('<t1@aplos.test>')]), '<m@gmail.test>');
  for (const bad of [
    '',
    '<>',
    '<t1>',
    '<t 1@a.test>',
    '<t1@a.test>x',
    '"<t1@a.test>"',
    '<t1@a_b.test>',
  ])
    assert.equal(identityOf([mid, tok(bad)]), '<m@gmail.test>', bad);
  assert.equal(identityOf([]), undefined);
  assert.ok(isDraftToken('<0123abcd@aplos.local>'));
});

// ---- (e) copyInternetId ----

test('token (e): copyInternetId is the Message-ID Gmail shows after a create and after a replace', async () => {
  const { s } = await world(REWRITTEN);
  const first = saved(await s.r.adapter.saveDraft(s.upload({ body: 'One.' }), s.r.ctx()));
  assert.equal(first.copyInternetId, headerValues(s.remoteDrafts()[0].text, 'Message-ID')[0]);
  const next = s.upload(
    { body: 'Two.' },
    { remoteDraftId: first.remoteDraftId, baseRemoteMessageId: first.remoteMessageId },
  );
  const second = saved(await s.r.adapter.saveDraft(next, s.r.ctx()));
  assert.equal(second.copyInternetId, headerValues(s.remoteDrafts()[0].text, 'Message-ID')[0]);
  assert.notEqual(second.copyInternetId, first.copyInternetId, 'Gmail gave it a new one');
});

test('token (e): copyInternetId is left out when Gmail kept our Message-ID', async () => {
  const { s } = await world({ draftIdentity: 'kept' });
  const result = saved(await s.r.adapter.saveDraft(s.upload(), s.r.ctx()));
  assert.equal('copyInternetId' in result, false);
});

test('token (e): a failing metadata read leaves copyInternetId out and never fails the save', async () => {
  const { s, faults } = await world(REWRITTEN);
  faults.failNext(
    { apiMethod: 'gmail.users.drafts.get' },
    { status: 503, reason: 'backendError', message: 'Backend Error' },
    { times: 20 },
  );
  const result = saved(await s.r.adapter.saveDraft(s.upload(), s.r.ctx()));
  assert.equal('copyInternetId' in result, false);
  assert.equal(s.remoteDrafts().length, 1);
});

test('token (e): a metadata read that shows another message id (changed since) leaves copyInternetId out', async () => {
  const { s } = await world(REWRITTEN);
  s.bridge.rewriteDraftGet = json => {
    const message = json.message as Record<string, unknown>;
    return { ...json, message: { ...message, id: 'changed-since' } };
  };
  const result = saved(await s.r.adapter.saveDraft(s.upload(), s.r.ctx()));
  assert.equal('copyInternetId' in result, false);
});

// ---- the comparison and the checks ----

test('token: content comparison ignores only the token and the Message-ID; a copy without a token equals the same bytes', () => {
  const { mime, internetId } = mimeOf('me@example.test', { body: 'Same.' });
  const tokened = withDraftToken({ internetId, mime });
  assert.ok(sameDraftContent(tokened, mime), 'with and without the token');
  const gmail = Buffer.from(
    `Message-ID: <x@mail.gmail.com>\r\n${Buffer.from(tokened)
      .toString('latin1')
      .replace(/Message-ID: [^\r]*\r\n/, '')}`,
    'latin1',
  );
  assert.ok(sameDraftContent(gmail, mime), "Gmail's id, moved to the top");
  assert.equal(rawIdentity(gmail), internetId, 'the identity is the token');
  assert.equal(rawIdentity(mime), internetId, 'without a token, the Message-ID');
  const other = Buffer.from(
    Buffer.from(tokened).toString('latin1').replace('Subject: ', 'Subject: x'),
    'latin1',
  );
  assert.ok(!sameDraftContent(other, mime), 'any other header still counts');
  const extra = Buffer.concat([Buffer.from('X-Other: 1\r\n'), mime]);
  assert.ok(!sameDraftContent(extra, mime), 'an extra header still counts');
});

test('token: checkDraftMime refuses a token that is not the upload id, or a second one', () => {
  const { mime, internetId } = mimeOf('me@example.test');
  const draft: DraftUpload = { draftId: 'd', revision: 1, fingerprint: 'f', internetId, mime };
  checkDraftMime('gmail.drafts.create', draft, withDraftToken(draft));
  const reason = (bytes: Uint8Array) => {
    try {
      checkDraftMime('gmail.drafts.create', draft, bytes);
    } catch (error) {
      return error instanceof ProviderError ? error.error.reason : String(error);
    }
    return 'accepted';
  };
  assert.equal(
    reason(Buffer.concat([Buffer.from('X-Aplos-Draft: <other@aplos.test>\r\n'), mime])),
    'draftTokenMismatch',
  );
  assert.equal(
    reason(withDraftToken({ internetId, mime: withDraftToken(draft) })),
    'duplicateHeader',
  );
});

// ---- useDraftsSend: the token never leaves in sent mail ----

test('token: with drafts.send on, a stored draft that carries the token is sent as the pinned bytes, without it', async () => {
  const world = await sendWorld({ useDraftsSend: true });
  const pinned = submission(world);
  const draft = world.emu.mailbox.createDraft(
    Buffer.from(withDraftToken({ internetId: pinned.payload.internetId, mime: pinned.mime })),
  );
  const receipt = await world.adapter.send(
    { ...pinned.payload, remoteDraftId: draft.id, baseRemoteMessageId: draft.message.id },
    world.ctx(),
  );
  assert.equal(receipt.draftConsumed, true);
  assert.equal(world.bridge.uploads[0].endpoint, 'drafts');
  assert.doesNotMatch(world.bridge.uploads[0].raw.toString('latin1'), /x-aplos-draft/i);
  assert.doesNotMatch(world.sentMessages()[0].raw.toString('latin1'), /x-aplos-draft/i);
});

// ---- the extra lookups only run after an attempt that may have landed ----

/** `messages.list` calls the adapter made since `from` (an index into the emulator's log). */
const listCalls = (s: Setup, from: number) =>
  s.r.emu.log.slice(from).filter(e => e.apiMethod === 'gmail.users.messages.list').length;

/** Raw reads of a draft (priced as full, 60 units) since `from`. */
const rawReads = (s: Setup, from: number) =>
  s.r.emu.log.slice(from).filter(e => e.apiMethod === 'gmail.users.drafts.get' && e.units === 60)
    .length;

for (const [name, fault] of [
  ['a 403', { status: 403, reason: 'forbidden', message: 'Forbidden' }],
  [
    'a 429 (the governor pauses the account)',
    { status: 429, reason: 'rateLimitExceeded', message: 'Rate limit exceeded' },
  ],
] as const) {
  test(`token: a definite refusal of the create (${name}, nothing landed) leaves the retry on the cheap lookups`, async () => {
    const { s, faults } = await world(DROPPED);
    const upload = s.upload({ body: 'Refused once.' });
    faults.failNext({ apiMethod: 'gmail.users.drafts.create' }, fault);
    const failure = await s.r.adapter.saveDraft(upload, s.r.ctx()).catch((e: unknown) => e);
    assert.ok(failure instanceof Error);
    assert.ok(
      !(failure instanceof ProviderError && failure.error.uncertain === true),
      'a refusal is not an uncertain end',
    );
    await s.r.clock.advance(300_000);
    const from = s.r.emu.log.length;
    saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
    assert.equal(listCalls(s, from), 1, 'only the all-mail search: no Sent/Trash scan');
    assert.equal(s.remoteDrafts().length, 1);
    assert.equal(rawReads(s, from), 0, 'no raw reads for the content fallback');
  });
}

test('token: an uncertain create (it may have landed) does run the Sent/Trash scan and the content fallback on the retry', async () => {
  const { s, faults } = await world(DROPPED);
  const upload = await uncertainCreate(s, faults);
  const from = s.r.emu.log.length;
  saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
  assert.equal(listCalls(s, from), 2, 'the all-mail search and the Sent/Trash scan');
  assert.equal(s.remoteDrafts().length, 1, 'adopted by the content fallback, no duplicate');
});

test('token: an attempt that was answered (the reply was then lost to the engine) also keeps the extra checks for its retry', async () => {
  const { s } = await world(DROPPED);
  const upload = s.upload({ body: 'Answered.' });
  saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
  const from = s.r.emu.log.length;
  const again = saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
  assert.equal(listCalls(s, from), 2);
  assert.equal(again.remoteDraftId, s.remoteDrafts()[0].id);
  assert.equal(s.remoteDrafts().length, 1);
});

// ---- the content fallback never takes a draft that carries a token of someone else ----

test('token (dropped): the content fallback skips a draft carrying a DIFFERENT well-formed token even when its content equals our upload', async () => {
  const { s, faults } = await world(DROPPED);
  const upload = s.upload({ body: 'Same content.' });
  faults.dropNext({ apiMethod: 'gmail.users.drafts.create' });
  const failure = await s.r.adapter.saveDraft(upload, s.r.ctx()).catch((e: unknown) => e);
  assert.ok(failure instanceof ProviderError && failure.error.uncertain === true);
  assert.equal(s.remoteDrafts().length, 0, 'the request never landed');
  // Another device's draft holds exactly our recorded content, under a token that is not ours.
  const lookalike = Buffer.from(
    uploadedBytes(upload)
      .toString('latin1')
      .replace(
        `X-Aplos-Draft: ${upload.internetId}`,
        'X-Aplos-Draft: <someone-else@mail.example.test>',
      ),
    'latin1',
  );
  // Made on another device: the emulator's header dropping (our API saves only) is off for this one.
  const dropping = s.r.emu.settings.dropDraftHeaders;
  s.r.emu.settings.dropDraftHeaders = [];
  const other = s.r.emu.mailbox.createDraft(lookalike);
  s.r.emu.settings.dropDraftHeaders = dropping;
  assert.deepEqual(
    headerValues(s.remoteDrafts()[0].text, 'X-Aplos-Draft'),
    ['<someone-else@mail.example.test>'],
    'the other draft really carries its own token',
  );
  const result = saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
  assert.notEqual(result.remoteDraftId, other.id, 'the lookalike was not adopted');
  const drafts = s.remoteDrafts();
  assert.equal(drafts.length, 2, 'a visible second draft, nothing overwritten');
  assert.equal(drafts.find(d => d.id === other.id)?.messageId, other.message.id, 'untouched');
});

// ---- two drafts with one token ----

test('token (rewritten): two drafts with our token, a phone-edited duplicate listed first: our unchanged copy is still found', async () => {
  const { s } = await world(REWRITTEN);
  const upload = s.upload({ body: 'Ours.' });
  const ours = s.r.emu.mailbox.createDraft(uploadedBytes(upload));
  await s.r.clock.advance(60_000); // the duplicate is NEWER, so Gmail lists it first
  const duplicate = s.r.emu.mailbox.createDraftElsewhere({
    subject: 'Draft subject',
    text: 'A phone edit of a copy.',
    headers: { 'X-Aplos-Draft': upload.internetId },
  });
  const result = saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
  assert.equal(result.remoteDraftId, ours.id, 'ours, not a conflict naming the duplicate');
  assert.equal(s.bridge.uploads.length, 0, 'nothing written');
  assert.equal(
    s.remoteDrafts().find(d => d.id === duplicate.draftId)?.messageId,
    duplicate.messageId,
  );
});

test('token (rewritten): two drafts with our token and neither proven ours: a conflict naming the first listed, nothing written', async () => {
  const { s } = await world(REWRITTEN);
  const upload = s.upload({ body: 'Ours.' });
  s.r.emu.mailbox.createDraftElsewhere({
    subject: 'Draft subject',
    text: 'Older phone copy.',
    headers: { 'X-Aplos-Draft': upload.internetId },
  });
  await s.r.clock.advance(60_000);
  const newer = s.r.emu.mailbox.createDraftElsewhere({
    subject: 'Draft subject',
    text: 'Newer phone copy.',
    headers: { 'X-Aplos-Draft': upload.internetId },
  });
  const result = await s.r.adapter.saveDraft(upload, s.r.ctx());
  assert.equal(result.kind, 'conflict');
  assert.equal(result.kind === 'conflict' ? result.remoteDraftId : '', newer.draftId);
  assert.equal(s.bridge.uploads.length, 0);
});

test('token: a 5xx that carries a throttle reason (503 rateLimitExceeded) is not a definite refusal: the retry keeps the extra checks', async () => {
  const { s, faults } = await world(DROPPED);
  const upload = s.upload({ body: 'Throttled 503.' });
  faults.failNext(
    { apiMethod: 'gmail.users.drafts.create' },
    { status: 503, reason: 'rateLimitExceeded', message: 'Rate limit exceeded' },
  );
  const failure = await s.r.adapter.saveDraft(upload, s.r.ctx()).catch((e: unknown) => e);
  assert.ok(failure instanceof ProviderError);
  assert.equal(failure.error.class, 'throttle', 'classified as a throttle');
  await s.r.clock.advance(300_000);
  const from = s.r.emu.log.length;
  saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
  assert.equal(listCalls(s, from), 2, 'the all-mail search and the Sent/Trash scan still run');
});

test('token: uncertain, then a retry that finds nothing and re-records, then a 429: the next retry still runs the extra checks', async () => {
  const { s, faults } = await world(DROPPED);
  const upload = s.upload({ body: 'Uncertain, miss, refused.' });
  // 1. The request is lost before it landed: uncertain, nothing stored.
  faults.dropNext({ apiMethod: 'gmail.users.drafts.create' });
  const lost = await s.r.adapter.saveDraft(upload, s.r.ctx()).catch((e: unknown) => e);
  assert.ok(lost instanceof ProviderError && lost.error.uncertain === true);
  assert.equal(s.remoteDrafts().length, 0);
  // 2. The retry finds nothing (the lookups run), records the attempt again, and its create is refused with a 429.
  faults.failNext(
    { apiMethod: 'gmail.users.drafts.create' },
    { status: 429, reason: 'rateLimitExceeded', message: 'Rate limit exceeded' },
  );
  const refused = await s.r.adapter.saveDraft(upload, s.r.ctx()).catch((e: unknown) => e);
  assert.ok(refused instanceof ProviderError && refused.error.status === 429);
  await s.r.clock.advance(300_000);
  // 3. The refusal did not erase that attempt 1 may have landed: the extra checks still run.
  const from = s.r.emu.log.length;
  saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
  assert.equal(listCalls(s, from), 2, 'the Sent/Trash scan still runs');
});
