import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { createGroq } from '../src/main/groq';
import { createGoogle, normalizeGmailThread } from '../src/main/google';
import type { Account, Draft, Thread } from '@aplos/contract/legacy/types';

const account: Account = {
  id: 'google-test',
  name: 'Alex',
  email: 'alex@example.test',
  provider: 'google',
  connected: true,
  color: '#aaa',
};
const thread: Thread = {
  id: 'google-test:thread1',
  accountId: account.id,
  remoteId: 'thread1',
  subject: 'Studio review',
  summary: 'Review on Friday',
  messages: [
    {
      id: 'm1',
      from: 'sam@example.test',
      fromName: 'Sam',
      to: [account.email],
      text: 'Meet October 16 at 10:00 UTC for one hour.',
      date: '2026-10-14T10:00:00Z',
      attachments: [],
    },
  ],
  date: '2026-10-14T10:00:00Z',
  unread: true,
  status: 'new',
  importance: 'important',
  bookmarked: false,
  replyStatus: 'needs-reply',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const encrypt = (text: string) => Buffer.from([...Buffer.from(text)].map(x => x ^ 0x57));
const decrypt = (buffer: Buffer) => Buffer.from([...buffer].map(x => x ^ 0x57)).toString();
async function tokenDir(expired = false) {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-google-test-'));
  await writeFile(
    join(dir, 'google-tokens.enc.json'),
    JSON.stringify({
      [account.id]: encrypt(
        JSON.stringify({
          access_token: 'test-access-token',
          refresh_token: 'test-refresh-token',
          expiresAt: expired ? 0 : Date.now() + 3600000,
        }),
      ).toString('base64'),
    }),
  );
  return dir;
}

test('Groq validates JSON results and uses only its own API', async () => {
  const responses = [
    {
      summary: 'Review Friday',
      importance: 'low',
      replyStatus: 'needs-reply',
      todo: 'Confirm',
      dueDate: '2026-10-16',
    },
    { to: 'sam@example.test', html: '<p>Yes.</p>' },
    { html: '<p>Thank you.</p>' },
    {
      events: [
        {
          title: 'Review',
          start: '2026-10-16T10:00:00Z',
          end: '2026-10-16T11:00:00Z',
          allDay: false,
          guests: ['sam@example.test', 'invalid'],
        },
        { title: 'Bad', start: 'tomorrow', end: 'next week' },
      ],
    },
  ];
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(String(input), 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer mock-secret');
    const body = JSON.parse(init?.body as string);
    assert.equal(body.model, 'openai/gpt-oss-120b');
    assert.equal(body.response_format.type, 'json_object');
    return json({ choices: [{ message: { content: JSON.stringify(responses.shift()) } }] });
  };
  const groq = createGroq({ apiKey: 'mock-secret', fetch: fetcher });
  assert.equal((await groq.summarize(thread)).todo, 'Confirm');
  assert.equal((await groq.draft('Confirm', thread)).html, '<p>Yes.</p>');
  assert.equal((await groq.polish('<p>Thanks</p>')).html, '<p>Thank you.</p>');
  const events = await groq.extractEvents(thread);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].guests, ['sam@example.test']);
});

test('Groq protects secrets in errors, supports cancellation, and sends audio as multipart', async () => {
  const failed = createGroq({
    apiKey: 'DO-NOT-LEAK',
    fetch: async () => {
      throw new Error('DO-NOT-LEAK');
    },
  });
  await assert.rejects(
    () => failed.summarize(thread),
    error => error instanceof Error && !error.message.includes('DO-NOT-LEAK'),
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => failed.summarize(thread, controller.signal), /cancelled/);
  const groq = createGroq({
    apiKey: 'test',
    fetch: async (input, init) => {
      assert.match(String(input), /audio\/transcriptions$/);
      assert.ok(init?.body instanceof FormData);
      assert.equal(init.body.get('model'), 'whisper-large-v3-turbo');
      assert.equal((init?.headers as Record<string, string>)['Content-Type'], undefined);
      return json({ text: 'Write a short thank you email' });
    },
  });
  assert.equal(
    (
      await groq.transcribe(
        Buffer.from('synthetic-audio').toString('base64'),
        'audio/webm;codecs=opus',
      )
    ).text,
    'Write a short thank you email',
  );
  await assert.rejects(() => groq.transcribe('!!!', 'audio/webm'), /base64/);
  await assert.rejects(() => groq.transcribe('YQ==', 'application/octet-stream'), /Unsupported/);
  await assert.rejects(
    () =>
      createGroq({
        apiKey: 'test',
        fetch: async () => json({ choices: [{ message: { content: 'not json' } }] }),
      }).summarize(thread),
    /invalid response/,
  );
});

test('Desktop Google OAuth verifies state and PKCE and persists encrypted tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-oauth-test-'));
  let authUrl: URL | undefined;
  let denySettings = false;
  const google = await createGoogle({
    dataDir: dir,
    clientId: 'own-desktop-client',
    clientSecret: 'own-client-secret',
    encrypt,
    decrypt,
    openExternal: async url => {
      authUrl = new URL(url);
      assert.ok(
        authUrl.searchParams
          .get('scope')
          ?.includes('https://www.googleapis.com/auth/gmail.settings.basic'),
      );
      const callback = new URL(authUrl.searchParams.get('redirect_uri')!);
      assert.equal(callback.hostname, '127.0.0.1');
      callback.searchParams.set('state', 'bad');
      callback.searchParams.set('code', 'intercepted');
      assert.equal((await fetch(callback)).status, 400);
      callback.searchParams.set('state', authUrl.searchParams.get('state')!);
      callback.searchParams.set('code', 'test-code');
      assert.equal((await fetch(callback)).status, 200);
    },
    fetch: async (input, init) => {
      if (String(input).includes('/settings/sendAs'))
        return denySettings
          ? json({}, 403)
          : json({
              sendAs: [
                {
                  sendAsEmail: account.email,
                  displayName: 'Alex',
                  isPrimary: true,
                  signature: '<p>Alex</p>',
                },
                {
                  sendAsEmail: 'studio@example.test',
                  displayName: 'Studio',
                  signature: '<p>Studio</p>',
                  isDefault: true,
                  verificationStatus: 'accepted',
                },
                { sendAsEmail: 'pending@example.test', verificationStatus: 'pending' },
              ],
            });
      if (String(input).includes('/token')) {
        const values = new URLSearchParams(init?.body as URLSearchParams);
        assert.equal(values.get('client_id'), 'own-desktop-client');
        assert.equal(values.get('code'), 'test-code');
        assert.equal(
          createHash('sha256').update(values.get('code_verifier')!).digest('base64url'),
          authUrl!.searchParams.get('code_challenge'),
        );
        return json({
          access_token: 'oauth-access-sensitive',
          refresh_token: 'oauth-refresh-sensitive',
          expires_in: 3600,
        });
      }
      return json({ sub: 'test', email: 'alex@example.test', name: 'Alex' });
    },
  });
  try {
    const result = await google.connect({ provider: 'google' });
    assert.equal(result.id, account.id);
    assert.deepEqual(
      result.sendAs?.map(alias => alias.email),
      [account.email, 'studio@example.test'],
    );
    assert.equal(result.sendAs?.[1].signature, '<p>Studio</p>');
    const disk = await readFile(join(dir, 'google-tokens.enc.json'), 'utf8');
    assert.ok(!disk.includes('oauth-access-sensitive'));
    assert.ok(!disk.includes('oauth-refresh-sensitive'));
    assert.ok(!disk.includes('own-client-secret'));
    denySettings = true;
    const fallback = await google.connect({ provider: 'google' });
    assert.match(fallback.error ?? '', /primary address/);
    assert.deepEqual(
      fallback.sendAs?.map(alias => alias.email),
      [account.email],
    );
  } finally {
    google.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Google sync paginates, normalizes multipart mail, respects triage mapping, downloads attachments and sends MIME without SMTP', async () => {
  const dir = await tokenDir();
  const requests: { url: string; body: any }[] = [];
  let sent: any;
  const raw = {
    id: 'thread1',
    messages: [
      {
        id: 'm1',
        internalDate: '1791972000000',
        labelIds: ['INBOX', 'UNREAD', 'IMPORTANT'],
        payload: {
          headers: [
            { name: 'Subject', value: 'Studio review' },
            { name: 'From', value: '"Sam" <sam@example.test>' },
            { name: 'To', value: 'Alex <alex@example.test>' },
            { name: 'Message-ID', value: '<original@example.test>' },
          ],
          mimeType: 'multipart/mixed',
          parts: [
            {
              partId: '0',
              mimeType: 'text/plain',
              headers: [{ name: 'Content-Type', value: 'text/plain; charset=iso-8859-1' }],
              body: { attachmentId: 'body-text', size: 40 },
            },
            { partId: '1', mimeType: 'text/html', body: { attachmentId: 'body-html', size: 50 } },
            {
              partId: '2',
              mimeType: 'text/plain',
              filename: 'note.txt',
              body: { attachmentId: 'a1', size: 4 },
            },
            {
              partId: '3',
              mimeType: 'image/png',
              filename: 'inline.png',
              headers: [{ name: 'Content-ID', value: '<image-1>' }],
              body: { attachmentId: 'inline-file', size: 4 },
            },
          ],
        },
      },
    ],
  };
  const google = await createGoogle({
    dataDir: dir,
    clientId: 'own-client',
    encrypt,
    decrypt,
    fetch: async (input, init) => {
      const url = String(input),
        body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, body });
      if (url.endsWith('/messages/send')) {
        sent = body;
        return json({ id: 'sent-id' });
      }
      if (url.endsWith('/attachments/body-text'))
        return json({ data: Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString('base64url') });
      if (url.endsWith('/attachments/body-html'))
        return json({
          data: Buffer.from('<p>Hello Alex</p><img src="cid:image-1">').toString('base64url'),
        });
      if (url.includes('/attachments/'))
        return json({ data: Buffer.from('note').toString('base64url') });
      if (url.endsWith('/profile')) return json({ historyId: '900' });
      if (url.includes('/threads/thread1')) return json(raw);
      if (url.includes('pageToken=next')) return json({ threads: [] });
      return json({ threads: [{ id: 'thread1' }], nextPageToken: 'next' });
    },
  });
  try {
    const result = await google.sync(account, undefined, { has: () => false });
    assert.equal(result.reset, true);
    assert.equal(result.cursor, '900');
    const synced = result.threads;
    assert.equal(synced.length, 1);
    const item = synced[0];
    assert.equal(item.messages[0].from, 'sam@example.test');
    assert.equal(item.messages[0].html, '<p>Hello Alex</p><img src="cid:image-1">');
    assert.equal(item.messages[0].text, 'café');
    assert.equal(item.messages[0].attachments.length, 2);
    assert.ok(requests.some(r => r.url.endsWith('/attachments/body-html')));
    assert.ok(!requests.some(r => /attachments\/(a1|inline-file)$/.test(r.url)));
    assert.equal(item.messages[0].attachments[1].contentId, 'image-1');
    assert.ok(requests.some(r => r.url.includes('pageToken=next')));
    await google.updateThread(account, item, { status: 'done', unread: false, labels: ['INBOX'] });
    const modify = requests.find(r => r.url.endsWith('/modify'))!;
    assert.ok(modify.body.addLabelIds.includes('INBOX'));
    assert.ok(modify.body.removeLabelIds.includes('UNREAD'));
    const attachment = await google.attachment(account, item, item.messages[0].attachments[0]);
    assert.equal(Buffer.from(attachment.data!, 'base64').toString(), 'note');
    const draft: Draft = {
      id: 'draft-test',
      accountId: account.id,
      threadId: item.id,
      mode: 'reply',
      to: 'sam@example.test',
      cc: '',
      bcc: 'archive@example.test',
      subject: 'Re: Studio review',
      html: '<p>Confirmed.</p>',
      attachments: [attachment],
      signature: false,
      updatedAt: new Date().toISOString(),
      revision: 1,
    };
    const aliasAccount = {
      ...account,
      sendAs: [
        {
          email: 'studio@example.test',
          name: 'Studio',
          signature: '<p>Studio</p>',
          isDefault: true,
        },
      ],
    };
    await google.send(aliasAccount, { ...draft, fromEmail: 'studio@example.test' });
    assert.equal(sent.threadId, 'thread1');
    const mail = await simpleParser(Buffer.from(sent.raw, 'base64url'));
    assert.equal(mail.from?.value[0].address, 'studio@example.test');
    assert.equal(mail.from?.value[0].name, 'Studio');
    assert.equal(mail.subject, 'Re: Studio review');
    assert.equal(mail.inReplyTo, '<original@example.test>');
    assert.equal(mail.attachments[0].content.toString(), 'note');
    assert.match(mail.bcc && !Array.isArray(mail.bcc) ? mail.bcc.text : '', /archive@example.test/);
    await assert.rejects(
      () => google.send(aliasAccount, { ...draft, fromEmail: 'unauthorized@example.test' }),
      /not authorized/,
    );
    await assert.rejects(
      () => google.send(account, { ...draft, subject: 'Bad\r\nBcc: victim@example.test' }),
      /line breaks/,
    );
  } finally {
    google.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Concurrent Google requests refresh once; Calendar creates, updates and deletes via explicit API calls', async () => {
  const dir = await tokenDir(true);
  let refreshes = 0;
  const requests: { url: string; method: string; body: any }[] = [];
  const google = await createGoogle({
    dataDir: dir,
    clientId: 'own-client',
    encrypt,
    decrypt,
    fetch: async (input, init) => {
      const url = String(input);
      if (url.includes('oauth2.googleapis.com/token')) {
        refreshes++;
        return json({ access_token: 'fresh-token', expires_in: 3600 });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, method: init?.method ?? 'GET', body });
      if (url.includes('/calendarList'))
        return json({ items: [{ id: 'primary', summary: 'Work' }] });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      if (body)
        return json({
          id: 'event-google',
          summary: body.summary,
          start: body.start,
          end: body.end,
          attendees: body.attendees,
        });
      return json({
        items: [
          {
            id: 'event-google',
            summary: 'Review',
            start: { dateTime: '2026-10-16T10:00:00Z' },
            end: { dateTime: '2026-10-16T11:00:00Z' },
          },
        ],
      });
    },
  });
  try {
    await Promise.all([google.listCalendars(account), google.listCalendars(account)]);
    assert.equal(refreshes, 1);
    const events = await google.listEvents(account);
    assert.equal(events[0].title, 'Review');
    const created = await google.saveEvent(account, {
      ...events[0],
      id: 'local-id',
      remoteId: undefined,
    });
    assert.equal(created.remoteId, 'event-google');
    assert.equal(created.id, 'local-id');
    await google.saveEvent(account, { ...created, title: 'Updated' });
    await google.deleteEvent(account, created);
    assert.ok(requests.some(r => r.method === 'POST' && r.body.summary === 'Review'));
    assert.ok(requests.some(r => r.method === 'PUT' && r.body.summary === 'Updated'));
    assert.ok(requests.some(r => r.method === 'DELETE'));
    assert.ok(requests.filter(r => r.body).every(r => r.url.includes('sendUpdates=none')));
  } finally {
    google.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Google requires own OAuth configuration and secure storage; callback times out cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aplos-oauth-timeout-'));
  try {
    const unavailable = await createGoogle({ dataDir: dir, clientId: '' });
    await assert.rejects(() => unavailable.connect({ provider: 'google' }), /GOOGLE_CLIENT_ID/);
    const insecure = await createGoogle({ dataDir: dir, clientId: 'own-client' });
    await assert.rejects(
      () => insecure.connect({ provider: 'google' }),
      /Secure credential storage/,
    );
    const timed = await createGoogle({
      dataDir: dir,
      clientId: 'own-client',
      encrypt,
      decrypt,
      openExternal: async () => {},
      oauthTimeoutMs: 15,
    });
    await assert.rejects(() => timed.connect({ provider: 'google' }), /timed out/);
    timed.close();
    const normalized = normalizeGmailThread({ id: 'empty' }, account);
    assert.equal(normalized.subject, '(No subject)');
    assert.deepEqual(normalized.messages, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Gmail keeps workflow data in one message under a hidden Aplos label that sync never shows', async () => {
  type Stored = {
    id: string;
    threadId: string;
    labelIds: string[];
    internalDate: string;
    raw?: string;
    headers: { name: string; value: string }[];
    text: string;
  };
  const dir = await tokenDir(),
    labels: Record<string, any>[] = [{ id: 'INBOX', name: 'INBOX', type: 'system' }],
    messages = new Map<string, Stored>(),
    history: Record<string, any>[] = [];
  const requests: { method: string; url: URL; body: any }[] = [];
  let historyId = 100;
  messages.set('m1', {
    id: 'm1',
    threadId: 't1',
    labelIds: ['INBOX'],
    internalDate: '1791972000000',
    text: 'Hello',
    headers: [
      { name: 'Subject', value: 'Hello' },
      { name: 'From', value: 'Sam <sam@example.test>' },
      { name: 'Message-ID', value: '<m1@example.test>' },
    ],
  });
  const record = (key: string, m: Stored) =>
    history.push({
      id: String(++historyId),
      [key]: [{ message: { id: m.id, threadId: m.threadId, labelIds: [...m.labelIds] } }],
    });
  const threadOf = (id: string) => ({
    id,
    messages: [...messages.values()]
      .filter(m => m.threadId === id)
      .map(m => ({
        id: m.id,
        internalDate: m.internalDate,
        labelIds: m.labelIds,
        payload: {
          headers: m.headers,
          mimeType: 'text/plain',
          body: { data: Buffer.from(m.text).toString('base64url') },
        },
      })),
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input)),
      method = init?.method ?? 'GET',
      body = init?.body ? JSON.parse(String(init.body)) : undefined,
      path = url.pathname.replace('/gmail/v1/users/me', '');
    requests.push({ method, url, body });
    let match: RegExpMatchArray | null;
    if (path === '/labels') {
      if (method === 'POST') {
        const label = { id: `Label_${labels.length}`, type: 'user', ...body };
        labels.push(label);
        return json(label);
      }
      return json({ labels });
    }
    if (path === '/messages/insert') {
      const mail = await simpleParser(Buffer.from(body.raw, 'base64url')),
        n = messages.size + 1;
      const m: Stored = {
        id: `app${n}`,
        threadId: `at${n}`,
        labelIds: [...body.labelIds],
        internalDate: String(Date.now() + n),
        raw: body.raw,
        text: mail.text ?? '',
        headers: mail.headerLines.map(h => ({
          name: h.line.slice(0, h.line.indexOf(':')),
          value: h.line.slice(h.line.indexOf(':') + 1).trim(),
        })),
      };
      messages.set(m.id, m);
      record('messagesAdded', m);
      return json({ id: m.id, threadId: m.threadId, labelIds: m.labelIds });
    }
    if (path === '/messages')
      return json({
        messages: [...messages.values()]
          .filter(
            m =>
              m.labelIds.includes(url.searchParams.get('labelIds')!) &&
              !m.labelIds.includes('TRASH'),
          )
          .map(m => ({ id: m.id, threadId: m.threadId })),
      });
    if ((match = path.match(/^\/messages\/(\w+)\/trash$/))) {
      const m = messages.get(match[1])!;
      m.labelIds.push('TRASH');
      record('labelsAdded', m);
      return json({ id: m.id });
    }
    if ((match = path.match(/^\/messages\/(\w+)$/))) {
      const m = messages.get(match[1]),
        format = url.searchParams.get('format');
      if (!m) return json({}, 404);
      if (format === 'metadata') {
        const wanted = url.searchParams.getAll('metadataHeaders').map(h => h.toLowerCase());
        return json({
          id: m.id,
          threadId: m.threadId,
          labelIds: m.labelIds,
          internalDate: m.internalDate,
          payload: { headers: m.headers.filter(h => wanted.includes(h.name.toLowerCase())) },
        });
      }
      assert.equal(format, 'raw');
      return json({
        id: m.id,
        threadId: m.threadId,
        labelIds: m.labelIds,
        internalDate: m.internalDate,
        raw: m.raw,
      });
    }
    if (path === '/profile') return json({ historyId: String(historyId) });
    if (path === '/history') {
      const since = Number(url.searchParams.get('startHistoryId'));
      return json({
        history: history.filter(h => Number(h.id) > since),
        historyId: String(historyId),
      });
    }
    if (path === '/threads') {
      const q = url.searchParams.get('q') ?? '',
        hidden = q.includes('-label:aplos-mail-data')
          ? labels.find(l => l.name === 'Aplos Mail Data')?.id
          : undefined;
      return json({
        threads: [...new Set([...messages.values()].map(m => m.threadId))]
          .filter(id => !hidden || !threadOf(id).messages.some(m => m.labelIds.includes(hidden)))
          .map(id => ({ id })),
      });
    }
    if ((match = path.match(/^\/threads\/(\w+)$/))) return json(threadOf(match[1]));
    return json({ error: `${method} ${path}` }, 500);
  };
  const google = await createGoogle({
    dataDir: dir,
    clientId: 'own-client',
    encrypt,
    decrypt,
    fetch: fetcher,
  });
  const fresh = await createGoogle({
    dataDir: dir,
    clientId: 'own-client',
    encrypt,
    decrypt,
    fetch: fetcher,
  });
  const has = (id: string) => id === `${account.id}:t1`;
  try {
    assert.deepEqual(await google.readAppData(account), []);
    assert.ok(!requests.some(r => r.method === 'POST'), 'reading creates nothing');
    const first = await google.sync(account, undefined, { has: () => false });
    assert.deepEqual(
      first.threads.map(t => t.remoteId),
      ['t1'],
    );
    await google.writeAppData(account, 'APLOS-WF1.first', []);
    assert.deepEqual(await google.readAppData(account), [{ id: 'app2', data: 'APLOS-WF1.first' }]);
    await google.writeAppData(account, 'second ünïcode\r\n=3D', ['app2']);
    const label = labels.find(l => l.name === 'Aplos Mail Data')!;
    assert.deepEqual(
      [label.labelListVisibility, label.messageListVisibility],
      ['labelHide', 'hide'],
    );
    assert.equal(labels.filter(l => l.type === 'user').length, 1, 'the label is created once');
    assert.ok(
      requests
        .filter(r => r.url.pathname.endsWith('/insert'))
        .every(r => JSON.stringify(r.body.labelIds) === JSON.stringify([label.id])),
      'inserted without INBOX or UNREAD',
    );
    assert.deepEqual(
      [...messages.values()]
        .filter(m => m.labelIds.includes(label.id))
        .map(m => [m.id, m.labelIds.includes('TRASH')]),
      [
        ['app2', true],
        ['app3', false],
      ],
      'the copy that was read and merged is trashed',
    );
    assert.ok(!requests.some(r => r.method === 'DELETE'), 'gmail.modify cannot delete');
    assert.deepEqual(await fresh.readAppData(account), [
      { id: 'app3', data: 'second ünïcode\r\n=3D' },
    ]);
    // Another device that read app2 writes too: it may replace only app2, so app3 survives and both are read, newest first.
    await fresh.writeAppData(account, 'third', ['app2']);
    messages.set('user1', {
      id: 'user1',
      threadId: 'ut1',
      labelIds: [label.id],
      internalDate: String(Date.now() + 99),
      raw: Buffer.from('Subject: Mine\r\n\r\nmy own mail').toString('base64url'),
      text: 'my own mail',
      headers: [{ name: 'Subject', value: 'Mine' }],
    });
    assert.deepEqual(
      await google.readAppData(account),
      [
        { id: 'app4', data: 'third' },
        { id: 'app3', data: 'second ünïcode\r\n=3D' },
      ],
      'mail the user filed under a same-named label is not app data',
    );
    assert.ok(
      !requests.some(
        r => r.url.pathname.endsWith('/user1') && r.url.searchParams.get('format') === 'raw',
      ),
      'and is never downloaded',
    );
    await google.writeAppData(account, 'merged', ['app4', 'app3']);
    assert.deepEqual(
      [...messages.values()]
        .filter(m => m.labelIds.includes(label.id) && !m.labelIds.includes('TRASH'))
        .map(m => m.id),
      ['user1', 'app6'],
      'only the merged copies are trashed',
    );
    assert.deepEqual(await google.readAppData(account), [{ id: 'app6', data: 'merged' }]);
    messages.delete('user1'); // The rest checks how sync treats app data, not mail the user filed themselves.
    const next = await google.sync(account, first.cursor, { has });
    assert.deepEqual([next.threads, next.flags, next.removed], [[], [], []]);
    // Without the label ID cached, the marker header still keeps the app-data threads out.
    const other = await createGoogle({
      dataDir: dir,
      clientId: 'own-client',
      encrypt,
      decrypt,
      fetch: fetcher,
    });
    try {
      const replay = await other.sync(account, first.cursor, { has });
      assert.deepEqual([replay.threads, replay.removed], [[], []]);
      assert.deepEqual(
        (await other.search(account, 'aplos')).map(t => t.remoteId),
        ['t1'],
        'search skips app-data threads',
      );
    } finally {
      other.close();
    }
    const window = await google.sync(account, undefined, { has: () => false });
    assert.deepEqual(
      window.threads.map(t => t.remoteId),
      ['t1'],
    );
    assert.equal(
      requests
        .filter(r => r.url.pathname.endsWith('/threads'))
        .at(-1)!
        .url.searchParams.get('q'),
      '-label:aplos-mail-data',
    );
  } finally {
    google.close();
    fresh.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Google rate limits sent as 403 are retried, and other refusals show Google's own reason", async () => {
  const dir = await tokenDir();
  let profileCalls = 0;
  const waits: number[] = [];
  const limited = () =>
    json(
      {
        error: {
          code: 403,
          message: 'User-rate limit exceeded.  Retry after 2026-10-25T03:00:00Z',
          errors: [{ reason: 'userRateLimitExceeded' }],
        },
      },
      403,
    );
  const google = await createGoogle({
    dataDir: dir,
    clientId: 'own-client',
    encrypt,
    decrypt,
    sleep: async ms => {
      waits.push(ms);
    },
    fetch: async input => {
      const url = String(input);
      if (url.endsWith('/profile'))
        return ++profileCalls < 3 ? limited() : json({ historyId: '7' });
      if (url.includes('/threads?')) return json({ threads: [] });
      if (url.includes('/settings/sendAs'))
        return json(
          {
            error: {
              code: 403,
              message: 'Request had insufficient authentication scopes.',
              status: 'PERMISSION_DENIED',
              details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
            },
          },
          403,
        );
      return json({});
    },
  });
  try {
    const result = await google.sync(account, undefined, { has: () => false });
    assert.equal(result.cursor, '7');
    assert.equal(profileCalls, 3);
    assert.equal(waits.length, 2, 'two backoffs before the third attempt succeeds');
    await assert.rejects(
      () => google.getSendAs(account),
      (error: Error) =>
        /Google denied this request\. Gmail \(ACCESS_TOKEN_SCOPE_INSUFFICIENT\): Request had insufficient authentication scopes\./.test(
          error.message,
        ),
    );
  } finally {
    google.close();
    await rm(dir, { recursive: true, force: true });
  }
});
