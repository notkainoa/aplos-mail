import test from 'node:test';
import assert from 'node:assert/strict';
import { rawMessage, setup, type Harness } from './gmail-helpers';

const DAY = 86400_000;

/** A small hand-made mailbox so every query test knows exactly what to expect. */
async function withMail(): Promise<Harness & { ids: Record<string, string> }> {
  const h = await setup({ unitsPerMinute: 10_000_000 });
  const mb = h.emu.mailbox;
  const now = h.clock.now();
  const projects = mb.createLabel('Projects').id;
  const team = mb.createLabel('Team Notes').id;
  const ids: Record<string, string> = {};
  ids.invoice = mb.addMessage({
    from: 'Billing Desk <billing@shop.example.test>',
    subject: 'Invoice 4411 attached',
    text: 'Please find the quarterly invoice attached.',
    labelIds: ['INBOX', 'UNREAD'],
    internalDate: now - 2 * DAY,
    messageId: 'invoice@shop.example.test',
  }).id;
  ids.lunch = mb.addMessage({
    from: 'Ana Keller <ana@mail.example.test>',
    subject: 'Lunch on Friday?',
    text: 'Shall we try the noodle place near the library?',
    labelIds: ['INBOX', 'IMPORTANT', projects],
    internalDate: now - 5 * DAY,
  }).id;
  ids.notes = mb.addMessage({
    from: 'Ana Keller <ana@mail.example.test>',
    subject: 'Meeting notes',
    text: 'Notes with a "golden ticket" phrase inside.',
    labelIds: ['INBOX', 'STARRED', team],
    internalDate: now - 20 * DAY,
  }).id;
  ids.sent = mb.addMessage({
    from: mb.emailAddress,
    to: ['ana@mail.example.test'],
    subject: 'Re: Lunch on Friday?',
    text: 'Yes please.',
    labelIds: ['SENT'],
    internalDate: now - 4 * DAY,
    replyTo: ids.lunch,
  }).id;
  ids.junk = mb.addMessage({
    from: 'spam@junk.example.test',
    subject: 'You won a prize',
    text: 'Claim your prize',
    labelIds: ['SPAM'],
    internalDate: now - 1 * DAY,
  }).id;
  ids.old = mb.addMessage({
    from: 'archive@mail.example.test',
    subject: 'Old thing',
    text: 'Archived long ago',
    labelIds: [],
    internalDate: Date.UTC(2026, 0, 15),
  }).id;
  mb.history.clear();
  return Object.assign(h, { ids });
}

const idsOf = (json: any): string[] => (json.messages ?? []).map((m: { id: string }) => m.id);

test('profile, label list and label counts', async () => {
  const h = await withMail();
  const profile = await h.api('/profile');
  assert.equal(profile.json.emailAddress, 'test.user@example.test');
  assert.equal(profile.json.messagesTotal, 6);
  assert.equal(profile.json.threadsTotal, 5, 'the reply joined the lunch thread');
  assert.match(profile.json.historyId, /^\d+$/);

  const labels = await h.api('/labels');
  assert.ok(labels.json.labels.some((l: any) => l.id === 'INBOX' && l.type === 'system'));
  const inbox = await h.api('/labels/INBOX');
  assert.equal(inbox.json.messagesTotal, 3);
  assert.equal(inbox.json.messagesUnread, 1);
  assert.equal((await h.api('/labels/Nope')).status, 404);
});

test('labels.create stores visibility and answers 409 on a duplicate name', async () => {
  const h = await setup();
  const created = await h.api('/labels', {
    method: 'POST',
    body: { name: 'Receipts', labelListVisibility: 'labelHide', messageListVisibility: 'hide' },
  });
  assert.equal(created.status, 200);
  assert.equal(created.json.type, 'user');
  assert.equal(created.json.labelListVisibility, 'labelHide');
  const fetched = await h.api(`/labels/${created.json.id}`);
  assert.equal(fetched.json.messageListVisibility, 'hide');
  const duplicate = await h.api('/labels', { method: 'POST', body: { name: 'receipts' } });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.json.error.errors[0].reason, 'duplicate');
});

test('messages.list: newest first, spam and trash hidden by default, repeated labelIds', async () => {
  const h = await withMail();
  const all = await h.api('/messages');
  assert.deepEqual(idsOf(all.json), [
    h.ids.invoice,
    h.ids.sent,
    h.ids.lunch,
    h.ids.notes,
    h.ids.old,
  ]);
  assert.equal(all.json.resultSizeEstimate, 5);
  const withJunk = await h.api('/messages?includeSpamTrash=true');
  assert.equal(withJunk.json.resultSizeEstimate, 6);
  assert.deepEqual(
    idsOf(await h.api('/messages?labelIds=SPAM').then(r => r.json)),
    [h.ids.junk],
    'asking for SPAM by label shows it',
  );
  assert.deepEqual(idsOf((await h.api('/messages?labelIds=INBOX&labelIds=UNREAD')).json), [
    h.ids.invoice,
  ]);
  const none = await h.api('/messages?q=nonexistentword');
  assert.deepEqual(none.json, { resultSizeEstimate: 0 });
});

test('messages.list pages with a token and defaults to 100', async () => {
  const h = await setup({ threads: 150, unitsPerMinute: 10_000_000 });
  const first = await h.api('/messages');
  assert.equal(first.json.messages.length, 100);
  assert.ok(first.json.nextPageToken);
  const seen = new Set<string>(idsOf(first.json));
  let token: string | undefined = first.json.nextPageToken;
  while (token) {
    const next = await h.api(`/messages?maxResults=500&pageToken=${encodeURIComponent(token)}`);
    for (const id of idsOf(next.json)) {
      assert.ok(!seen.has(id), 'no repeats across pages');
      seen.add(id);
    }
    token = next.json.nextPageToken;
  }
  assert.equal(
    seen.size,
    h.emu.mailbox
      .listMessages()
      .filter(m => !m.labelIds.includes('SPAM') && !m.labelIds.includes('TRASH')).length,
  );
  assert.equal(
    (await h.api('/messages?maxResults=9999')).json.messages.length,
    Math.min(500, seen.size),
  );
  assert.equal((await h.api('/messages?pageToken=garbage')).status, 400);
});

test('search queries', async () => {
  const h = await withMail();
  const q = async (query: string) =>
    idsOf((await h.api(`/messages?q=${encodeURIComponent(query)}`)).json).sort();
  const sorted = (...names: string[]) => names.map(n => h.ids[n]).sort();
  assert.deepEqual(await q('label:projects'), sorted('lunch'));
  assert.deepEqual(
    await q('label:team-notes'),
    sorted('notes'),
    'spaces in label names become hyphens',
  );
  assert.deepEqual(await q('-label:inbox'), sorted('sent', 'old'));
  assert.deepEqual(await q('in:sent'), sorted('sent'));
  assert.deepEqual(await q('in:spam'), sorted('junk'));
  assert.deepEqual(
    await q('in:anywhere'),
    sorted('invoice', 'lunch', 'notes', 'sent', 'junk', 'old'),
  );
  assert.deepEqual(await q('is:unread'), sorted('invoice'));
  assert.deepEqual(await q('is:starred'), sorted('notes'));
  assert.deepEqual(await q('is:important'), sorted('lunch'));
  assert.deepEqual(await q('from:ana'), sorted('lunch', 'notes'));
  assert.deepEqual(await q('from:billing@shop.example.test'), sorted('invoice'));
  assert.deepEqual(await q('to:ana@mail.example.test'), sorted('sent'));
  assert.deepEqual(await q('subject:lunch'), sorted('lunch', 'sent'));
  assert.deepEqual(await q('rfc822msgid:<invoice@shop.example.test>'), sorted('invoice'));
  assert.deepEqual(await q('rfc822msgid:invoice@shop.example.test'), sorted('invoice'));
  assert.deepEqual(await q('newer_than:3d'), sorted('invoice'));
  assert.deepEqual(await q('older_than:10d'), sorted('notes', 'old'));
  assert.deepEqual(await q('before:2026/02/01'), sorted('old'));
  assert.deepEqual(await q('after:2026/02/01 label:starred'), sorted('notes'));
  assert.deepEqual(await q('noodle'), sorted('lunch'), 'bare words match the body');
  assert.deepEqual(await q('"golden ticket"'), sorted('notes'), 'quoted phrases');
  assert.deepEqual(await q('invoice -quarterly'), []);
  assert.deepEqual(await q('noodle OR archived'), sorted('lunch', 'old'));
  assert.deepEqual(await q('from:ana -subject:meeting'), sorted('lunch'));
});

test('messages.get in every format', async () => {
  const h = await withMail();
  const id = h.ids.invoice;
  const minimal = (await h.api(`/messages/${id}?format=minimal`)).json;
  assert.deepEqual(Object.keys(minimal).sort(), [
    'historyId',
    'id',
    'internalDate',
    'labelIds',
    'sizeEstimate',
    'snippet',
    'threadId',
  ]);
  assert.equal(typeof minimal.internalDate, 'string');

  const metadata = (
    await h.api(
      `/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=message-id`,
    )
  ).json;
  assert.deepEqual(metadata.payload.headers.map((x: any) => x.name).sort(), [
    'Message-ID',
    'Subject',
  ]);
  assert.equal(metadata.payload.parts, undefined);
  const allHeaders = (await h.api(`/messages/${id}?format=metadata`)).json.payload.headers.map(
    (x: any) => x.name,
  );
  assert.ok(allHeaders.includes('From') && allHeaders.includes('Date'));

  const full = (await h.api(`/messages/${id}`)).json;
  assert.equal(full.payload.mimeType, 'text/plain');
  assert.equal(
    Buffer.from(full.payload.body.data, 'base64url').toString(),
    'Please find the quarterly invoice attached.',
  );

  const raw = (await h.api(`/messages/${id}?format=raw`)).json;
  assert.match(
    Buffer.from(raw.raw, 'base64url').toString(),
    /^From: Billing Desk <billing@shop\.example\.test>\r\n/,
  );
  assert.equal(raw.payload, undefined);

  assert.equal((await h.api('/messages/00000000000000ff')).status, 404);
  assert.equal((await h.api('/messages/00000000000000ff')).json.error.errors[0].reason, 'notFound');
  const malformed = await h.api('/messages/doesnotexist');
  assert.equal(malformed.status, 400, 'a non-hex id is not a missing message');
  assert.equal(malformed.json.error.message, 'Invalid id value');
  assert.equal((await h.api(`/messages/${id}?format=bogus`)).status, 400);
  const thread = h.emu.mailbox.getMessage(id)!.threadId;
  assert.equal(
    (await h.api(`/threads/${thread}?format=raw`)).status,
    400,
    'raw exists only for messages',
  );
});

test('threads.list and threads.get group messages by thread', async () => {
  const h = await withMail();
  const list = await h.api('/threads');
  assert.equal(list.json.threads.length, 4);
  assert.ok(list.json.threads[0].snippet && list.json.threads[0].historyId);
  const lunchThread = h.emu.mailbox.getMessage(h.ids.lunch)!.threadId;
  const thread = await h.api(`/threads/${lunchThread}?format=metadata&metadataHeaders=Subject`);
  assert.deepEqual(
    thread.json.messages.map((m: any) => m.id),
    [h.ids.lunch, h.ids.sent],
  );
  assert.deepEqual(thread.json.messages[1].payload.headers, [
    { name: 'Subject', value: 'Re: Lunch on Friday?' },
  ]);
  assert.equal((await h.api('/threads/00000000000000ff')).status, 404);
  assert.equal((await h.api('/threads/nope')).status, 400);
});

test('attachments, and HTML bodies that Gmail returns as attachmentId-only parts', async () => {
  const h = await setup();
  const pdf = Buffer.from('%PDF-1.4 synthetic');
  const message = h.emu.mailbox.addMessage({
    subject: 'Mixed',
    text: 'plain part',
    html: '<p>html part</p>',
    htmlAsAttachment: true,
    attachments: [{ filename: 'receipt.pdf', mimeType: 'application/pdf', data: pdf }],
  });
  const full = (await h.api(`/messages/${message.id}`)).json;
  assert.equal(full.payload.mimeType, 'multipart/mixed');
  const [alternative, attachment] = full.payload.parts;
  assert.equal(alternative.mimeType, 'multipart/alternative');
  const [plain, html] = alternative.parts;
  assert.ok(plain.body.data, 'plain text is inline');
  assert.equal(html.body.data, undefined, 'the html body is attachmentId-only');
  assert.ok(html.body.attachmentId);
  assert.equal(attachment.filename, 'receipt.pdf');
  assert.equal(attachment.partId, '1');

  const htmlBody = (await h.api(`/messages/${message.id}/attachments/${html.body.attachmentId}`))
    .json;
  assert.equal(Buffer.from(htmlBody.data, 'base64url').toString(), '<p>html part</p>');
  assert.equal(htmlBody.size, '<p>html part</p>'.length);
  const file = (await h.api(`/messages/${message.id}/attachments/${attachment.body.attachmentId}`))
    .json;
  assert.deepEqual(Buffer.from(file.data, 'base64url'), pdf);
  assert.equal((await h.api(`/messages/${message.id}/attachments/unknown`)).status, 404);
});

test('modify, thread modify, batchModify, trash and untrash change labels and cost the table price', async () => {
  const h = await withMail();
  const modified = await h.api(`/messages/${h.ids.invoice}/modify`, {
    method: 'POST',
    body: { addLabelIds: ['STARRED'], removeLabelIds: ['UNREAD'] },
  });
  assert.deepEqual(modified.json.labelIds, ['INBOX', 'STARRED']);
  assert.equal(
    (
      await h.api(`/messages/${h.ids.invoice}/modify`, {
        method: 'POST',
        body: { addLabelIds: ['Label_99'] },
      })
    ).status,
    400,
  );
  assert.equal((await h.api('/messages/zzz/modify', { method: 'POST', body: {} })).status, 400);
  assert.equal(
    (await h.api('/messages/00000000000000ff/modify', { method: 'POST', body: {} })).status,
    404,
  );

  const thread = h.emu.mailbox.getMessage(h.ids.lunch)!.threadId;
  await h.api(`/threads/${thread}/modify`, { method: 'POST', body: { addLabelIds: ['UNREAD'] } });
  assert.ok(
    h.emu.mailbox.getMessage(h.ids.sent)!.labelIds.includes('UNREAD'),
    'every message in the thread changed',
  );

  const batch = await h.api('/messages/batchModify', {
    method: 'POST',
    body: { ids: [h.ids.lunch, h.ids.notes], removeLabelIds: ['INBOX'] },
  });
  assert.equal(batch.status, 204);
  assert.ok(!h.emu.mailbox.getMessage(h.ids.notes)!.labelIds.includes('INBOX'));
  const tooMany = await h.api('/messages/batchModify', {
    method: 'POST',
    body: { ids: Array.from({ length: 1001 }, (_, i) => `id${i}`), removeLabelIds: ['INBOX'] },
  });
  assert.equal(tooMany.status, 400);
  assert.equal(
    h.emu.log.at(-1)!.units,
    50,
    'a request that reached the handler and failed validation is still charged',
  );

  const trashed = await h.api(`/messages/${h.ids.invoice}/trash`, { method: 'POST' });
  assert.deepEqual(trashed.json.labelIds, ['STARRED', 'TRASH']);
  assert.equal(h.emu.log.at(-1)!.units, 20);
  assert.ok(!idsOf((await h.api('/messages')).json).includes(h.ids.invoice));
  const restored = await h.api(`/messages/${h.ids.invoice}/untrash`, { method: 'POST' });
  assert.deepEqual(restored.json.labelIds, ['STARRED', 'INBOX']);
  await h.api(`/threads/${thread}/trash`, { method: 'POST' });
  assert.ok(h.emu.mailbox.getMessage(h.ids.sent)!.labelIds.includes('TRASH'));
  await h.api(`/threads/${thread}/untrash`, { method: 'POST' });
  assert.ok(!h.emu.mailbox.getMessage(h.ids.sent)!.labelIds.includes('TRASH'));
});

test('messages.insert honours labelIds and internalDateSource', async () => {
  const h = await setup();
  const raw = rawMessage({
    subject: 'Inserted',
    messageId: 'ins@client.example.test',
    extra: ['Date: Tue, 01 Sep 2026 10:00:00 +0000'],
  });
  const received = await h.api('/messages/insert?internalDateSource=receivedTime', {
    method: 'POST',
    body: { raw, labelIds: ['INBOX', 'UNREAD'] },
  });
  assert.deepEqual(received.json.labelIds, ['INBOX', 'UNREAD']);
  assert.equal(h.emu.mailbox.getMessage(received.json.id)!.internalDate, h.clock.now());
  const dated = await h.api('/messages/insert?internalDateSource=dateHeader', {
    method: 'POST',
    body: {
      raw: rawMessage({ subject: 'Dated', extra: ['Date: Tue, 01 Sep 2026 10:00:00 +0000'] }),
    },
  });
  assert.equal(dated.json.labelIds, undefined, 'no labels unless asked for');
  assert.equal(h.emu.mailbox.getMessage(dated.json.id)!.internalDate, Date.UTC(2026, 8, 1, 10));
  assert.equal(h.emu.log.at(-1)!.units, 25);
  assert.equal((await h.api('/messages/insert', { method: 'POST', body: {} })).status, 400);
});

test('replies join the thread through In-Reply-To and a matching subject', async () => {
  const h = await setup();
  const first = await h.api('/messages/send', {
    method: 'POST',
    body: { raw: rawMessage({ subject: 'Plans', messageId: 'a@x.example.test' }) },
  });
  const reply = await h.api('/messages/send', {
    method: 'POST',
    body: {
      raw: rawMessage({
        subject: 'Re: Plans',
        messageId: 'b@x.example.test',
        extra: ['In-Reply-To: <a@x.example.test>'],
      }),
    },
  });
  const other = await h.api('/messages/send', {
    method: 'POST',
    body: {
      raw: rawMessage({
        subject: 'Different',
        messageId: 'c@x.example.test',
        extra: ['In-Reply-To: <a@x.example.test>'],
      }),
    },
  });
  assert.equal(reply.json.threadId, first.json.threadId);
  assert.notEqual(
    other.json.threadId,
    first.json.threadId,
    'a changed subject starts a new thread',
  );
  const explicit = await h.api('/messages/send', {
    method: 'POST',
    body: { raw: rawMessage({ subject: 'RE: plans' }), threadId: first.json.threadId },
  });
  assert.equal(
    explicit.json.threadId,
    first.json.threadId,
    'an explicit threadId joins when the subject matches (Re: and case ignored)',
  );
  const mismatched = await h.api('/messages/send', {
    method: 'POST',
    body: { raw: rawMessage({ subject: 'Anything' }), threadId: first.json.threadId },
  });
  assert.notEqual(
    mismatched.json.threadId,
    first.json.threadId,
    'an explicit threadId with another subject starts a new thread',
  );
  assert.equal(
    (
      await h.api('/messages/send', {
        method: 'POST',
        body: { raw: rawMessage({}), threadId: 'nope' },
      })
    ).status,
    404,
  );
});

test('drafts: update keeps the draft id and replaces the message id; send turns it into a SENT message', async () => {
  const h = await setup();
  const created = await h.api('/drafts', {
    method: 'POST',
    body: { message: { raw: rawMessage({ subject: 'Draft v1', body: 'first words' }) } },
  });
  assert.equal(created.status, 200);
  assert.deepEqual(created.json.message.labelIds, ['DRAFT']);
  const draftId = created.json.id;
  const firstMessage = created.json.message.id;

  const updated = await h.api(`/drafts/${draftId}`, {
    method: 'PUT',
    body: { message: { raw: rawMessage({ subject: 'Draft v2', body: 'second words' }) } },
  });
  assert.equal(updated.json.id, draftId);
  assert.notEqual(updated.json.message.id, firstMessage);
  assert.equal(updated.json.message.threadId, created.json.message.threadId, 'the thread is kept');
  assert.equal((await h.api(`/messages/${firstMessage}`)).status, 404);

  const got = await h.api(`/drafts/${draftId}?format=metadata&metadataHeaders=Subject`);
  assert.equal(got.json.message.payload.headers[0].value, 'Draft v2');
  const list = await h.api('/drafts');
  assert.deepEqual(list.json.drafts, [
    {
      id: draftId,
      message: { id: updated.json.message.id, threadId: updated.json.message.threadId },
    },
  ]);
  assert.equal(h.emu.log.filter(e => e.apiMethod === 'gmail.users.drafts.update')[0].units, 15);

  const sent = await h.api('/drafts/send', { method: 'POST', body: { id: draftId } });
  assert.deepEqual(sent.json.labelIds, ['SENT']);
  assert.equal(h.emu.log.at(-1)!.units, 100);
  assert.equal((await h.api(`/drafts/${draftId}`)).status, 404);
  assert.equal((await h.api('/drafts')).json.drafts, undefined);

  const second = await h.api('/drafts', {
    method: 'POST',
    body: { message: { raw: rawMessage({}) } },
  });
  assert.equal((await h.api(`/drafts/${second.json.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await h.api(`/drafts/${second.json.id}`, { method: 'DELETE' })).status, 404);
});

test('settings.filters create, list, get, delete and sendAs.list', async () => {
  const h = await setup();
  assert.deepEqual((await h.api('/settings/filters')).json, {});
  const projects = (await h.api('/labels', { method: 'POST', body: { name: 'News' } })).json.id;
  const body = {
    criteria: { from: 'news@list.example.test', hasAttachment: false },
    action: { addLabelIds: [projects], removeLabelIds: ['INBOX'] },
  };
  const created = await h.api('/settings/filters', { method: 'POST', body });
  assert.equal(created.status, 200);
  assert.deepEqual({ criteria: created.json.criteria, action: created.json.action }, body);
  assert.deepEqual((await h.api('/settings/filters')).json.filter, [created.json]);
  assert.deepEqual((await h.api(`/settings/filters/${created.json.id}`)).json, created.json);
  assert.equal(
    (await h.api('/settings/filters', { method: 'POST', body })).status,
    400,
    'duplicates are refused',
  );
  assert.equal(
    (
      await h.api('/settings/filters', {
        method: 'POST',
        body: { criteria: {}, action: { removeLabelIds: ['INBOX'] } },
      })
    ).status,
    400,
  );
  assert.equal(
    (await h.api(`/settings/filters/${created.json.id}`, { method: 'DELETE' })).status,
    204,
  );
  assert.equal((await h.api(`/settings/filters/${created.json.id}`)).status, 404);

  const sendAs = await h.api('/settings/sendAs');
  assert.equal(sendAs.json.sendAs[0].sendAsEmail, 'test.user@example.test');
  assert.equal(sendAs.json.sendAs[0].isPrimary, true);
});

test('changes made elsewhere reach a client through history', async () => {
  const h = await withMail();
  const mb = h.emu.mailbox;
  const cursor = (await h.api('/profile')).json.historyId;

  const added = mb.addMessage({
    from: 'new@mail.example.test',
    subject: 'Fresh',
    text: 'x',
    labelIds: ['INBOX', 'UNREAD'],
  });
  mb.relabel({ messageIds: [h.ids.invoice] }, ['STARRED'], ['UNREAD']);
  const archived = mb.archiveThreads(1);
  mb.trashMessage(h.ids.lunch);
  mb.deleteMessage(h.ids.old);
  const draft = mb.createDraftElsewhere({
    to: ['ana@mail.example.test'],
    subject: 'From my phone',
    text: 'typing',
  });

  const history = (await h.api(`/history?startHistoryId=${cursor}&maxResults=500`)).json
    .history as any[];
  const flat = (key: string) => history.flatMap(r => r[key] ?? []);
  assert.ok(flat('messagesAdded').some(e => e.message.id === added.id));
  assert.ok(
    flat('messagesAdded').some(
      e => e.message.id === draft.messageId && e.message.labelIds.includes('DRAFT'),
    ),
  );
  assert.ok(flat('messagesDeleted').some(e => e.message.id === h.ids.old));
  assert.ok(
    flat('labelsAdded').some(e => e.message.id === h.ids.invoice && e.labelIds.includes('STARRED')),
  );
  assert.ok(
    flat('labelsRemoved').some(
      e => e.message.id === h.ids.invoice && e.labelIds.includes('UNREAD'),
    ),
  );
  assert.ok(
    flat('labelsAdded').some(e => e.message.id === h.ids.lunch && e.labelIds.includes('TRASH')),
  );
  assert.equal(archived.length, 1);
  assert.ok(flat('labelsRemoved').some(e => e.labelIds.includes('INBOX')));
});

test('a mailbox of unrelated generated mail stays internally consistent', async () => {
  const h = await setup({ threads: 80, unitsPerMinute: 10_000_000 });
  const profile = (await h.api('/profile')).json;
  assert.equal(profile.threadsTotal, 80);
  const everything = await h.api('/messages?includeSpamTrash=true&maxResults=500');
  assert.equal(everything.json.messages.length, profile.messagesTotal);
  for (const { id } of everything.json.messages.slice(0, 20)) {
    const raw = (await h.api(`/messages/${id}?format=raw`)).json.raw;
    const full = (await h.api(`/messages/${id}`)).json;
    const subject = full.payload.headers.find((x: any) => x.name === 'Subject').value;
    assert.ok(Buffer.from(raw, 'base64url').toString('latin1').includes(`Subject: ${subject}`));
  }
});
