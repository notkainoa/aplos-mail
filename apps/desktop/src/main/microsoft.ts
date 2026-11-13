import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import type {
  Account,
  Attachment,
  CalendarEvent,
  Draft,
  Message,
  Thread,
} from '@aplos/contract/legacy/types';
import {
  ProviderError,
  calendarColor,
  type AppDataRecord,
  type CalendarInfo,
  type ConnectRequest,
  type MailProvider,
  type ProviderCapabilities,
  type ProviderEnvironment,
  type RemoteThread,
  type SyncContext,
  type SyncResult,
  type ThreadFlags,
} from '@aplos/engine/legacy/provider';
import { createVault } from './vault';
import { bundledOAuth, oauthClient, releaseBuild } from './oauth-config';

export interface MicrosoftOptions extends ProviderEnvironment<Buffer> {
  clientId?: string;
  tenant?: string;
  oauthTimeoutMs?: number;
}
interface Token {
  access_token: string;
  refresh_token?: string;
  expiresAt: number;
}
type Json = Record<string, any>;
/** Where a message sits and the flags needed to describe its thread without refetching it. */
interface Entry {
  c: string;
  f: string;
  r: boolean;
  g: boolean;
  o: boolean;
  d: string;
}
interface Sub {
  method: string;
  url: string;
  body?: unknown;
  prefer?: string[];
}
interface SubResult {
  status: number;
  body: Json;
  headers: Record<string, string>;
}

/** `uncertain` means the request may have reached Microsoft even though no answer came back. `code` is Graph's error code. */
export class MicrosoftError extends ProviderError {
  constructor(
    message: string,
    status?: number,
    uncertain = false,
    readonly code?: string,
  ) {
    super(message, status, uncertain);
  }
}
export type MicrosoftAdapter = MailProvider &
  Required<
    Pick<
      MailProvider,
      | 'getSendAs'
      | 'listCalendars'
      | 'listEvents'
      | 'saveEvent'
      | 'deleteEvent'
      | 'readAppData'
      | 'writeAppData'
    >
  >;
const CAPABILITIES: ProviderCapabilities = {
  labels: false,
  importance: false,
  aliases: false,
  signatures: false,
  calendar: true,
  serverSearch: true,
};
/** Messages across tracked folders downloaded on a first sync, newest first. Older mail is reached through search. */
export const INITIAL_MESSAGES = 500;
const SEARCH_MESSAGES = 100;
const PAGE = 100;
/** Delta pages per folder before a fresh window is cheaper than replaying changes. */
const MAX_DELTA_PAGES = 50;
/** Graph rejects requests over 4 MB; base64 MIME grows by a third. */
const MAX_SEND_BASE64 = 3_900_000;
const MAX_APP_DATA = 3_000_000;
const INLINE_LIMIT = 1_000_000;
const SCOPES =
  'offline_access openid profile email User.Read Mail.ReadWrite Mail.Send MailboxSettings.Read Calendars.ReadWrite';
const graph = 'https://graph.microsoft.com/v1.0';
const ROLES: Record<string, string> = {
  inbox: 'INBOX',
  archive: 'ARCHIVE',
  sentitems: 'SENT',
  deleteditems: 'TRASH',
  junkemail: 'SPAM',
  drafts: 'DRAFTS',
};
const TRACKED = ['inbox', 'archive', 'sentitems', 'deleteditems', 'junkemail'];
const LIGHT = 'id,conversationId,receivedDateTime,isRead,flag,from,isDraft';
const FULL =
  'id,conversationId,internetMessageId,subject,body,bodyPreview,from,toRecipients,ccRecipients,sentDateTime,receivedDateTime,isRead,flag,hasAttachments,parentFolderId,isDraft,inferenceClassification';
/** Attachment list pages per message; anything past this is not a real mail. */
const MAX_ATTACHMENT_PAGES = 20;
const APP_FOLDER = 'Aplos Mail Data',
  APP_FILE = 'aplos-data.bin';
/** Named property on every workflow record, so only messages Aplos wrote are ever read or deleted. */
const APP_PROPERTY = 'String {8d4b6f0e-3a91-4c57-b2e8-61f0c9a7d354} Name AplosWorkflowRecord',
  APP_MARK = '1';
const APP_FILTER = `singleValueExtendedProperties/Any(ep: ep/id eq '${APP_PROPERTY}' and ep/value eq '${APP_MARK}')`;
const enc = encodeURIComponent;
/** OData option names keep their `$`; values are percent-encoded. */
const q = (params: Record<string, string | undefined>) =>
  Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${enc(v!)}`)
    .join('&');
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
const isMe = (account: Account, address: unknown) =>
  typeof address === 'string' && address.toLowerCase() === account.email.toLowerCase();
const recipients = (list: unknown) =>
  Array.isArray(list) ? list.map(r => String(r?.emailAddress?.address ?? '')).filter(Boolean) : [];
function htmlText(html: string) {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Status from the well-known folders a conversation's messages sit in ('' is any other folder). */
export function folderStatus(folders: string[]): ThreadFlags['status'] {
  if (folders.includes('inbox')) return 'new';
  if (folders.length && folders.every(f => f === 'deleteditems')) return 'trash';
  return folders.includes('junkemail') ? 'spam' : 'done';
}
function describe(account: Account, conversationId: string, entries: Entry[]): ThreadFlags {
  const unread = entries.some(e => !e.o && !e.r),
    bookmarked = entries.some(e => e.g),
    folders = entries.map(e => e.f);
  const labels = [
    ...Object.keys(ROLES)
      .filter(f => folders.includes(f))
      .map(f => ROLES[f]),
    ...(unread ? ['UNREAD'] : []),
    ...(bookmarked ? ['STARRED'] : []),
  ];
  return {
    id: `${account.id}:${conversationId}`,
    unread,
    bookmarked,
    status: folderStatus(folders),
    labels,
  };
}
function entryOf(m: Json, folder: string, account: Account, previous?: Entry): Entry {
  return {
    c: String(m.conversationId ?? previous?.c ?? ''),
    f: folder,
    r: typeof m.isRead === 'boolean' ? m.isRead : (previous?.r ?? true),
    g: m.flag ? m.flag.flagStatus === 'flagged' : (previous?.g ?? false),
    o:
      Boolean(previous?.o) ||
      folder === 'sentitems' ||
      isMe(account, m.from?.emailAddress?.address),
    d: String(m.receivedDateTime ?? previous?.d ?? ''),
  };
}
/** Normalize Graph messages of one conversation into our mailbox model. HTML is sanitized at display. */
export function normalizeGraphConversation(
  conversationId: string,
  raw: { message: Json; folder: string; attachments?: Attachment[] }[],
  account: Account,
): Thread {
  const items = raw.filter(r => !r.message.isDraft);
  const messages: (Message & { preview: string; subject: string; focused: boolean })[] = items
    .map(({ message: m, folder, attachments }) => {
      const html = m.body?.contentType === 'html' ? String(m.body.content ?? '') : undefined;
      const sender = m.from?.emailAddress ?? {},
        address = String(sender.address ?? ''),
        sent = folder === 'sentitems' || isMe(account, address);
      const when =
        (sent ? (m.sentDateTime ?? m.receivedDateTime) : (m.receivedDateTime ?? m.sentDateTime)) ??
        Date.now();
      return {
        id: String(m.id),
        ...(m.internetMessageId ? { internetId: String(m.internetMessageId) } : {}),
        from: address,
        fromName: String(sender.name || address.split('@')[0] || ''),
        to: recipients(m.toRecipients),
        cc: recipients(m.ccRecipients),
        date: new Date(when).toISOString(),
        text: html !== undefined ? htmlText(html) : String(m.body?.content ?? m.bodyPreview ?? ''),
        html: html || undefined,
        sent,
        attachments: attachments ?? [],
        preview: String(m.bodyPreview ?? ''),
        subject: String(m.subject ?? ''),
        focused: m.inferenceClassification !== 'other',
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  const flags = describe(
    account,
    conversationId,
    items.map(r => entryOf(r.message, r.folder, account)),
  );
  const last = messages.at(-1);
  return {
    id: flags.id,
    remoteId: conversationId,
    accountId: account.id,
    subject: messages.find(m => m.subject)?.subject || '(No subject)',
    summary: last?.preview.trim() || last?.text.slice(0, 200) || '',
    messages: messages.map(({ preview: _p, subject: _s, focused: _f, ...m }) => m),
    date: last?.date ?? new Date().toISOString(),
    unread: flags.unread,
    status: flags.status,
    // Read-only seed from Focused Inbox; Aplos does not write importance back to Outlook.
    importance: messages.some(m => !m.sent && m.focused) ? 'important' : 'low',
    bookmarked: flags.bookmarked,
    replyStatus: 'none',
    labels: flags.labels,
  };
}

/** Message ID → entry, with a reverse index by conversation, persisted in provider memory. */
function createIndex() {
  const messages = new Map<string, Entry>(),
    convs = new Map<string, Set<string>>();
  const index = {
    get: (id: string) => messages.get(id),
    delete(id: string) {
      const e = messages.get(id);
      if (!e) return;
      messages.delete(id);
      const set = convs.get(e.c);
      set?.delete(id);
      if (set && !set.size) convs.delete(e.c);
    },
    set(id: string, e: Entry) {
      index.delete(id);
      messages.set(id, e);
      let set = convs.get(e.c);
      if (!set) convs.set(e.c, (set = new Set()));
      set.add(id);
    },
    entries: (c: string) => [...(convs.get(c) ?? [])].map(id => [id, messages.get(id)!] as const),
    clear() {
      messages.clear();
      convs.clear();
    },
    dump: () =>
      JSON.stringify(
        Object.fromEntries([...messages].map(([id, e]) => [id, [e.c, e.f, +e.r, +e.g, +e.o, e.d]])),
      ),
    load(text: string | undefined) {
      index.clear();
      if (!text) return;
      try {
        for (const [id, v] of Object.entries(JSON.parse(text) as Record<string, any[]>))
          if (Array.isArray(v) && typeof v[0] === 'string')
            index.set(id, {
              c: v[0],
              f: String(v[1] ?? ''),
              r: !!v[2],
              g: !!v[3],
              o: !!v[4],
              d: String(v[5] ?? ''),
            });
      } catch {
        index.clear();
      }
    },
  };
  return index;
}
type MailIndex = ReturnType<typeof createIndex>;

const microsoftUnavailable = releaseBuild
  ? 'Outlook sign-in isn’t available in this build.'
  : 'Outlook sign-in isn’t available in this build. Developers: register an app in Microsoft Entra with the “Mobile and desktop applications” platform, redirect URI http://localhost, public client flows allowed and no client secret, then set MICROSOFT_CLIENT_ID (and optionally MICROSOFT_TENANT) in .env and restart.';

export async function createMicrosoft(options: MicrosoftOptions): Promise<MicrosoftAdapter> {
  const request = options.fetch ?? fetch,
    clientId =
      options.clientId ??
      oauthClient(process.env.MICROSOFT_CLIENT_ID, undefined, bundledOAuth.microsoft).clientId;
  const tenant = options.tenant ?? process.env.MICROSOFT_TENANT ?? 'common';
  if (!/^[\w.-]+$/.test(tenant))
    throw new Error(
      'MICROSOFT_TENANT must be a tenant ID, domain, "common", "organizations" or "consumers".',
    );
  const login = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
  const vault = await createVault<Token>({
    dataDir: options.dataDir,
    encrypt: options.encrypt,
    decrypt: options.decrypt,
    file: 'microsoft-tokens.enc.json',
  });
  const refreshes = new Map<string, Promise<string>>(),
    zones = new Map<string, string>();
  let servers: Server[] = [],
    cancelConnect: (() => void) | undefined;
  const memory = {
    get: (account: Account, key: string) => options.memory?.get(account.id, key),
    set: (account: Account, key: string, value: string | undefined) =>
      options.memory?.set(account.id, key, value),
  };

  function failure(
    status: number,
    body: Json | undefined,
    retryAfter?: string | null,
  ): MicrosoftError {
    const code = typeof body?.error === 'string' ? body.error : String(body?.error?.code ?? '');
    if (status === 410 || /^(syncStateNotFound|resyncRequired|syncStateInvalid)$/i.test(code))
      return new MicrosoftError('The Outlook sync position expired.', 410, false, code);
    if (status === 401)
      return new MicrosoftError(
        'Microsoft authorization expired. Reconnect this account.',
        status,
        false,
        code,
      );
    if (status === 403)
      return new MicrosoftError(
        'Microsoft denied this operation. Reconnect and grant the requested mail and calendar permissions.',
        status,
        false,
        code,
      );
    if (status === 404)
      return new MicrosoftError('Outlook could not find this item.', status, false, code);
    if (status === 413)
      return new MicrosoftError(
        'This message is too large for Outlook. Remove some attachments and try again.',
        status,
        false,
        code,
      );
    if (status === 429) {
      const seconds = Number(retryAfter);
      return new MicrosoftError(
        `Microsoft rate limit reached. Please retry ${seconds > 0 ? `in ${Math.ceil(seconds)} seconds` : 'shortly'}.`,
        status,
        false,
        code,
      );
    }
    return new MicrosoftError(
      `Microsoft request failed (${status}). Please retry.`,
      status,
      status >= 500,
      code,
    );
  }
  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await request(url, { ...init, signal: init.signal ?? AbortSignal.timeout(45000) });
    } catch {
      throw new MicrosoftError(
        'Microsoft could not be reached. Check your internet connection.',
        undefined,
        true,
      );
    }
  }
  async function fetchJson(url: string, init: RequestInit = {}): Promise<Json> {
    const response = await send(url, init);
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new MicrosoftError(
        'The connection to Microsoft dropped before it answered. Please retry.',
        undefined,
        true,
      );
    }
    let body: Json | undefined;
    try {
      body = text ? (JSON.parse(text) as Json) : {};
    } catch {
      body = undefined;
    }
    if (!response.ok) throw failure(response.status, body, response.headers.get('retry-after'));
    if (!body) throw new Error('Microsoft returned an unreadable response. Please retry.');
    return body;
  }
  async function tokenRequest(params: Record<string, string>): Promise<Json> {
    try {
      return await fetchJson(`${login}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId!, scope: SCOPES, ...params }),
      });
    } catch (error) {
      if (error instanceof MicrosoftError && (error.status === 400 || error.status === 401))
        throw new MicrosoftError(
          'Microsoft authorization expired. Reconnect this account.',
          401,
          false,
          error.code,
        );
      throw error;
    }
  }
  async function access(id: string): Promise<string> {
    const token = vault.get(id);
    if (!token) throw new Error('This Outlook account needs to be reconnected.');
    if (token.expiresAt > Date.now() + 60000) return token.access_token;
    if (!token.refresh_token || !clientId)
      throw new MicrosoftError('Microsoft authorization expired. Reconnect this account.', 401);
    const active = refreshes.get(id);
    if (active) return active;
    const promise = (async () => {
      const data = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token!,
      });
      if (typeof data.access_token !== 'string')
        throw new MicrosoftError('Microsoft authorization expired. Reconnect this account.', 401);
      if (vault.get(id) !== token) throw new Error('This Outlook account was disconnected.');
      // Microsoft rotates refresh tokens; the old one may stop working once the new one is issued.
      await vault.set(id, {
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? token.refresh_token,
        expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      });
      return data.access_token as string;
    })();
    refreshes.set(id, promise);
    try {
      return await promise;
    } finally {
      refreshes.delete(id);
    }
  }
  const preferValue = (extra: string[] = []) => ['IdType="ImmutableId"', ...extra].join(', ');
  function target(path: string) {
    const url = path.startsWith('https://') ? path : `${graph}${path}`;
    if (!url.startsWith(`${graph}/`))
      throw new Error('Refusing to send Microsoft credentials to another host.');
    return url;
  }
  async function api(
    account: Account,
    path: string,
    method = 'GET',
    body?: unknown,
    prefer?: string[],
  ): Promise<Json> {
    const url = target(path),
      token = await access(account.id),
      text = typeof body === 'string';
    return fetchJson(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Prefer: preferValue(prefer),
        ...(body === undefined ? {} : { 'Content-Type': text ? 'text/plain' : 'application/json' }),
      },
      ...(body === undefined ? {} : { body: text ? body : JSON.stringify(body) }),
    });
  }
  async function bytes(account: Account, path: string): Promise<Buffer> {
    const response = await send(target(path), {
      headers: { Authorization: `Bearer ${await access(account.id)}`, Prefer: preferValue() },
    });
    if (!response.ok) {
      let body: Json | undefined;
      try {
        body = (await response.json()) as Json;
      } catch {
        /* Error bodies are optional. */
      }
      throw failure(response.status, body, response.headers.get('retry-after'));
    }
    try {
      return Buffer.from(await response.arrayBuffer());
    } catch {
      throw new MicrosoftError(
        'The connection to Microsoft dropped before it answered. Please retry.',
        undefined,
        true,
      );
    }
  }
  async function pages(
    account: Account,
    path: string,
    prefer?: string[],
    limit = Infinity,
  ): Promise<Json[]> {
    const items: Json[] = [];
    let next: string | undefined = path;
    for (let n = 0; next && n < limit; n++) {
      const page = await api(account, next, 'GET', undefined, prefer);
      items.push(...(Array.isArray(page.value) ? page.value : []));
      next = typeof page['@odata.nextLink'] === 'string' ? page['@odata.nextLink'] : undefined;
    }
    return items;
  }
  async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const result: R[] = new Array(items.length);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
          const at = cursor++;
          result[at] = await fn(items[at]);
        }
      }),
    );
    return result;
  }
  /** JSON batching: Graph accepts at most 20 requests per batch. Order of results matches `subs`. */
  async function batch(account: Account, subs: Sub[]): Promise<SubResult[]> {
    const chunks: Sub[][] = [];
    for (let i = 0; i < subs.length; i += 20) chunks.push(subs.slice(i, i + 20));
    const results = await pool(chunks, 3, async chunk => {
      const data = await api(account, '/$batch', 'POST', {
        requests: chunk.map((s, i) => ({
          id: String(i),
          method: s.method,
          url: s.url,
          headers: {
            Prefer: preferValue(s.prefer),
            ...(s.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(s.body === undefined ? {} : { body: s.body }),
        })),
      });
      const out: SubResult[] = new Array(chunk.length);
      for (const r of Array.isArray(data.responses) ? data.responses : []) {
        const at = Number(r.id);
        if (Number.isInteger(at) && at >= 0 && at < chunk.length)
          out[at] = {
            status: Number(r.status),
            body: r.body && typeof r.body === 'object' ? r.body : {},
            headers: r.headers ?? {},
          };
      }
      if (out.some(r => !r) || out.length !== chunk.length)
        throw new MicrosoftError(
          'Microsoft returned an incomplete batch response. Please retry.',
          undefined,
          true,
        );
      return out;
    });
    return results.flat();
  }
  const ok = (r: SubResult) => {
    if (r.status >= 200 && r.status < 300) return r.body;
    throw failure(r.status, r.body, r.headers['Retry-After'] ?? r.headers['retry-after']);
  };
  const missing = (r: SubResult) => r.status === 404;

  // Loaded fresh for every call rather than cached: memory is the only copy that a failed sync rolls back.
  const loadIndex = (account: Account): MailIndex => {
    const index = createIndex();
    index.load(memory.get(account, 'index'));
    return index;
  };
  const saveIndex = (account: Account, index: MailIndex) =>
    memory.set(account, 'index', index.dump());
  /** Well-known folder name → folder ID, for reading `parentFolderId`. */
  async function folderIds(account: Account, refresh = false): Promise<Record<string, string>> {
    if (!refresh) {
      try {
        const saved = JSON.parse(memory.get(account, 'folders') ?? '') as Record<string, string>;
        if (saved && typeof saved.inbox === 'string') return saved;
      } catch {
        /* Resolve again below. */
      }
    }
    const names = Object.keys(ROLES),
      results = await batch(
        account,
        names.map(name => ({ method: 'GET', url: `/me/mailFolders/${name}?$select=id` })),
      );
    const ids: Record<string, string> = {};
    results.forEach((r, i) => {
      if (missing(r)) return;
      const body = ok(r);
      if (typeof body.id === 'string') ids[names[i]] = body.id;
    });
    if (!ids.inbox) throw new Error('Outlook did not return an inbox for this account.');
    memory.set(account, 'folders', JSON.stringify(ids));
    return ids;
  }
  const folderName = (ids: Record<string, string>, parentFolderId: unknown) =>
    Object.entries(ids).find(([, id]) => id === parentFolderId)?.[0] ?? '';

  /** Full conversations, refreshing the index entries of every message they contain. */
  async function fullThreads(
    account: Account,
    conversations: string[],
    index: MailIndex,
  ): Promise<Map<string, Thread | undefined>> {
    const ids = await folderIds(account),
      result = new Map<string, Thread | undefined>();
    const responses = await batch(
      account,
      conversations.map(c => ({
        method: 'GET',
        url: `/me/messages?${q({ $filter: `conversationId eq ${quote(c)}`, $select: FULL, $top: '100' })}`,
      })),
    );
    const lists = await pool(responses, 4, async r => {
      const body = ok(r),
        items: Json[] = Array.isArray(body.value) ? body.value : [];
      if (typeof body['@odata.nextLink'] === 'string')
        items.push(...(await pages(account, body['@odata.nextLink'])));
      return items.filter(m => !m.isDraft && typeof m.id === 'string');
    });
    const all = lists.flat(),
      attachments = new Map<string, Attachment[]>();
    const withFiles = all.filter(
      m =>
        m.hasAttachments ||
        (m.body?.contentType === 'html' && /\bcid:/i.test(String(m.body.content ?? ''))),
    );
    const listed = await batch(
      account,
      withFiles.map(m => ({
        method: 'GET',
        url: `/me/messages/${enc(m.id)}/attachments?$select=id,name,contentType,size,isInline`,
      })),
    );
    const listings = await pool(listed, 4, async r => {
      if (missing(r)) return undefined;
      const body = ok(r),
        rows: Json[] = Array.isArray(body.value) ? [...body.value] : [];
      if (typeof body['@odata.nextLink'] === 'string')
        rows.push(
          ...(await pages(account, body['@odata.nextLink'], undefined, MAX_ATTACHMENT_PAGES)),
        );
      return rows;
    });
    const inline: { message: string; attachment: Attachment }[] = [];
    listings.forEach((listing, i) => {
      if (!listing) return;
      const message = String(withFiles[i].id);
      const rows = listing.filter(
        (a: Json) =>
          typeof a.id === 'string' && a['@odata.type'] !== '#microsoft.graph.referenceAttachment',
      );
      attachments.set(
        message,
        rows.map((a: Json) => {
          const attachment: Attachment = {
            id: `${message}:${a.id}`,
            name: String(a.name || 'attachment'),
            type: String(a.contentType || 'application/octet-stream'),
            size: Number(a.size) || 0,
            remoteId: a.id,
            messageId: message,
          };
          if (
            a.isInline &&
            attachment.size <= INLINE_LIMIT &&
            a['@odata.type'] !== '#microsoft.graph.itemAttachment'
          )
            inline.push({ message, attachment });
          return attachment;
        }),
      );
    });
    const bodies = await batch(
      account,
      inline.map(({ message, attachment }) => ({
        method: 'GET',
        url: `/me/messages/${enc(message)}/attachments/${enc(attachment.remoteId!)}`,
      })),
    );
    bodies.forEach((r, i) => {
      if (r.status === 429 || r.status >= 500) ok(r);
      if (r.status !== 200) return;
      const a = inline[i].attachment;
      if (typeof r.body.contentBytes === 'string') a.data = r.body.contentBytes;
      if (typeof r.body.contentId === 'string')
        a.contentId = r.body.contentId.replace(/^<|>$/g, '');
    });
    conversations.forEach((c, i) => {
      for (const [id] of index.entries(c)) index.delete(id);
      const rows = lists[i].map(message => ({
        message,
        folder: folderName(ids, message.parentFolderId),
        attachments: attachments.get(message.id),
      }));
      for (const row of rows) index.set(row.message.id, entryOf(row.message, row.folder, account));
      result.set(c, rows.length ? normalizeGraphConversation(c, rows, account) : undefined);
    });
    return result;
  }
  async function follow(
    account: Account,
    url: string,
  ): Promise<{ items: Json[]; link: string } | undefined> {
    const items: Json[] = [];
    let next = url;
    for (let page = 0; page < MAX_DELTA_PAGES; page++) {
      const data = await api(account, next, 'GET', undefined, [`odata.maxpagesize=${PAGE}`]);
      items.push(...(Array.isArray(data.value) ? data.value : []));
      if (typeof data['@odata.deltaLink'] === 'string')
        return { items, link: data['@odata.deltaLink'] };
      if (typeof data['@odata.nextLink'] !== 'string')
        throw new Error('Outlook ended a change list without a sync position. Please retry.');
      next = data['@odata.nextLink'];
    }
    return undefined;
  }
  async function freshWindow(account: Account, index: MailIndex): Promise<SyncResult> {
    const ids = await folderIds(account, true),
      tracked = TRACKED.filter(f => ids[f]);
    // Delta cannot be limited to the newest N, so find the date of the Nth newest message and start each folder's delta there.
    const newest = await batch(
      account,
      tracked.map(f => ({
        method: 'GET',
        url: `/me/mailFolders/${f}/messages?${q({ $top: String(INITIAL_MESSAGES), $orderby: 'receivedDateTime desc', $select: 'receivedDateTime' })}`,
      })),
    );
    const dates = newest
      .flatMap(r => (ok(r).value ?? []).map((m: Json) => String(m.receivedDateTime ?? '')))
      .filter(Boolean)
      .sort()
      .reverse();
    const cutoff =
      dates.length >= INITIAL_MESSAGES
        ? new Date(dates[INITIAL_MESSAGES - 1]).toISOString()
        : undefined;
    const links: Record<string, string> = {},
      conversations = new Set<string>();
    index.clear();
    for (const folder of tracked) {
      const round = await follow(
        account,
        `/me/mailFolders/${folder}/messages/delta?${q({ $select: LIGHT, $filter: cutoff ? `receivedDateTime ge ${cutoff}` : undefined })}`,
      );
      if (!round)
        throw new Error(
          'Outlook returned more mail than expected for the first sync. Please retry.',
        );
      links[folder] = round.link;
      for (const m of round.items)
        if (
          !m['@removed'] &&
          !m.isDraft &&
          typeof m.id === 'string' &&
          typeof m.conversationId === 'string'
        ) {
          index.set(m.id, entryOf(m, folder, account));
          conversations.add(m.conversationId);
        }
    }
    const threads = [...(await fullThreads(account, [...conversations], index)).values()]
      .filter((t): t is Thread => !!t)
      .sort((a, b) => b.date.localeCompare(a.date));
    return {
      threads,
      flags: [],
      removed: [],
      cursor: JSON.stringify({ v: 1, links }),
      reset: true,
    };
  }
  function parseCursor(cursor: string, tracked: string[]): Record<string, string> | undefined {
    try {
      const parsed = JSON.parse(cursor);
      const links = parsed?.v === 1 ? parsed.links : undefined;
      if (
        !links ||
        typeof links !== 'object' ||
        Object.keys(links).sort().join() !== [...tracked].sort().join()
      )
        return undefined;
      return Object.values(links).every(l => typeof l === 'string' && l.startsWith(`${graph}/`))
        ? (links as Record<string, string>)
        : undefined;
    } catch {
      return undefined;
    }
  }
  async function incremental(
    account: Account,
    cursor: string,
    context: SyncContext,
    index: MailIndex,
  ): Promise<SyncResult | undefined> {
    const ids = await folderIds(account),
      tracked = TRACKED.filter(f => ids[f]),
      links = parseCursor(cursor, tracked);
    if (!links) return undefined;
    const next: Record<string, string> = {},
      arrived = new Set<string>(),
      touched = new Set<string>(),
      removals: { id: string; folder: string }[] = [],
      unknown = new Set<string>();
    // Conversations that lost a message: their stored copy still shows it, so flags alone cannot describe them.
    const shrunk = new Set<string>();
    const changed = (previous: Entry | undefined, entry: Entry) => {
      if (!previous) {
        arrived.add(entry.c);
        return;
      }
      touched.add(entry.c);
      if (previous.c !== entry.c) {
        touched.add(previous.c);
        shrunk.add(previous.c);
        arrived.add(entry.c);
      }
    };
    const gone = (id: string, previous: Entry | undefined) => {
      if (!previous) return;
      index.delete(id);
      touched.add(previous.c);
      shrunk.add(previous.c);
    };
    for (const folder of tracked) {
      const round = await follow(account, links[folder]);
      if (!round) return undefined;
      next[folder] = round.link;
      for (const m of round.items) {
        if (typeof m.id !== 'string') continue;
        if (m['@removed']) {
          removals.push({ id: m.id, folder });
          continue;
        }
        if (m.isDraft) continue;
        const previous = index.get(m.id);
        if (!previous && typeof m.conversationId !== 'string') {
          unknown.add(m.id);
          continue;
        }
        const entry = entryOf(m, folder, account, previous);
        index.set(m.id, entry);
        changed(previous, entry);
      }
    }
    // A move reports @removed in the old folder and an addition in the new one; only removals not seen elsewhere need a lookup.
    const pending = [
      ...new Set([
        ...removals.filter(r => index.get(r.id)?.f === r.folder).map(r => r.id),
        ...unknown,
      ]),
    ];
    const lookups = await batch(
      account,
      pending.map(id => ({
        method: 'GET',
        url: `/me/messages/${enc(id)}?$select=${LIGHT},parentFolderId`,
      })),
    );
    lookups.forEach((r, i) => {
      const id = pending[i],
        previous = index.get(id);
      if (missing(r)) {
        gone(id, previous);
        return;
      }
      const m = ok(r);
      if (m.isDraft || typeof m.conversationId !== 'string') {
        gone(id, previous);
        return;
      }
      const entry = entryOf(m, folderName(ids, m.parentFolderId), account, previous);
      index.set(id, entry);
      changed(previous, entry);
    });
    const removed: string[] = [],
      flags: ThreadFlags[] = [],
      full: string[] = [];
    for (const c of new Set([...arrived, ...touched])) {
      const id = `${account.id}:${c}`,
        entries = index.entries(c).map(([, e]) => e);
      if (!entries.length) {
        if (context.has(id)) removed.push(id);
        continue;
      }
      if (arrived.has(c) || shrunk.has(c) || !context.has(id)) full.push(c);
      else flags.push(describe(account, c, entries));
    }
    const threads: Thread[] = [];
    for (const [c, thread] of await fullThreads(account, full, index)) {
      const id = `${account.id}:${c}`;
      if (!thread) {
        if (context.has(id)) removed.push(id);
        continue;
      }
      // A thread this device never stored only matters once it is in the inbox, unless it gained mail.
      if (arrived.has(c) || context.has(id) || thread.status === 'new') threads.push(thread);
    }
    return { threads, flags, removed, cursor: JSON.stringify({ v: 1, links: next }), reset: false };
  }
  /** Index entries for a conversation, asking Outlook when this device has not indexed it. */
  async function conversationEntries(
    account: Account,
    index: MailIndex,
    conversationId: string,
  ): Promise<(readonly [string, Entry])[]> {
    let entries = index.entries(conversationId);
    if (entries.length) return entries;
    const ids = await folderIds(account);
    for (const m of await pages(
      account,
      `/me/messages?${q({ $filter: `conversationId eq ${quote(conversationId)}`, $select: `${LIGHT},parentFolderId`, $top: '100' })}`,
    ))
      if (!m.isDraft && typeof m.id === 'string')
        index.set(m.id, entryOf(m, folderName(ids, m.parentFolderId), account));
    saveIndex(account, index);
    entries = index.entries(conversationId);
    return entries;
  }
  function destination(e: Entry, status: Thread['status'], inInbox: boolean): string | undefined {
    if (status === 'trash') return e.f === 'deleteditems' ? undefined : 'deleteditems';
    if (status === 'spam') return e.o || e.f === 'junkemail' ? undefined : 'junkemail';
    const parked = e.f === 'deleteditems' || e.f === 'junkemail';
    if (e.o && parked) return 'sentitems';
    if (e.f === 'sentitems') return undefined;
    if (inInbox) return parked || (status === 'new' && e.f === 'archive') ? 'inbox' : undefined;
    return parked || e.f === 'inbox' ? 'archive' : undefined;
  }
  function eventModel(raw: Json, account: Account, calendarId: string): CalendarEvent {
    const allDay = raw.isAllDay === true;
    const time = (value: Json | undefined) => {
      const text = String(value?.dateTime ?? '');
      if (!text) return '';
      if (allDay) return text.slice(0, 10);
      return new Date(/(?:Z|[+-]\d\d:\d\d)$/i.test(text) ? text : `${text}Z`).toISOString();
    };
    return {
      id: `${account.id}:${calendarId}:${raw.id}`,
      remoteId: raw.id,
      accountId: account.id,
      calendarId,
      title: raw.subject || '(Untitled event)',
      start: time(raw.start),
      end: time(raw.end),
      allDay,
      location: raw.location?.displayName ?? '',
      description:
        raw.body?.contentType === 'html'
          ? htmlText(String(raw.body.content ?? ''))
          : String(raw.body?.content ?? raw.bodyPreview ?? '').trim(),
      guests: (raw.attendees ?? []).map((a: Json) => a.emailAddress?.address).filter(Boolean),
      url: raw.webLink,
    };
  }
  async function listCalendars(account: Account): Promise<CalendarInfo[]> {
    return (
      await pages(account, '/me/calendars?$select=id,name,isDefaultCalendar,hexColor&$top=100')
    ).map(c => ({
      id: String(c.id),
      name: String(c.name ?? c.id),
      accountId: account.id,
      ...(calendarColor(c.hexColor) ? { color: calendarColor(c.hexColor) } : {}),
      ...(c.isDefaultCalendar === true ? { primary: true } : {}),
    }));
  }
  async function timeZone(account: Account): Promise<string> {
    let zone = zones.get(account.id);
    if (!zone) {
      try {
        const value = (await api(account, '/me/mailboxSettings/timeZone')).value;
        zone = typeof value === 'string' && value ? value : 'UTC';
      } catch {
        zone = 'UTC';
      }
      zones.set(account.id, zone);
    }
    return zone;
  }
  async function appFolder(account: Account, create: boolean): Promise<string | undefined> {
    const saved = memory.get(account, 'dataFolder');
    if (saved) return saved;
    // Only a hidden folder can be one Aplos created; a visible folder of the same name belongs to the user.
    const found = (
      await pages(
        account,
        '/me/mailFolders?includeHiddenFolders=true&$select=id,displayName,isHidden&$top=100',
      )
    ).find(f => f.displayName === APP_FOLDER && f.isHidden === true);
    let id = typeof found?.id === 'string' ? found.id : undefined;
    if (!id && create)
      id = String(
        (await api(account, '/me/mailFolders', 'POST', { displayName: APP_FOLDER, isHidden: true }))
          .id,
      );
    if (id) memory.set(account, 'dataFolder', id);
    return id;
  }
  /** Workflow records in the folder, newest first. The marker filter keeps any other message out. */
  async function appRecords(
    account: Account,
    folder: string,
  ): Promise<{ id: string; created: string }[]> {
    const rows = await pages(
      account,
      `/me/mailFolders/${enc(folder)}/messages?${q({ $filter: APP_FILTER, $select: 'id,createdDateTime', $top: '100' })}`,
    );
    return rows
      .filter(m => typeof m.id === 'string')
      .map(m => ({ id: String(m.id), created: String(m.createdDateTime ?? '') }))
      .sort((a, b) => b.created.localeCompare(a.created) || b.id.localeCompare(a.id));
  }
  /** Run an app-data step, forgetting a cached folder the user deleted and trying once more. */
  async function withAppFolder<T>(
    account: Account,
    create: boolean,
    fn: (folder: string | undefined) => Promise<T>,
  ): Promise<T> {
    try {
      return await fn(await appFolder(account, create));
    } catch (error) {
      if (
        !(error instanceof MicrosoftError && error.status === 404) ||
        !memory.get(account, 'dataFolder')
      )
        throw error;
      memory.set(account, 'dataFolder', undefined);
      return fn(await appFolder(account, create));
    }
  }
  async function findSent(
    account: Account,
    messageId: string,
  ): Promise<{ id: string; threadId: string } | undefined> {
    const id = `<${messageId.trim().replace(/^<|>$/g, '')}>`,
      query = q({
        $filter: `internetMessageId eq ${quote(id)}`,
        $select: 'id,conversationId',
        $top: '1',
      });
    for (const path of ['/me/mailFolders/sentitems/messages', '/me/messages']) {
      const found = (await api(account, `${path}?${query}`)).value?.[0];
      if (typeof found?.id === 'string' && typeof found.conversationId === 'string')
        return { id: found.id, threadId: found.conversationId };
    }
    return undefined;
  }
  /** In-Reply-To and References for a reply, from the newest synced message in the conversation. */
  async function replyHeaders(
    account: Account,
    conversationId: string | undefined,
    thread?: Thread,
  ): Promise<{ inReplyTo?: string; references?: string }> {
    let last = thread?.messages.filter(m => m.internetId).at(-1),
      graphId = last?.id,
      inReplyTo = last?.internetId,
      references = last?.references;
    try {
      if (!graphId && conversationId) {
        const rows = await pages(
          account,
          `/me/messages?${q({ $filter: `conversationId eq ${quote(conversationId)}`, $select: 'id,internetMessageId,receivedDateTime,isDraft', $top: '100' })}`,
        );
        const newest = rows
          .filter(m => !m.isDraft)
          .sort((a, b) => String(a.receivedDateTime).localeCompare(String(b.receivedDateTime)))
          .at(-1);
        graphId = newest?.id;
        inReplyTo = newest?.internetMessageId;
      }
      if (graphId && !references) {
        const raw = await api(
          account,
          `/me/messages/${enc(graphId)}?$select=internetMessageId,internetMessageHeaders`,
        );
        const header = (name: string) =>
          (raw.internetMessageHeaders ?? []).find(
            (h: Json) => String(h.name).toLowerCase() === name,
          )?.value as string | undefined;
        inReplyTo = raw.internetMessageId ?? inReplyTo;
        references = header('references');
      }
    } catch {
      /* Threading headers are best effort; the reply still sends. */
    }
    return {
      inReplyTo,
      references: [references, inReplyTo].filter(Boolean).join(' ') || undefined,
    };
  }

  return {
    kind: 'microsoft',
    available: Boolean(clientId),
    unavailableReason: clientId ? undefined : microsoftUnavailable,
    capabilities: () => CAPABILITIES,
    async getSendAs(account: Account) {
      return [{ email: account.email, name: account.name, signature: '', isDefault: true }];
    },
    async connect(_request?: ConnectRequest): Promise<Account> {
      if (!clientId) throw new Error(microsoftUnavailable);
      if (!vault.secure)
        throw new Error('Secure credential storage is unavailable. Connect using the desktop app.');
      if (!options.openExternal)
        throw new Error('Microsoft sign-in requires the desktop app and a system browser.');
      if (servers.length) throw new Error('A Microsoft sign-in is already in progress.');
      const state = randomBytes(32).toString('base64url'),
        verifier = randomBytes(48).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      let resolveCode!: (code: string) => void, rejectCode!: (error: Error) => void;
      const codePromise = new Promise<string>((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
      });
      // Attach rejection handling before opening a browser, which may itself fail.
      void codePromise.catch(() => {});
      const handle = (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (
          url.pathname !== '/' ||
          (!url.searchParams.has('state') && !url.searchParams.has('error'))
        ) {
          res.writeHead(404);
          res.end();
          return;
        }
        if (url.searchParams.get('state') !== state) {
          res.writeHead(400);
          res.end('Invalid sign-in state.');
          return;
        }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        const code = url.searchParams.get('code');
        if (url.searchParams.has('error') || !code) {
          res.end('<p>Sign-in canceled. Return to Aplos Mail.</p>');
          rejectCode(new Error('Microsoft sign-in was declined.'));
          return;
        }
        res.end('<p>Sign-in received. You can close this tab and return to Aplos Mail.</p>');
        resolveCode(code);
      };
      const v4 = createServer(handle);
      servers = [v4];
      cancelConnect = () => rejectCode(new Error('Microsoft sign-in cancelled.'));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          v4.once('error', reject);
          v4.listen(0, '127.0.0.1', () => resolve());
        });
        const address = v4.address();
        if (!address || typeof address === 'string')
          throw new Error('Microsoft sign-in could not open its local callback.');
        // Entra only ignores the port for `localhost` redirect URIs, and browsers may resolve it to ::1 first.
        const v6 = createServer(handle);
        await new Promise<void>(resolve => {
          v6.once('error', () => resolve());
          v6.listen(address.port, '::1', () => {
            servers.push(v6);
            resolve();
          });
        });
        const redirect = `http://localhost:${address.port}`;
        timer = setTimeout(
          () => rejectCode(new Error('Microsoft sign-in timed out. Please try again.')),
          options.oauthTimeoutMs ?? 180000,
        );
        const auth = new URL(`${login}/authorize`);
        auth.search = new URLSearchParams({
          client_id: clientId,
          response_type: 'code',
          redirect_uri: redirect,
          response_mode: 'query',
          scope: SCOPES,
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          prompt: 'select_account',
        }).toString();
        await options.openExternal(auth.toString());
        const code = await codePromise;
        const result = await tokenRequest({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirect,
          code_verifier: verifier,
        });
        if (typeof result.access_token !== 'string')
          throw new Error('Microsoft sign-in did not return access credentials.');
        const me = await fetchJson(`${graph}/me?$select=id,displayName,mail,userPrincipalName`, {
          headers: { Authorization: `Bearer ${result.access_token}` },
        });
        const email = typeof me.mail === 'string' && me.mail ? me.mail : me.userPrincipalName;
        if (typeof me.id !== 'string' || typeof email !== 'string' || !email)
          throw new Error('Microsoft did not return an account identity.');
        const id = `microsoft-${me.id}`;
        await vault.set(id, {
          access_token: result.access_token,
          refresh_token: result.refresh_token ?? vault.get(id)?.refresh_token,
          expiresAt: Date.now() + (Number(result.expires_in) || 3600) * 1000,
        });
        const name = typeof me.displayName === 'string' && me.displayName ? me.displayName : email;
        return {
          id,
          name,
          email,
          provider: 'microsoft',
          preset: 'outlook',
          capabilities: CAPABILITIES,
          color: '#4f7cac',
          connected: true,
          calendarConnected: true,
          sendAs: [{ email, name, signature: '', isDefault: true }],
        };
      } finally {
        if (timer) clearTimeout(timer);
        for (const s of servers) s.close();
        servers = [];
        cancelConnect = undefined;
      }
    },
    // Microsoft has no token revocation endpoint for this flow; forgetting the tokens locally is the disconnect.
    async disconnect(accountId: string) {
      await vault.delete(accountId);
      options.memory?.clear(accountId);
      zones.delete(accountId);
    },
    async sync(
      account: Account,
      cursor?: string,
      context: SyncContext = { has: () => false },
    ): Promise<SyncResult> {
      // The index is saved only alongside a complete result, so a failed round replays from the old cursor with the old index.
      const index = loadIndex(account);
      let result: SyncResult | undefined;
      if (cursor) {
        try {
          result = await incremental(account, cursor, context, index);
        } catch (error) {
          if (!(error instanceof MicrosoftError && (error.status === 410 || error.status === 404)))
            throw error;
        }
      }
      result ??= await freshWindow(account, index);
      saveIndex(account, index);
      return result;
    },
    async search(account: Account, query: string): Promise<Thread[]> {
      const rows =
        (
          await api(
            account,
            `/me/messages?${q({ $search: `"${query.replace(/["\\]/g, ' ').trim()}"`, $top: String(SEARCH_MESSAGES), $select: 'id,conversationId,isDraft,parentFolderId' })}`,
          )
        ).value ?? [];
      const hidden = memory.get(account, 'dataFolder');
      const conversations = [
        ...new Set<string>(
          rows
            .filter(
              (m: Json) =>
                !m.isDraft &&
                typeof m.conversationId === 'string' &&
                (!hidden || m.parentFolderId !== hidden),
            )
            .map((m: Json) => m.conversationId),
        ),
      ];
      // Search results stay out of the index: a message indexed here would look already delivered to the next sync.
      return [...(await fullThreads(account, conversations, createIndex())).values()]
        .filter((t): t is Thread => !!t)
        .sort((a, b) => b.date.localeCompare(a.date));
    },
    async updateThread(account: Account, thread: RemoteThread, patch: Partial<Thread>) {
      if (!thread.remoteId) throw new Error('This thread has no Outlook identifier.');
      const index = loadIndex(account);
      let entries = await conversationEntries(account, index, thread.remoteId);
      if (!entries.length)
        throw new MicrosoftError('Outlook could not find this conversation.', 404);
      if (patch.status) {
        const inInbox = patch.labels ? patch.labels.includes('INBOX') : patch.status === 'new';
        const moves = entries
          .map(([id, e]) => ({ id, e, to: destination(e, patch.status!, inInbox) }))
          .filter((m): m is { id: string; e: Entry; to: string } => !!m.to);
        const results = await batch(
          account,
          moves.map(m => ({
            method: 'POST',
            url: `/me/messages/${enc(m.id)}/move`,
            body: { destinationId: m.to },
          })),
        );
        try {
          results.forEach((r, i) => {
            const { id, e, to } = moves[i];
            if (missing(r)) {
              index.delete(id);
              return;
            }
            const body = ok(r),
              next = typeof body.id === 'string' ? body.id : id;
            index.delete(id);
            index.set(next, { ...e, f: to });
          });
        } finally {
          saveIndex(account, index);
        }
        entries = index.entries(thread.remoteId);
      }
      const latest = (list: typeof entries) => {
        const inbound = list.filter(([, e]) => !e.o);
        return [...(inbound.length ? inbound : list)]
          .sort((a, b) => a[1].d.localeCompare(b[1].d))
          .at(-1);
      };
      const changes: { id: string; body: Json; apply: (e: Entry) => Entry }[] = [];
      if (patch.unread === false)
        for (const [id, e] of entries)
          if (!e.r) changes.push({ id, body: { isRead: true }, apply: x => ({ ...x, r: true }) });
      if (patch.unread === true) {
        const last = latest(entries);
        if (last && last[1].r)
          changes.push({ id: last[0], body: { isRead: false }, apply: x => ({ ...x, r: false }) });
      }
      if (patch.bookmarked === false)
        for (const [id, e] of entries)
          if (e.g)
            changes.push({
              id,
              body: { flag: { flagStatus: 'notFlagged' } },
              apply: x => ({ ...x, g: false }),
            });
      if (patch.bookmarked === true && !entries.some(([, e]) => e.g)) {
        const last = latest(entries);
        if (last)
          changes.push({
            id: last[0],
            body: { flag: { flagStatus: 'flagged' } },
            apply: x => ({ ...x, g: true }),
          });
      }
      if (!changes.length) return;
      const results = await batch(
        account,
        changes.map(c => ({ method: 'PATCH', url: `/me/messages/${enc(c.id)}`, body: c.body })),
      );
      try {
        results.forEach((r, i) => {
          const { id, apply } = changes[i];
          if (missing(r)) {
            index.delete(id);
            return;
          }
          ok(r);
          const e = index.get(id);
          if (e) index.set(id, apply(e));
        });
      } finally {
        saveIndex(account, index);
      }
    },
    async send(account: Account, draft: Draft, thread?: Thread) {
      if (!draft.to.trim()) throw new Error('Add at least one recipient before sending.');
      const fromEmail = draft.fromEmail ?? account.email;
      for (const value of [draft.to, draft.cc, draft.bcc, draft.subject, fromEmail])
        if (/[\r\n]/.test(value)) throw new Error('Email headers cannot contain line breaks.');
      if (fromEmail.toLowerCase() !== account.email.toLowerCase())
        throw new Error('Outlook accounts can only send from their primary address.');
      let conversationId: string | undefined,
        threading: { inReplyTo?: string; references?: string } = {};
      if (draft.threadId && draft.mode !== 'new' && draft.mode !== 'forward') {
        conversationId =
          thread?.remoteId ??
          (draft.threadId.startsWith(`${account.id}:`)
            ? draft.threadId.slice(account.id.length + 1)
            : undefined);
        threading = await replyHeaders(account, conversationId, thread);
      }
      const transport = nodemailer.createTransport({
        streamTransport: true,
        buffer: true,
        newline: 'windows',
      });
      const info = await transport.sendMail({
        ...(draft.messageId ? { messageId: draft.messageId } : {}),
        from: { name: account.name, address: account.email },
        to: draft.to,
        cc: draft.cc || undefined,
        bcc: draft.bcc || undefined,
        subject: draft.subject,
        html: draft.html,
        text: htmlText(draft.html),
        ...threading,
        attachments: draft.attachments.map(a => {
          if (!a.data)
            throw new Error(
              `Attachment "${a.name}" has not been downloaded. Reattach it before sending.`,
            );
          return {
            filename: a.name,
            content: Buffer.from(a.data, 'base64'),
            contentType: a.type,
            cid: a.contentId,
          };
        }),
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      if (!Buffer.isBuffer(info.message))
        throw new Error('Email could not be encoded for Outlook.');
      const raw = info.message.toString('base64');
      if (raw.length > MAX_SEND_BASE64)
        throw new Error(
          'Outlook accepts messages up to about 3 MB from Aplos. Remove or shrink attachments and try again.',
        );
      // MIME sendMail keeps our Message-ID as internetMessageId, which is what findSent looks for after an unknown outcome.
      await api(account, '/me/sendMail', 'POST', raw);
      let found: { id: string; threadId: string } | undefined;
      try {
        found = await findSent(account, info.messageId);
      } catch {
        /* Sent; the copy in Sent Items may not be visible yet. */
      }
      return found ?? (conversationId ? { threadId: conversationId } : {});
    },
    findSent,
    async attachment(
      account: Account,
      _thread: Thread,
      attachment: Attachment,
    ): Promise<Attachment> {
      if (attachment.data) return attachment;
      if (!attachment.remoteId || !attachment.messageId)
        throw new Error('This attachment has no downloadable content.');
      const data = await bytes(
        account,
        `/me/messages/${enc(attachment.messageId)}/attachments/${enc(attachment.remoteId)}/$value`,
      );
      return { ...attachment, data: data.toString('base64'), size: attachment.size || data.length };
    },
    listCalendars,
    async listEvents(account: Account): Promise<CalendarEvent[]> {
      const min = new Date();
      min.setDate(min.getDate() - 30);
      const max = new Date();
      max.setFullYear(max.getFullYear() + 1);
      const result: CalendarEvent[] = [];
      for (const c of await listCalendars(account)) {
        const rows = await pages(
          account,
          `/me/calendars/${enc(c.id)}/calendarView?${q({ startDateTime: min.toISOString(), endDateTime: max.toISOString(), $select: 'id,subject,start,end,isAllDay,location,body,attendees,webLink,isCancelled', $top: '200' })}`,
          ['outlook.timezone="UTC"', 'outlook.body-content-type="text"'],
        );
        result.push(
          ...rows.filter(row => !row.isCancelled).map(row => eventModel(row, account, c.id)),
        );
      }
      return result;
    },
    async saveEvent(account: Account, event: CalendarEvent): Promise<CalendarEvent> {
      if (
        !event.title.trim() ||
        !Number.isFinite(Date.parse(event.start)) ||
        !Number.isFinite(Date.parse(event.end)) ||
        Date.parse(event.end) <= Date.parse(event.start)
      )
        throw new Error('A calendar event needs a title and valid start and end times.');
      const zone = event.allDay ? await timeZone(account) : 'UTC';
      const when = (value: string) =>
        event.allDay
          ? { dateTime: `${value.slice(0, 10)}T00:00:00`, timeZone: zone }
          : { dateTime: new Date(value).toISOString().replace(/Z$/, ''), timeZone: 'UTC' };
      const calendarId = event.calendarId || 'primary';
      const path = event.remoteId
        ? `/me/events/${enc(event.remoteId)}`
        : calendarId === 'primary'
          ? '/me/calendar/events'
          : `/me/calendars/${enc(calendarId)}/events`;
      const raw = await api(
        account,
        path,
        event.remoteId ? 'PATCH' : 'POST',
        {
          subject: event.title,
          body: { contentType: 'text', content: event.description },
          location: { displayName: event.location },
          isAllDay: event.allDay,
          start: when(event.start),
          end: when(event.end),
          attendees: event.guests.map(address => ({ emailAddress: { address }, type: 'required' })),
        },
        ['outlook.timezone="UTC"', 'outlook.body-content-type="text"'],
      );
      return { ...event, ...eventModel(raw, account, calendarId), id: event.id };
    },
    async deleteEvent(account: Account, event: CalendarEvent) {
      if (!event.remoteId) throw new Error('This event has no Outlook identifier.');
      await api(account, `/me/events/${enc(event.remoteId)}`, 'DELETE');
    },
    async readAppData(account: Account): Promise<AppDataRecord[]> {
      return withAppFolder(account, false, async folder => {
        if (!folder) return [];
        const copies = await pool(
          await appRecords(account, folder),
          4,
          async ({ id }): Promise<AppDataRecord | undefined> => {
            let rows: Json[];
            try {
              rows = (await api(account, `/me/messages/${enc(id)}/attachments`)).value ?? [];
            } catch (error) {
              // Another device replaced this copy after it was listed.
              if (error instanceof MicrosoftError && error.status === 404) return undefined;
              throw error;
            }
            const file = rows.find(a => a.name === APP_FILE && typeof a.contentBytes === 'string');
            return file
              ? { id, data: Buffer.from(file.contentBytes, 'base64').toString('utf8') }
              : undefined;
          },
        );
        return copies.filter((c): c is AppDataRecord => !!c);
      });
    },
    async writeAppData(account: Account, data: string, replaces: string[]) {
      const content = Buffer.from(data, 'utf8').toString('base64');
      if (content.length > MAX_APP_DATA)
        throw new Error('Workflow data is too large to sync through Outlook.');
      await withAppFolder(account, true, async folder => {
        const created = await api(account, `/me/mailFolders/${enc(folder!)}/messages`, 'POST', {
          subject: 'Aplos Mail private data',
          body: { contentType: 'text', content: 'Private Aplos Mail data. Do not edit.' },
          singleValueExtendedProperties: [{ id: APP_PROPERTY, value: APP_MARK }],
          attachments: [
            {
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: APP_FILE,
              contentType: 'application/octet-stream',
              contentBytes: content,
            },
          ],
        });
        if (!replaces.length) return;
        const ours = new Set((await appRecords(account, folder!)).map(r => r.id));
        const old = [...new Set(replaces)].filter(id => id !== created.id && ours.has(id));
        // A copy left behind is read and merged again next round, so failed deletes need no retry here.
        try {
          await batch(
            account,
            old.map(id => ({ method: 'DELETE', url: `/me/messages/${enc(id)}` })),
          );
        } catch {
          /* See above. */
        }
      });
    },
    close() {
      cancelConnect?.();
      for (const s of servers) s.close();
    },
  };
}
