/**
 * Emulator option `draftIdentity: 'rewritten'` and `dropDraftHeaders` (live finding 2026-11-04: real Gmail replaces the
 * Message-ID of a draft the API saves and may drop a custom header), and `drafts.list?q=`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGmailEmulator, FakeClock, type GmailEmulatorOptions } from '../src/index';
import { setup } from './gmail-helpers';
import { withoutHeaders } from '../src/gmail/mime';

const raw = (extra: string[] = []) =>
  Buffer.from(
    [
      'Subject: probe',
      'Message-ID: <ours-1@aplos.invalid>',
      'X-Aplos-Probe: token',
      ...extra,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Body mentions Message-ID: <ours-1@aplos.invalid> and X-Aplos-Probe: token.',
    ].join('\r\n'),
  );

function make(options: Partial<GmailEmulatorOptions> = {}) {
  return createGmailEmulator({ clock: new FakeClock(), latencyMs: 0, ...options });
}

test('default: a draft keeps the Message-ID and custom header the client wrote, through create and update', () => {
  const emu = make();
  const made = emu.mailbox.createDraft(raw());
  assert.equal(made.message.messageId, 'ours-1@aplos.invalid');
  const updated = emu.mailbox.updateDraft(made.id, raw());
  assert.equal(updated.message.messageId, 'ours-1@aplos.invalid');
});

test("'rewritten': create and every update give the draft a new <hex@mail.gmail.com> Message-ID; the draft id stays", () => {
  const emu = make({ draftIdentity: 'rewritten' });
  const made = emu.mailbox.createDraft(raw());
  assert.match(made.message.messageId, /^[0-9a-f]{20}@mail\.gmail\.com$/);
  const updated = emu.mailbox.updateDraft(made.id, raw());
  assert.equal(updated.id, made.id);
  assert.match(updated.message.messageId, /^[0-9a-f]{20}@mail\.gmail\.com$/);
  assert.notEqual(updated.message.messageId, made.message.messageId);
  assert.notEqual(updated.message.messageId, 'ours-1@aplos.invalid');
});

test("a message that is not a draft keeps its Message-ID under 'rewritten' (send and insert are not drafts)", () => {
  const emu = make({ draftIdentity: 'rewritten' });
  const inserted = emu.mailbox.insertRaw(raw(), ['INBOX'], undefined, 'receivedTime');
  assert.equal(inserted.messageId, 'ours-1@aplos.invalid');
});

test('dropDraftHeaders removes the named header (any case, folded lines included) from saved drafts only, never from the body', async () => {
  const emu = make({ dropDraftHeaders: ['x-aplos-probe'] });
  const made = emu.mailbox.createDraft(raw(['X-Folded: one', ' two']));
  const stored = emu.mailbox.listDrafts().find(d => d.id === made.id)!;
  assert.equal(
    stored.message.messageId,
    'ours-1@aplos.invalid',
    'identity is kept unless rewritten',
  );
  const result = withoutHeaders(raw(['X-Aplos-Probe: second', ' folded part']), [
    'X-APLOS-PROBE',
  ]).toString();
  assert.ok(!/^X-Aplos-Probe/im.test(result.split('\r\n\r\n')[0]!), 'no such header left');
  assert.ok(!/folded part/.test(result.split('\r\n\r\n')[0]!), 'its continuation went with it');
  assert.ok(/Body mentions Message-ID: <ours-1/.test(result), 'the body is untouched');
  assert.ok(/Subject: probe/.test(result));
});

test('drafts.list q= narrows the list like messages.list (rfc822msgid:, subject:)', async () => {
  const h = await setup({ draftIdentity: 'rewritten' });
  const a = h.emu.mailbox.createDraft(raw());
  h.emu.mailbox.createDraft(Buffer.from('Subject: other\r\n\r\nx'));
  const count = async (q: string) =>
    ((await h.api(`/drafts?q=${encodeURIComponent(q)}`)).json.drafts ?? []).length;
  assert.equal(await count(`rfc822msgid:${a.message.messageId}`), 1);
  assert.equal(
    await count('rfc822msgid:ours-1@aplos.invalid'),
    0,
    'the rewritten draft is not found by our id',
  );
  assert.equal(await count('subject:other'), 1);
  assert.equal(await count(''), 2);
});
