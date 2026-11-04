import { badRequest, invalidIdError, notFound } from './errors';
import { HISTORY_TYPES, type HistoryType } from './history';
import {
  compareKeyed,
  type Keyed,
  type Mailbox,
  type MessageFormat,
  type MessageView,
} from './mailbox';
import { SCOPE } from './oauth';
import { emptyReply, jsonReply, type Reply } from './reply';
import type { SearchLag } from './search-lag';
import { RESPONSE, type Shape } from './schema';

/**
 * The Gmail REST surface. Each route names its API method (for the cost table and the log), the
 * kind of scope it needs, and a handler that works on one user's mailbox.
 */
export type ScopeClass = 'read' | 'write' | 'compose' | 'settingsRead' | 'settingsWrite' | 'full';

/** Any one of these scopes is enough for a route of that class. */
export const SCOPES_FOR: Record<ScopeClass, string[]> = {
  read: [SCOPE.gmailReadonly, SCOPE.gmailModify, SCOPE.mailFull],
  write: [SCOPE.gmailModify, SCOPE.mailFull],
  compose: [SCOPE.gmailModify, SCOPE.gmailCompose, SCOPE.mailFull],
  settingsRead: [SCOPE.gmailReadonly, SCOPE.gmailModify, SCOPE.gmailSettingsBasic, SCOPE.mailFull],
  settingsWrite: [SCOPE.gmailSettingsBasic, SCOPE.mailFull],
  full: [SCOPE.mailFull],
};

export interface RouteContext {
  mailbox: Mailbox;
  /** The search index lag after a send (`GmailEmulatorOptions.searchLagMs`). */
  lag: SearchLag;
  query: URLSearchParams;
  params: Record<string, string>;
  body: Buffer;
  now: number;
  /** The JSON request body ({} when empty); a malformed body answers 400. */
  json(): Record<string, unknown>;
}

export interface Route {
  method: string;
  /** Path below /users/{id}/, with :name placeholders. */
  pattern: string;
  apiMethod: string;
  scope: ScopeClass;
  /** Counts toward the daily send limit when it succeeds. */
  send?: boolean;
  /** Served under /upload/gmail/v1 instead of /gmail/v1. */
  upload?: boolean;
  handler(ctx: RouteContext): Reply;
}

// ---------- small helpers ----------

const MESSAGE_FORMATS: readonly string[] = ['minimal', 'metadata', 'full', 'raw'];

function formatOf(query: URLSearchParams, allowRaw: boolean): MessageFormat {
  const format = query.get('format') ?? 'full';
  if (!MESSAGE_FORMATS.includes(format) || (format === 'raw' && !allowRaw))
    throw badRequest(`Invalid format "${format}" for this resource`);
  return format as MessageFormat;
}

function maxResultsOf(query: URLSearchParams): number {
  const raw = query.get('maxResults');
  if (raw === null || raw === '') return 100;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw badRequest('Invalid maxResults');
  return value === 0 ? 100 : Math.min(value, 500);
}

/** Pages a newest-first list. The page token remembers the last item's position, so edits between pages cannot skip or repeat. */
function page<T extends Keyed>(
  items: T[],
  query: URLSearchParams,
): { items: T[]; nextPageToken?: string } {
  const max = maxResultsOf(query);
  const token = query.get('pageToken');
  let start = 0;
  if (token) {
    let cursor: Keyed;
    try {
      cursor = JSON.parse(Buffer.from(token, 'base64url').toString()) as Keyed;
      if (typeof cursor.date !== 'number' || typeof cursor.id !== 'string')
        throw new Error('bad cursor');
    } catch {
      throw badRequest('Invalid pageToken');
    }
    const found = items.findIndex(item => compareKeyed(item, cursor) > 0);
    start = found === -1 ? items.length : found;
  }
  const slice = items.slice(start, start + max);
  const more = start + max < items.length;
  const last = slice[slice.length - 1];
  return {
    items: slice,
    nextPageToken:
      more && last
        ? Buffer.from(JSON.stringify({ date: last.date, id: last.id })).toString('base64url')
        : undefined,
  };
}

function decodeRaw(value: unknown): Buffer {
  if (typeof value !== 'string' || !value) {
    throw badRequest(
      "'raw' RFC822 payload message string or uploading message via /upload/* URL required",
      'invalidArgument',
    );
  }
  return Buffer.from(value, 'base64url');
}

/**
 * Gmail message and thread ids are 64-bit numbers written in hex (up to 16 digits). Anything else
 * is rejected as 400 "Invalid id value" before any lookup [observed], so a corrupted id never
 * looks like a message that was deleted remotely (which is 404).
 */
const HEX_ID = /^[0-9a-f]{1,16}$/i;

export function requireGmailId(id: string): string {
  if (!HEX_ID.test(id)) throw invalidIdError();
  return id;
}

const stringList = (value: unknown, name: string): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string'))
    throw badRequest(`Invalid ${name}`);
  return value as string[];
};

const labelsOut = (m: MessageView) => ({
  id: m.id,
  threadId: m.threadId,
  ...(m.labelIds.length ? { labelIds: m.labelIds } : {}),
});
const refOut = (m: MessageView) => ({ id: m.id, threadId: m.threadId });

function labelChange(ctx: RouteContext): { add: string[]; remove: string[] } {
  const body = ctx.json();
  return {
    add: stringList(body.addLabelIds, 'addLabelIds'),
    remove: stringList(body.removeLabelIds, 'removeLabelIds'),
  };
}

function listFilter(query: URLSearchParams): {
  labelIds: string[];
  q: string;
  includeSpamTrash: boolean;
} {
  return {
    labelIds: query.getAll('labelIds'),
    q: query.get('q') ?? '',
    includeSpamTrash: query.get('includeSpamTrash') === 'true',
  };
}

// ---------- handlers ----------

const listMessages = (ctx: RouteContext): Reply => {
  const hits = ctx.mailbox.select(listFilter(ctx.query)).filter(h => ctx.lag.shows(h.id, ctx.now));
  const paged = page(hits, ctx.query);
  return jsonReply({
    ...(paged.items.length
      ? { messages: paged.items.map(h => ({ id: h.id, threadId: h.threadId })) }
      : {}),
    ...(paged.nextPageToken ? { nextPageToken: paged.nextPageToken } : {}),
    resultSizeEstimate: hits.length,
  });
};

const listThreads = (ctx: RouteContext): Reply => {
  const hits = ctx.mailbox.selectThreads(listFilter(ctx.query));
  const paged = page(hits, ctx.query);
  return jsonReply({
    ...(paged.items.length
      ? {
          threads: paged.items.map(t => ({ id: t.id, snippet: t.snippet, historyId: t.historyId })),
        }
      : {}),
    ...(paged.nextPageToken ? { nextPageToken: paged.nextPageToken } : {}),
    resultSizeEstimate: hits.length,
  });
};

/**
 * Like Gmail, `drafts.list` hides a draft that is in Trash unless `includeSpamTrash=true` (`drafts.get` still finds it),
 * and `q` narrows it with the same query language as `messages.list` (`rfc822msgid:`, `subject:`, ...).
 */
const listDrafts = (ctx: RouteContext): Reply => {
  const withTrash = ctx.query.get('includeSpamTrash') === 'true';
  const q = ctx.query.get('q') ?? '';
  const matching = q
    ? new Set(ctx.mailbox.select({ q, includeSpamTrash: withTrash }).map(h => h.id))
    : undefined;
  const drafts = ctx.mailbox
    .listDrafts()
    .filter(d => withTrash || !d.message.labelIds.includes('TRASH'))
    .filter(d => !matching || matching.has(d.message.id))
    .map(d => ({ date: d.message.internalDate, id: d.id, message: d.message }))
    .sort(compareKeyed);
  const paged = page(drafts, ctx.query);
  return jsonReply({
    ...(paged.items.length
      ? { drafts: paged.items.map(d => ({ id: d.id, message: refOut(d.message) })) }
      : {}),
    ...(paged.nextPageToken ? { nextPageToken: paged.nextPageToken } : {}),
    resultSizeEstimate: drafts.length,
  });
};

const draftOut = (id: string, message: MessageView) => ({ id, message: labelsOut(message) });

function historyList(ctx: RouteContext): Reply {
  const start = ctx.query.get('startHistoryId');
  if (start === null || !/^\d+$/.test(start)) throw badRequest('Invalid startHistoryId');
  const types = ctx.query.getAll('historyTypes');
  for (const type of types)
    if (!HISTORY_TYPES.includes(type as HistoryType))
      throw badRequest(`Invalid historyTypes: ${type}`);
  const result = ctx.mailbox.history.query({
    startHistoryId: Number(start),
    types: types as HistoryType[],
    labelId: ctx.query.get('labelId') ?? undefined,
    maxResults: maxResultsOf(ctx.query),
    pageToken: ctx.query.get('pageToken') ?? undefined,
  });
  if (result.expired) throw notFound();
  return jsonReply({
    ...(result.records.length ? { history: result.records } : {}),
    ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
    historyId: result.historyId,
  });
}

function createFilter(ctx: RouteContext): Reply {
  const body = ctx.json();
  const asObject = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return jsonReply(ctx.mailbox.createFilter(asObject(body.criteria), asObject(body.action)));
}

function batchModify(ctx: RouteContext): Reply {
  const body = ctx.json();
  const ids = stringList(body.ids, 'ids');
  if (!ids.length) throw badRequest('ids must not be empty');
  if (ids.length > 1000) throw badRequest('Too many ids: at most 1000 per batchModify');
  ids.forEach(requireGmailId);
  const unknown = ids.find(id => !ctx.mailbox.hasMessage(id));
  if (unknown !== undefined) throw invalidIdError();
  ctx.mailbox.modifyMessages(
    ids,
    stringList(body.addLabelIds, 'addLabelIds'),
    stringList(body.removeLabelIds, 'removeLabelIds'),
  );
  return emptyReply(204);
}

function sendJson(ctx: RouteContext): Reply {
  const body = ctx.json();
  const message = ctx.mailbox.sendRaw(
    decodeRaw(body.raw),
    typeof body.threadId === 'string' ? body.threadId : undefined,
  );
  ctx.lag.sent(message.id, ctx.now);
  return jsonReply(labelsOut(message));
}

function sendUpload(ctx: RouteContext): Reply {
  const uploadType = ctx.query.get('uploadType');
  if (uploadType !== 'media')
    throw badRequest(
      `Unsupported uploadType "${uploadType ?? ''}"; the emulator accepts uploadType=media with message/rfc822`,
    );
  if (!ctx.body.length) throw badRequest('Empty upload');
  const message = ctx.mailbox.sendRaw(ctx.body);
  ctx.lag.sent(message.id, ctx.now);
  return jsonReply(labelsOut(message));
}

function draftMessageRaw(ctx: RouteContext): { raw: Buffer; threadId?: string } {
  const message = ctx.json().message as { raw?: unknown; threadId?: unknown } | undefined;
  if (!message) throw badRequest('Missing draft message');
  return {
    raw: decodeRaw(message.raw),
    threadId: typeof message.threadId === 'string' ? message.threadId : undefined,
  };
}

export const ROUTES: Route[] = [
  {
    method: 'GET',
    pattern: 'profile',
    apiMethod: 'gmail.users.getProfile',
    scope: 'read',
    handler: ctx => jsonReply(ctx.mailbox.profile()),
  },
  {
    method: 'POST',
    pattern: 'watch',
    apiMethod: 'gmail.users.watch',
    scope: 'read',
    handler: ctx =>
      jsonReply({
        historyId: String(ctx.mailbox.history.currentId),
        expiration: String(ctx.now + 7 * 86400_000),
      }),
  },

  // labels
  {
    method: 'GET',
    pattern: 'labels',
    apiMethod: 'gmail.users.labels.list',
    scope: 'read',
    handler: ctx => jsonReply({ labels: ctx.mailbox.listLabels() }),
  },
  {
    method: 'POST',
    pattern: 'labels',
    apiMethod: 'gmail.users.labels.create',
    scope: 'write',
    handler: ctx => {
      const body = ctx.json();
      if (typeof body.name !== 'string') throw badRequest('Invalid label name');
      return jsonReply(
        ctx.mailbox.createLabel(body.name, {
          labelListVisibility:
            typeof body.labelListVisibility === 'string' ? body.labelListVisibility : undefined,
          messageListVisibility:
            typeof body.messageListVisibility === 'string' ? body.messageListVisibility : undefined,
        }),
      );
    },
  },
  {
    method: 'GET',
    pattern: 'labels/:id',
    apiMethod: 'gmail.users.labels.get',
    scope: 'read',
    handler: ctx =>
      jsonReply({
        ...ctx.mailbox.getLabel(ctx.params.id),
        ...ctx.mailbox.labelCounts(ctx.params.id),
      }),
  },

  // history
  {
    method: 'GET',
    pattern: 'history',
    apiMethod: 'gmail.users.history.list',
    scope: 'read',
    handler: historyList,
  },

  // messages (literal paths first so ":id" does not swallow them)
  {
    method: 'GET',
    pattern: 'messages',
    apiMethod: 'gmail.users.messages.list',
    scope: 'read',
    handler: listMessages,
  },
  {
    method: 'POST',
    pattern: 'messages/batchModify',
    apiMethod: 'gmail.users.messages.batchModify',
    scope: 'write',
    handler: batchModify,
  },
  {
    method: 'POST',
    pattern: 'messages/insert',
    apiMethod: 'gmail.users.messages.insert',
    scope: 'compose',
    handler: ctx => {
      const body = ctx.json();
      const source =
        ctx.query.get('internalDateSource') === 'dateHeader' ? 'dateHeader' : 'receivedTime';
      const message = ctx.mailbox.insertRaw(
        decodeRaw(body.raw),
        stringList(body.labelIds, 'labelIds'),
        typeof body.threadId === 'string' ? body.threadId : undefined,
        source,
      );
      return jsonReply(labelsOut(message));
    },
  },
  {
    method: 'POST',
    pattern: 'messages/send',
    apiMethod: 'gmail.users.messages.send',
    scope: 'compose',
    send: true,
    handler: sendJson,
  },
  {
    method: 'POST',
    pattern: 'messages/send',
    apiMethod: 'gmail.users.messages.send',
    scope: 'compose',
    send: true,
    upload: true,
    handler: sendUpload,
  },
  {
    method: 'GET',
    pattern: 'messages/:messageId',
    apiMethod: 'gmail.users.messages.get',
    scope: 'read',
    handler: ctx =>
      jsonReply(
        ctx.mailbox.messageResource(
          ctx.params.messageId,
          formatOf(ctx.query, true),
          ctx.query.getAll('metadataHeaders'),
        ),
      ),
  },
  {
    method: 'DELETE',
    pattern: 'messages/:messageId',
    apiMethod: 'gmail.users.messages.delete',
    scope: 'full',
    handler: ctx => {
      ctx.mailbox.deleteMessage(ctx.params.messageId);
      return emptyReply(204);
    },
  },
  {
    method: 'POST',
    pattern: 'messages/:messageId/modify',
    apiMethod: 'gmail.users.messages.modify',
    scope: 'write',
    handler: ctx => {
      const { add, remove } = labelChange(ctx);
      ctx.mailbox.modifyMessages([ctx.params.messageId], add, remove);
      return jsonReply(labelsOut(ctx.mailbox.getMessage(ctx.params.messageId)!));
    },
  },
  {
    method: 'POST',
    pattern: 'messages/:messageId/trash',
    apiMethod: 'gmail.users.messages.trash',
    scope: 'write',
    handler: ctx => {
      ctx.mailbox.trashMessage(ctx.params.messageId);
      return jsonReply(labelsOut(ctx.mailbox.getMessage(ctx.params.messageId)!));
    },
  },
  {
    method: 'POST',
    pattern: 'messages/:messageId/untrash',
    apiMethod: 'gmail.users.messages.untrash',
    scope: 'write',
    handler: ctx => {
      ctx.mailbox.untrashMessage(ctx.params.messageId);
      return jsonReply(labelsOut(ctx.mailbox.getMessage(ctx.params.messageId)!));
    },
  },
  {
    method: 'GET',
    pattern: 'messages/:messageId/attachments/:attachmentId',
    apiMethod: 'gmail.users.messages.attachments.get',
    scope: 'read',
    handler: ctx => {
      const data = ctx.mailbox.attachment(ctx.params.messageId, ctx.params.attachmentId);
      return jsonReply({ size: data.length, data: data.toString('base64url') });
    },
  },

  // threads
  {
    method: 'GET',
    pattern: 'threads',
    apiMethod: 'gmail.users.threads.list',
    scope: 'read',
    handler: listThreads,
  },
  {
    method: 'GET',
    pattern: 'threads/:threadId',
    apiMethod: 'gmail.users.threads.get',
    scope: 'read',
    handler: ctx =>
      jsonReply(
        ctx.mailbox.threadResource(
          ctx.params.threadId,
          formatOf(ctx.query, false) as Exclude<MessageFormat, 'raw'>,
          ctx.query.getAll('metadataHeaders'),
        ),
      ),
  },
  {
    method: 'POST',
    pattern: 'threads/:threadId/modify',
    apiMethod: 'gmail.users.threads.modify',
    scope: 'write',
    handler: ctx => {
      const { add, remove } = labelChange(ctx);
      ctx.mailbox.modifyThread(ctx.params.threadId, add, remove);
      return jsonReply(ctx.mailbox.threadResource(ctx.params.threadId, 'minimal'));
    },
  },
  {
    method: 'POST',
    pattern: 'threads/:threadId/trash',
    apiMethod: 'gmail.users.threads.trash',
    scope: 'write',
    handler: ctx => {
      ctx.mailbox.trashThread(ctx.params.threadId);
      return jsonReply(ctx.mailbox.threadResource(ctx.params.threadId, 'minimal'));
    },
  },
  {
    method: 'POST',
    pattern: 'threads/:threadId/untrash',
    apiMethod: 'gmail.users.threads.untrash',
    scope: 'write',
    handler: ctx => {
      ctx.mailbox.untrashThread(ctx.params.threadId);
      return jsonReply(ctx.mailbox.threadResource(ctx.params.threadId, 'minimal'));
    },
  },

  // drafts
  {
    method: 'GET',
    pattern: 'drafts',
    apiMethod: 'gmail.users.drafts.list',
    scope: 'read',
    handler: listDrafts,
  },
  {
    method: 'POST',
    pattern: 'drafts',
    apiMethod: 'gmail.users.drafts.create',
    scope: 'compose',
    handler: ctx => {
      const { raw, threadId } = draftMessageRaw(ctx);
      const draft = ctx.mailbox.createDraft(raw, threadId);
      return jsonReply(draftOut(draft.id, draft.message));
    },
  },
  {
    method: 'POST',
    pattern: 'drafts/send',
    apiMethod: 'gmail.users.drafts.send',
    scope: 'compose',
    send: true,
    handler: ctx => {
      const id = ctx.json().id;
      if (typeof id !== 'string') throw badRequest('Missing draft id');
      return jsonReply(labelsOut(ctx.mailbox.sendDraft(id)));
    },
  },
  {
    method: 'GET',
    pattern: 'drafts/:id',
    apiMethod: 'gmail.users.drafts.get',
    scope: 'read',
    handler: ctx => {
      const messageId = ctx.mailbox.draftMessageId(ctx.params.id);
      return jsonReply({
        id: ctx.params.id,
        message: ctx.mailbox.messageResource(
          messageId,
          formatOf(ctx.query, true),
          ctx.query.getAll('metadataHeaders'),
        ),
      });
    },
  },
  {
    method: 'PUT',
    pattern: 'drafts/:id',
    apiMethod: 'gmail.users.drafts.update',
    scope: 'compose',
    handler: ctx => {
      const { raw, threadId } = draftMessageRaw(ctx);
      const draft = ctx.mailbox.updateDraft(ctx.params.id, raw, threadId);
      return jsonReply(draftOut(draft.id, draft.message));
    },
  },
  {
    method: 'DELETE',
    pattern: 'drafts/:id',
    apiMethod: 'gmail.users.drafts.delete',
    scope: 'compose',
    handler: ctx => {
      ctx.mailbox.deleteDraft(ctx.params.id);
      return emptyReply(204);
    },
  },

  // settings
  {
    method: 'GET',
    pattern: 'settings/filters',
    apiMethod: 'gmail.users.settings.filters.list',
    scope: 'settingsRead',
    handler: ctx => {
      const filter = ctx.mailbox.listFilters();
      return jsonReply(filter.length ? { filter } : {});
    },
  },
  {
    method: 'POST',
    pattern: 'settings/filters',
    apiMethod: 'gmail.users.settings.filters.create',
    scope: 'settingsWrite',
    handler: createFilter,
  },
  {
    method: 'GET',
    pattern: 'settings/filters/:id',
    apiMethod: 'gmail.users.settings.filters.get',
    scope: 'settingsRead',
    handler: ctx => jsonReply(ctx.mailbox.getFilter(ctx.params.id)),
  },
  {
    method: 'DELETE',
    pattern: 'settings/filters/:id',
    apiMethod: 'gmail.users.settings.filters.delete',
    scope: 'settingsWrite',
    handler: ctx => {
      ctx.mailbox.deleteFilter(ctx.params.id);
      return emptyReply(204);
    },
  },
  {
    method: 'GET',
    pattern: 'settings/sendAs',
    apiMethod: 'gmail.users.settings.sendAs.list',
    scope: 'settingsRead',
    handler: ctx => jsonReply({ sendAs: ctx.mailbox.listSendAs() }),
  },
];

/** The response type a `fields=` mask is checked against. Methods answering 204 have none. */
const RESPONSE_OF: Record<string, Shape> = {
  'gmail.users.getProfile': RESPONSE.profile,
  'gmail.users.watch': RESPONSE.watch,
  'gmail.users.labels.list': RESPONSE.labels,
  'gmail.users.labels.create': RESPONSE.label,
  'gmail.users.labels.get': RESPONSE.label,
  'gmail.users.history.list': RESPONSE.history,
  'gmail.users.messages.list': RESPONSE.messages,
  'gmail.users.messages.insert': RESPONSE.message,
  'gmail.users.messages.send': RESPONSE.message,
  'gmail.users.messages.get': RESPONSE.message,
  'gmail.users.messages.modify': RESPONSE.message,
  'gmail.users.messages.trash': RESPONSE.message,
  'gmail.users.messages.untrash': RESPONSE.message,
  'gmail.users.messages.attachments.get': RESPONSE.attachment,
  'gmail.users.threads.list': RESPONSE.threads,
  'gmail.users.threads.get': RESPONSE.thread,
  'gmail.users.threads.modify': RESPONSE.thread,
  'gmail.users.threads.trash': RESPONSE.thread,
  'gmail.users.threads.untrash': RESPONSE.thread,
  'gmail.users.drafts.list': RESPONSE.drafts,
  'gmail.users.drafts.create': RESPONSE.draft,
  'gmail.users.drafts.send': RESPONSE.message,
  'gmail.users.drafts.get': RESPONSE.draft,
  'gmail.users.drafts.update': RESPONSE.draft,
  'gmail.users.settings.filters.list': RESPONSE.filters,
  'gmail.users.settings.filters.create': RESPONSE.filter,
  'gmail.users.settings.filters.get': RESPONSE.filter,
  'gmail.users.settings.sendAs.list': RESPONSE.sendAs,
};

export function responseShapeOf(apiMethod: string): Shape | undefined {
  return RESPONSE_OF[apiMethod];
}

// ---------- matching ----------

interface Compiled {
  route: Route;
  regex: RegExp;
  names: string[];
}

/** Message and thread ids in the path are checked before the handler looks them up. */
function checkingIds(handler: Route['handler']): Route['handler'] {
  return ctx => {
    if (ctx.params.messageId !== undefined) requireGmailId(ctx.params.messageId);
    if (ctx.params.threadId !== undefined) requireGmailId(ctx.params.threadId);
    return handler(ctx);
  };
}

const COMPILED: Compiled[] = ROUTES.map(base => {
  const route: Route = { ...base, handler: checkingIds(base.handler) };
  const names: string[] = [];
  const source = route.pattern
    .split('/')
    .map(segment => {
      if (!segment.startsWith(':')) return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(segment.slice(1));
      return '([^/]+)';
    })
    .join('/');
  return { route, regex: new RegExp(`^${source}$`), names };
});

export interface RouteMatch {
  route: Route;
  params: Record<string, string>;
  /** The `{userId}` path segment: "me" or an email address. */
  userId: string;
}

const GMAIL_PATH = /^\/(upload\/)?gmail\/v1\/users\/([^/]+)\/(.+?)\/?$/;

/** Finds the route for a method and full path, or undefined. */
export function matchRoute(method: string, pathname: string): RouteMatch | undefined {
  const parts = GMAIL_PATH.exec(pathname);
  if (!parts) return undefined;
  const upload = parts[1] !== undefined;
  for (const compiled of COMPILED) {
    if (compiled.route.method !== method || Boolean(compiled.route.upload) !== upload) continue;
    const hit = compiled.regex.exec(parts[3]);
    if (!hit) continue;
    const params: Record<string, string> = {};
    compiled.names.forEach((name, index) => {
      params[name] = decodeURIComponent(hit[index + 1]);
    });
    return { route: compiled.route, params, userId: decodeURIComponent(parts[2]) };
  }
  return undefined;
}
