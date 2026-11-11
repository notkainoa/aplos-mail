import * as z from 'zod/mini';
import { area } from '../registry/define';
import {
  bool,
  choice,
  Count,
  Empty,
  EpochMs,
  Id,
  Ids,
  line,
  Ok,
  OpId,
  Receipt,
  SenderMatch,
  State,
} from '../schemas/common';
import {
  AuditEntry,
  Client,
  DiagnosticsBundle,
  GrantableScope,
  ListenerState,
  NotificationItem,
  QueueItem,
  SenderRule,
} from '../schemas/session';

const fileBlob = z.object({ blobId: Id, name: line(500), size: Count });

export const queue = area('queue', {
  'Queue/list': {
    summary: 'The queue inspector: ops, AI jobs and submissions, content-free.',
    kind: 'query',
    scope: 'read',
    input: z.object({
      kinds: z.optional(z.array(choice(['op', 'job', 'submission'])).check(z.maxLength(3))),
    }),
    output: z.object({ list: z.array(QueueItem) }),
  },
  'Queue/retry': {
    summary:
      'Retry a queued item now. Needs the scope of the method that made it (`QueueItem.scope`; `send` for a submission).',
    kind: 'command',
    scope: 'admin',
    audit: true,
    scopeRule: 'originating',
    input: z.object({ id: Id }),
    output: Ok,
  },
  'Queue/discard': {
    summary:
      'Discard a queued item. Needs the scope of the method that made it (`QueueItem.scope`; `send` for a submission).',
    kind: 'command',
    scope: 'admin',
    audit: true,
    scopeRule: 'originating',
    input: z.object({ id: Id }),
    output: Ok,
  },
});

export const diagnostics = area('diagnostics', {
  'Diagnostics/preview': {
    summary: 'The content-free diagnostics bundle, to preview before saving. Never uploaded.',
    kind: 'query',
    scope: 'admin',
    input: Empty,
    output: DiagnosticsBundle,
  },
  'Diagnostics/export': {
    summary: "The same bundle as a file blob, for main's save dialog (`File/save`).",
    kind: 'command',
    scope: 'admin',
    input: Empty,
    output: fileBlob,
  },
  'Diagnostics/verbose': {
    summary:
      'Turn the verbose protocol log (headers only) on, switching itself off after 15 minutes, or off. A tool may only turn it off — turning it on is the owner’s. With no `on` it is a query and just answers the current deadline; the method stays a command and only the writes are audited.',
    kind: 'command',
    scope: 'admin',
    audit: true,
    input: z.object({ on: z.optional(bool()) }),
    output: z.object({ until: z.optional(EpochMs) }),
  },
});

export const listener = area('listener', {
  'Listener/get': {
    summary: 'Whether "Allow tools on this Mac" is on, and where.',
    kind: 'query',
    scope: 'admin',
    uiOnly: true,
    input: Empty,
    output: ListenerState,
  },
  'Listener/set': {
    summary:
      'Turn the local socket and loopback HTTP listener on or off (off by default in release builds).',
    kind: 'command',
    scope: 'admin',
    uiOnly: true,
    audit: true,
    input: z.object({ enabled: bool() }),
    output: ListenerState,
  },
});

export const clients = area('clients', {
  'Clients/list': {
    summary: 'Tools allowed on this Mac.',
    kind: 'query',
    scope: 'admin',
    uiOnly: true,
    input: Empty,
    output: z.object({ list: z.array(Client) }),
  },
  'Clients/grant': {
    summary:
      'Allow a tool with scopes; the host writes its token to a 0600 file and the token never crosses the contract.',
    kind: 'command',
    scope: 'admin',
    uiOnly: true,
    audit: true,
    input: z.object({
      name: line(200).check(z.minLength(1, 'Name the tool.')),
      kind: choice(['cli', 'mcp', 'preview', 'phone']),
      scopes: z
        .array(GrantableScope)
        .check(z.minLength(1, 'Choose at least one permission.'), z.maxLength(6)),
    }),
    output: z.object({ client: Client }),
  },
  'Clients/revoke': {
    summary: 'Revoke a tool; its open connections close within a second.',
    kind: 'command',
    scope: 'admin',
    uiOnly: true,
    audit: true,
    input: z.object({ id: Id }),
    output: Ok,
  },
  'Clients/audit': {
    summary: 'Sends, deletes and settings changes made by tools.',
    kind: 'query',
    scope: 'admin',
    uiOnly: true,
    input: z.object({
      clientId: z.optional(Id),
      limit: z.optional(z.int().check(z.minimum(1), z.maximum(1_000))),
    }),
    output: z.object({ list: z.array(AuditEntry) }),
  },
});

export const notification = area('notification', {
  'Notification/claim': {
    summary:
      'Main claims notifications to post (the durable outbox, ARCH 7.6). Delivery is at-least-once: a claimed item is leased for about a minute and offered again if it is not acked in time, with the same stable `id`, so a repost replaces the banner.',
    kind: 'command',
    scope: 'host',
    input: z.object({ max: z.optional(z.int().check(z.minimum(1), z.maximum(50))) }),
    output: z.object({ items: z.array(NotificationItem) }),
  },
  'Notification/ack': {
    summary: 'Main reports claimed notifications posted or dropped (notifications off, Focus).',
    kind: 'command',
    scope: 'host',
    input: z.object({ ids: Ids(50), state: choice(['posted', 'dropped']) }),
    output: Ok,
  },
});

export const sender = area('sender', {
  'SenderRule/get': {
    summary: 'Block, lane and skip-Inbox rules.',
    kind: 'query',
    scope: 'read',
    input: z.object({ accountId: z.optional(Id) }),
    output: z.object({ state: State, list: z.array(SenderRule) }),
  },
  'SenderRule/set': {
    summary:
      'Create (no `id`) or change a rule, e.g. "Always do this for [sender]" after a lane correction.',
    kind: 'command',
    scope: 'triage',
    audit: true,
    input: z.object({
      opId: OpId,
      id: z.optional(Id),
      accountId: z.optional(Id),
      match: SenderMatch,
      action: choice(['block', 'lane', 'skipInbox']),
      lane: z.optional(choice(['do', 'update', 'low'])),
    }),
    output: z.object({ rule: SenderRule, receipt: Receipt }),
  },
  'SenderRule/destroy': {
    summary: 'Delete a rule.',
    kind: 'command',
    scope: 'triage',
    audit: true,
    input: z.object({ opId: OpId, id: Id }),
    output: Receipt,
  },
  'SenderRule/block': {
    summary: "Block a sender: their mail goes to Spam now and later (today's `sender.block`).",
    kind: 'command',
    scope: 'triage',
    audit: true,
    input: z.object({ opId: OpId, address: SenderMatch, accountId: z.optional(Id) }),
    output: z.object({ rule: SenderRule, receipt: Receipt }),
  },
  'SenderRule/unblock': {
    summary: "Unblock a sender (today's `sender.unblock`).",
    kind: 'command',
    scope: 'triage',
    audit: true,
    input: z.object({ opId: OpId, address: SenderMatch }),
    output: Receipt,
  },
});

export const data = area('data', {
  'Data/export': {
    summary:
      'Export your Aplos data (accounts, settings, workflow, drafts, conversations) as a file blob; no credentials.',
    kind: 'command',
    scope: 'admin',
    uiOnly: true,
    audit: true,
    input: z.object({ format: z.optional(choice(['json'])) }),
    output: fileBlob,
  },
});
