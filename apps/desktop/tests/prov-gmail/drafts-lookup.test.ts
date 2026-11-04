/**
 * prov-gmail-write drafts, the create lookup (google/drafts.ts): a hit is compared with our bytes (the engine's rebuilt
 * MIME has new boundaries), a vanished hit is never "absent", and a conflict on the create path names no draft
 * (PORT GAP 4). Each test fails on the broken version it names.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFaultInjector } from '@aplos/emulators';
import { ProviderError, type DraftUpload } from '@aplos/engine/ports';
import { buildMime } from '../../../../packages/engine/src/outbox/mime';
import { canonicalMime } from '../../src/host/providers/google/draft-compare';
import {
  apiCalls,
  mimeOf,
  nextNumber,
  saved,
  setup,
  uncertainCreate,
  uploadedBytes,
  type Setup,
} from './draft-rig';

// ---- the create lookup: a hit is compared with our bytes, a vanished hit is never "absent" ----

const rawReads = (s: Setup) =>
  s.bridge.requests.filter(
    r => r.method === 'GET' && /\/drafts\/[^/]+$/.test(r.path) && r.query.get('format') === 'raw',
  );

test('prov-gmail-drafts a hit with our bytes is saved with its current message id after one raw read', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const upload = await uncertainCreate(s, faults);
  const before = apiCalls(s).length;
  const result = saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
  assert.equal(result.remoteMessageId, s.remoteDrafts()[0].messageId);
  assert.equal(rawReads(s).length, 1, 'the hit was read raw once');
  const raw = apiCalls(s, before).find(c => c.method === 'gmail.drafts.get' && c.cost === 60);
  assert.ok(raw, 'priced as a full read (60)');
  assert.equal(s.bridge.uploads.length, 1);
});

test('prov-gmail-drafts a hit whose line endings differ only is still our copy', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const upload = await uncertainCreate(s, faults);
  const lf = Buffer.from(
    Buffer.from(upload.mime).toString('latin1').replace(/\r\n/g, '\n'),
    'latin1',
  );
  s.r.emu.mailbox.updateDraft(s.remoteDrafts()[0].id, lf);
  saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
  assert.equal(s.bridge.uploads.length, 1);
});

for (const [name, blind] of [
  ['found by the search (a)', false],
  ['found in the newest drafts (b)', true],
] as const) {
  test(`prov-gmail-drafts a phone edit that keeps our Message-ID before the retried create is a conflict, never adopted (${name})`, async () => {
    const faults = createFaultInjector();
    const s = await setup({ emulator: { faults } });
    const upload = await uncertainCreate(s, faults);
    // The phone keeps every header we wrote: our Message-ID and our token.
    const { mime } = mimeOf(s.r.account.address, {
      id: upload.internetId,
      token: upload.internetId,
      body: 'Phone text.',
    });
    const phone = s.r.emu.mailbox.updateDraft(s.remoteDrafts()[0].id, mime);
    s.bridge.blindSearch = blind;
    const result = await s.r.adapter.saveDraft(upload, s.r.ctx());
    assert.deepEqual(result, {
      kind: 'conflict',
      remoteMessageId: phone.message.id,
      remoteDraftId: s.remoteDrafts()[0].id,
      remoteInternetId: upload.internetId,
    });
    assert.equal(s.bridge.uploads.length, 1, 'nothing was written');
    assert.equal(s.remoteDrafts().length, 1);
    assert.match(s.remoteDrafts()[0].text, /Phone text\./);
  });
}

test('prov-gmail-drafts known limit: a hit that differs by a harmless rewrite (whitespace) is a conflict, the comparison is exact', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const upload = await uncertainCreate(s, faults);
  const padded = Buffer.from(uploadedBytes(upload).toString('latin1') + ' ', 'latin1');
  const edited = s.r.emu.mailbox.updateDraft(s.remoteDrafts()[0].id, padded);
  const result = await s.r.adapter.saveDraft(upload, s.r.ctx());
  assert.deepEqual(result, {
    kind: 'conflict',
    remoteMessageId: edited.message.id,
    remoteDraftId: s.remoteDrafts()[0].id,
    remoteInternetId: upload.internetId,
  });
  assert.equal(s.bridge.uploads.length, 1);
});

test('prov-gmail-drafts a raw read that fails after a hit is thrown, never saved, nothing uploaded', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const upload = await uncertainCreate(s, faults);
  // The metadata read of the hit passes, then every try of the raw read fails.
  faults.failNext(
    { apiMethod: 'gmail.users.drafts.get', after: 1 },
    { status: 503, reason: 'backendError', message: 'Backend Error' },
    { times: 20 },
  );
  const error = await s.r.adapter.saveDraft(upload, s.r.ctx()).catch((e: unknown) => e);
  assert.ok(error instanceof ProviderError, JSON.stringify(error));
  assert.equal(error.error.class, 'transient');
  assert.equal(s.bridge.uploads.length, 1);
  faults.clear();
  saved(await s.r.adapter.saveDraft(upload, s.r.ctx()));
});

test('prov-gmail-drafts a hit that is sent between the metadata read and the raw read is thrown, not saved', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const upload = await uncertainCreate(s, faults);
  s.bridge.rewriteDraftGet = json => {
    const message = json.message as { raw?: string; labelIds?: string[] };
    return message.raw ? { ...json, message: { ...message, labelIds: ['SENT'] } } : json;
  };
  const error = await s.r.adapter.saveDraft(upload, s.r.ctx()).catch((e: unknown) => e);
  assert.ok(error instanceof ProviderError && error.error.class === 'transient');
  assert.equal(s.bridge.uploads.length, 1);
});

test('prov-gmail-drafts a hit of the all-mail lookup that returns 404 is thrown as vanished, never absent', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const upload = await uncertainCreate(s, faults);
  // Sent elsewhere; the message id changed while the index still lists the old one.
  s.r.emu.mailbox.trashMessage(s.remoteDrafts()[0].messageId);
  faults.failNext(
    { apiMethod: 'gmail.users.messages.get' },
    { status: 404, reason: 'notFound', message: 'Requested entity was not found.' },
  );
  const error = await s.r.adapter.saveDraft(upload, s.r.ctx()).catch((e: unknown) => e);
  assert.ok(error instanceof ProviderError, JSON.stringify(error));
  assert.equal(error.error.class, 'transient');
  assert.equal(error.error.reason, 'draftHitVanished');
  assert.equal(s.bridge.uploads.length, 1, 'the draft was not created again');
  assert.deepEqual(await s.r.adapter.saveDraft(upload, s.r.ctx()), { kind: 'gone' });
});

test('prov-gmail-drafts a draft-only hit of the all-mail lookup is index lag: transient, nothing uploaded', async () => {
  const faults = createFaultInjector();
  // The all-mail lookup (c) searches by Message-ID, which only a provider that keeps ours can answer: pinned to
  // 'kept'. On Gmail (rewritten) the same case is a visible duplicate: drafts-token.test.ts.
  const s = await setup({ emulator: { faults, draftIdentity: 'kept' } });
  const upload = await uncertainCreate(s, faults);
  s.bridge.blindSearch = true;
  // More drafts than the newest page holds push ours out of lookup (b).
  for (let i = 0; i < 11; i++)
    s.r.emu.mailbox.createDraftElsewhere({ subject: `Phone ${i}`, text: 'Not ours.' });
  const error = await s.r.adapter.saveDraft(upload, s.r.ctx()).catch((e: unknown) => e);
  assert.ok(error instanceof ProviderError, JSON.stringify(error));
  assert.equal(error.error.class, 'transient');
  assert.equal(error.error.reason, 'draftIndexLag');
  assert.equal(s.bridge.uploads.length, 1);
});

for (const method of ['messages.list', 'messages.get'] as const) {
  test(`prov-gmail-drafts an error from ${method} in the all-mail lookup is thrown, with zero uploads`, async () => {
    const faults = createFaultInjector();
    const s = await setup({ emulator: { faults } });
    s.r.emu.mailbox.trashMessage(s.r.emu.mailbox.createDraftElsewhere({ subject: 'x' }).messageId);
    const upload = s.upload({ body: 'Fresh.' });
    if (method === 'messages.get') {
      // A message holding our Message-ID, so the lookup has something to read.
      s.r.emu.mailbox.addMessage({
        messageId: upload.internetId.slice(1, -1),
        labelIds: ['INBOX'],
      });
    }
    faults.failNext(
      { apiMethod: `gmail.users.${method}` },
      { status: 503, reason: 'backendError', message: 'Backend Error' },
      { times: 20 },
    );
    const error = await s.r.adapter.saveDraft(upload, s.r.ctx()).catch((e: unknown) => e);
    assert.ok(error instanceof ProviderError, JSON.stringify(error));
    assert.equal(error.error.class, 'transient');
    assert.equal(s.bridge.uploads.length, 0, 'nothing was created');
  });
}

test('prov-gmail-drafts a search with more hits than one page is thrown as partial, never absent', async () => {
  const s = await setup();
  const upload = s.upload({ body: 'Fresh.' });
  // Eleven received messages hold the same Message-ID (none is a draft): the all-mail page is full and has a next page.
  for (let i = 0; i < 11; i++)
    s.r.emu.mailbox.addMessage({ messageId: upload.internetId.slice(1, -1), labelIds: ['INBOX'] });
  const error = await s.r.adapter.saveDraft(upload, s.r.ctx()).catch((e: unknown) => e);
  assert.ok(error instanceof ProviderError, JSON.stringify(error));
  assert.equal(error.error.reason, 'draftSearchPartial');
  assert.equal(s.bridge.uploads.length, 0);
});

// ---- the engine rebuilds the MIME on every attempt: new boundaries, same message ----

let seed = 0;
/** The engine's own `buildMime` (what `draftMime` calls) with its own random boundaries, a fresh seed per call. */
function engineMime(
  s: Setup,
  over: { html?: string; subject?: string; id: string; attachment?: boolean },
) {
  return buildMime({
    from: { address: s.r.account.address },
    to: [{ address: 'friend@example.test' }],
    cc: [],
    subject: over.subject ?? 'Engine draft',
    html: over.html ?? '<p>Hello from the engine.</p>',
    messageId: over.id,
    date: Date.UTC(2026, 9, 30, 10),
    attachments: over.attachment
      ? [{ name: 'a.txt', mime: 'text/plain', bytes: Buffer.from('attached') }]
      : [],
    randomBytes: n => Uint8Array.from({ length: n }, (_, i) => (seed++ * 13 + i * 7) % 256),
  });
}

function engineUpload(s: Setup, mime: Uint8Array, id: string): DraftUpload {
  return { draftId: 'local-1', revision: 1, fingerprint: 'fp-1', internetId: id, mime };
}

for (const attachment of [false, true]) {
  test(`prov-gmail-drafts the engine's rebuilt MIME (new boundaries${attachment ? ', nested mixed' : ''}) finds the unedited copy: saved, not a conflict`, async () => {
    const faults = createFaultInjector();
    const s = await setup({ emulator: { faults } });
    const id = `<engine-${nextNumber()}@aplos.test>`;
    const first = engineMime(s, { id, attachment });
    const second = engineMime(s, { id, attachment });
    assert.notDeepEqual(second, first, 'the engine gave different bytes: other boundaries');
    await uncertainCreate(s, faults, engineUpload(s, first, id));
    const result = saved(await s.r.adapter.saveDraft(engineUpload(s, second, id), s.r.ctx()));
    assert.equal(result.remoteMessageId, s.remoteDrafts()[0].messageId);
    assert.equal(s.bridge.uploads.length, 1);
  });
}

for (const [name, change] of [
  ['body text', { html: '<p>Hello from the phone.</p>' }],
  ['subject header', { subject: 'Phone subject' }],
] as const) {
  test(`prov-gmail-drafts a changed ${name} under the engine's rebuilt MIME is a conflict`, async () => {
    const faults = createFaultInjector();
    const s = await setup({ emulator: { faults } });
    const id = `<engine-${nextNumber()}@aplos.test>`;
    await uncertainCreate(s, faults, engineUpload(s, engineMime(s, { id }), id));
    // The phone keeps our headers, the token included.
    const phone = s.r.emu.mailbox.updateDraft(
      s.remoteDrafts()[0].id,
      uploadedBytes({ internetId: id, mime: engineMime(s, { id, ...change }) }),
    );
    const retry = engineUpload(s, engineMime(s, { id }), id);
    assert.deepEqual(await s.r.adapter.saveDraft(retry, s.r.ctx()), {
      kind: 'conflict',
      remoteMessageId: phone.message.id,
      remoteDraftId: s.remoteDrafts()[0].id,
      remoteInternetId: id,
    });
    assert.equal(s.bridge.uploads.length, 1);
  });
}

test('prov-gmail-drafts boundary blanking only touches declared boundaries: look-alike text still differs', () => {
  const mime = (b: string, extra: string) =>
    Buffer.from(
      [
        'Subject: x',
        `Content-Type: multipart/alternative; boundary="${b}"`,
        '',
        `--${b}`,
        'Content-Type: text/plain',
        '',
        `body ${extra}`,
        `--${b}--`,
        '',
      ].join('\r\n'),
    );
  assert.equal(canonicalMime(mime('AAA', '--BBB')), canonicalMime(mime('CCC', '--BBB')));
  assert.notEqual(canonicalMime(mime('AAA', '--AAA ')), canonicalMime(mime('AAA', '--AAB ')));
  assert.notEqual(canonicalMime(mime('AAA', 'one')), canonicalMime(mime('AAA', 'two')));
});

test('prov-gmail-drafts boundary blanking: a delimiter on its own line is blanked, look-alike lines and text are not', () => {
  const mime = (b: string, lines: string[]) =>
    Buffer.from(
      [
        'Subject: x',
        `Content-Type: multipart/alternative; boundary="${b}"`,
        '',
        `--${b}`,
        'Content-Type: text/plain',
        '',
        ...lines,
        `--${b}--`,
        '',
      ].join('\r\n'),
    );
  const plain = ['line one', 'line two'];
  // The real delimiters are on their own lines: with another boundary the message is the same.
  assert.equal(canonicalMime(mime('AAA', plain)), canonicalMime(mime('CCC', plain)));
  assert.ok(!canonicalMime(mime('AAA', plain)).includes('--AAA'), 'delimiter lines are blanked');
  // Look-alikes inside the body stay as they are: they are text, not delimiters.
  for (const lookAlike of ['quoted --AAA text', '--AAAX', ' --AAA', '--AAA-', 'x--AAA']) {
    const lines = ['line one', lookAlike, 'line two'];
    assert.ok(canonicalMime(mime('AAA', lines)).includes(lookAlike), `${lookAlike} kept`);
    assert.notEqual(
      canonicalMime(mime('AAA', lines)),
      canonicalMime(mime('AAA', ['line one', lookAlike.replace('AAA', 'CCC'), 'line two'])),
      `${lookAlike} is not treated as a boundary`,
    );
  }
});

// ---- PORT GAP 4 (closed by #153): a conflict on the create path names the copy and its Message-ID ----

test("prov-gmail-drafts PORT GAP 4: a create-path conflict names remoteDraftId, remoteMessageId and the copy's Message-ID", async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const upload = await uncertainCreate(s, faults);
  const { mime } = mimeOf(s.r.account.address, {
    id: upload.internetId,
    token: upload.internetId,
    body: 'Phone text.',
  });
  const phone = s.r.emu.mailbox.updateDraft(s.remoteDrafts()[0].id, mime);
  const result = await s.r.adapter.saveDraft(upload, s.r.ctx());
  assert.deepEqual(result, {
    kind: 'conflict',
    remoteMessageId: phone.message.id,
    remoteDraftId: s.remoteDrafts()[0].id,
    remoteInternetId: upload.internetId,
  });
  assert.equal(s.remoteDrafts().length, 1, 'the copy is neither deleted nor overwritten');
  assert.match(s.remoteDrafts()[0].text, /Phone text\./);
});

test('prov-gmail-drafts PORT GAP 4: the Message-ID is the one the copy carries, read from its own header (folded, other case)', async () => {
  const faults = createFaultInjector();
  const s = await setup({ emulator: { faults } });
  const upload = await uncertainCreate(s, faults);
  const raw = uploadedBytes(upload)
    .toString('latin1')
    .replace('X-Aplos-Draft: ', 'x-aplos-draft:\r\n ')
    .replace('Message-ID: ', 'message-id:\r\n ')
    .replace('Landed.', 'Phone text.');
  s.r.emu.mailbox.updateDraft(s.remoteDrafts()[0].id, Buffer.from(raw, 'latin1'));
  const result = await s.r.adapter.saveDraft(upload, s.r.ctx());
  assert.equal(result.kind, 'conflict');
  if (result.kind !== 'conflict') return;
  assert.equal(result.remoteInternetId, upload.internetId);
});
