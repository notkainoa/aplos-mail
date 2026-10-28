import type { EngineMethodName, ErrorType, Input, Output } from '../../src/index';
import type { EngineSession } from '../../src/client/index';

/**
 * One valid call per engine method, built from ids the engine under test reports itself (never from fixture
 * internals). `allow` names the error types a method may answer with when the demo data cannot set up its
 * precondition on every engine (no failed write to retry, no AI key, a host-only scope).
 */
export interface Sample<M extends EngineMethodName> {
  args: (c: SampleContext) => Promise<Input<M>> | Input<M>;
  allow?: readonly ErrorType[];
}
export type Samples = { [M in EngineMethodName]: Sample<M> };

let n = 0;
export const opId = (tag = 'op') => `conf-${tag}-${++n}`;

/** Lazily discovered ids, created through the contract only. */
export class SampleContext {
  private cache = new Map<string, unknown>();
  constructor(
    readonly session: EngineSession,
    readonly advance: (ms: number) => Promise<void>,
  ) {}

  call<M extends EngineMethodName>(method: M, args: Input<M>): Promise<Output<M>> {
    return this.session.call(method, args) as Promise<Output<M>>;
  }
  private async once<T>(key: string, make: () => Promise<T>): Promise<T> {
    if (!this.cache.has(key)) this.cache.set(key, await make());
    return this.cache.get(key) as T;
  }

  async state() {
    return (await this.call('Session/get', {})).state;
  }
  account() {
    return this.once('account', async () => (await this.call('Account/get', {})).list[0]!.id);
  }
  thread() {
    return this.once(
      'thread',
      async () =>
        (await this.call('View/query', { spec: { kind: 'mailbox', role: 'inbox' } })).ids[0]!,
    );
  }
  message() {
    return this.once(
      'message',
      async () =>
        (await this.call('View/query', { spec: { kind: 'thread', threadId: await this.thread() } }))
          .ids[0]!,
    );
  }
  attachment() {
    return this.once('attachment', async () => {
      const found = await this.call('View/query', {
        spec: { kind: 'search', query: { text: '', hasAttachment: true } },
      });
      for (const threadId of found.ids) {
        const ids = (await this.call('View/query', { spec: { kind: 'thread', threadId } })).ids;
        for (const m of (await this.call('Message/get', { ids })).list)
          if (m.attachments[0]) return { messageId: m.id, attachmentId: m.attachments[0].id };
      }
      return { messageId: await this.message(), attachmentId: 'none' };
    });
  }
  async window() {
    return (await this.call('View/watch', { spec: { kind: 'mailbox', role: 'inbox' } })).windowId;
  }
  async frameUrl() {
    return (
      await this.call('Mail/frame', { messageId: await this.message(), imagePolicy: 'block' })
    ).url;
  }
  async blob() {
    return (
      await this.call('Blob/put', {
        bytes: new TextEncoder().encode('conformance'),
        mime: 'text/plain',
        name: 'conformance.txt',
      })
    ).blobId;
  }
  async draft() {
    const accountId = await this.account();
    const fields = {
      accountId,
      mode: 'new' as const,
      to: [{ address: 'someone@conformance.example', name: 'Someone' }],
      cc: [],
      bcc: [],
      subject: 'Conformance',
      html: '<p>Hello</p>',
      attachments: [],
      signature: false,
    };
    return (await this.call('Draft/set', { opId: opId('draft'), fields })).draft;
  }
  async submission() {
    const d = await this.draft();
    return (
      await this.call('Submission/set', {
        opId: opId('send'),
        action: {
          type: 'send',
          draftId: d.id,
          revision: d.revision,
          notBefore: Date.UTC(2099, 0, 1),
        },
      })
    ).submission.id;
  }
  async actOp() {
    const id = opId('act');
    await this.call('Thread/act', {
      opId: id,
      ids: [await this.thread()],
      action: { type: 'bookmark', on: true },
    });
    return id;
  }
  calendar() {
    return this.once('calendar', async () => (await this.call('Calendar/get', {})).list[0]!.id);
  }
  async eventsAround() {
    const now = (await this.call('Session/get', {})).now;
    const ids = (
      await this.call('View/query', {
        spec: { kind: 'events', from: now - 7 * 86_400_000, to: now + 14 * 86_400_000 },
      })
    ).ids;
    return (await this.call('Event/get', { ids })).list;
  }
  event() {
    return this.once('event', async () => (await this.eventsAround())[0]?.id ?? 'none');
  }
  invitation() {
    return this.once(
      'invitation',
      async () => (await this.eventsAround()).find(e => e.can.rsvp)?.id ?? 'none',
    );
  }
  plan() {
    return this.once(
      'plan',
      async () => (await this.call('View/query', { spec: { kind: 'plans' } })).ids[0] ?? 'none',
    );
  }
  async conversation() {
    const run = await this.call('Ask/run', {
      question: 'Should I reply to this?',
      context: { threadId: await this.thread() },
    });
    await this.advance(2_000);
    return run;
  }
  async rule() {
    return (
      await this.call('SenderRule/set', {
        opId: opId('rule'),
        match: '@fieldnotes.example',
        action: 'lane',
        lane: 'low',
      })
    ).rule.id;
  }
  senderGroup() {
    return this.once(
      'senderGroup',
      async () =>
        (await this.call('View/query', { spec: { kind: 'lowSenders' } })).ids[0] ?? 'none',
    );
  }
  async consentVersion() {
    return (await this.call('Consent/get', {})).currentVersion;
  }
}

const ai = ['notConfigured'] as const;
const groq = { provider: 'groq' as const, model: 'openai/gpt-oss-120b' };

export const samples: Samples = {
  'Session/get': { args: () => ({}) },
  'Session/changes': { args: async c => ({ since: await c.state() }) },
  'Settings/get': { args: () => ({}) },
  'Settings/set': { args: () => ({ opId: opId(), patch: { ui: { density: 'roomy' } } }) },
  'Outbox/pending': { args: () => ({}) },

  'View/watch': { args: () => ({ spec: { kind: 'home' } }) },
  'View/move': { args: async c => ({ windowId: await c.window(), anchor: { position: 0 } }) },
  'View/unwatch': { args: async c => ({ windowId: await c.window() }) },
  'View/hold': { args: async c => ({ windowId: await c.window(), ids: [await c.thread()] }) },
  'View/release': { args: async c => ({ windowId: await c.window() }) },
  'View/query': { args: () => ({ spec: { kind: 'mailbox', role: 'inbox' } }) },
  'Folder/get': { args: () => ({}) },
  'Counts/get': { args: () => ({}) },
  'SenderGroup/get': { args: async c => ({ ids: [await c.senderGroup()] }) },
  'Search/remote': { args: () => ({ opId: opId(), query: { text: 'garden' } }) },

  'Thread/get': { args: async c => ({ ids: [await c.thread(), 'no-such-thread'] }) },
  'Thread/act': {
    args: async c => ({
      opId: opId(),
      ids: [await c.thread()],
      action: { type: 'flag', on: true },
    }),
  },
  'Thread/open': { args: async c => ({ threadId: await c.thread() }) },
  'Thread/why': { args: async c => ({ threadId: await c.thread() }) },
  'Operation/undo': { args: async c => ({ opId: await c.actOp(), undoOpId: opId('undo') }) },
  'Operation/get': { args: async c => ({ opIds: [await c.actOp(), 'no-such-op'] }) },
  'Operation/retry': { args: async c => ({ opId: await c.actOp() }), allow: ['conflict'] },

  'Message/get': { args: async c => ({ ids: [await c.message()] }) },
  'MessageBody/get': { args: async c => ({ messageId: await c.message() }) },
  'MessageBody/prefetch': { args: async c => ({ ids: [await c.message()] }) },
  'Mail/frame': { args: async c => ({ messageId: await c.message(), imagePolicy: 'block' }) },
  'Mail/allowImages': { args: () => ({ opId: opId(), sender: '@garden.example', allow: true }) },
  'Mail/release': { args: async c => ({ url: await c.frameUrl() }) },
  'Mail/toggleQuotes': { args: async c => ({ url: await c.frameUrl(), open: true }) },
  'Mail/serve': {
    args: async c => ({ token: (await c.frameUrl()).split('/').pop()!, path: '/' }),
    allow: ['forbidden'],
  },
  'Attachment/get': { args: c => c.attachment() },
  'Message/original': { args: async c => ({ messageId: await c.message() }) },
  'Blob/put': {
    args: () => ({
      bytes: new TextEncoder().encode('hello'),
      mime: 'text/plain',
      name: 'hello.txt',
    }),
  },
  'Blob/get': { args: async c => ({ blobId: await c.blob() }) },
  'Blob/release': { args: async c => ({ blobId: await c.blob() }) },
  'Later/presets': { args: () => ({}) },
  'Reminder/list': { args: () => ({}) },
  'Reminder/ack': { args: async c => ({ opId: opId(), threadIds: [await c.thread()] }) },
  'Notification/claim': { args: () => ({}), allow: ['forbidden'] },
  'Notification/ack': {
    args: () => ({ ids: ['no-such-note'], state: 'posted' }),
    allow: ['forbidden'],
  },

  'Draft/get': { args: async c => ({ ids: [(await c.draft()).id] }) },
  'Draft/set': {
    args: async c => {
      const d = await c.draft();
      const fields = {
        accountId: d.accountId,
        mode: 'new' as const,
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
        subject: 'Changed',
        html: d.html,
        attachments: d.attachments,
        signature: d.signature,
      };
      return { opId: opId(), id: d.id, baseRevision: d.revision, fields };
    },
  },
  'Draft/destroy': { args: async c => ({ opId: opId(), id: (await c.draft()).id }) },
  'Draft/resolve': {
    args: async c => ({ opId: opId(), id: (await c.draft()).id, choice: 'keepMine' }),
  },
  'Submission/get': { args: async c => ({ ids: [await c.submission()] }) },
  'Submission/set': {
    args: async c => ({
      opId: opId(),
      action: { type: 'undo', submissionId: await c.submission() },
    }),
  },

  'Ai/request': {
    args: async c => ({ opId: opId(), kind: 'summary', threadId: await c.thread(), force: true }),
    allow: ai,
  },
  'Ai/jobs': { args: () => ({}) },
  'Ai/polish': { args: () => ({ requestId: opId('ai'), html: '<p>hello  world</p>' }), allow: ai },
  'Ai/draft': {
    args: async c => ({
      requestId: opId('ai'),
      instruction: 'Say thanks and agree.',
      threadId: await c.thread(),
    }),
    allow: ai,
  },
  'Ai/transcribe': {
    args: async c => ({ requestId: opId('ai'), blobId: await c.blob() }),
    allow: ai,
  },
  'Ai/cancel': { args: () => ({}) },
  'Ai/followup': { args: async c => ({ threadId: await c.thread() }) },
  'Ai/dismissFollowup': { args: async c => ({ opId: opId(), threadId: await c.thread() }) },
  'Ai/providers': { args: () => ({}) },
  'Ai/models': { args: () => ({ provider: 'groq' }) },
  'Ai/status': { args: () => ({}) },
  'Ai/usage': { args: () => ({}) },
  'Ai/setKey': { args: () => ({ provider: 'openrouter', key: 'conformance-placeholder-0000' }) },
  'Ai/removeKey': { args: () => ({ provider: 'openrouter' }) },
  'Ai/testKey': { args: () => ({ provider: 'groq' }) },
  'Ai/test': { args: () => ({ model: groq }), allow: ai },
  'Ask/run': {
    args: async c => ({
      question: 'What needs my reply today?',
      context: { threadId: await c.thread() },
    }),
    allow: ai,
  },
  'Ask/cancel': {
    args: async c => ({
      runId: (await c.call('Ask/run', { question: 'What is due this week?' })).runId,
    }),
    allow: ai,
  },
  'Ask/decide': {
    args: async c => {
      const run = await c.conversation();
      const turn = (
        await c.call('Conversation/get', { ids: [run.conversationId] })
      ).list[0]?.turns.at(-1);
      return {
        opId: opId(),
        conversationId: run.conversationId,
        turnId: turn?.id ?? 'none',
        proposalId: turn?.proposals[0]?.id ?? 'none',
        accept: true,
      };
    },
    allow: ['notFound', 'notConfigured'],
  },
  'Ask/suggestions': { args: () => ({}) },
  'Conversation/get': {
    args: async c => ({ ids: [(await c.conversation()).conversationId] }),
    allow: ai,
  },
  'Conversation/destroy': {
    args: async c => ({ opId: opId(), id: (await c.conversation()).conversationId }),
    allow: ai,
  },
  'Setup/begin': { args: () => ({ origin: 'settings' }) },
  'Setup/end': { args: () => ({ reason: 'closed' }) },
  'Setup/status': { args: () => ({}) },
  'Setup/retry': { args: async c => ({ accountId: await c.account() }) },
  'Demo/load': { args: () => ({}) },
  'Demo/reset': { args: () => ({}) },
  'Demo/remove': { args: () => ({}) },
  'Consent/get': { args: () => ({}) },
  'Consent/grant': {
    args: async c => ({
      scope: 'background',
      version: await c.consentVersion(),
      provider: 'groq',
      model: groq.model,
    }),
  },
  'Consent/revoke': { args: () => ({ scope: 'background' }) },

  'Queue/list': { args: () => ({}) },
  'Queue/retry': { args: async c => ({ id: await c.actOp() }), allow: ['notFound', 'conflict'] },
  'Queue/discard': { args: async c => ({ id: await c.submission() }), allow: ['notFound'] },
  'Diagnostics/preview': { args: () => ({}) },
  'Diagnostics/export': { args: () => ({}) },
  'Diagnostics/verbose': { args: () => ({ on: false }) },
  'Listener/get': { args: () => ({}) },
  'Listener/set': { args: () => ({ enabled: false }) },
  'Clients/list': { args: () => ({}) },
  'Clients/grant': { args: () => ({ name: 'Conformance tool', kind: 'cli', scopes: ['read'] }) },
  'Clients/revoke': {
    args: async c => ({
      id: (await c.call('Clients/grant', { name: 'Revoke me', kind: 'cli', scopes: ['read'] }))
        .client.id,
    }),
  },
  'Clients/audit': { args: () => ({}) },

  'Account/get': { args: () => ({}) },
  'Account/discover': { args: () => ({ domain: 'gmail.com' }) },
  'Account/connect': {
    args: () => ({ provider: 'google', loginHint: 'practice@conformance.example' }),
  },
  'Account/reconnect': {
    args: async c => ({ accountId: await c.account() }),
    allow: ['unsupported'],
  },
  'Account/grantPermissions': {
    args: async c => ({ accountId: await c.account() }),
    allow: ['unsupported'],
  },
  'Account/cancelConnect': {
    args: async c => ({
      connectId: (
        await c.call('Account/connect', {
          provider: 'google',
          loginHint: 'cancel@conformance.example',
        })
      ).connectId,
    }),
  },
  'Account/set': {
    args: async c => ({ opId: opId(), accountId: await c.account(), colorTag: 'sage' }),
  },
  'Account/lease': { args: () => ({ pin: false }) },
  'Account/disconnect': { args: async c => ({ opId: opId(), accountId: await c.account() }) },
  'Sync/request': { args: () => ({}) },
  'Workflow/status': { args: () => ({}) },
  'Workflow/enable': { args: () => ({}), allow: ['unavailable', 'unsupported'] },
  'Workflow/code': { args: () => ({}), allow: ['unavailable', 'unsupported'] },
  'Workflow/disable': { args: () => ({}) },
  'Unsubscribe/get': { args: async c => ({ threadId: await c.thread() }) },
  'Unsubscribe/run': { args: async c => ({ opId: opId(), threadId: await c.thread() }) },

  'Calendar/get': { args: () => ({}) },
  'Calendar/set': { args: async c => ({ opId: opId(), id: await c.calendar(), shown: true }) },
  'Event/get': { args: async c => ({ ids: [await c.event()] }) },
  'Event/set': {
    args: async c => {
      const now = (await c.call('Session/get', {})).now;
      return {
        opId: opId(),
        change: {
          type: 'create',
          calendarId: await c.calendar(),
          fields: {
            title: 'Conformance check',
            start: { type: 'utc', utc: now + 86_400_000 },
            end: { type: 'utc', utc: now + 90_000_000 },
            allDay: false,
          },
        },
      };
    },
  },
  'Event/rsvp': {
    args: async c => ({
      opId: opId(),
      id: await c.invitation(),
      response: 'accepted',
      scope: 'occurrence',
    }),
    allow: ['notFound', 'unsupported'],
  },
  'Event/extract': { args: async c => ({ opId: opId(), threadId: await c.thread() }), allow: ai },
  'Plan/get': { args: async c => ({ ids: [await c.plan()] }) },
  'Event/hide': {
    args: async c => ({ opId: opId(), ids: [await c.event()], hidden: true }),
    allow: ['notFound'],
  },
  'Contact/suggest': { args: () => ({ query: 'a', limit: 5 }) },
  'Account/updateSecret': {
    args: async c => ({ accountId: await c.account(), secret: 'conformance-app-password' }),
    allow: ['unsupported'],
  },
  'Plan/confirm': { args: async c => ({ opId: opId(), id: await c.plan() }), allow: ['notFound'] },
  'Plan/dismiss': { args: async c => ({ opId: opId(), ids: [await c.plan()] }) },
  'SenderRule/get': { args: () => ({}) },
  'SenderRule/set': {
    args: () => ({ opId: opId(), match: '@digest.example', action: 'skipInbox' }),
  },
  'SenderRule/destroy': { args: async c => ({ opId: opId(), id: await c.rule() }) },
  'SenderRule/block': { args: () => ({ opId: opId(), address: 'offers@unwanted.example' }) },
  'SenderRule/unblock': { args: () => ({ opId: opId(), address: 'offers@unwanted.example' }) },
  'Data/export': { args: () => ({}) },
};

/** Methods that remove or replace the demo data: run after the rest. */
export const runLast: readonly EngineMethodName[] = [
  'Consent/revoke',
  'Account/disconnect',
  'Demo/reset',
  'Demo/remove',
  'Demo/load',
];
