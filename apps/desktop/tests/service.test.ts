import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppState, Draft } from '@aplos/contract/legacy/types';
import { createService, type ServiceOptions } from '../src/main/service';
import { createGoogle } from '../src/main/google';
import { createGroq } from '../src/main/groq';

async function fixture(overrides: Partial<ServiceOptions> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-service-'));
  const google = await createGoogle({ dataDir, clientId: '' });
  const service = await createService({
    dataDir,
    google,
    groq: createGroq({ apiKey: '' }),
    ...overrides,
  });
  return {
    dataDir,
    google,
    service,
    async cleanup() {
      await service.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
async function settle(fn: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  assert.fail('Timed out waiting for operation');
}
const newDraft = (accountId = 'work'): Draft => ({
  id: 'draft-test',
  accountId,
  to: 'reader@example.com',
  cc: '',
  bcc: '',
  subject: 'A fresh message',
  html: '<p>Hello from a test.</p>',
  attachments: [],
  mode: 'new',
  signature: false,
  updatedAt: new Date().toISOString(),
  revision: 0,
});

test('triage, undo, settings and drafts survive a restart; returned state cannot mutate storage', async () => {
  const f = await fixture();
  try {
    const initial = (await f.service.invoke('state.get')) as AppState;
    assert.ok(initial.threads.length >= 15);
    assert.equal(initial.accounts.length, 2);
    initial.threads[0].subject = 'Not persisted';
    assert.notEqual((await f.service.invoke('state.get')).threads[0].subject, 'Not persisted');
    await f.service.invoke('settings.update', { patch: { doneAction: 'read', theme: 'dark' } });
    await f.service.invoke('thread.update', {
      ids: ['garden', 'design'],
      patch: { status: 'done' },
    });
    let state = (await f.service.invoke('state.get')) as AppState;
    assert.equal(state.threads.find(t => t.id === 'garden')!.unread, false);
    // Advancing a stack marks the next message read without replacing the user's undo.
    await f.service.invoke('thread.update', {
      ids: ['trip'],
      patch: { unread: false },
      recordUndo: false,
    });
    await f.service.invoke('thread.undo');
    state = await f.service.invoke('state.get');
    assert.equal(state.threads.find(t => t.id === 'garden')!.status, 'new');
    assert.equal(state.threads.find(t => t.id === 'garden')!.unread, true);
    assert.equal(state.threads.find(t => t.id === 'trip')!.unread, false);
    const saved = await f.service.invoke('draft.save', { draft: newDraft() });
    assert.equal(saved.revision, 1);
    await f.service.close();
    const reopened = await createService({
      dataDir: f.dataDir,
      google: f.google,
      groq: createGroq({ apiKey: '' }),
    });
    try {
      const restored = (await reopened.invoke('state.get')) as AppState;
      assert.equal(restored.settings.theme, 'dark');
      assert.equal(restored.drafts.find(d => d.id === 'draft-test')!.html, saved.html);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('undo send preserves a draft, eventual local sends appear in sent mail', async () => {
  const f = await fixture();
  try {
    await f.service.invoke('settings.update', { patch: { undoSeconds: 10 } });
    await f.service.invoke('draft.save', { draft: newDraft() });
    await f.service.invoke('draft.send', { id: 'draft-test' });
    assert.ok(
      (await f.service.invoke('state.get')).drafts.find((d: Draft) => d.id === 'draft-test')
        .pendingSendAt,
    );
    await f.service.invoke('draft.undoSend', { id: 'draft-test' });
    assert.equal(
      (await f.service.invoke('state.get')).drafts.find((d: Draft) => d.id === 'draft-test')
        .pendingSendAt,
      undefined,
    );
    await f.service.invoke('settings.update', { patch: { undoSeconds: 0 } });
    await f.service.invoke('draft.send', { id: 'draft-test' });
    await settle(
      async () =>
        !(await f.service.invoke('state.get')).drafts.some((d: Draft) => d.id === 'draft-test'),
    );
    const state = (await f.service.invoke('state.get')) as AppState;
    assert.ok(
      state.threads.some(t => t.subject === 'A fresh message' && t.messages.some(m => m.sent)),
    );
  } finally {
    await f.cleanup();
  }
});

test('provider failures retain a recoverable draft and pending sends resume after restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-send-'));
  const base = await createGoogle({ dataDir, clientId: '' });
  let attempts = 0;
  const google = {
    ...base,
    available: true,
    connect: async () => ({
      id: 'google-test',
      name: 'Test',
      email: 'test@example.com',
      color: '#123456',
      provider: 'google' as const,
      connected: true,
    }),
    sync: async () => ({ threads: [], flags: [], removed: [], reset: true }),
    getSendAs: async () => [],
    send: async () => {
      attempts++;
      throw new Error('Provider unavailable.');
    },
  };
  let service = await createService({ dataDir, google, groq: createGroq({ apiKey: '' }) });
  try {
    await service.invoke('account.connect');
    await service.invoke('settings.update', { patch: { undoSeconds: 0 } });
    await service.invoke('draft.save', { draft: newDraft('google-test') });
    await service.invoke('draft.send', { id: 'draft-test' });
    await settle(async () =>
      Boolean(
        (await service.invoke('state.get')).drafts.find((d: Draft) => d.id === 'draft-test')
          ?.sendError,
      ),
    );
    const failed = (await service.invoke('state.get')).drafts.find(
      (d: Draft) => d.id === 'draft-test',
    );
    assert.equal(failed.html, '<p>Hello from a test.</p>');
    assert.equal(failed.pendingSendAt, undefined);
    assert.equal(attempts, 1);
    await service.invoke('settings.update', { patch: { undoSeconds: 60 } });
    await service.invoke('draft.send', { id: 'draft-test' });
    await service.close();
    const db = new DatabaseSync(join(dataDir, 'aplos.db')),
      row = db.prepare("SELECT data FROM drafts WHERE id='draft-test'").get() as { data: string };
    const persisted = JSON.parse(row.data) as Draft;
    persisted.pendingSendAt = new Date(Date.now() - 1000).toISOString();
    db.prepare("UPDATE drafts SET data=? WHERE id='draft-test'").run(JSON.stringify(persisted));
    db.close();
    service = await createService({ dataDir, google, groq: createGroq({ apiKey: '' }) });
    await settle(async () =>
      Boolean(
        (await service.invoke('state.get')).drafts.find((d: Draft) => d.id === 'draft-test')
          ?.sendError,
      ),
    );
    assert.equal(attempts, 2);
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('reminders return mail to Home, calendar save is duplicate-aware and search supports filters', async () => {
  let clock = new Date('2026-10-14T12:00:00Z');
  const f = await fixture({ now: () => clock });
  try {
    await f.service.invoke('thread.update', {
      ids: ['garden'],
      patch: { status: 'later', hiddenFromHome: true, reminderAt: '2026-10-14T13:00:00Z' },
    });
    clock = new Date('2026-10-14T14:00:00Z');
    const state = (await f.service.invoke('state.get')) as AppState,
      t = state.threads.find(t => t.id === 'garden')!;
    assert.equal(t.status, 'new');
    assert.equal(t.hiddenFromHome, false);
    assert.equal(t.reminderFired, true);
    assert.ok(
      state.threads.filter(t => t.dueDate).every(t => /^\d{4}-\d{2}-\d{2}$/.test(t.dueDate!)),
    );
    await f.service.invoke('thread.update', {
      ids: ['garden'],
      patch: { dueDate: '2026-10-20T19:00:00Z' },
    });
    assert.equal(
      (await f.service.invoke('state.get')).threads.find((t: { id: string }) => t.id === 'garden')
        .dueDate,
      '2026-10-20',
    );
    await assert.rejects(
      f.service.invoke('thread.update', { ids: ['garden'], patch: { dueDate: '2026-02-30' } }),
      /valid due date/,
    );
    const event = {
      id: 'new-event',
      accountId: 'work',
      calendarId: 'demo-work',
      title: 'Team walk',
      start: '2026-10-16T15:00:00Z',
      end: '2026-10-16T16:00:00Z',
      allDay: false,
      location: 'Park',
      description: '',
      guests: [],
    };
    await f.service.invoke('calendar.save', { event });
    const duplicate = await f.service.invoke('calendar.save', {
      event: { ...event, id: 'duplicate' },
    });
    assert.equal(duplicate.id, 'new-event');
    assert.equal(
      (await f.service.invoke('search', { query: 'from:maya has:attachment is:unread' })).length,
      1,
    );
    assert.equal(
      (await f.service.invoke('search', { query: 'subject:"community garden"', accountId: 'work' }))
        .length,
      0,
    );
    const prefix = (await f.service.invoke('search', { query: 'gard is:unread' })) as {
      id: string;
    }[];
    assert.ok(prefix.some(t => t.id === 'garden'));
    assert.equal((await f.service.invoke('search', { query: 'zzqx' })).length, 0);
    const attachment = await f.service.invoke('attachment.get', {
      threadId: 'garden',
      attachmentId: 'att-notes',
    });
    assert.match(Buffer.from(attachment.data, 'base64').toString(), /Community garden/);
  } finally {
    await f.cleanup();
  }
});

test('outbound signatures respect draft choice and mode, escape text, and never polish after Send', async () => {
  const groq = {
    ...createGroq({ apiKey: '' }),
    available: true,
    polish: async () => {
      throw new Error('Delivery must not call AI.');
    },
  };
  const f = await fixture({ groq });
  try {
    const cases: Array<{
      mode: Draft['mode'];
      signature: boolean;
      signatureMode: 'always' | 'new' | 'never';
      expected: boolean;
    }> = [
      { mode: 'new', signature: true, signatureMode: 'new', expected: true },
      { mode: 'forward', signature: true, signatureMode: 'new', expected: true },
      { mode: 'reply', signature: true, signatureMode: 'new', expected: false },
      { mode: 'reply', signature: true, signatureMode: 'always', expected: true },
      { mode: 'new', signature: true, signatureMode: 'never', expected: false },
      { mode: 'new', signature: false, signatureMode: 'always', expected: false },
    ];
    for (const [index, c] of cases.entries()) {
      await f.service.invoke('settings.update', {
        patch: {
          undoSeconds: 0,
          autoPolish: true,
          signature: 'Alex <script>alert("x")</script>\nDesign & words',
          signatureMode: c.signatureMode,
          footer: true,
        },
      });
      const input = {
        ...newDraft(),
        id: `signature-${index}`,
        subject: `Signature case ${index}`,
        mode: c.mode,
        signature: c.signature,
      };
      await f.service.invoke('draft.save', { draft: input });
      await f.service.invoke('draft.send', { id: input.id });
      await settle(
        async () =>
          !(await f.service.invoke('state.get')).drafts.some((d: Draft) => d.id === input.id),
      );
      const sent = (await f.service.invoke('state.get')).threads.find(
        (t: { subject: string }) => t.subject === input.subject,
      ).messages[0].html as string;
      assert.equal(sent.includes('data-aplos-signature'), c.expected);
      assert.ok(sent.includes('Sent with Aplos Mail'));
      assert.ok(sent.startsWith(input.html));
      assert.ok(!sent.includes('<script>'));
      if (c.expected)
        assert.ok(
          sent.includes(
            'Alex &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;<br>Design &amp; words',
          ),
        );
    }
  } finally {
    await f.cleanup();
  }
});

test('sync classifies fresh mail, auto-adds definite events, and preserves edits despite visible AI failures', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-sync-ai-'));
  const base = await createGoogle({ dataDir, clientId: '' });
  let calls = 0;
  const template = {
    id: 'live-one',
    accountId: 'google-ai',
    subject: 'Review meeting',
    summary: 'Original snippet',
    messages: [],
    date: '2026-10-16T12:00:00Z',
    unread: true,
    status: 'new' as const,
    importance: 'low' as const,
    bookmarked: false,
    replyStatus: 'none' as const,
  };
  const google = {
    ...base,
    available: true,
    connect: async () => ({
      id: 'google-ai',
      name: 'Test',
      email: 'test@example.com',
      color: '#123456',
      provider: 'google' as const,
      connected: true,
      calendarConnected: true,
    }),
    sync: async () => ({
      threads: [structuredClone(template), { ...structuredClone(template), id: 'live-two' }],
      flags: [],
      removed: [],
      reset: true,
    }),
    updateThread: async () => {},
    getSendAs: async () => [],
    listEvents: async () => [],
    saveEvent: async (_account: unknown, event: any) => ({ ...event, remoteId: 'google-event' }),
  };
  const groq = {
    ...createGroq({ apiKey: '' }),
    available: true,
    summarize: async (t: { id: string }) => {
      calls++;
      if (t.id === 'live-two') throw new Error('AI unavailable');
      return {
        summary: 'A definite review meeting',
        importance: 'important' as const,
        replyStatus: 'needs-reply' as const,
        todo: 'Prepare the review',
        dueDate: '2026-10-18T12:00:00Z',
      };
    },
    extractEvents: async (t: { id: string }) =>
      t.id === 'live-one'
        ? [
            {
              title: 'Review meeting',
              start: '2026-10-18T12:00:00Z',
              end: '2026-10-18T13:00:00Z',
              allDay: false,
            },
            { title: 'Planning day', start: '2026-10-19', end: '2026-10-20', allDay: true },
          ]
        : [],
  };
  const service = await createService({ dataDir, google, groq });
  try {
    await service.invoke('settings.update', { patch: { autoCalendar: true } });
    const state = (await service.invoke('account.connect')) as AppState;
    const classified = state.threads.find(t => t.id === 'live-one')!;
    assert.equal(classified.summary, 'A definite review meeting');
    assert.equal(classified.replyStatus, 'needs-reply');
    assert.equal(classified.dueDate, '2026-10-18');
    assert.ok(
      state.events.some(e => e.title === 'Review meeting' && e.remoteId === 'google-event'),
    );
    const allDay = state.events.find(e => e.title === 'Planning day')!;
    assert.equal(allDay.start, '2026-10-19');
    assert.equal(allDay.end, '2026-10-20');
    assert.equal(allDay.allDay, true);
    assert.match(state.sync.error!, /Mail synced.*AI could not classify/);
    assert.equal(state.accounts.find(a => a.id === 'google-ai')!.error, undefined);
    await service.invoke('thread.update', {
      ids: ['live-one'],
      patch: { importance: 'low', todo: 'My own task', replyStatus: 'none' },
    });
    const again = (await service.invoke('sync')) as AppState,
      t = again.threads.find(t => t.id === 'live-one')!;
    assert.equal(calls, 2);
    assert.equal(t.importance, 'low');
    assert.equal(t.todo, 'My own task');
    assert.equal(t.replyStatus, 'none');
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('authorized Gmail aliases retain selected identity and signature; unavailable aliases fail safely', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aplos-alias-'));
  const base = await createGoogle({ dataDir, clientId: '' });
  let sent: Draft | undefined,
    settingsUnavailable = false;
  const google = {
    ...base,
    available: true,
    connect: async () => ({
      id: 'alias-account',
      name: 'Primary Person',
      email: 'primary@example.com',
      color: '#123456',
      provider: 'google' as const,
      connected: true,
    }),
    sync: async () => ({ threads: [], flags: [], removed: [], reset: true }),
    getSendAs: async () => {
      if (settingsUnavailable) throw new Error('Settings unavailable');
      return [
        {
          email: 'primary@example.com',
          name: 'Primary Person',
          signature: '<p>Primary signature</p>',
          isDefault: false,
        },
        {
          email: 'studio@example.com',
          name: 'Studio Person',
          signature: '<p><strong>Studio signature</strong></p>',
          isDefault: true,
        },
      ];
    },
    send: async (_account: unknown, d: Draft) => {
      sent = structuredClone(d);
      return { id: 'sent-alias-message', threadId: 'sent-alias-thread' };
    },
  };
  const service = await createService({ dataDir, google, groq: createGroq({ apiKey: '' }) });
  try {
    const connected = (await service.invoke('account.connect')) as AppState;
    assert.equal(connected.accounts.find(a => a.id === 'alias-account')!.sendAs!.length, 2);
    await service.invoke('settings.update', {
      patch: { undoSeconds: 0, signature: 'Custom <signature>', signatureMode: 'always' },
    });
    const input = {
      ...newDraft('alias-account'),
      fromEmail: 'studio@example.com',
      signatureSource: 'account' as const,
      signature: true,
    };
    const saved = (await service.invoke('draft.save', { draft: input })) as Draft;
    assert.equal(saved.fromEmail, input.fromEmail);
    assert.equal(saved.signatureSource, 'account');
    await assert.rejects(
      service.invoke('draft.save', {
        draft: { ...input, id: 'untrusted-from', fromEmail: 'intruder@example.com' },
      }),
      /authorized sending address/,
    );
    await assert.rejects(
      service.invoke('draft.save', {
        draft: { ...input, id: 'cross-account', threadId: 'garden' },
      }),
      /message account/,
    );
    await service.invoke('draft.send', { id: input.id });
    await settle(
      async () => !(await service.invoke('state.get')).drafts.some((d: Draft) => d.id === input.id),
    );
    assert.equal(sent!.fromEmail, 'studio@example.com');
    assert.ok(sent!.html.includes('<strong>Studio signature</strong>'));
    assert.ok(!sent!.html.includes('Custom'));
    const state = (await service.invoke('state.get')) as AppState,
      message = state.threads.find(t => t.remoteId === 'sent-alias-thread')!.messages[0];
    assert.equal(message.from, 'studio@example.com');
    assert.equal(message.fromName, 'Studio Person');
    const custom = await service.invoke('draft.save', {
      draft: { ...input, id: 'custom-signature', signatureSource: 'custom' },
    });
    await service.invoke('draft.send', { id: custom.id });
    await settle(
      async () =>
        !(await service.invoke('state.get')).drafts.some((d: Draft) => d.id === custom.id),
    );
    assert.ok(sent!.html.includes('Custom &lt;signature&gt;'));
    assert.ok(!sent!.html.includes('Studio signature'));
    await service.invoke('draft.save', { draft: { ...input, id: 'revoked-alias' } });
    settingsUnavailable = true;
    const refreshed = (await service.invoke('sync')) as AppState;
    const account = refreshed.accounts.find(a => a.id === 'alias-account')!;
    assert.equal(account.sendAs!.length, 1);
    assert.equal(account.sendAs![0].email, account.email);
    assert.match(account.error!, /sending addresses and signatures/i);
    await assert.rejects(
      service.invoke('draft.send', { id: 'revoked-alias' }),
      /authorized sending address/,
    );
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('AI proposals never send or overwrite drafts; citations are scoped and conversations persist', async () => {
  let requestMessages: unknown[] = [];
  let turn = 0;
  const groq = {
    ...createGroq({ apiKey: '' }),
    available: true,
    summarize: async () => ({ summary: 'A volunteer invitation', todo: 'Confirm the shift' }),
    // First a draft proposal for the open email, then an answer citing it and a ref the model never saw.
    chat: async (request: { messages: unknown[] }) => {
      requestMessages = request.messages;
      return turn++ % 2 === 0
        ? {
            content: '',
            toolCalls: [
              {
                id: '1',
                name: 'propose_draft',
                arguments: JSON.stringify({
                  to: 'maya@garden.example',
                  body: 'Sounds good.',
                  reply_to: 'm1',
                }),
              },
            ],
          }
        : { content: 'The invitation is in your personal mail [m1][m9].', toolCalls: [] };
    },
    draft: async () => ({ html: '<p>An original proposal.</p>' }),
  };
  const f = await fixture({ groq });
  try {
    const original = (await f.service.invoke('state.get')).drafts;
    const result = await f.service.invoke('ai.ask', {
      message: 'What should I reply?',
      accountId: 'personal',
      context: { threadId: 'garden' },
      draft: {
        to: 'maya@garden.example',
        subject: 'Saturday',
        html: '<p>I can bring gloves.</p>',
        ignoredSecret: 'never transmit',
      },
    });
    const sent = JSON.stringify(requestMessages);
    assert.match(sent, /I can bring gloves/);
    assert.ok(!sent.includes('ignoredSecret'));
    assert.ok(!sent.includes('never transmit'));
    assert.equal(result.messages[0].content, 'What should I reply?');
    await assert.rejects(
      f.service.invoke('ai.ask', { message: 'Edit this', draft: { html: 123 } }),
      /Invalid text/,
    );
    assert.deepEqual(result.messages[1].citations, ['garden']);
    assert.deepEqual(result.messages[1].proposal, {
      html: '<p>Sounds good.</p>',
      to: 'maya@garden.example',
      threadId: 'garden',
      mode: 'reply',
    });
    assert.deepEqual((await f.service.invoke('state.get')).drafts, original);
    assert.equal(
      (await f.service.invoke('ai.summarize', { threadId: 'garden' })).summary,
      'A volunteer invitation',
    );
    await f.service.invoke('ai.draft', { instruction: 'Draft a reply' });
    assert.deepEqual((await f.service.invoke('state.get')).drafts, original);
    await f.service.close();
    const reopened = await createService({ dataDir: f.dataDir, google: f.google, groq });
    try {
      assert.equal((await reopened.invoke('state.get')).conversations[0].id, result.id);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.cleanup();
  }
});

test('AI cancellation aborts work without persisting partial state', async () => {
  let started!: () => void;
  const start = new Promise<void>(r => {
    started = r;
  });
  const groq = {
    ...createGroq({ apiKey: '' }),
    available: true,
    polish: async (
      _html: string,
      _instruction?: string,
      signal?: AbortSignal,
    ): Promise<{ html: string }> => {
      started();
      return new Promise((_resolve, reject) =>
        signal!.addEventListener('abort', () => reject(new Error('AI request cancelled.')), {
          once: true,
        }),
      );
    },
  };
  const f = await fixture({ groq });
  try {
    const work = f.service.invoke('ai.polish', { requestId: 'cancel-test', html: '<p>hi</p>' });
    await start;
    await f.service.invoke('ai.cancel', { requestId: 'cancel-test' });
    await assert.rejects(work, /cancelled/);
  } finally {
    await f.cleanup();
  }
});

test('validation prevents malformed recipients, settings, calendar ranges and stale draft writes', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.service.invoke('settings.update', { patch: { undoSeconds: -1 } }),
      /between/,
    );
    await assert.rejects(
      f.service.invoke('thread.update', { ids: ['garden'], patch: { status: 'invalid' } }),
      /Invalid/,
    );
    await f.service.invoke('draft.save', { draft: { ...newDraft(), to: 'invalid' } });
    await assert.rejects(f.service.invoke('draft.send', { id: 'draft-test' }), /email/);
    await assert.rejects(f.service.invoke('draft.save', { draft: newDraft() }), /another window/);
    await assert.rejects(
      f.service.invoke('calendar.save', {
        event: { accountId: 'work', start: '2026-01-02', end: '2026-01-01' },
      }),
      /end after/,
    );
    await assert.rejects(
      f.service.invoke('ai.transcribe', { audio: 'not-base64!', mimeType: 'audio/webm' }),
      /base64/,
    );
    const exported = JSON.parse(await f.service.invoke('data.export'));
    assert.equal(exported.version, 1);
    assert.equal(exported.accounts[0].access_token, undefined);
  } finally {
    await f.cleanup();
  }
});

test('summarizing again keeps the owner’s due date, to-do, importance and reply state', async () => {
  let answer: Record<string, unknown> = {};
  const groq = {
    ...createGroq({ apiKey: '' }),
    available: true,
    summarize: async () => ({ ...answer }),
  };
  // Stored as a provider would sync it: the summary is just the email's opening words, not from Groq.
  const seed = await fixture();
  const dataDir = seed.dataDir;
  await seed.service.close();
  const db = new DatabaseSync(join(dataDir, 'aplos.db')),
    row = db.prepare("SELECT data FROM threads WHERE id='garden'").get() as { data: string };
  const stored = JSON.parse(row.data);
  stored.summary = stored.messages[0].text.slice(0, 60);
  db.prepare("UPDATE threads SET data=? WHERE id='garden'").run(JSON.stringify(stored));
  db.close();
  const service = await createService({ dataDir, google: seed.google, groq });
  const garden = async () =>
    ((await service.invoke('state.get')) as AppState).threads.find(t => t.id === 'garden')!;
  try {
    // Never summarized yet, so Groq judges importance and reply state, and fills what is empty.
    await service.invoke('thread.update', {
      ids: ['garden'],
      patch: { todo: null, dueDate: '2031-05-05', importance: 'important', replyStatus: 'none' },
    });
    answer = {
      summary: 'A volunteer invitation',
      importance: 'low',
      replyStatus: 'needs-reply',
      todo: 'Confirm the shift',
      dueDate: '2030-01-02',
      action: null,
    };
    await service.invoke('ai.summarize', { threadId: 'garden' });
    let t = await garden();
    assert.equal(t.summary, 'A volunteer invitation');
    assert.equal(t.importance, 'low');
    assert.equal(t.replyStatus, 'needs-reply');
    assert.equal(t.todo, 'Confirm the shift');
    assert.equal(t.dueDate, '2031-05-05');
    // Summarized for real now: a second pass only refreshes the summary.
    await service.invoke('thread.update', {
      ids: ['garden'],
      patch: { todo: 'My own note', importance: 'important', replyStatus: 'none' },
    });
    answer = {
      summary: 'Help plant herbs on Saturday',
      importance: 'low',
      replyStatus: 'needs-reply',
      todo: 'Something else',
      dueDate: '2030-01-02',
      action: null,
    };
    await service.invoke('ai.summarize', { threadId: 'garden' });
    t = await garden();
    assert.equal(t.summary, 'Help plant herbs on Saturday');
    assert.equal(t.todo, 'My own note');
    assert.equal(t.dueDate, '2031-05-05');
    assert.equal(t.importance, 'important');
    assert.equal(t.replyStatus, 'none');
  } finally {
    await service.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a second summary request for the same email waits for the first instead of asking Groq again', async () => {
  let calls = 0,
    release!: () => void;
  const gate = new Promise<void>(r => {
    release = r;
  });
  const groq = {
    ...createGroq({ apiKey: '' }),
    available: true,
    summarize: async () => {
      calls++;
      await gate;
      return { summary: 'Help plant herbs on Saturday' };
    },
  };
  const f = await fixture({ groq });
  const events: { threadId: string; active: boolean }[] = [];
  f.service.subscribe(event => {
    if (event.type === 'ai.summarizing')
      events.push(event.payload as { threadId: string; active: boolean });
  });
  try {
    const first = f.service.invoke('ai.summarize', { threadId: 'garden' }),
      second = f.service.invoke('ai.summarize', { threadId: 'garden' });
    await settle(async () => events.length === 1);
    release();
    const result = await second;
    await first;
    assert.equal(result.summary, 'Help plant herbs on Saturday');
    assert.equal(result.aiSummary, true);
    assert.equal(calls, 1);
    assert.deepEqual(events, [
      { threadId: 'garden', active: true },
      { threadId: 'garden', active: false },
    ]);
  } finally {
    await f.cleanup();
  }
});

test('background summary requests skip emails that already have one, and in-flight summaries can be listed', async () => {
  let calls = 0,
    release!: () => void;
  const gate = new Promise<void>(r => {
    release = r;
  });
  const groq = {
    ...createGroq({ apiKey: '' }),
    available: true,
    summarize: async () => {
      calls++;
      await gate;
      return { summary: 'A fresh summary' };
    },
  };
  const f = await fixture({ groq });
  try {
    // The demo email already has a real summary, so a background request leaves it alone.
    assert.notEqual(
      (await f.service.invoke('ai.summarize', { threadId: 'garden', onlyIfMissing: true })).summary,
      'A fresh summary',
    );
    assert.equal(calls, 0);
    assert.deepEqual(await f.service.invoke('ai.summarizing'), []);
    const running = f.service.invoke('ai.summarize', { threadId: 'garden' });
    await settle(async () => calls === 1);
    assert.deepEqual(await f.service.invoke('ai.summarizing'), ['garden']);
    release();
    assert.equal((await running).summary, 'A fresh summary');
    assert.deepEqual(await f.service.invoke('ai.summarizing'), []);
  } finally {
    await f.cleanup();
  }
});

test('a request that overlaps a failed summary run reports the failure instead of the old summary', async () => {
  let calls = 0,
    fail!: () => void;
  const gate = new Promise<void>((_, reject) => {
    fail = () => reject(new Error('Groq rate limit reached. Please try again shortly.'));
  });
  const groq = {
    ...createGroq({ apiKey: '' }),
    available: true,
    summarize: async () => {
      calls++;
      await gate;
      return { summary: 'Never used' };
    },
  };
  const f = await fixture({ groq });
  try {
    // The demo email already has a real summary; a retry during a failing run must not pass that off as fresh.
    const first = f.service.invoke('ai.summarize', { threadId: 'garden' }),
      second = f.service.invoke('ai.summarize', { threadId: 'garden' });
    await settle(async () => calls === 1);
    fail();
    await assert.rejects(first, /rate limit/);
    await assert.rejects(second, /rate limit/);
    assert.equal(calls, 1);
  } finally {
    await f.cleanup();
  }
});
