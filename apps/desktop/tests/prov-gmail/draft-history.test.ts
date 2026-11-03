/**
 * prov-gmail draft facts from history (google/history.ts, google/draft-body.ts): the body of a foreign draft
 * (`RemoteDraftFact.html` / `text`, at most five reads per pass, never with attachments, over the cap or empty) and
 * `supersedes` (the previous message ids of the same draft). Each test fails on the version without the feature.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFaultInjector, type GmailEmulator } from '@aplos/emulators';
import type { RemoteDraftFact } from '@aplos/engine/ports';
import { gmailLog, rig, type Rig } from './harness';
import { messageWrite } from '../../../../packages/engine/src/sync/facts';
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
  assert.ok(
    facts.filter(f => f.html !== undefined || f.text !== undefined).every(f => f.message),
    'a body never goes without the message',
  );
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

// ---- the Message-ID of the draft ----

test("prov-gmail-drafts body delivery: the fact names the draft's Message-ID as internetId, also when no body is delivered", async () => {
  const r = await synced();
  const plain = r.emu.mailbox.createDraftElsewhere(spec({ messageId: 'phone-1@example.test' }));
  const withFile = r.emu.mailbox.createDraftElsewhere(
    spec({
      messageId: 'phone-2@example.test',
      attachments: [{ filename: 'a.txt', mimeType: 'text/plain', data: Buffer.from('a') }],
    }),
  );
  const from = r.store.commits.length;
  await historyPass(r);
  const facts = factsSince(r, from);
  assert.equal(
    facts.find(f => f.remoteDraftId === plain.draftId)?.internetId,
    '<phone-1@example.test>',
  );
  const file = facts.find(f => f.remoteDraftId === withFile.draftId)!;
  assert.equal(file.internetId, '<phone-2@example.test>');
  assert.equal(file.text, undefined, 'no body with an attachment');
});

// ---- attachments hidden in containers ----

const b64 = (text: string): string => Buffer.from(text).toString('base64url');
const leaf = (mimeType: string, text: string, extra: Record<string, unknown> = {}) => ({
  mimeType,
  body: { size: text.length, data: b64(text) },
  ...extra,
});

/** A fetch that swaps the payload of every `drafts.get format=full` reply for `payload`. */
function payloadFetch(holder: { emu?: GmailEmulator }, payload: () => unknown): typeof fetch {
  return async (input, init) => {
    const response = await holder.emu!.fetch(input, init);
    const url = new URL(String(input instanceof Request ? input.url : input));
    const full = url.searchParams.get('format') === 'full';
    if (!/\/drafts\/[^/]+$/.test(url.pathname) || !full || !response.ok) return response;
    const json = JSON.parse(await response.text()) as { message: { payload: unknown } };
    const original = (json.message.payload as { headers?: unknown[] }).headers ?? [];
    const { replaceHeaders, ...given } = payload() as {
      headers?: unknown[];
      replaceHeaders?: boolean;
    };
    const own = given.headers ?? [];
    const named = new Set(own.map(h => (h as { name: string }).name.toLowerCase()));
    const kept = replaceHeaders
      ? original.filter(h => !named.has((h as { name: string }).name.toLowerCase()))
      : original;
    json.message.payload = { ...given, headers: [...own, ...kept] };
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

const forwarded = {
  mimeType: 'message/rfc822',
  filename: 'fwd.eml',
  body: { size: 0 },
  parts: [
    {
      mimeType: 'multipart/alternative',
      parts: [leaf('text/html', '<p>forwarded html</p>')],
    },
  ],
};

const hiddenAttachments: [string, unknown][] = [
  [
    'a message/rfc822 attachment whose children are text/html',
    { mimeType: 'multipart/mixed', parts: [leaf('text/plain', 'my note'), forwarded] },
  ],
  [
    'a message/rfc822 container without a filename',
    {
      mimeType: 'multipart/mixed',
      parts: [leaf('text/plain', 'my note'), { ...forwarded, filename: '' }],
    },
  ],
  [
    'a multipart/mixed attachment container nested inside multipart/alternative',
    {
      mimeType: 'multipart/alternative',
      parts: [
        leaf('text/plain', 'my note'),
        {
          mimeType: 'multipart/mixed',
          parts: [leaf('text/html', '<p>html</p>'), forwarded],
        },
      ],
    },
  ],
  [
    'a container with a filename',
    {
      mimeType: 'multipart/mixed',
      parts: [{ mimeType: 'multipart/mixed', filename: 'x', parts: [leaf('text/plain', 'inner')] }],
    },
  ],
  [
    'an inline image',
    {
      mimeType: 'multipart/related',
      parts: [
        leaf('text/html', '<img src="cid:pic">'),
        {
          mimeType: 'image/png',
          headers: [
            { name: 'Content-Disposition', value: 'inline' },
            { name: 'Content-ID', value: '<pic>' },
          ],
          body: { size: 3, attachmentId: 'att-1' },
        },
      ],
    },
  ],
  [
    'an application/pdf part with no filename',
    {
      mimeType: 'multipart/mixed',
      parts: [
        leaf('text/plain', 'note'),
        { mimeType: 'application/pdf', body: { size: 3, data: b64('pdf') } },
      ],
    },
  ],
];

for (const [name, payload] of hiddenAttachments) {
  test(`prov-gmail-drafts body delivery: ${name} means no body is delivered`, async () => {
    const holder: { emu?: GmailEmulator } = {};
    const r = await rig({ threads: 60, adapter: { fetch: payloadFetch(holder, () => payload) } });
    holder.emu = r.emu;
    await r.drive({ until: windowDone(r), maxSteps: 300 });
    await r.clock.advance(60_000);
    const draft = r.emu.mailbox.createDraftElsewhere(spec());
    const from = r.store.commits.length;
    await historyPass(r);
    const fact = factsSince(r, from).find(f => f.remoteDraftId === draft.draftId)!;
    assert.ok(fact, 'still reported');
    assert.equal(fact.html, undefined);
    assert.equal(fact.text, undefined);
  });
}

test('prov-gmail-drafts body delivery: plain nested multipart without attachments is still delivered', async () => {
  const holder: { emu?: GmailEmulator } = {};
  const body = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'multipart/alternative',
        parts: [leaf('text/plain', 'my note'), leaf('text/html', '<p>my note</p>')],
      },
    ],
  };
  const r = await rig({ threads: 60, adapter: { fetch: payloadFetch(holder, () => body) } });
  holder.emu = r.emu;
  await r.drive({ until: windowDone(r), maxSteps: 300 });
  await r.clock.advance(60_000);
  const draft = r.emu.mailbox.createDraftElsewhere(spec());
  const from = r.store.commits.length;
  await historyPass(r);
  const fact = factsSince(r, from).find(f => f.remoteDraftId === draft.draftId)!;
  assert.equal(fact.html, '<p>my note</p>');
  assert.equal(fact.text, 'my note');
});

// ---- a failed read is retried, not forgotten ----

const failReads = (faults: ReturnType<typeof createFaultInjector>, status: number) =>
  faults.failNext(
    { apiMethod: 'gmail.users.drafts.get' },
    { status, reason: status === 404 ? 'notFound' : 'backendError', message: 'Backend Error' },
    { times: 200 },
  );

test('prov-gmail-drafts body delivery: a transient failure goes back to waiting and is read again on a later pass', async () => {
  const faults = createFaultInjector();
  const r = await syncedWith({ emulator: { faults } });
  const draft = r.emu.mailbox.createDraftElsewhere(spec());
  failReads(faults, 503);
  const from = r.store.commits.length;
  await historyPass(r);
  assert.equal(factsSince(r, from).find(f => f.remoteDraftId === draft.draftId)?.text, undefined);
  await r.clock.advance(60_000);
  await historyPass(r);
  faults.clear();
  await r.clock.advance(60_000);
  const next = r.store.commits.length;
  await historyPass(r);
  const fact = factsSince(r, next).find(f => f.remoteDraftId === draft.draftId)!;
  assert.equal(fact.text?.trim(), 'Phone text.', 'the third read succeeded');
});

test('prov-gmail-drafts body delivery: after three failed reads the draft is dropped with only the reason code logged', async () => {
  const faults = createFaultInjector();
  const r = await syncedWith({ emulator: { faults } });
  const draft = r.emu.mailbox.createDraftElsewhere(spec({ text: 'PRIVATE-DROP-MARKER' }));
  failReads(faults, 503);
  for (let i = 0; i < 3; i++) {
    await historyPass(r);
    await r.clock.advance(60_000);
  }
  faults.clear();
  const dropped = r.log.lines.filter(
    l => l.event === 'sync.gmail.request_refused' && l.fields.attempt === 3,
  );
  assert.equal(dropped.length, 1);
  assert.equal((dropped[0].fields.error as { reason?: string }).reason, 'backendError');
  assert.ok(!JSON.stringify(r.log.lines).includes('PRIVATE-DROP-MARKER'));
  const start = r.clock.now();
  await historyPass(r);
  assert.equal(fullReads(r, start).length, 0, 'not read again');
  assert.equal(r.store.drafts.get(draft.draftId)?.text, undefined);
});

test('prov-gmail-drafts body delivery: a 404 drops the draft at once, no later read', async () => {
  const faults = createFaultInjector();
  const r = await syncedWith({ emulator: { faults } });
  const draft = r.emu.mailbox.createDraftElsewhere(spec());
  failReads(faults, 404);
  await historyPass(r);
  faults.clear();
  await r.clock.advance(60_000);
  const start = r.clock.now();
  await historyPass(r);
  assert.equal(fullReads(r, start).length, 0);
  assert.ok(r.store.drafts.has(draft.draftId), 'it was reported');
  assert.equal(r.store.drafts.get(draft.draftId)?.text, undefined);
});

// ---- the bound, per history step ----

test('prov-gmail-drafts body delivery: with 8 foreign drafts one history step reads exactly 5, each once with format=full', async () => {
  const r = await synced();
  for (let i = 0; i < 8; i++) r.emu.mailbox.createDraftElsewhere(spec({ subject: `Phone ${i}` }));
  const start = r.clock.now();
  await r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 1 });
  assert.equal(fullReads(r, start).length, 5);
  const reads = r.fetches.filter(f => f.at >= start && /\/drafts\/[^/]+$/.test(f.path));
  assert.equal(reads.length, 5);
  assert.equal(new Set(reads.map(f => f.path)).size, 5, 'each draft once');
  assert.ok(reads.every(f => f.query.get('format') === 'full'));
});

// ---- the fact's metadata: the engine's proof that a fact is our own echo needs `message.from` and `hasAttachments` ----

/** A fetch that removes the From header from every `drafts.get format=full` reply. */
function withoutFrom(holder: { emu?: GmailEmulator }): typeof fetch {
  return async (input, init) => {
    const response = await holder.emu!.fetch(input, init);
    const url = new URL(String(input instanceof Request ? input.url : input));
    const full = url.searchParams.get('format') === 'full';
    if (!/\/drafts\/[^/]+$/.test(url.pathname) || !full || !response.ok) return response;
    const json = JSON.parse(await response.text()) as {
      message: { payload: { headers: { name: string }[] } };
    };
    const headers = json.message.payload.headers;
    json.message.payload.headers = headers.filter(h => h.name.toLowerCase() !== 'from');
    return new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

test('prov-gmail-drafts fact metadata: a delivered body carries message.from (lower-cased), recipients, subject and no attachments', async () => {
  const r = await synced();
  const draft = r.emu.mailbox.createDraftElsewhere(
    spec({ from: r.account.address.toUpperCase(), cc: ['cc.person@mail.example.test'] }),
  );
  const from = r.store.commits.length;
  await historyPass(r);
  const fact = factsSince(r, from).find(f => f.remoteDraftId === draft.draftId)!;
  assert.equal(fact.text?.trim(), 'Phone text.');
  const message = fact.message!;
  assert.equal(message.from?.address, r.account.address.toLowerCase());
  assert.equal(message.remoteId, draft.messageId);
  assert.equal(message.remoteThreadId, draft.threadId);
  assert.deepEqual(
    message.to.map(a => a.address),
    ['maren.ashgrove@mail.example.test'],
  );
  assert.deepEqual(
    message.cc.map(a => a.address),
    ['cc.person@mail.example.test'],
  );
  assert.equal(message.subject, 'From the phone');
  assert.equal(message.partial, true);
  assert.ok(message.flags.draft);
  // What the engine stores from it (`messageWrite`, the same conversion the actor applies to the fact).
  assert.equal(messageWrite(r.account.id, r.account.address, message).hasAttachments, false);
});

test('prov-gmail-drafts fact metadata: a draft with a file or an inline image reports hasAttachments and delivers no body', async () => {
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
        {
          filename: 'pic.png',
          mimeType: 'image/png',
          data: Buffer.from('png'),
          cid: 'pic',
          inline: true,
        },
      ],
    }),
  );
  const from = r.store.commits.length;
  await historyPass(r);
  const facts = factsSince(r, from);
  for (const draft of [file, inline]) {
    const fact = facts.find(f => f.remoteDraftId === draft.draftId)!;
    assert.equal(fact.html, undefined);
    assert.equal(fact.text, undefined);
    assert.equal(fact.message?.from?.address, r.account.address.toLowerCase());
    assert.ok(fact.message!.attachments!.length > 0);
    const stored = messageWrite(r.account.id, r.account.address, fact.message!);
    assert.equal(stored.hasAttachments, true, 'the engine reads it as a draft with attachments');
  }
});

test('prov-gmail-drafts fact metadata: no From header means no message AND no body (never html/text without the recipients and subject)', async () => {
  const holder: { emu?: GmailEmulator } = {};
  const r = await rig({ threads: 60, adapter: { fetch: withoutFrom(holder) } });
  holder.emu = r.emu;
  await r.drive({ until: windowDone(r), maxSteps: 300 });
  await r.clock.advance(60_000);
  const draft = r.emu.mailbox.createDraftElsewhere(spec());
  const from = r.store.commits.length;
  await historyPass(r);
  const fact = factsSince(r, from).find(f => f.remoteDraftId === draft.draftId)!;
  assert.ok(fact, 'still reported');
  assert.equal(fact.text, undefined);
  assert.equal(fact.html, undefined);
  assert.equal(fact.message, undefined);
});

test('prov-gmail-drafts fact metadata: a draft whose body was not read (a failed read) carries no message', async () => {
  const faults = createFaultInjector();
  const r = await syncedWith({ emulator: { faults } });
  const draft = r.emu.mailbox.createDraftElsewhere(spec());
  faults.failNext(
    { apiMethod: 'gmail.users.drafts.get' },
    { status: 503, reason: 'backendError', message: 'Backend Error' },
    { times: 20 },
  );
  const from = r.store.commits.length;
  await historyPass(r);
  const fact = factsSince(r, from).find(f => f.remoteDraftId === draft.draftId)!;
  assert.ok(fact, 'still reported');
  assert.equal(fact.message, undefined);
  assert.equal(fact.text, undefined);
});

test('prov-gmail-drafts fact metadata: bcc is [] when the draft has no Bcc header and lists the Bcc header (lower-cased) when it has one', async () => {
  const r = await synced();
  const plain = r.emu.mailbox.createDraftElsewhere(spec());
  const hidden = r.emu.mailbox.createDraftElsewhere(
    spec({
      headers: { Bcc: 'Quiet Person <Quiet.Person@Mail.Example.test>, other@mail.example.test' },
    }),
  );
  const from = r.store.commits.length;
  await historyPass(r);
  const facts = factsSince(r, from);
  assert.deepEqual(facts.find(f => f.remoteDraftId === plain.draftId)!.message!.bcc, []);
  const bcc = facts.find(f => f.remoteDraftId === hidden.draftId)!.message!.bcc;
  assert.deepEqual(bcc, [
    { address: 'quiet.person@mail.example.test', name: 'Quiet Person' },
    { address: 'other@mail.example.test' },
  ]);
});

// ---- the charset of a part ----

const withCharset = (charset: string, bytes: Buffer) => ({
  mimeType: 'text/plain',
  headers: [{ name: 'Content-Type', value: `text/plain; charset=${charset}` }],
  body: { size: bytes.length, data: bytes.toString('base64url') },
});

async function payloadRig(payload: unknown): Promise<{ r: Rig; draftId: string }> {
  const holder: { emu?: GmailEmulator } = {};
  const r = await rig({ threads: 60, adapter: { fetch: payloadFetch(holder, () => payload) } });
  holder.emu = r.emu;
  await r.drive({ until: windowDone(r), maxSteps: 300 });
  await r.clock.advance(60_000);
  return { r, draftId: r.emu.mailbox.createDraftElsewhere(spec()).draftId };
}

const deliveredText = async (payload: unknown): Promise<string | undefined> => {
  const { r, draftId } = await payloadRig(payload);
  const from = r.store.commits.length;
  await historyPass(r);
  const fact = factsSince(r, from).find(f => f.remoteDraftId === draftId)!;
  assert.ok(fact, 'still reported');
  return fact.text;
};

test('prov-gmail-drafts body decoding: a part in a known non-UTF-8 charset is decoded in it', async () => {
  const text = await deliveredText(withCharset('iso-8859-1', Buffer.from('caf\xe9', 'latin1')));
  assert.equal(text, 'caf\u00e9');
});

test('prov-gmail-drafts body decoding: an unknown charset label gives no body, not a UTF-8 guess', async () => {
  assert.equal(
    await deliveredText(withCharset('x-no-such-charset', Buffer.from('hello'))),
    undefined,
  );
});

test('prov-gmail-drafts body decoding: bytes that are not valid in the charset give no body, not replacement characters', async () => {
  assert.equal(
    await deliveredText(withCharset('utf-8', Buffer.from([0x68, 0xff, 0xfe, 0x69]))),
    undefined,
  );
  assert.equal(
    await deliveredText({ mimeType: 'text/plain', body: { size: 2, data: b64('ok') } }),
    'ok',
  );
});

test('prov-gmail-drafts body decoding: a part that cannot fit the cap is skipped before it is decoded', async () => {
  const decoded: number[] = [];
  const Real = globalThis.TextDecoder;
  globalThis.TextDecoder = class extends Real {
    override decode(input?: AllowSharedBufferSource, options?: TextDecodeOptions): string {
      decoded.push((input as Uint8Array | undefined)?.byteLength ?? 0);
      return super.decode(input, options);
    }
  } as typeof TextDecoder;
  try {
    const big = Buffer.alloc(4_000_100, 0x61);
    assert.equal(await deliveredText(withCharset('utf-8', big)), undefined);
    // Declared size over the limit: skipped without a decode, whatever the data says.
    const declared = { mimeType: 'text/plain', body: { size: 5_000_000, data: b64('short') } };
    assert.equal(await deliveredText(declared), undefined);
  } finally {
    globalThis.TextDecoder = Real;
  }
  assert.ok(
    decoded.every(n => n < 4_000_000),
    `decoded sizes ${decoded.join(',')}`,
  );
  assert.ok(!decoded.includes(5), 'the part with the oversized declared size was not decoded');
});

// ---- the read bound is per pass, not per page ----

test('prov-gmail-drafts body delivery: the 5-read bound holds across the pages of one pass', async () => {
  const r = await syncedWith({ threads: 600 });
  for (let i = 0; i < 8; i++) r.emu.mailbox.createDraftElsewhere(spec({ subject: `Phone ${i}` }));
  // About 1,300 label records: several history pages of 500 after the drafts.
  const ids = [...r.store.rows.keys()];
  r.emu.mailbox.relabel({ messageIds: ids }, ['STARRED'], []);
  r.emu.mailbox.relabel({ messageIds: ids }, [], ['STARRED']);
  r.emu.mailbox.relabel({ messageIds: ids.slice(0, 400) }, ['STARRED'], []);
  const start = r.clock.now();
  const from = r.store.commits.length;
  let steps = 0;
  for (; steps < 50; steps++) {
    await r.drive({ trigger: 'manual', scopes: ['history'], maxSteps: 1 });
    if (!/^pass:/.test(r.store.states.get('history')?.phase ?? '')) break;
  }
  assert.ok(steps >= 2, `the pass had ${steps + 1} pages`);
  assert.equal(fullReads(r, start).length, 5, 'five reads in the whole pass');
  assert.equal(factsSince(r, from).filter(f => f.text !== undefined).length, 5);
  // The next pass takes the rest.
  await r.clock.advance(60_000);
  const next = r.clock.now();
  await historyPass(r);
  assert.equal(fullReads(r, next).length, 3);
});

// ---- headers that the fact cannot show whole: no body next to them ----

const plainBody = (headers: { name: string; value: string }[]) => ({
  mimeType: 'text/plain',
  headers,
  body: { size: 4, data: b64('body') },
});

const ambiguous: [string, { name: string; value: string }[]][] = [
  ['a second To header', [{ name: 'To', value: 'second@mail.example.test' }]],
  [
    'a second Cc header',
    [
      { name: 'Cc', value: 'one@mail.example.test' },
      { name: 'Cc', value: 'two@mail.example.test' },
    ],
  ],
  ['a second From header', [{ name: 'From', value: 'other@mail.example.test' }]],
  ['a second Subject header', [{ name: 'Subject', value: 'Another subject' }]],
  ['a Reply-To header', [{ name: 'Reply-To', value: 'elsewhere@mail.example.test' }]],
];

/** Single headers that replace the draft's own (not a second copy), so only the decode rule can refuse them. */
const undecoded: [string, { name: string; value: string }[]][] = [
  ['a subject that did not decode (U+FFFD)', [{ name: 'Subject', value: '=?utf-8?B?/w==?=' }]],
  [
    'a display name that did not decode (U+FFFD)',
    [{ name: 'To', value: '=?utf-8?B?/w==?= <x@mail.example.test>' }],
  ],
  [
    'a subject with an encoded word of an unknown charset',
    [{ name: 'Subject', value: 'Plans =?unknown-charset?Q?caf=E9?=' }],
  ],
  [
    'a display name with an encoded word of an unknown charset',
    [{ name: 'To', value: '=?unknown-charset?Q?caf=E9?= <x@mail.example.test>' }],
  ],
];

const refusals: [string, { name: string; value: string }[], boolean][] = [
  ...ambiguous.map(([name, headers]): [string, { name: string; value: string }[], boolean] => [
    name,
    headers,
    false,
  ]),
  ...undecoded.map(([name, headers]): [string, { name: string; value: string }[], boolean] => [
    name,
    headers,
    true,
  ]),
];

for (const [name, headers, replace] of refusals) {
  test(`prov-gmail-drafts body delivery: ${name} means no body, the message is still reported`, async () => {
    const { r, draftId } = await payloadRig({
      ...plainBody(headers),
      ...(replace ? { replaceHeaders: true } : {}),
    });
    const from = r.store.commits.length;
    await historyPass(r);
    const fact = factsSince(r, from).find(f => f.remoteDraftId === draftId)!;
    assert.ok(fact, 'reported');
    assert.equal(fact.text, undefined);
    assert.equal(fact.html, undefined);
    assert.ok(fact.message, 'metadata still shown');
  });
}

test('prov-gmail-drafts body delivery: single From, To, Cc and Subject headers (and In-Reply-To) still deliver the body', async () => {
  const { r, draftId } = await payloadRig(
    plainBody([{ name: 'In-Reply-To', value: '<parent@mail.example.test>' }]),
  );
  const from = r.store.commits.length;
  await historyPass(r);
  assert.equal(factsSince(r, from).find(f => f.remoteDraftId === draftId)!.text, 'body');
});
