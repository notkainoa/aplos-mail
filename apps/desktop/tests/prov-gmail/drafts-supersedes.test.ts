/**
 * prov-gmail-write drafts, PORT GAP 2 (google/drafts.ts): a create offered `DraftUpload.supersedes` replaces the copy
 * an earlier, uncertain create left, but only a copy it can prove is its own earlier upload. Each test fails on the
 * version that ignores `supersedes` (two drafts) or that replaces without the proof (a phone edit lost).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFaultInjector } from '@aplos/emulators';
import { ProviderError, type DraftUpload } from '@aplos/engine/ports';
import {
  apiCalls,
  mimeOf,
  saved,
  setup,
  uncertainCreate,
  uploadedBytes,
  type Setup,
} from './draft-rig';

/** The next revision of the draft `first` belongs to, as the engine offers it after an unanswered create. */
const edited = (s: Setup, first: DraftUpload, body: string, over: Partial<DraftUpload> = {}) =>
  s.upload({ body }, { supersedes: [first.internetId], ...over });

test('prov-gmail-drafts supersedes: an uncertain create landed, the edit replaces that copy, one draft total', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const first = await uncertainCreate(s, faults);
  const draftId = s.remoteDrafts()[0].id;
  const next = edited(s, first, 'Edited text.');
  assert.notEqual(next.internetId, first.internetId);
  const result = saved(await s.r.adapter.saveDraft(next, s.r.ctx()));
  assert.equal(result.remoteDraftId, draftId, 'the earlier copy was replaced');
  assert.equal(s.remoteDrafts().length, 1, 'one draft total');
  assert.match(s.remoteDrafts()[0].text, /Edited text\./);
  assert.match(s.remoteDrafts()[0].text, new RegExp(next.internetId.replace(/[.$]/g, '\\.')));
  assert.equal(result.remoteMessageId, s.remoteDrafts()[0].messageId);
  assert.equal(s.bridge.uploads.length, 2, 'one create, one update');
  // A retry of that same revision finds the replaced copy by its own Message-ID: nothing more is written.
  saved(await s.r.adapter.saveDraft(next, s.r.ctx()));
  assert.equal(s.bridge.uploads.length, 2);
});

test('prov-gmail-drafts supersedes: the copy is found in the newest drafts when the search lags', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const first = await uncertainCreate(s, faults);
  s.bridge.blindSearch = true;
  const result = saved(await s.r.adapter.saveDraft(edited(s, first, 'Edited.'), s.r.ctx()));
  assert.equal(result.remoteDraftId, s.remoteDrafts()[0].id);
  assert.equal(s.remoteDrafts().length, 1);
});

test('prov-gmail-drafts supersedes: two edits after one lost create, the second still replaces the same copy', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const first = await uncertainCreate(s, faults);
  const second = edited(s, first, 'Second.');
  // The replace of the first copy is uncertain too: it landed, the reply was lost.
  faults.dropAfterNext({ apiMethod: 'gmail.users.drafts.update' });
  faults.failNext(
    { apiMethod: 'gmail.users.drafts.list', after: 2 },
    { status: 503, reason: 'backendError', message: 'Backend Error' },
    { times: 20 },
  );
  const lost = await s.r.adapter.saveDraft(second, s.r.ctx()).catch((e: unknown) => e);
  assert.ok(lost instanceof ProviderError);
  faults.clear();
  const third = s.upload({ body: 'Third.' }, { supersedes: [first.internetId, second.internetId] });
  const result = saved(await s.r.adapter.saveDraft(third, s.r.ctx()));
  assert.equal(s.remoteDrafts().length, 1);
  assert.equal(result.remoteDraftId, s.remoteDrafts()[0].id);
  assert.match(s.remoteDrafts()[0].text, /Third\./);
});

test('prov-gmail-drafts supersedes: the earlier copy was edited on the phone, a conflict naming it, nothing written', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const first = await uncertainCreate(s, faults);
  // The phone edit keeps our Message-ID and token (the worst case: the headers alone look like ours).
  const { mime } = mimeOf(s.r.account.address, {
    id: first.internetId,
    token: first.internetId,
    body: 'Phone text.',
  });
  const phone = s.r.emu.mailbox.updateDraft(s.remoteDrafts()[0].id, mime);
  const result = await s.r.adapter.saveDraft(edited(s, first, 'Edited.'), s.r.ctx());
  assert.deepEqual(result, {
    kind: 'conflict',
    remoteMessageId: phone.message.id,
    remoteDraftId: s.remoteDrafts()[0].id,
    remoteInternetId: first.internetId,
  });
  assert.equal(s.bridge.uploads.length, 1, 'nothing was written');
  assert.equal(s.remoteDrafts().length, 1);
  assert.match(s.remoteDrafts()[0].text, /Phone text\./);
});

test('prov-gmail-drafts supersedes: a copy this adapter never recorded (a restart) is a conflict, never replaced', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  // Landed by an earlier process: the same bytes (with its token), but nothing was recorded for this draft here.
  const first = s.upload({ body: 'Before the restart.' });
  s.r.emu.mailbox.createDraft(uploadedBytes(first));
  const result = await s.r.adapter.saveDraft(edited(s, first, 'Edited.'), s.r.ctx());
  assert.equal(result.kind, 'conflict');
  assert.equal(s.bridge.uploads.length, 0);
  assert.match(s.remoteDrafts()[0].text, /Before the restart\./);
});

test('prov-gmail-drafts supersedes: the same bytes recorded for another local draft do not prove this one', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const first = await uncertainCreate(s, faults);
  const other = edited(s, first, 'Edited.', { draftId: 'local-2' });
  const result = await s.r.adapter.saveDraft(other, s.r.ctx());
  assert.equal(result.kind, 'conflict');
  assert.equal(s.bridge.uploads.length, 1);
});

test('prov-gmail-drafts supersedes: a copy in another thread than the upload names is a conflict, never replaced', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const first = await uncertainCreate(s, faults);
  const draftId = s.remoteDrafts()[0].id;
  const result = await s.r.adapter.saveDraft(
    edited(s, first, 'Edited.', { remoteThreadId: 'some-other-thread' }),
    s.r.ctx(),
  );
  assert.equal(result.kind, 'conflict');
  assert.equal(s.bridge.uploads.length, 1, 'nothing was written');
  assert.equal(s.remoteDrafts().length, 1);
  assert.equal(s.remoteDrafts()[0].id, draftId);
});

for (const [name, move] of [
  ['SENT', (s: Setup, r: { id: string }) => s.r.emu.mailbox.sendDraft(r.id)],
  ['TRASH', (s: Setup, r: { messageId: string }) => s.r.emu.mailbox.trashMessage(r.messageId)],
] as const) {
  test(`prov-gmail-drafts supersedes: an earlier copy that is ${name} is gone, not resurrected and not created again`, async () => {
    const faults = createFaultInjector();
    const s = await setup({ emulator: { faults } });
    const first = await uncertainCreate(s, faults);
    const remote = s.remoteDrafts()[0];
    move(s, remote);
    const next = edited(s, first, 'Edited.');
    assert.deepEqual(await s.r.adapter.saveDraft(next, s.r.ctx()), { kind: 'gone' });
    assert.equal(s.bridge.uploads.length, 1, 'nothing was created or written');
    assert.ok(s.remoteDrafts().length <= 1, 'no second draft');
  });
}

test('prov-gmail-drafts supersedes: absent or empty is today: nothing listed means a plain create', async () => {
  for (const supersedes of [undefined, [] as string[]]) {
    const faults = createFaultInjector();
    const s = await setup({ emulator: { faults } });
    const first = await uncertainCreate(s, faults);
    const next = s.upload({ body: 'Edited.' }, supersedes ? { supersedes } : {});
    saved(await s.r.adapter.saveDraft(next, s.r.ctx()));
    assert.equal(s.remoteDrafts().length, 2, 'the old behaviour: a duplicate, never a loss');
    assert.ok(s.remoteDrafts().some(d => d.text.includes(first.internetId)));
  }
});

test('prov-gmail-drafts supersedes: a draft with an unrelated Message-ID is never touched', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const foreign = mimeOf(s.r.account.address, { subject: 'Not ours', body: 'Foreign text.' });
  s.r.emu.mailbox.createDraft(foreign.mime);
  // The listed earlier id never landed: only the foreign draft exists.
  const ghost = s.upload({ body: 'Never uploaded.' });
  const result = saved(await s.r.adapter.saveDraft(edited(s, ghost, 'Edited.'), s.r.ctx()));
  const drafts = s.remoteDrafts();
  assert.equal(drafts.length, 2, 'a plain create next to the foreign draft');
  assert.ok(drafts.some(d => d.text.includes('Foreign text.') && d.id !== result.remoteDraftId));
  const kept = drafts.find(d => d.text.includes('Foreign text.'));
  assert.equal(
    kept?.messageId,
    s.r.emu.mailbox.listDrafts().find(d => d.id === kept?.id)?.message.id,
  );
  assert.equal(s.bridge.uploads.length, 1, 'only our own create went out');
});

test('prov-gmail-drafts supersedes: its own Message-ID in the list is ignored, never looked up as an earlier copy', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const upload = s.upload({ body: 'Own.' });
  saved(await s.r.adapter.saveDraft({ ...upload, supersedes: [upload.internetId] }, s.r.ctx()));
  assert.equal(s.remoteDrafts().length, 1);
});

// ---- one create reads each draft once ----

/**
 * The lookup's metadata reads: those before the write. The one read after it is the saved copy's `copyInternetId`
 * (`storedCopy` in drafts.ts), not part of the lookup.
 */
function metadataReads(s: Setup, since: number) {
  const calls = apiCalls(s, since);
  const write = calls.findIndex(c => /^gmail\.drafts\.(create|update)$/.test(c.method));
  const lookup = write < 0 ? calls : calls.slice(0, write);
  return lookup.filter(c => c.method === 'gmail.drafts.get' && c.cost !== 60);
}

test('prov-gmail-drafts supersedes: a lookup that finds nothing reads each of ten drafts once, not twice', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  for (let i = 0; i < 10; i++) {
    s.r.emu.mailbox.createDraft(mimeOf(s.r.account.address, { body: `Foreign ${i}.` }).mime);
  }
  const ghost = s.upload({ body: 'Never uploaded.' });
  const before = apiCalls(s).length;
  saved(await s.r.adapter.saveDraft(edited(s, ghost, 'Edited.'), s.r.ctx()));
  const reads = metadataReads(s, before);
  const units = reads.reduce((sum, c) => sum + c.cost, 0);
  assert.equal(reads.length, 10, 'each draft read once for both lookups');
  assert.equal(units, 10 * reads[0].cost, 'the budget units of ten reads');
  assert.equal(s.remoteDrafts().length, 11, 'a plain create next to the ten');
});

test('prov-gmail-drafts supersedes: a draft the create lookup already read, carrying a superseded Message-ID, is still replaced', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const first = await uncertainCreate(s, faults);
  const draftId = s.remoteDrafts()[0].id;
  s.bridge.blindSearch = true;
  const before = apiCalls(s).length;
  const result = saved(await s.r.adapter.saveDraft(edited(s, first, 'Edited.'), s.r.ctx()));
  assert.equal(metadataReads(s, before).length, 1, 'read once, then matched against supersedes');
  assert.equal(result.remoteDraftId, draftId, 'the earlier copy was replaced');
  assert.equal(s.remoteDrafts().length, 1, 'one draft total');
});
