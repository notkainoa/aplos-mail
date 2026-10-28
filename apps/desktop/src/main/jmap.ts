import { randomUUID } from 'node:crypto';
import type { Account, Attachment, Draft, Message, Thread } from '@aplos/contract/legacy/types';
import {
  ProviderError,
  type AppDataRecord,
  type CalendarBackend,
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

type Json = Record<string, any>;
type Call = [name: string, args: Json, id: string];
/** `type` carries the JMAP error type (for example `cannotCalculateChanges`) when the server named one. */
export class JmapError extends ProviderError {
  constructor(
    message: string,
    status?: number,
    uncertain = false,
    readonly type?: string,
  ) {
    super(message, status, uncertain);
  }
}
export type JmapOptions = ProviderEnvironment<Buffer> & { calendar?: CalendarBackend };
export type JmapAdapter = MailProvider &
  Required<Pick<MailProvider, 'getSendAs' | 'readAppData' | 'writeAppData'>>;
export const JMAP_PRESETS = {
  fastmail: {
    sessionUrl: 'https://api.fastmail.com/jmap/session',
    tokenUrl: 'https://app.fastmail.com/settings/security',
    help: 'In Fastmail open Settings → Privacy & Security → Connected apps & API tokens → Manage API tokens → New API token. Choose the JMAP type with the Email and Email submission scopes, then paste the token here. API tokens are not available on Basic plans.',
  },
} as const;
const CORE = 'urn:ietf:params:jmap:core',
  MAIL = 'urn:ietf:params:jmap:mail',
  SUBMISSION = 'urn:ietf:params:jmap:submission';
// Fastmail API tokens do not reach CalDAV, and JMAP calendars are not standardized yet.
const CAPABILITIES: ProviderCapabilities = {
  labels: false,
  importance: false,
  aliases: true,
  signatures: true,
  calendar: false,
  serverSearch: true,
};
/** Threads fetched on a first sync, newest first. Older mail is reached through search. */
export const INITIAL_THREADS = 500;
const SEARCH_THREADS = 100;
/** Change pages to follow before a fresh window is cheaper than replaying changes. */
const MAX_CHANGE_PAGES = 20;
const MAX_CHANGES = 500;
const BODY_BYTES = 1_000_000;
const EMAILS_PER_GET = 50;
/** A name users are unlikely to have chosen, so the data copies do not land in the user's own "Aplos" folder. */
const APP_MAILBOX = 'Aplos Mail Data';
/** Marks the emails Aplos stores its workflow data in; a user folder named "Aplos" may hold the user's own mail. */
const APP_KEYWORD = 'aplos-app-data';
const APP_COPIES = 20;
/** Copies of one Message-ID to inspect when reconciling a send (Sent copy, self-addressed copy, leftovers). */
const SEND_COPIES = 20;
const MAX_REDIRECTS = 3;
const ROLE_LABELS: Record<string, string> = {
  inbox: 'INBOX',
  archive: 'ARCHIVE',
  sent: 'SENT',
  trash: 'TRASH',
  junk: 'SPAM',
  drafts: 'DRAFTS',
};
const MAILBOX = ['id', 'name', 'role', 'parentId'];
const LIGHT = ['id', 'threadId', 'mailboxIds', 'keywords', 'from', 'receivedAt'];
const FULL = [
  ...LIGHT,
  'to',
  'cc',
  'subject',
  'messageId',
  'references',
  'preview',
  'textBody',
  'htmlBody',
  'bodyValues',
  'attachments',
];
const BODIES = {
  properties: FULL,
  fetchHTMLBodyValues: true,
  fetchTextBodyValues: true,
  maxBodyValueBytes: BODY_BYTES,
};
const COPY = ['id', 'threadId', 'mailboxIds', 'keywords'];

interface Credential {
  token: string;
  sessionUrl: string;
}
interface Session {
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  accountId: string;
  state: string;
  username: string;
  maxGet: number;
  stale?: boolean;
}
interface Mailboxes {
  role(role: string): string | undefined;
  label(id: string): string | undefined;
  aplos?: string;
  list: Json[];
}
interface Cursor {
  email: string;
  thread: string;
}

const enc = encodeURIComponent;
const bare = (id: string) => id.trim().replace(/^<|>$/g, '');
const jmapDate = (date = new Date()) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
function parseAddress(value: string) {
  const match = value.match(/^(.*?)\s*<([^<>]+)>\s*$/);
  return match
    ? { email: match[2].trim(), name: match[1].replace(/^"|"$/g, '').trim() }
    : { email: value.trim(), name: '' };
}
const parseAddresses = (value: string) =>
  value
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map(parseAddress)
    .filter(a => a.email);
function htmlText(html: string) {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}
const textHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');
function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
async function each<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, items.length) }, async () => {
      while (cursor < items.length) {
        const at = cursor++;
        result[at] = await fn(items[at]);
      }
    }),
  );
  return result;
}

/** Map a JMAP method error or SetError to a ProviderError the engine understands. */
export function jmapError(error: Json | undefined): JmapError {
  const type = String(error?.type ?? 'serverFail'),
    detail = typeof error?.description === 'string' ? ` ${error.description}` : '';
  switch (type) {
    case 'serverUnavailable':
    case 'serverFail':
    case 'serverPartialFail':
      return new JmapError(
        'The mail server could not finish this request. Please retry.',
        503,
        true,
        type,
      );
    case 'forbidden':
    case 'accountReadOnly':
      return new JmapError(
        'The API token does not allow this change. Reconnect with Email and Email submission access.',
        403,
        false,
        type,
      );
    case 'accountNotFound':
    case 'accountNotSupportedByMethod':
      return new JmapError(
        'This mail account is no longer available. Reconnect it.',
        401,
        false,
        type,
      );
    case 'cannotCalculateChanges':
      return new JmapError(
        'The mail server can no longer list changes since the last sync.',
        410,
        false,
        type,
      );
    case 'stateMismatch':
      return new JmapError(
        'The mailbox changed during the update. Please retry.',
        409,
        false,
        type,
      );
    case 'notFound':
      return new JmapError('The mail server could not find this item.', 404, false, type);
    case 'rateLimit':
      return new JmapError(
        'The mail server sending limit was reached. Please retry later.',
        429,
        false,
        type,
      );
    case 'overQuota':
      return new JmapError('The mailbox is over its storage or sending quota.', 507, false, type);
    case 'tooLarge':
    case 'requestTooLarge':
    case 'tooManyChanges':
      return new JmapError(
        'This message or request is larger than the mail server allows.',
        413,
        false,
        type,
      );
    case 'forbiddenFrom':
      return new JmapError(
        'The mail server does not allow sending from this address.',
        403,
        false,
        type,
      );
    case 'forbiddenToSend':
      return new JmapError('This account is not allowed to send mail right now.', 403, false, type);
    case 'noRecipients':
    case 'invalidRecipients':
    case 'tooManyRecipients':
      return new JmapError(`The mail server rejected the recipients.${detail}`, 400, false, type);
    default:
      return new JmapError(
        `The mail server rejected the request (${type}).${detail}`,
        400,
        false,
        type,
      );
  }
}
/** Response arguments for a call ID; a method error becomes a JmapError. */
function pick(responses: any[], id: string, name?: string): Json {
  const found = responses.find(
    r => Array.isArray(r) && r[2] === id && (!name || r[0] === name || r[0] === 'error'),
  );
  if (!found)
    throw new JmapError(
      'The mail server returned an incomplete response. Please retry.',
      undefined,
      true,
    );
  if (found[0] === 'error') throw jmapError(found[1]);
  return found[1] ?? {};
}
function mailboxes(list: Json[]): Mailboxes {
  const aplos = list.find(m => m.name === APP_MAILBOX && !m.parentId && !m.role)?.id;
  const byId = new Map(list.map(m => [m.id, m]));
  return {
    list,
    aplos,
    role: role => list.find(m => m.role === role)?.id,
    label: id => {
      const box = byId.get(id);
      if (!box) return undefined;
      return ROLE_LABELS[box.role] ?? box.name;
    },
  };
}
/** Throws unless the URL is https without embedded credentials, so the bearer token never travels in clear text. */
function secure(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new JmapError('The mail server sent an invalid address.', 400);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new JmapError(
      'The mail server sent an address that does not use a secure https connection.',
      400,
    );
  return parsed;
}
const filed = (drafts: string, sent: string) => ({
  [`mailboxIds/${drafts}`]: null,
  [`mailboxIds/${sent}`]: true,
  'keywords/$draft': null,
});

export async function createJmap(options: JmapOptions): Promise<JmapAdapter> {
  const request = options.fetch ?? fetch;
  const vault = await createVault<Credential>({
    dataDir: options.dataDir,
    encrypt: options.encrypt,
    decrypt: options.decrypt,
    file: 'jmap-credentials.enc.json',
  });
  const sessions = new Map<string, Session>();

  async function http(url: string, init: RequestInit = {}): Promise<Response> {
    let response: Response,
      href = url,
      from = secure(url),
      current: RequestInit = {
        ...init,
        redirect: 'manual',
        signal: init.signal ?? AbortSignal.timeout(45000),
      };
    for (let hop = 0; ; hop++) {
      try {
        response = await request(href, current);
      } catch {
        throw new JmapError(
          'The mail server could not be reached. Check your internet connection.',
          undefined,
          true,
        );
      }
      if (response.type === 'opaqueredirect')
        throw new JmapError(
          'The mail server redirected the request to an address that cannot be checked.',
          400,
        );
      const location =
        response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      if (!location) break;
      if (hop >= MAX_REDIRECTS)
        throw new JmapError('The mail server redirected the request too many times.', 400);
      const to = secure(new URL(location, href).href),
        headers = new Headers(current.headers),
        method = String(current.method ?? 'GET').toUpperCase();
      // Matches fetch's own redirect rules: credentials stay with their origin, and 301/302 after POST and 303 become GET.
      if (to.origin !== from.origin) headers.delete('authorization');
      if (
        (response.status === 303 && method !== 'HEAD') ||
        ((response.status === 301 || response.status === 302) && method === 'POST')
      ) {
        headers.delete('content-type');
        current = { ...current, method: 'GET', body: undefined };
      }
      current = { ...current, headers };
      href = to.href;
      from = to;
      await response.body?.cancel().catch(() => undefined);
    }
    if (response.ok) return response;
    const status = response.status;
    if (status === 401 || status === 403)
      throw new JmapError(
        'The mail server rejected the API token. Create a token with Email and Email submission access and reconnect this account.',
        status,
      );
    if (status === 429)
      throw new JmapError('The mail server rate limit was reached. Please retry shortly.', status);
    if (status === 404) throw new JmapError('The mail server could not find this item.', status);
    if (status >= 500)
      throw new JmapError(`The mail server failed (${status}). Please retry.`, status, true);
    let problem: Json = {};
    try {
      problem = (await response.json()) as Json;
    } catch {
      /* Problem details are optional. */
    }
    const type =
      typeof problem.type === 'string'
        ? problem.type.replace('urn:ietf:params:jmap:error:', '')
        : undefined;
    throw new JmapError(
      type === 'limit'
        ? 'This request is larger than the mail server allows.'
        : type === 'unknownCapability'
          ? 'This server does not support JMAP mail.'
          : `The mail server refused the request (${status}).`,
      status,
      false,
      type,
    );
  }
  async function json(response: Response): Promise<Json> {
    try {
      return (await response.json()) as Json;
    } catch {
      throw new JmapError(
        'The mail server returned an unreadable response. Please retry.',
        undefined,
        true,
      );
    }
  }
  const auth = (credential: Credential) => ({ Authorization: `Bearer ${credential.token}` });
  async function loadSession(credential: Credential): Promise<Session> {
    const raw = await json(
      await http(credential.sessionUrl, {
        headers: { ...auth(credential), Accept: 'application/json' },
      }),
    );
    const capabilities = raw.capabilities ?? {},
      accountId = raw.primaryAccounts?.[MAIL];
    if (!capabilities[CORE] || !capabilities[MAIL] || typeof accountId !== 'string')
      throw new JmapError('This server does not offer JMAP mail for this token.', 400);
    if (
      !capabilities[SUBMISSION] ||
      (raw.primaryAccounts?.[SUBMISSION] && raw.primaryAccounts[SUBMISSION] !== accountId)
    )
      throw new JmapError(
        'This API token cannot send mail. Create a token with the Email and Email submission scopes and reconnect.',
        403,
      );
    if (
      typeof raw.apiUrl !== 'string' ||
      typeof raw.downloadUrl !== 'string' ||
      typeof raw.uploadUrl !== 'string'
    )
      throw new JmapError('The JMAP session is missing its API addresses.', 400);
    // URL templates contain braces that new URL() would percent-encode, so only relative paths are resolved.
    const absolute = (url: string) => {
      const value = /^[a-z][a-z\d+.-]*:/i.test(url)
        ? url
        : `${new URL(credential.sessionUrl).origin}${url.startsWith('/') ? '' : '/'}${url}`;
      secure(value);
      return value;
    };
    return {
      apiUrl: absolute(raw.apiUrl),
      downloadUrl: absolute(raw.downloadUrl),
      uploadUrl: absolute(raw.uploadUrl),
      accountId,
      state: String(raw.state ?? ''),
      username: String(raw.username ?? ''),
      maxGet: Math.max(1, Number(capabilities[CORE].maxObjectsInGet) || 500),
    };
  }
  function credential(accountId: string): Credential {
    const value = vault.get(accountId);
    if (!value) throw new JmapError('This mail account needs to be reconnected.', 401);
    return value;
  }
  async function session(accountId: string, value = credential(accountId)): Promise<Session> {
    const cached = sessions.get(accountId);
    if (cached && !cached.stale) return cached;
    const fresh = await loadSession(value);
    sessions.set(accountId, fresh);
    return fresh;
  }
  async function invoke(value: Credential, current: Session, calls: Call[]): Promise<any[]> {
    const body = {
      using: [CORE, MAIL, SUBMISSION],
      methodCalls: calls.map(([name, args, id]) => [
        name,
        { accountId: current.accountId, ...args },
        id,
      ]),
    };
    const raw = await json(
      await http(current.apiUrl, {
        method: 'POST',
        headers: { ...auth(value), 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    if (typeof raw.sessionState === 'string' && raw.sessionState !== current.state)
      current.stale = true;
    if (!Array.isArray(raw.methodResponses))
      throw new JmapError(
        'The mail server returned an unreadable response. Please retry.',
        undefined,
        true,
      );
    return raw.methodResponses;
  }
  const api = async (account: Account, calls: Call[]) =>
    invoke(credential(account.id), await session(account.id), calls);
  const maxGet = async (account: Account) =>
    Math.min((await session(account.id)).maxGet, EMAILS_PER_GET);
  /** Email/get in batches the server accepts; `size` defaults to the session limit. */
  async function getEmails(
    account: Account,
    ids: string[],
    args: Json,
    size?: number,
  ): Promise<Json[]> {
    const limit = size ?? (await session(account.id)).maxGet;
    return (
      await each(
        chunks([...new Set(ids)], limit),
        async batch =>
          pick(await api(account, [['Email/get', { ids: batch, ...args }, 'e']]), 'e').list ?? [],
      )
    ).flat();
  }
  /** Thread/get in batches the server accepts. */
  async function getThreads(
    account: Account,
    ids: string[],
  ): Promise<{ rows: Json[]; notFound: string[] }> {
    const rows: Json[] = [],
      notFound: string[] = [];
    for (const batch of chunks([...new Set(ids)], (await session(account.id)).maxGet)) {
      const t = pick(await api(account, [['Thread/get', { ids: batch }, 't']]), 't');
      rows.push(...(t.list ?? []));
      notFound.push(...(t.notFound ?? []));
    }
    return { rows, notFound };
  }

  async function getMailboxes(account: Account): Promise<Mailboxes> {
    return mailboxes(
      pick(await api(account, [['Mailbox/get', { properties: MAILBOX }, 'm']]), 'm').list ?? [],
    );
  }
  async function ensureMailbox(
    account: Account,
    boxes: Mailboxes,
    role: string | undefined,
    name: string,
    extra: Json = {},
  ): Promise<string> {
    const existing = role ? boxes.role(role) : undefined;
    if (existing) return existing;
    const named = boxes.list.find(
      m => !m.parentId && String(m.name).toLowerCase() === name.toLowerCase() && (role || !m.role),
    );
    if (named) return named.id;
    const create = async (withRole: boolean) =>
      pick(
        await api(account, [
          [
            'Mailbox/set',
            {
              create: {
                box: { name, parentId: null, ...(withRole && role ? { role } : {}), ...extra },
              },
            },
            'c',
          ],
        ]),
        'c',
      );
    let result = await create(true);
    // Some servers do not let clients assign roles; a plain mailbox with the same name still works.
    if (!result.created?.box && role) result = await create(false);
    const id = result.created?.box?.id;
    if (typeof id !== 'string') throw jmapError(result.notCreated?.box);
    boxes.list.push({ id, name, role: role ?? null, parentId: null });
    return id;
  }
  function own(account: Account) {
    return new Set(
      [account.email, ...(account.sendAs ?? []).map(a => a.email)].map(e => e.toLowerCase()),
    );
  }
  const visible = (e: Json) => !e.keywords?.$draft && !e.keywords?.[APP_KEYWORD];
  function isSent(account: Account, boxes: Mailboxes, e: Json) {
    const sent = boxes.role('sent'),
      inbox = boxes.role('inbox');
    return (
      Boolean(sent && e.mailboxIds?.[sent]) ||
      (own(account).has(String(e.from?.[0]?.email ?? '').toLowerCase()) &&
        !(inbox && e.mailboxIds?.[inbox]))
    );
  }
  /** Host-owned thread state from its emails; works with the light property set. */
  function threadState(
    account: Account,
    boxes: Mailboxes,
    threadId: string,
    emails: Json[],
  ): ThreadFlags {
    const inbox = boxes.role('inbox'),
      trash = boxes.role('trash'),
      junk = boxes.role('junk');
    const live = emails.filter(e => !(trash && e.mailboxIds?.[trash]));
    const unread = emails.some(e => !isSent(account, boxes, e) && !e.keywords?.$seen),
      bookmarked = emails.some(e => e.keywords?.$flagged === true);
    const status: ThreadFlags['status'] = !live.length
      ? 'trash'
      : live.some(e => junk && e.mailboxIds?.[junk])
        ? 'spam'
        : live.some(e => inbox && e.mailboxIds?.[inbox])
          ? 'new'
          : 'done';
    const labels = [
      ...new Set(
        emails.flatMap(e =>
          Object.keys(e.mailboxIds ?? {})
            .filter(id => e.mailboxIds[id])
            .map(boxes.label)
            .filter((l): l is string => !!l),
        ),
      ),
    ];
    if (unread) labels.push('UNREAD');
    if (bookmarked) labels.push('STARRED');
    return { id: `${account.id}:${threadId}`, unread, bookmarked, status, labels };
  }
  function message(account: Account, boxes: Mailboxes, e: Json): Message {
    const from = e.from?.[0] ?? {},
      values = (parts: Json[] | undefined, type: string) =>
        (parts ?? [])
          .filter(p => p.type === type)
          .map(p => e.bodyValues?.[p.partId]?.value ?? '')
          .join('\n');
    const html = values(e.htmlBody, 'text/html'),
      text = values(e.textBody, 'text/plain') || htmlText(html) || String(e.preview ?? '');
    const internetId = e.messageId?.[0] ? `<${e.messageId[0]}>` : undefined,
      references = e.references?.length
        ? e.references.map((r: string) => `<${r}>`).join(' ')
        : undefined;
    const emails = (list: Json[] | undefined) =>
      (list ?? []).map(a => String(a.email ?? '')).filter(Boolean);
    return {
      id: e.id,
      ...(internetId ? { internetId } : {}),
      ...(references ? { references } : {}),
      from: String(from.email ?? ''),
      fromName: String(from.name || String(from.email ?? '').split('@')[0]),
      to: emails(e.to),
      cc: emails(e.cc),
      date: new Date(Date.parse(e.receivedAt) || Date.now()).toISOString(),
      text,
      html: html || undefined,
      sent: isSent(account, boxes, e),
      attachments: (e.attachments ?? []).map((p: Json, i: number): Attachment => ({
        id: `${e.id}:${p.partId ?? i}`,
        name: p.name || 'attachment',
        type: p.type || 'application/octet-stream',
        size: Number(p.size) || 0,
        remoteId: p.blobId,
        messageId: e.id,
        contentId: typeof p.cid === 'string' ? p.cid.replace(/^<|>$/g, '') || undefined : undefined,
      })),
    };
  }
  /** Normalize a JMAP thread; undefined when nothing in it is shown to the user (drafts, Aplos data). */
  function normalize(
    account: Account,
    boxes: Mailboxes,
    threadId: string,
    all: Json[],
  ): Thread | undefined {
    const emails = all.filter(visible);
    if (!emails.length) return undefined;
    const flags = threadState(account, boxes, threadId, emails),
      messages = emails
        .map(e => message(account, boxes, e))
        .sort((a, b) => a.date.localeCompare(b.date));
    const first = emails.find(e => e.id === messages[0].id) ?? emails[0],
      last = emails.find(e => e.id === messages.at(-1)!.id) ?? emails.at(-1)!;
    return {
      id: flags.id,
      remoteId: threadId,
      accountId: account.id,
      subject: String(first.subject || '(No subject)'),
      summary: String(last.preview ?? '').trim() || messages.at(-1)!.text.slice(0, 200),
      messages,
      date: messages.at(-1)!.date,
      unread: flags.unread,
      status: flags.status,
      importance: 'important',
      bookmarked: flags.bookmarked,
      replyStatus: 'none',
      labels: flags.labels,
    };
  }
  /** Full threads for Thread/get rows, in row order; undefined where nothing is visible. */
  async function loadThreads(
    account: Account,
    boxes: Mailboxes,
    rows: Json[],
  ): Promise<(Thread | undefined)[]> {
    const byId = new Map<string, Json>();
    for (const e of await getEmails(
      account,
      rows.flatMap(r => r.emailIds ?? []),
      BODIES,
      await maxGet(account),
    ))
      byId.set(e.id, e);
    return rows.map(r =>
      normalize(
        account,
        boxes,
        r.id,
        (r.emailIds ?? []).map((id: string) => byId.get(id)).filter(Boolean),
      ),
    );
  }
  async function fetchThreads(
    account: Account,
    boxes: Mailboxes,
    ids: string[],
  ): Promise<Map<string, Thread | undefined>> {
    const result = new Map<string, Thread | undefined>(ids.map(id => [id, undefined]));
    for (const batch of chunks(ids, (await session(account.id)).maxGet)) {
      const { rows } = await getThreads(account, batch);
      (await loadThreads(account, boxes, rows)).forEach((thread, i) =>
        result.set(rows[i].id, thread),
      );
    }
    return result;
  }
  function withoutAppData(filter?: Json): Json {
    const hidden = { notKeyword: APP_KEYWORD };
    return filter ? { operator: 'AND', conditions: [filter, hidden] } : hidden;
  }
  /** Newest threads matching `filter`, paged within the server's get limit, plus the states read before the first page. */
  async function query(account: Account, filter: Json | undefined, limit: number) {
    const boxes = await getMailboxes(account),
      where = withoutAppData(filter),
      size = (await session(account.id)).maxGet,
      rows = new Map<string, Json>();
    let cursor: Cursor | undefined,
      position = 0;
    while (position < limit) {
      const page = Math.min(size, limit - position);
      // Reading the states before the query means anything that changes while the window loads is replayed later.
      const r = await api(account, [
        ...(cursor
          ? []
          : ([
              ['Email/get', { ids: [] }, 'se'],
              ['Thread/get', { ids: [] }, 'st'],
            ] as Call[])),
        [
          'Email/query',
          {
            filter: where,
            sort: [{ property: 'receivedAt', isAscending: false }],
            collapseThreads: true,
            position,
            limit: page,
          },
          'q',
        ],
        [
          'Email/get',
          {
            '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
            properties: ['threadId'],
          },
          'e',
        ],
        [
          'Thread/get',
          { '#ids': { resultOf: 'e', name: 'Email/get', path: '/list/*/threadId' } },
          't',
        ],
      ]);
      cursor ??= { email: String(pick(r, 'se').state), thread: String(pick(r, 'st').state) };
      const ids = pick(r, 'q').ids ?? [];
      pick(r, 'e');
      for (const row of pick(r, 't').list ?? []) rows.set(row.id, row);
      position += ids.length;
      if (ids.length < page) break;
    }
    const threads = (await loadThreads(account, boxes, [...rows.values()]))
      .filter((x): x is Thread => !!x)
      .sort((a, b) => b.date.localeCompare(a.date));
    return { threads, cursor: cursor! };
  }
  async function freshWindow(account: Account): Promise<SyncResult> {
    const { threads, cursor } = await query(account, undefined, INITIAL_THREADS);
    const window = new Map(threads.map(t => [t.id, t]));
    const replay = await changes(account, cursor, { has: id => window.has(id) });
    if (!replay)
      return { threads, flags: [], removed: [], cursor: JSON.stringify(cursor), reset: true };
    for (const id of replay.removed) window.delete(id);
    for (const f of replay.flags) {
      const t = window.get(f.id);
      if (t)
        window.set(f.id, {
          ...t,
          unread: f.unread,
          bookmarked: f.bookmarked,
          status: f.status,
          labels: f.labels,
        });
    }
    for (const t of replay.threads) window.set(t.id, t);
    return {
      threads: [...window.values()].sort((a, b) => b.date.localeCompare(a.date)),
      flags: [],
      removed: replay.removed,
      cursor: replay.cursor,
      reset: true,
    };
  }
  async function changes(
    account: Account,
    cursor: Cursor,
    context: SyncContext,
  ): Promise<SyncResult | undefined> {
    const updatedEmails = new Set<string>(),
      destroyedEmails = new Set<string>(),
      changedThreads = new Set<string>(),
      goneThreads = new Set<string>();
    let email = cursor.email,
      thread = cursor.thread,
      moreEmail = true,
      moreThread = true,
      pages = 0,
      boxes: Mailboxes | undefined;
    try {
      while (moreEmail || moreThread) {
        if (pages++ >= MAX_CHANGE_PAGES) return undefined;
        const calls: Call[] = [];
        if (!boxes) calls.push(['Mailbox/get', { properties: MAILBOX }, 'm']);
        if (moreEmail)
          calls.push(['Email/changes', { sinceState: email, maxChanges: MAX_CHANGES }, 'e']);
        if (moreThread)
          calls.push(['Thread/changes', { sinceState: thread, maxChanges: MAX_CHANGES }, 't']);
        const r = await api(account, calls);
        if (!boxes) boxes = mailboxes(pick(r, 'm').list ?? []);
        if (moreEmail) {
          const page = pick(r, 'e');
          for (const id of page.updated ?? []) updatedEmails.add(id);
          for (const id of page.destroyed ?? []) destroyedEmails.add(id);
          email = String(page.newState);
          moreEmail = page.hasMoreChanges === true;
        }
        if (moreThread) {
          const page = pick(r, 't');
          for (const id of [...(page.created ?? []), ...(page.updated ?? [])])
            changedThreads.add(id);
          for (const id of page.destroyed ?? []) goneThreads.add(id);
          thread = String(page.newState);
          moreThread = page.hasMoreChanges === true;
        }
      }
    } catch (error) {
      if (error instanceof JmapError && error.type === 'cannotCalculateChanges') return undefined;
      throw error;
    }
    const local = (id: string) => `${account.id}:${id}`,
      removed = new Set<string>(),
      flags: ThreadFlags[] = [],
      discovered = new Set<string>();
    for (const id of goneThreads) {
      changedThreads.delete(id);
      if (context.has(local(id))) removed.add(local(id));
    }
    const relabeled = [...updatedEmails].filter(id => !destroyedEmails.has(id));
    const rows = new Map<string, Json>(),
      missing = new Set<string>();
    for (const ids of chunks(relabeled, (await session(account.id)).maxGet)) {
      const r = await api(account, [
        ['Email/get', { ids, properties: ['threadId'] }, 'e'],
        [
          'Thread/get',
          { '#ids': { resultOf: 'e', name: 'Email/get', path: '/list/*/threadId' } },
          't',
        ],
      ]);
      pick(r, 'e');
      const t = pick(r, 't');
      for (const row of t.list ?? []) rows.set(row.id, row);
      for (const id of t.notFound ?? []) missing.add(id);
    }
    for (const id of missing) if (!rows.has(id) && context.has(local(id))) removed.add(local(id));
    const known = [...rows.values()].filter(row => {
      if (changedThreads.has(row.id) || goneThreads.has(row.id)) return false;
      // A thread this device never stored only matters once it is in the inbox; then it needs its messages.
      if (!context.has(local(row.id))) {
        discovered.add(row.id);
        return false;
      }
      return true;
    });
    const byId = new Map<string, Json>(
      (
        await getEmails(
          account,
          known.flatMap(row => row.emailIds ?? []),
          { properties: LIGHT },
        )
      ).map(e => [e.id, e]),
    );
    for (const row of known) {
      const emails = (row.emailIds ?? [])
        .map((id: string) => byId.get(id))
        .filter(Boolean)
        .filter(visible);
      if (emails.length) flags.push(threadState(account, boxes!, row.id, emails));
      else removed.add(local(row.id));
    }
    const threads: Thread[] = [];
    for (const [id, value] of await fetchThreads(account, boxes!, [
      ...changedThreads,
      ...discovered,
    ])) {
      if (!value) {
        if (context.has(local(id))) removed.add(local(id));
        continue;
      }
      if (!discovered.has(id) || value.status === 'new') threads.push(value);
    }
    const seen = new Set(flags.map(f => f.id));
    return {
      threads: threads.sort((a, b) => b.date.localeCompare(a.date)),
      flags,
      removed: [...removed].filter(id => !seen.has(id)),
      cursor: JSON.stringify({ email, thread }),
      reset: false,
    };
  }
  function parseCursor(cursor: string | undefined): Cursor | undefined {
    if (!cursor) return undefined;
    try {
      const value = JSON.parse(cursor);
      return typeof value?.email === 'string' && typeof value.thread === 'string'
        ? value
        : undefined;
    } catch {
      return undefined;
    }
  }
  async function identities(account: Account): Promise<Json[]> {
    return (pick(await api(account, [['Identity/get', {}, 'i']]), 'i').list ?? []).filter(
      (i: Json) => typeof i.id === 'string' && typeof i.email === 'string',
    );
  }
  function sendAs(list: Json[], primary: string, name: string): NonNullable<Account['sendAs']> {
    const aliases = new Map<string, NonNullable<Account['sendAs']>[number]>();
    // Wildcard identities (`*@example.com`) authorize sending but are not addresses to offer.
    for (const item of list)
      if (
        /^[^\s@<>*]+@[^\s@<>]+\.[^\s@<>]+$/.test(item.email) &&
        !aliases.has(item.email.toLowerCase())
      )
        aliases.set(item.email.toLowerCase(), {
          email: item.email,
          name:
            typeof item.name === 'string' && item.name.trim()
              ? item.name.replace(/[\r\n]/g, ' ')
              : name,
          signature:
            typeof item.htmlSignature === 'string' && item.htmlSignature.trim()
              ? item.htmlSignature
              : typeof item.textSignature === 'string' && item.textSignature.trim()
                ? textHtml(item.textSignature)
                : '',
          isDefault: false,
        });
    if (!aliases.has(primary.toLowerCase()))
      aliases.set(primary.toLowerCase(), { email: primary, name, signature: '', isDefault: false });
    aliases.get(primary.toLowerCase())!.isDefault = true;
    return [...aliases.values()];
  }
  function identityFor(list: Json[], email: string) {
    const lower = email.toLowerCase();
    return (
      list.find(i => i.email.toLowerCase() === lower) ??
      list.find(i => i.email.startsWith('*@') && lower.endsWith(i.email.slice(1).toLowerCase()))
    );
  }
  async function upload(account: Account, data: Buffer, type: string): Promise<string> {
    const current = await session(account.id);
    const raw = await json(
      await http(current.uploadUrl.replace('{accountId}', enc(current.accountId)), {
        method: 'POST',
        headers: {
          ...auth(credential(account.id)),
          'Content-Type': type || 'application/octet-stream',
        },
        body: new Uint8Array(data),
      }),
    );
    if (typeof raw.blobId !== 'string')
      throw new JmapError(
        'The mail server did not accept the upload. Please retry.',
        undefined,
        true,
      );
    return raw.blobId;
  }
  async function download(
    account: Account,
    blobId: string,
    name: string,
    type: string,
  ): Promise<Buffer> {
    const current = await session(account.id);
    const url = current.downloadUrl
      .replace('{accountId}', enc(current.accountId))
      .replace('{blobId}', enc(blobId))
      .replace('{name}', enc(name || 'attachment'))
      .replace('{type}', enc(type || 'application/octet-stream'));
    return Buffer.from(
      await (await http(url, { headers: auth(credential(account.id)) })).arrayBuffer(),
    );
  }
  /**
   * Copies of a message by Message-ID: `sent` proves it went out (a non-draft copy, or a draft with a live
   * EmailSubmission because the move to Sent failed); `leftovers` are drafts that were never submitted.
   */
  async function copies(
    account: Account,
    messageId: string,
    found?: Json[],
  ): Promise<{ sent?: Json; leftovers: Json[] }> {
    let list: Json[];
    if (found) list = found;
    else {
      const r = await api(account, [
        ['Email/query', { filter: { header: ['Message-ID', messageId] }, limit: SEND_COPIES }, 'q'],
        [
          'Email/get',
          { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: COPY },
          'e',
        ],
      ]);
      pick(r, 'q');
      list = pick(r, 'e').list ?? [];
    }
    const drafts = list.filter(e => e.keywords?.$draft);
    let submitted = new Set<string>();
    if (drafts.length) {
      const r = await api(account, [
        [
          'EmailSubmission/query',
          { filter: { emailIds: drafts.map(e => e.id) }, limit: SEND_COPIES },
          'q',
        ],
        [
          'EmailSubmission/get',
          {
            '#ids': { resultOf: 'q', name: 'EmailSubmission/query', path: '/ids' },
            properties: ['emailId', 'undoStatus'],
          },
          'g',
        ],
      ]);
      pick(r, 'q');
      submitted = new Set(
        (pick(r, 'g').list ?? [])
          .filter((s: Json) => s.undoStatus !== 'canceled')
          .map((s: Json) => String(s.emailId)),
      );
    }
    return {
      sent: list.find(e => !e.keywords?.$draft) ?? list.find(e => submitted.has(e.id)),
      leftovers: drafts.filter(e => !submitted.has(e.id)),
    };
  }
  /** Moves a submitted message out of Drafts; a sent message left as a draft is hidden from sync and easy to resend by hand. */
  async function fileSent(account: Account, id: string, boxes?: Mailboxes) {
    boxes ??= await getMailboxes(account);
    const drafts = boxes.role('drafts'),
      sent = await ensureMailbox(account, boxes, 'sent', 'Sent');
    const result = pick(
      await api(account, [
        [
          'Email/set',
          {
            update: {
              [id]: drafts
                ? filed(drafts, sent)
                : { [`mailboxIds/${sent}`]: true, 'keywords/$draft': null },
            },
          },
          'f',
        ],
      ]),
      'f',
    );
    if (result.notUpdated?.[id]) throw jmapError(result.notUpdated[id]);
  }
  async function replyHeaders(
    account: Account,
    draft: Draft,
    thread?: Thread,
  ): Promise<{ inReplyTo?: string[]; references?: string[] }> {
    if (!draft.threadId || draft.mode === 'new' || draft.mode === 'forward') return {};
    let last: { internetId?: string; references?: string } | undefined = thread?.messages.at(-1);
    const remoteId =
      thread?.remoteId ??
      (draft.threadId.startsWith(`${account.id}:`)
        ? draft.threadId.slice(account.id.length + 1)
        : undefined);
    if (!last?.internetId && remoteId) {
      const { rows } = await getThreads(account, [remoteId]);
      const e = (
        await getEmails(
          account,
          rows.flatMap(row => row.emailIds ?? []),
          { properties: ['messageId', 'references', 'receivedAt'] },
        )
      )
        .sort((a: Json, b: Json) => String(a.receivedAt).localeCompare(String(b.receivedAt)))
        .at(-1);
      last = e?.messageId?.[0]
        ? {
            internetId: `<${e.messageId[0]}>`,
            references: (e.references ?? []).map((x: string) => `<${x}>`).join(' '),
          }
        : undefined;
    }
    if (!last?.internetId) return {};
    const parent = bare(last.internetId),
      references = [...(last.references ?? '').split(/\s+/).map(bare).filter(Boolean), parent];
    return { inReplyTo: [parent], references: [...new Set(references)] };
  }

  return {
    kind: 'jmap',
    available: true,
    capabilities: () => CAPABILITIES,
    async getSendAs(account: Account) {
      return sendAs(await identities(account), account.email, account.name);
    },
    async connect(connect: ConnectRequest): Promise<Account> {
      if (!vault.secure)
        throw new Error('Secure credential storage is unavailable. Connect using the desktop app.');
      const token = connect.secret?.trim();
      if (!token) throw new Error('Paste an API token to connect this account.');
      const preset =
        connect.preset === 'fastmail' || (!connect.sessionUrl && !connect.preset)
          ? 'fastmail'
          : (connect.preset ?? 'generic');
      const sessionUrl =
        connect.sessionUrl?.trim() ||
        (preset === 'fastmail' ? JMAP_PRESETS.fastmail.sessionUrl : '');
      let parsed: URL;
      try {
        parsed = new URL(sessionUrl);
      } catch {
        throw new Error('Enter the JMAP session URL for this server.');
      }
      if (parsed.protocol !== 'https:') throw new Error('The JMAP session URL must use https.');
      const value: Credential = { token, sessionUrl: parsed.toString() };
      const current = await loadSession(value);
      const list = (
        pick(await invoke(value, current, [['Identity/get', {}, 'i']]), 'i').list ?? []
      ).filter((i: Json) => typeof i.id === 'string' && typeof i.email === 'string');
      const isEmail = (v: string) => /^[^\s@<>*]+@[^\s@<>]+\.[^\s@<>]+$/.test(v);
      const primary =
        identityFor(list, current.username) ??
        list.find((i: Json) => i.mayDelete === false && isEmail(i.email)) ??
        list.find((i: Json) => isEmail(i.email));
      const email = isEmail(current.username)
        ? current.username
        : (primary?.email ?? connect.email?.trim());
      if (!email || !isEmail(email))
        throw new JmapError(
          'The mail server did not report an email address for this account.',
          400,
        );
      const id = `jmap-${current.accountId}`,
        name =
          connect.name?.trim() ||
          (typeof primary?.name === 'string' && primary.name.trim()) ||
          email;
      await vault.set(id, value);
      sessions.set(id, current);
      return {
        id,
        name,
        email,
        provider: 'jmap',
        preset,
        capabilities: CAPABILITIES,
        color: '#6f86a6',
        connected: true,
        calendarConnected: false,
        sendAs: sendAs(list, email, name),
      };
    },
    async disconnect(accountId: string) {
      sessions.delete(accountId);
      options.memory?.clear(accountId);
      await vault.delete(accountId);
    },
    async sync(
      account: Account,
      cursor?: string,
      context: SyncContext = { has: () => false },
    ): Promise<SyncResult> {
      const position = parseCursor(cursor);
      if (position) {
        const result = await changes(account, position, context);
        if (result) return result;
      }
      return freshWindow(account);
    },
    search: async (account: Account, text: string) =>
      (await query(account, { text }, SEARCH_THREADS)).threads,
    async updateThread(account: Account, thread: RemoteThread, patch: Partial<Thread>) {
      if (!thread.remoteId) throw new Error('This thread has no JMAP identifier.');
      const r = await api(account, [
        ['Mailbox/get', { properties: MAILBOX }, 'm'],
        ['Thread/get', { ids: [thread.remoteId] }, 't'],
      ]);
      const boxes = mailboxes(pick(r, 'm').list ?? []),
        rows = pick(r, 't').list ?? [];
      if (!rows.length) throw new JmapError('The mail server could not find this item.', 404);
      const emails = (
        await getEmails(
          account,
          rows.flatMap((row: Json) => row.emailIds ?? []),
          { properties: LIGHT },
        )
      )
        .filter(visible)
        .sort((a: Json, b: Json) =>
          String(a.receivedAt ?? '').localeCompare(String(b.receivedAt ?? '')),
        );
      if (!emails.length) throw new JmapError('The mail server could not find this item.', 404);
      const update: Record<string, Json> = {},
        set = (id: string, key: string, value: unknown) => {
          (update[id] ??= {})[key] = value;
        };
      const inbound = emails.filter((e: Json) => !isSent(account, boxes, e)),
        latest = inbound.at(-1) ?? emails.at(-1)!;
      if (patch.unread === false)
        for (const e of emails) if (!e.keywords?.$seen) set(e.id, 'keywords/$seen', true);
      if (patch.unread === true) set(latest.id, 'keywords/$seen', null);
      if (patch.bookmarked === true && !emails.some((e: Json) => e.keywords?.$flagged))
        set(latest.id, 'keywords/$flagged', true);
      if (patch.bookmarked === false)
        for (const e of emails) if (e.keywords?.$flagged) set(e.id, 'keywords/$flagged', null);
      if (patch.status) {
        const target = patch.status,
          restore = thread.status === 'trash' || thread.status === 'spam';
        const toInbox =
          target === 'new'
            ? true
            : target === 'trash' || target === 'spam'
              ? undefined
              : patch.labels
                ? patch.labels.includes('INBOX')
                : undefined;
        const role = async (name: string, fallback: string) =>
          ensureMailbox(account, boxes, name, fallback);
        const trash = target === 'trash' ? await role('trash', 'Trash') : boxes.role('trash'),
          junk = target === 'spam' ? await role('junk', 'Spam') : boxes.role('junk');
        const inbox = toInbox ? await role('inbox', 'Inbox') : boxes.role('inbox'),
          sent = boxes.role('sent');
        let archive = boxes.role('archive');
        for (const e of emails) {
          const before: Record<string, boolean> = Object.fromEntries(
            Object.entries(e.mailboxIds ?? {}).filter(([, v]) => v === true),
          ) as Record<string, boolean>;
          let next: Record<string, boolean> = { ...before };
          const outbound = isSent(account, boxes, e);
          if (target === 'trash') next = { [trash!]: true };
          else if (target === 'spam') next = { [junk!]: true };
          else {
            if (restore) {
              if (trash) delete next[trash];
              if (junk) delete next[junk];
            }
            const dropped = (trash && next[trash]) || (junk && next[junk]);
            if (toInbox === true && !outbound && !dropped) {
              next[inbox!] = true;
              if (archive) delete next[archive];
            }
            if (toInbox === false && inbox && next[inbox]) {
              delete next[inbox];
              next[(archive ??= await role('archive', 'Archive'))] = true;
            }
            if (!Object.keys(next).length) {
              if (outbound && sent) next[sent] = true;
              else if (toInbox) next[inbox!] = true;
              else next[(archive ??= await role('archive', 'Archive'))] = true;
            }
          }
          const same =
            Object.keys(next).length === Object.keys(before).length &&
            Object.keys(next).every(k => before[k]);
          if (!same) set(e.id, 'mailboxIds', next);
        }
      }
      if (!Object.keys(update).length) return;
      const result = pick(await api(account, [['Email/set', { update }, 'u']]), 'u');
      for (const error of Object.values(result.notUpdated ?? {}) as Json[])
        if (error?.type !== 'notFound') throw jmapError(error);
    },
    async send(account: Account, draft: Draft, thread?: Thread) {
      const to = parseAddresses(draft.to),
        cc = parseAddresses(draft.cc),
        bcc = parseAddresses(draft.bcc);
      if (!to.length) throw new Error('Add at least one recipient before sending.');
      const fromEmail = draft.fromEmail ?? account.email;
      for (const value of [draft.to, draft.cc, draft.bcc, draft.subject, fromEmail])
        if (/[\r\n]/.test(value)) throw new Error('Email headers cannot contain line breaks.');
      const messageId = bare(draft.messageId || `${randomUUID()}@${fromEmail.split('@')[1]}`);
      const r = await api(account, [
        ['Identity/get', {}, 'i'],
        ['Mailbox/get', { properties: MAILBOX }, 'm'],
        [
          'Email/query',
          { filter: { header: ['Message-ID', messageId] }, limit: SEND_COPIES },
          'old',
        ],
        [
          'Email/get',
          { '#ids': { resultOf: 'old', name: 'Email/query', path: '/ids' }, properties: COPY },
          'copies',
        ],
      ]);
      const identity = identityFor(
        (pick(r, 'i').list ?? []).filter(
          (i: Json) => typeof i.id === 'string' && typeof i.email === 'string',
        ),
        fromEmail,
      );
      if (!identity)
        throw new Error(
          'This sending address is not authorized for this account. Sync the account and choose an available address.',
        );
      const boxes = mailboxes(pick(r, 'm').list ?? []);
      pick(r, 'old');
      const prior = await copies(account, messageId, pick(r, 'copies').list ?? []);
      // An earlier attempt already went out; submitting again would deliver the message twice.
      if (prior.sent) {
        if (prior.sent.keywords?.$draft)
          await fileSent(account, prior.sent.id, boxes).catch(() => undefined);
        return { id: String(prior.sent.id), threadId: String(prior.sent.threadId) };
      }
      const drafts = await ensureMailbox(account, boxes, 'drafts', 'Drafts'),
        sentBox = await ensureMailbox(account, boxes, 'sent', 'Sent');
      const alias = account.sendAs?.find(a => a.email.toLowerCase() === fromEmail.toLowerCase());
      const attachments = [];
      for (const a of draft.attachments) {
        const blobId = a.data
          ? await upload(account, Buffer.from(a.data, 'base64'), a.type)
          : a.remoteId;
        if (!blobId)
          throw new Error(
            `Attachment "${a.name}" has not been downloaded. Reattach it before sending.`,
          );
        attachments.push({
          blobId,
          type: a.type || 'application/octet-stream',
          name: a.name,
          disposition: a.contentId ? 'inline' : 'attachment',
          ...(a.contentId ? { cid: a.contentId } : {}),
        });
      }
      const email = {
        mailboxIds: { [drafts]: true },
        keywords: { $draft: true, $seen: true },
        from: [
          {
            name:
              alias?.name || (typeof identity.name === 'string' && identity.name) || account.name,
            email: fromEmail,
          },
        ],
        to,
        ...(cc.length ? { cc } : {}),
        subject: draft.subject,
        sentAt: jmapDate(),
        messageId: [messageId],
        ...(await replyHeaders(account, draft, thread)),
        textBody: [{ partId: 'text', type: 'text/plain' }],
        htmlBody: [{ partId: 'html', type: 'text/html' }],
        bodyValues: { text: { value: htmlText(draft.html) }, html: { value: draft.html } },
        attachments,
      };
      // Bcc stays out of the stored message; the envelope alone delivers it.
      const envelope = {
        mailFrom: { email: fromEmail },
        rcptTo: [...new Set([...to, ...cc, ...bcc].map(a => a.email.toLowerCase()))].map(email => ({
          email,
        })),
      };
      const result = await api(account, [
        // Drafts left by an earlier attempt that never reached submission are replaced, so a retry cannot leave duplicates.
        [
          'Email/set',
          {
            create: { draft: email },
            ...(prior.leftovers.length ? { destroy: prior.leftovers.map(e => e.id) } : {}),
          },
          'draft',
        ],
        [
          'EmailSubmission/set',
          {
            create: { send: { identityId: identity.id, emailId: '#draft', envelope } },
            onSuccessUpdateEmail: { '#send': filed(drafts, sentBox) },
          },
          'send',
        ],
      ]);
      const created = pick(result, 'draft', 'Email/set');
      if (!created.created?.draft) throw jmapError(created.notCreated?.draft);
      const id = String(created.created.draft.id),
        discard = () =>
          api(account, [['Email/set', { destroy: [id] }, 'x']]).catch(() => undefined);
      let submission: Json;
      try {
        submission = pick(result, 'send', 'EmailSubmission/set');
      } catch (error) {
        if (error instanceof JmapError && !error.uncertain) await discard();
        throw error;
      }
      if (!submission.created?.send) {
        await discard();
        throw jmapError(submission.notCreated?.send);
      }
      // The move to Sent is a separate implicit Email/set; when it fails the message has still gone out.
      const moved = result.find(
        x => Array.isArray(x) && x[0] === 'Email/set' && x[2] === 'send',
      )?.[1];
      if (!moved || moved.notUpdated?.[id] || !(id in (moved.updated ?? {})))
        await fileSent(account, id, boxes).catch(() => undefined);
      return { id, threadId: String(created.created.draft.threadId) };
    },
    async findSent(account: Account, messageId: string) {
      const { sent } = await copies(account, bare(messageId));
      if (typeof sent?.id !== 'string' || typeof sent.threadId !== 'string') return undefined;
      if (sent.keywords?.$draft) await fileSent(account, sent.id).catch(() => undefined);
      return { id: sent.id, threadId: sent.threadId };
    },
    async attachment(
      account: Account,
      _thread: Thread,
      attachment: Attachment,
    ): Promise<Attachment> {
      if (attachment.data) return attachment;
      if (!attachment.remoteId) throw new Error('This attachment has no downloadable content.');
      return {
        ...attachment,
        data: (
          await download(account, attachment.remoteId, attachment.name, attachment.type)
        ).toString('base64'),
      };
    },
    async readAppData(account: Account): Promise<AppDataRecord[]> {
      const r = await api(account, [
        [
          'Email/query',
          {
            filter: { hasKeyword: APP_KEYWORD },
            sort: [{ property: 'receivedAt', isAscending: false }],
            limit: Math.min(APP_COPIES, (await session(account.id)).maxGet),
          },
          'q',
        ],
        [
          'Email/get',
          {
            '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
            properties: ['keywords', 'attachments'],
          },
          'e',
        ],
      ]);
      const order: string[] = pick(r, 'q').ids ?? [],
        byId = new Map<string, Json>((pick(r, 'e').list ?? []).map((e: Json) => [e.id, e]));
      const owned = order
        .map(id => byId.get(id))
        .filter(
          (e): e is Json =>
            !!e?.keywords?.[APP_KEYWORD] && typeof e.attachments?.[0]?.blobId === 'string',
        );
      return each(owned, async e => {
        const part = e.attachments[0];
        return {
          id: String(e.id),
          data: (
            await download(
              account,
              part.blobId,
              part.name ?? 'aplos-data',
              part.type ?? 'application/octet-stream',
            )
          ).toString('utf8'),
        };
      });
    },
    async writeAppData(account: Account, data: string, replaces: string[]) {
      const boxes = await getMailboxes(account);
      const box =
        boxes.aplos ??
        (await ensureMailbox(account, boxes, undefined, APP_MAILBOX, { isSubscribed: false }));
      const blobId = await upload(account, Buffer.from(data, 'utf8'), 'application/octet-stream');
      const email = {
        mailboxIds: { [box]: true },
        keywords: { $seen: true, [APP_KEYWORD]: true },
        from: [{ name: 'Aplos Mail', email: account.email }],
        subject: 'Aplos Mail data',
        receivedAt: new Date().toISOString(),
        textBody: [{ partId: 'text', type: 'text/plain' }],
        bodyValues: {
          text: { value: 'Aplos Mail keeps workflow data here. Leave this message in place.' },
        },
        attachments: [
          {
            blobId,
            type: 'application/octet-stream',
            name: 'aplos-data',
            disposition: 'attachment',
          },
        ],
      };
      const result = pick(
        await api(account, [['Email/set', { create: { data: email } }, 'w']]),
        'w',
      );
      if (!result.created?.data) throw jmapError(result.notCreated?.data);
      // Only copies Aplos wrote are destroyed, whatever IDs the caller passes; the new copy exists before any old one goes.
      const ids = replaces.filter(id => id !== result.created.data.id);
      const owned = (await getEmails(account, ids, { properties: ['keywords'] }))
        .filter(e => e.keywords?.[APP_KEYWORD])
        .map(e => String(e.id));
      // A copy that cannot be destroyed now is read and merged again on the next round.
      if (owned.length) pick(await api(account, [['Email/set', { destroy: owned }, 'x']]), 'x');
    },
    close() {
      sessions.clear();
    },
  };
}
