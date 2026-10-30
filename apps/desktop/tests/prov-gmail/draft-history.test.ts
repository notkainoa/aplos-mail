/**
 * prov-gmail draft facts from history (google/history.ts, google/draft-body.ts): the body of a foreign draft
 * (`RemoteDraftFact.html` / `text`, at most five reads per pass, never with attachments, over the cap or empty) and
 * `supersedes` (the previous message ids of the same draft). Each test fails on the version without the feature.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFaultInjector } from '@aplos/emulators';
import type { RemoteDraftFact } from '@aplos/engine/ports';
import { gmailLog, rig, type Rig } from './harness';
import { mimeOf } from './draft-rig';

const windowDone = (r: Rig) => () => r.store.states.get('window:inbox')?.phase === 'done';

async function synced(): Promise<Rig> {
  return syncedWith({});
}

async function syncedWith(options: Parameters<typeof rig>[0]): Promise<Rig> {
  const r = await rig({ threads: 60, ...options });
  await r.drive({ until: windowDone(r), maxSteps: 300 });
  await r.clock.advance(60_000);
  return r;
}

async function historyPass(r: Rig): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 1 });
    if (!/^pass:/.test(r.store.states.get('history')?.phase ?? '')) return;
  }
  throw new Error('history pass did not finish');
}

const factsSince = (r: Rig, from: number): RemoteDraftFact[] =>
  r.store.commits.slice(from).flatMap(c => c.result.drafts ?? []);

const fullReads = (r: Rig, since: number) =>
  gmailLog(r.emu, since).filter(e => e.apiMethod === 'gmail.users.drafts.get');

const spec = (over: Record<string, unknown> = {}) => ({
  to: ['maren.ashgrove@mail.example.test'],
  subject: 'From the phone',
  text: 'Phone text.',
  ...over,
});

test('prov-gmail-drafts body delivery: html and text of a foreign draft are delivered, read once with format=full', async () => {
  const r = await synced();
  const both = r.emu.mailbox.createDraftElsewhere(spec({ html: '<p>Phone <b>html</b>.</p>' }));
  const plain = r.emu.mailbox.createDraftElsewhere(spec({ subject: 'Plain' }));
  const start = r.clock.now();
  const from = r.store.commits.length;
  await historyPass(r);
  const facts = factsSince(r, from);
  const withBoth = facts.find(f => f.remoteDraftId === both.draftId)!;
  assert.equal(withBoth.html, '<p>Phone <b>html</b>.</p>');
  assert.equal(withBoth.text?.trim(), 'Phone text.');
  assert.equal(withBoth.remoteMessageId, both.messageId);
  const withText = facts.find(f => f.remoteDraftId === plain.draftId)!;
  assert.equal(withText.html, undefined);
  assert.equal(withText.text?.trim(), 'Phone text.');
  const reads = fullReads(r, start);
  assert.equal(reads.length, 2, 'one read per draft');
  assert.ok(
    reads.every(e => e.units === 60),
    'priced as full',
  );
});

test('prov-gmail-drafts body delivery: a draft with an attachment (inline too) gets no body fields', async () => {
  const r = await synced();
  const file = r.emu.mailbox.createDraftElsewhere(
    spec({
      attachments: [{ filename: 'plan.txt', mimeType: 'text/plain', data: Buffer.from('plan') }],
    }),
  );
  const inline = r.emu.mailbox.createDraftElsewhere(
    spec({
      html: '<img src="cid:pic">',
      attachments: [
        { filename: 'pic.png', mimeType: 'image/png', data: Buffer.from('png'), contentId: 'pic' },
      ],
    }),
  );
  const from = r.store.commits.length;
  await historyPass(r);
  for (const d of [file, inline]) {
    const fact = factsSince(r, from).find(f => f.remoteDraftId === d.draftId)!;
    assert.ok(fact, 'still reported');
    assert.equal(fact.html, undefined);
    assert.equal(fact.text, undefined);
  }
});

test('prov-gmail-drafts body delivery: a body over 1,000,000 characters, an empty body and a body stored by attachment id are not delivered', async () => {
  const r = await synced();
  const huge = r.emu.mailbox.createDraftElsewhere(spec({ text: 'x'.repeat(1_000_001) }));
  const edge = r.emu.mailbox.createDraftElsewhere(spec({ text: 'y'.repeat(1_000_000) }));
  const empty = r.emu.mailbox.createDraftElsewhere(spec({ text: '  \n ' }));
  const stored = r.emu.mailbox.createDraftElsewhere(
    spec({ html: '<p>by id</p>', htmlAsAttachment: true }),
  );
  const from = r.store.commits.length;
  await historyPass(r);
  const facts = factsSince(r, from);
  const byId = (id: string) => facts.find(f => f.remoteDraftId === id)!;
  assert.equal(byId(huge.draftId).text, undefined, 'over the cap');
  assert.equal(byId(edge.draftId).text?.length, 1_000_000, 'exactly the cap is fine');
  assert.equal(byId(empty.draftId).text, undefined, 'empty');
  assert.equal(byId(empty.draftId).html, undefined);
  assert.equal(byId(stored.draftId).html, undefined, 'stored by attachment id');
  assert.equal(byId(stored.draftId).text, undefined);
  for (const d of [huge, empty, stored]) assert.ok(byId(d.draftId), 'reported without a body');
});

test('prov-gmail-drafts body delivery: at most five reads per pass, the rest on the next pass (reported again with the body)', async () => {
  const r = await synced();
  const made = Array.from({ length: 7 }, (_, i) =>
    r.emu.mailbox.createDraftElsewhere(spec({ subject: `Phone ${i}`, text: `Text ${i}.` })),
  );
  const start = r.clock.now();
  const from = r.store.commits.length;
  await historyPass(r);
  assert.equal(fullReads(r, start).length, 5, 'bounded');
  const first = factsSince(r, from);
  assert.equal(first.length, 7, 'all seven are reported');
  assert.equal(first.filter(f => f.text !== undefined).length, 5);
  const waiting = first.filter(f => f.text === undefined);
  assert.equal(waiting.length, 2);

  await r.clock.advance(60_000);
  const second = r.store.commits.length;
  const again = r.clock.now();
  await historyPass(r);
  const later = factsSince(r, second);
  assert.equal(fullReads(r, again).length, 2);
  assert.deepEqual(
    later.map(f => f.remoteMessageId).sort(),
    waiting.map(f => f.remoteMessageId).sort(),
  );
  for (const f of later) {
    const index = made.findIndex(d => d.messageId === f.remoteMessageId);
    assert.equal(f.text?.trim(), `Text ${index}.`);
    assert.equal(f.remoteDraftId, made[index].draftId);
  }
  // Nothing is left waiting: a third pass reads nothing.
  await r.clock.advance(60_000);
  const third = r.clock.now();
  await historyPass(r);
  assert.equal(fullReads(r, third).length, 0);
});

test('prov-gmail-drafts body delivery: a draft edited again before its turn is read at its new message id, never the old text', async () => {
  const r = await synced();
  const made = Array.from({ length: 6 }, (_, i) =>
    r.emu.mailbox.createDraftElsewhere(spec({ subject: `Phone ${i}`, text: `Text ${i}.` })),
  );
  const from = r.store.commits.length;
  await historyPass(r);
  const waiting = factsSince(r, from).find(f => f.text === undefined)!;
  const { mime } = mimeOf(r.account.address, { body: 'Edited meanwhile.' });
  const edited = r.emu.mailbox.updateDraft(waiting.remoteDraftId, mime);
  await r.clock.advance(60_000);
  const next = r.store.commits.length;
  await historyPass(r);
  const facts = factsSince(r, next).filter(f => f.remoteDraftId === waiting.remoteDraftId);
  assert.equal(facts.length, 1, 'one fact for the draft');
  assert.equal(facts[0].remoteMessageId, edited.message.id);
  assert.match(facts[0].text ?? '', /Edited meanwhile\./);
  assert.ok(made.length === 6);
});

test('prov-gmail-drafts body delivery: a refused read (429) still reports the draft without a body and retries it after the pause', async () => {
  const faults = createFaultInjector();
  const r = await syncedWith({ emulator: { faults } });
  const draft = r.emu.mailbox.createDraftElsewhere(spec());
  faults.failNext(
    { apiMethod: 'gmail.users.drafts.get' },
    { status: 429, reason: 'rateLimitExceeded', message: 'Rate limit exceeded' },
  );
  const from = r.store.commits.length;
  await historyPass(r);
  const first = factsSince(r, from).find(f => f.remoteDraftId === draft.draftId)!;
  assert.ok(first, 'reported');
  assert.equal(first.text, undefined);
  await r.clock.advance(120_000);
  const next = r.store.commits.length;
  await historyPass(r);
  const second = factsSince(r, next).find(f => f.remoteDraftId === draft.draftId)!;
  assert.equal(second.text?.trim(), 'Phone text.');
});

test('prov-gmail-drafts body delivery: no body content reaches the log', async () => {
  const r = await synced();
  r.emu.mailbox.createDraftElsewhere(spec({ text: 'SECRET-BODY-MARKER' }));
  const from = r.store.commits.length;
  await historyPass(r);
  assert.equal(factsSince(r, from)[0].text?.trim(), 'SECRET-BODY-MARKER');
  assert.ok(!JSON.stringify(r.emu.log).includes('SECRET-BODY-MARKER'));
});

test('prov-gmail-drafts supersedes: an edit of a known draft names the previous message ids; a first sighting names none', async () => {
  const r = await synced();
  const draft = r.emu.mailbox.createDraftElsewhere(spec());
  let from = r.store.commits.length;
  await historyPass(r);
  const first = factsSince(r, from).find(f => f.remoteDraftId === draft.draftId)!;
  assert.equal(first.remoteMessageId, draft.messageId);
  assert.equal(first.supersedes, undefined, 'nothing earlier is known');

  const second = r.emu.mailbox.updateDraft(
    draft.draftId,
    mimeOf(r.account.address, { body: 'Second.' }).mime,
  );
  await r.clock.advance(60_000);
  from = r.store.commits.length;
  await historyPass(r);
  const edit = factsSince(r, from).find(f => f.remoteMessageId === second.message.id)!;
  assert.deepEqual(edit.supersedes, [draft.messageId]);
  assert.equal(edit.remoteDraftId, draft.draftId);

  const third = r.emu.mailbox.updateDraft(
    draft.draftId,
    mimeOf(r.account.address, { body: 'Third.' }).mime,
  );
  await r.clock.advance(60_000);
  from = r.store.commits.length;
  await historyPass(r);
  const latest = factsSince(r, from).find(f => f.remoteMessageId === third.message.id)!;
  assert.deepEqual(latest.supersedes, [second.message.id], 'only the previous version');
});

test('prov-gmail-drafts supersedes: another draft is never named, and our own save is not reported at all', async () => {
  const r = await synced();
  const one = r.emu.mailbox.createDraftElsewhere(spec({ subject: 'One' }));
  const two = r.emu.mailbox.createDraftElsewhere(spec({ subject: 'Two' }));
  await historyPass(r);
  const edited = r.emu.mailbox.updateDraft(
    one.draftId,
    mimeOf(r.account.address, { body: 'One again.' }).mime,
  );
  r.store.ownDrafts.set(edited.message.id, one.draftId);
  const other = r.emu.mailbox.updateDraft(
    two.draftId,
    mimeOf(r.account.address, { body: 'Two again.' }).mime,
  );
  await r.clock.advance(60_000);
  const from = r.store.commits.length;
  await historyPass(r);
  const facts = factsSince(r, from);
  assert.ok(!facts.some(f => f.remoteMessageId === edited.message.id), 'our own copy is not news');
  const theirs = facts.find(f => f.remoteMessageId === other.message.id)!;
  assert.deepEqual(theirs.supersedes, [two.messageId]);
});
