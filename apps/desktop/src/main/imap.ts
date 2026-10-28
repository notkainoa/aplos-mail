import { createHash, randomUUID } from 'node:crypto';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
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
  type AppDataRecord,
  type CalendarBackend,
  type CalendarCredentials,
  type ConnectRequest,
  type MailProvider,
  type ProviderCapabilities,
  type ProviderEnvironment,
  type ProviderMemory,
  type RemoteThread,
  type ServerSettings,
  type SyncContext,
  type SyncResult,
  type ThreadFlags,
} from '@aplos/engine/legacy/provider';
import { createVault } from './vault';
import {
  createIndex,
  normalizeId,
  referenceIds,
  type ImapIndex,
  type MessageRecord,
  type Role,
} from './imap-index';
import {
  imapflowSession,
  nodemailerSender,
  type ImapBox,
  type ImapFetched,
  type ImapLogin,
  type ImapSession,
  type SmtpLogin,
  type SmtpSender,
} from './imap-session';

export type {
  ImapBox,
  ImapFetched,
  ImapFetchQuery,
  ImapFolder,
  ImapLogin,
  ImapPart,
  ImapQuery,
  ImapSession,
  SmtpLogin,
  SmtpSender,
} from './imap-session';

/** `uncertain` means the request may have reached the server even though no answer came back. */
export class ImapError extends ProviderError {}
export type ImapPreset = 'icloud' | 'yahoo' | 'aol';
export interface ImapOptions extends ProviderEnvironment<Buffer> {
  calendar?: CalendarBackend;
  client?: (config: ImapLogin) => ImapSession;
  smtp?: (config: SmtpLogin) => SmtpSender;
  /** How long to wait for the host to file a sent message itself before Aplos appends a copy to Sent. */
  sentCopyDelayMs?: number;
  /** Close an unused IMAP connection after this long. */
  idleMs?: number;
}
export type ImapAdapter = MailProvider &
  Required<
    Pick<
      MailProvider,
      'listCalendars' | 'listEvents' | 'saveEvent' | 'deleteEvent' | 'readAppData' | 'writeAppData'
    >
  >;

export const IMAP_PRESETS: Record<
  ImapPreset,
  { name: string; server: ServerSettings; help: string; passwordUrl: string }
> = {
  icloud: {
    name: 'iCloud Mail',
    server: {
      imap: { host: 'imap.mail.me.com', port: 993, secure: true },
      smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
      caldav: 'https://caldav.icloud.com',
    },
    help: 'Use your full iCloud email address and an app-specific password. Create one at appleid.apple.com under Sign-In and Security → App-Specific Passwords; your Apple Account password will not work.',
    passwordUrl: 'https://appleid.apple.com/account/manage',
  },
  yahoo: {
    name: 'Yahoo Mail',
    server: {
      imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
      smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    },
    help: 'Use your full Yahoo email address and an app password. Create one in Yahoo Account Security → Generate app password; your Yahoo password will not work.',
    passwordUrl: 'https://login.yahoo.com/account/security',
  },
  aol: {
    name: 'AOL Mail',
    server: {
      imap: { host: 'imap.aol.com', port: 993, secure: true },
      smtp: { host: 'smtp.aol.com', port: 465, secure: true },
    },
    help: 'Use your full AOL email address and an app password. Create one in AOL Account Security → Generate app password; your AOL password will not work.',
    passwordUrl: 'https://login.aol.com/account/security',
  },
};
const HOST_NAME: Record<ImapPreset, string> = { icloud: 'iCloud', yahoo: 'Yahoo', aol: 'AOL' };
const COLORS: Record<ImapPreset | 'generic', string> = {
  icloud: '#6f8fb3',
  yahoo: '#8a6fb3',
  aol: '#5f8597',
  generic: '#8a8170',
};
const PASSWORD_HINT: Record<ImapPreset, string> = {
  icloud: 'Use an app-specific password from appleid.apple.com, not your Apple Account password.',
  yahoo: 'Use an app password from Yahoo Account Security, not your Yahoo password.',
  aol: 'Use an app password from AOL Account Security, not your AOL password.',
};

/** Folders synced, in the order threads are assembled: inbox mail first so replies join it. */
const SYNC_ROLES: Role[] = ['inbox', 'sent', 'archive', 'trash', 'junk'];
/** First-sync window per folder: newest messages, and for folders other than the inbox only recent ones. */
const WINDOW: Record<Role, { max: number; days?: number }> = {
  inbox: { max: 500 },
  sent: { max: 250, days: 90 },
  archive: { max: 250, days: 90 },
  trash: { max: 100, days: 30 },
  junk: { max: 100, days: 30 },
};
const ROLE_LABEL: Record<Role, string> = {
  inbox: 'INBOX',
  archive: 'ARCHIVE',
  sent: 'SENT',
  trash: 'TRASH',
  junk: 'SPAM',
};
/** Display preference when one message has copies in several folders. */
const PREFERENCE: Role[] = ['inbox', 'archive', 'junk', 'trash', 'sent'];
/** Messages up to this size are downloaded whole; larger ones only their text, attachments on demand. */
export const MAX_SOURCE = 1_000_000;
const MAX_INLINE = 256_000,
  MAX_ATTACHMENT = 50_000_000,
  SEARCH_THREADS = 100,
  APP_FOLDER = 'Aplos Mail Data',
  APP_FILE = 'aplos-data.json';
/** Marks app-data messages Aplos wrote, so a user folder that shares the name is never read or cleaned up. */
const APP_HEADER = 'X-Aplos-Data',
  APP_MARK = 'workflow/1';
const PARSE = {
  skipTextToHtml: true,
  skipImageLinks: true,
  skipTextLinks: true,
  keepCidLinks: true,
} as const;
const NETWORK = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'ETIMEOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'CONNECT_TIMEOUT',
  'GREETING_TIMEOUT',
  'UPGRADE_TIMEOUT',
  'NoConnection',
  'EConnectionClosed',
  'ClosedAfterConnectText',
  'ClosedAfterConnectTLS',
  'StateLogout',
  'ESOCKET',
  'ECONNECTION',
  'EDNS',
]);
/** SMTP failures that happen before any message data could have been accepted. */
const SMTP_DEFINITE = new Set([
  'EAUTH',
  'ENOAUTH',
  'EOAUTH2',
  'EENVELOPE',
  'EMESSAGE',
  'ETLS',
  'EDNS',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EREQUIRETLS',
]);

type Boxes = Partial<Record<Role | 'all' | 'aplos', string>>;
interface Entry {
  session?: ImapSession;
  boxes?: Boxes;
  chain: Promise<unknown>;
  timer?: ReturnType<typeof setTimeout>;
}
interface FolderCursor {
  v: string;
  n: number;
  m?: string;
}
interface Cursor {
  v: 1;
  f: Partial<Record<Role, FolderCursor>>;
}
interface Meta {
  record: MessageRecord;
  references: string[];
}
interface Parsed {
  message: Message;
  subject: string;
}

const loc = (r: Pick<MessageRecord, 'f' | 'v' | 'u'>) => `${r.f}:${r.v}:${r.u}`;
const synthetic = (id: string) => /^(inbox|archive|sent|trash|junk):\d+:\d+$/.test(id);
const clip = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, 200);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const byDate = (a: { d: string }, b: { d: string }) => a.d.localeCompare(b.d);
function uidSet(uids: number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b),
    parts: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? String(sorted[i]) : `${sorted[i]}:${sorted[j]}`);
    i = j + 1;
  }
  return parts.join(',');
}
function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    map.set(k, [...(map.get(k) ?? []), item]);
  }
  return map;
}
function addresses(value: AddressObject | AddressObject[] | undefined): string[] {
  return (Array.isArray(value) ? value : value ? [value] : [])
    .flatMap(v => v.value)
    .flatMap(a => (a.group ? a.group : [a]))
    .map(a => a.address ?? '')
    .filter(Boolean);
}
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
function headerId(headers: Buffer | undefined): string | undefined {
  const match = /^message-id:[ \t]*(.*)$/im.exec(
    headers?.toString('utf8').replace(/\r?\n[ \t]+/g, ' ') ?? '',
  );
  return normalizeId(match?.[1]);
}
function parseCursor(cursor: string | undefined): Cursor | undefined {
  if (!cursor) return;
  try {
    const value = JSON.parse(cursor) as Cursor;
    return value?.v === 1 && value.f && typeof value.f === 'object' ? value : undefined;
  } catch {
    return undefined;
  }
}
export function imapAccountId(email: string, host: string) {
  return `imap-${createHash('sha256').update(`${email.trim().toLowerCase()}\n${host.trim().toLowerCase()}`).digest('hex').slice(0, 16)}`;
}
const presetOf = (account: Pick<Account, 'preset'>): ImapPreset | undefined =>
  account.preset && account.preset in IMAP_PRESETS ? (account.preset as ImapPreset) : undefined;
const hostLabel = (preset: ImapPreset | undefined, host?: string) =>
  preset ? HOST_NAME[preset] : host ? `The mail server ${host}` : 'The mail server';
function authMessage(preset: ImapPreset | undefined) {
  return preset
    ? `${HOST_NAME[preset]} rejected the password. ${PASSWORD_HINT[preset]}`
    : 'The mail server rejected the username or password. Check them, and use an app password if your provider requires one.';
}

/** Map an IMAP failure to words for the user. Dropped connections are `uncertain`: the command may have run. */
export function imapFailure(error: unknown, preset?: ImapPreset, host?: string): ProviderError {
  if (error instanceof ProviderError) return error;
  const e = (error ?? {}) as {
    code?: string;
    authenticationFailed?: boolean;
    serverResponseCode?: string;
    responseText?: string;
    tlsFailed?: boolean;
  };
  if (e.authenticationFailed || /AUTHENTICATIONFAILED/i.test(e.serverResponseCode ?? ''))
    return new ImapError(authMessage(preset), 401);
  if (e.tlsFailed)
    return new ImapError(
      `${hostLabel(preset, host)} did not accept a secure connection. Check the server name and port.`,
    );
  if (e.code === 'ETHROTTLE')
    return new ImapError(
      `${hostLabel(preset, host)} asked Aplos to slow down. Please retry shortly.`,
      429,
    );
  if (e.code && NETWORK.has(e.code))
    return new ImapError(
      `${hostLabel(preset, host)} could not be reached. Check your internet connection.`,
      undefined,
      true,
    );
  return new ImapError(
    `${hostLabel(preset, host)} refused the request${e.responseText ? `: ${clip(e.responseText)}` : ''}.`,
  );
}
/**
 * Map an SMTP failure. A reply code from the server, or a failure while connecting, means the message was not
 * accepted. A connection that drops later may have been cut after the server accepted the data, so it is `uncertain`.
 */
export function smtpFailure(error: unknown, preset?: ImapPreset, host?: string): ProviderError {
  if (error instanceof ProviderError) return error;
  const e = (error ?? {}) as {
    code?: string;
    responseCode?: number;
    command?: string;
    response?: string;
  };
  const label = preset
    ? `${HOST_NAME[preset]}’s outgoing server`
    : host
      ? `The outgoing server ${host}`
      : 'The outgoing mail server';
  if (e.code === 'EAUTH' || e.responseCode === 535 || e.responseCode === 534)
    return new ImapError(authMessage(preset), 401);
  if (e.responseCode && e.responseCode >= 500)
    return new ImapError(
      `${label} rejected the message${e.response ? `: ${clip(e.response)}` : ''}.`,
      e.responseCode,
    );
  if (e.responseCode && e.responseCode >= 400)
    return new ImapError(
      `${label} could not take the message right now${e.response ? ` (${clip(e.response)})` : ''}. Please retry shortly.`,
      e.responseCode,
    );
  if (e.command === 'CONN' || (e.code && SMTP_DEFINITE.has(e.code)))
    return new ImapError(
      `${label} could not be reached. Check your internet connection and the server settings.`,
    );
  return new ImapError(
    `The connection to ${label.charAt(0).toLowerCase() + label.slice(1)} was lost while sending. Aplos checks Sent mail before trying again.`,
    undefined,
    true,
  );
}

/** Thread state that follows from where its copies are: the inbox wins, then all-in-Trash, then Junk. */
export function imapFlags(accountId: string, key: string, records: MessageRecord[]): ThreadFlags {
  const placed = records.filter(r => r.f !== 'sent');
  const status: ThreadFlags['status'] = placed.some(r => r.f === 'inbox' && !r.out)
    ? 'new'
    : placed.length && placed.every(r => r.f === 'trash')
      ? 'trash'
      : placed.some(r => r.f === 'junk') && !placed.some(r => r.f === 'inbox')
        ? 'spam'
        : 'done';
  const unread = records.some(r => !r.out && !r.seen),
    bookmarked = records.some(r => r.flagged);
  const labels = [
    ...new Set(
      PREFERENCE.filter(role => records.some(r => r.f === role)).map(role => ROLE_LABEL[role]),
    ),
  ];
  if (unread) labels.push('UNREAD');
  if (bookmarked) labels.push('STARRED');
  return { id: `${accountId}:${key}`, unread, bookmarked, status, labels };
}
function memoryFallback(): ProviderMemory {
  const data = new Map<string, string>();
  return {
    get: (a, k) => data.get(`${a}\n${k}`),
    set: (a, k, v) => {
      if (v === undefined) data.delete(`${a}\n${k}`);
      else data.set(`${a}\n${k}`, v);
    },
    clear: a => {
      for (const k of [...data.keys()]) if (k.startsWith(`${a}\n`)) data.delete(k);
    },
  };
}

export async function createImap(options: ImapOptions): Promise<ImapAdapter> {
  const vault = await createVault<string>({
    dataDir: options.dataDir,
    encrypt: options.encrypt,
    decrypt: options.decrypt,
    file: 'imap-credentials.enc.json',
  });
  const memory = options.memory ?? memoryFallback(),
    client = options.client ?? imapflowSession,
    smtp = options.smtp ?? nodemailerSender;
  const idleMs = options.idleMs ?? 60_000,
    pool = new Map<string, Entry>();
  let closed = false;
  const index = (account: Pick<Account, 'id'>) => createIndex(memory, account.id);
  function logins(
    account: Pick<Account, 'id' | 'email' | 'server'>,
    secret = vault.get(account.id),
  ): { imap: ImapLogin; smtp: SmtpLogin } {
    if (!account.server)
      throw new ImapError('This account has no server settings. Reconnect it.', 401);
    if (!secret)
      throw new ImapError('This account needs its app password again. Reconnect it.', 401);
    const user = account.server.username || account.email;
    return {
      imap: { ...account.server.imap, user, pass: secret },
      smtp: { ...account.server.smtp, user, pass: secret },
    };
  }
  function entryOf(id: string): Entry {
    let entry = pool.get(id);
    if (!entry) {
      entry = { chain: Promise.resolve() };
      pool.set(id, entry);
    }
    return entry;
  }
  /** Serialize everything that touches one account's connection or index. */
  function locked<T>(id: string, fn: (entry: Entry) => Promise<T>): Promise<T> {
    const entry = entryOf(id);
    const task = entry.chain.then(() => fn(entry));
    entry.chain = task.catch(() => {});
    return task;
  }
  function retire(entry: Entry) {
    const session = entry.session;
    entry.session = undefined;
    entry.boxes = undefined;
    if (session) void session.logout().catch(() => {});
  }
  function scheduleIdle(id: string, entry: Entry) {
    if (entry.timer) clearTimeout(entry.timer);
    if (!entry.session || closed) return;
    entry.timer = setTimeout(() => {
      void locked(id, async e => retire(e));
    }, idleMs);
    entry.timer.unref?.();
  }
  function run<T>(
    account: Account,
    fn: (session: ImapSession, entry: Entry) => Promise<T>,
  ): Promise<T> {
    return locked(account.id, async entry => {
      if (closed) throw new ImapError('Aplos is closing.');
      if (entry.timer) clearTimeout(entry.timer);
      try {
        let session = entry.session;
        if (!session?.usable) {
          retire(entry);
          const fresh = client(logins(account).imap);
          try {
            await fresh.connect();
          } catch (error) {
            void fresh.logout().catch(() => {});
            throw error;
          }
          entry.session = session = fresh;
        }
        return await fn(session, entry);
      } catch (error) {
        if (entry.session && !entry.session.usable) retire(entry);
        throw imapFailure(error, presetOf(account), account.server?.imap.host);
      } finally {
        scheduleIdle(account.id, entry);
      }
    });
  }
  async function roles(entry: Entry, session: ImapSession, refresh = false): Promise<Boxes> {
    if (entry.boxes && !refresh) return entry.boxes;
    const list = await session.list(),
      boxes: Boxes = {};
    const special: Record<string, keyof Boxes> = {
      '\\Inbox': 'inbox',
      '\\Archive': 'archive',
      '\\Sent': 'sent',
      '\\Trash': 'trash',
      '\\Junk': 'junk',
      '\\All': 'all',
    };
    for (const folder of list) {
      const role = folder.specialUse && special[folder.specialUse];
      if (role && !boxes[role]) boxes[role] = folder.path;
    }
    boxes.inbox ??= list.find(f => f.path.toUpperCase() === 'INBOX')?.path ?? 'INBOX';
    // Name fallbacks for hosts without SPECIAL-USE, in order of preference (iCloud names first).
    const names: Partial<Record<Role, string[]>> = {
      archive: ['archive', 'archives'],
      trash: ['deleted messages', 'trash', 'deleted items', 'deleted'],
      junk: ['junk', 'spam', 'bulk mail', 'junk e-mail', 'junk email'],
      sent: ['sent messages', 'sent', 'sent items', 'sent mail'],
    };
    for (const [role, candidates] of Object.entries(names) as [Role, string[]][])
      if (!boxes[role])
        for (const name of candidates) {
          const hit = list.find(
            f => f.name.toLowerCase() === name || f.path.toLowerCase() === name,
          );
          if (hit) {
            boxes[role] = hit.path;
            break;
          }
        }
    boxes.aplos = list.find(f => f.name === APP_FOLDER)?.path;
    entry.boxes = boxes;
    return boxes;
  }
  async function folderFor(entry: Entry, session: ImapSession, role: Role): Promise<string> {
    const boxes = await roles(entry, session);
    if (boxes[role]) return boxes[role]!;
    if (role !== 'archive')
      throw new ImapError(
        `This account has no ${ROLE_LABEL[role].toLowerCase()} folder on the server.`,
      );
    await session.create('Archive');
    return (await roles(entry, session, true)).archive ?? 'Archive';
  }

  // ---- Reading messages ----
  async function meta(row: ImapFetched, role: Role, v: string, account: Account): Promise<Meta> {
    const head = row.headers?.length
      ? await simpleParser(Buffer.concat([row.headers, Buffer.from('\r\n')]), PARSE)
      : undefined;
    const id = normalizeId(head?.messageId) ?? `${role}:${v}:${row.uid}`;
    const references = [...referenceIds(head?.references), ...referenceIds(head?.inReplyTo)].filter(
      x => x !== id,
    );
    const from = addresses(head?.from)[0]?.toLowerCase(),
      own = new Set(
        [account.email, ...(account.sendAs ?? []).map(s => s.email)].map(e => e.toLowerCase()),
      );
    return {
      references,
      record: {
        id,
        f: role,
        v,
        u: row.uid,
        seen: row.flags.includes('\\Seen'),
        flagged: row.flags.includes('\\Flagged'),
        out: role === 'sent' || (role !== 'inbox' && !!from && own.has(from)),
        d: row.date ?? head?.date?.toISOString() ?? new Date().toISOString(),
        z: row.size ?? 0,
      },
    };
  }
  async function metas(
    session: ImapSession,
    path: string,
    role: Role,
    v: string,
    range: string,
    account: Account,
    bySequence = false,
  ): Promise<Meta[]> {
    if (!range) return [];
    const rows = (await session.fetch(path, range, { headers: true }, { bySequence })).filter(
      r => !r.flags.includes('\\Deleted'),
    );
    return Promise.all(rows.map(row => meta(row, role, v, account)));
  }
  const add = (idx: ImapIndex, m: Meta) => {
    const key = idx.link(m.record.id, m.references);
    idx.put(key, m.record);
    return key;
  };
  /** UIDs whose Message-ID is exactly `id`. SEARCH HEADER matches substrings, so candidates are checked. */
  async function withId(
    session: ImapSession,
    path: string,
    id: string,
    deleted = false,
  ): Promise<number[]> {
    const uids = await session.search(path, { header: { 'message-id': id } });
    if (!uids.length) return [];
    return (await session.fetch(path, uidSet(uids), { headers: true }))
      .filter(r => (deleted || !r.flags.includes('\\Deleted')) && headerId(r.headers) === id)
      .map(r => r.uid);
  }
  function message(
    record: MessageRecord,
    parsed: ParsedMail | undefined,
    body: { text: string; html?: string },
    attachments: Attachment[],
  ): Parsed {
    const from = parsed?.from?.value[0];
    const references =
      referenceIds(parsed?.references)
        .map(r => `<${r}>`)
        .join(' ') || undefined;
    return {
      subject: parsed?.subject || '',
      message: {
        id: record.id,
        ...(synthetic(record.id) ? {} : { internetId: `<${record.id}>` }),
        ...(references ? { references } : {}),
        from: from?.address ?? '',
        fromName: from?.name || from?.address?.split('@')[0] || '',
        to: addresses(parsed?.to),
        cc: addresses(parsed?.cc),
        date: new Date(record.d).toISOString(),
        text: body.text,
        ...(body.html ? { html: body.html } : {}),
        sent: record.out,
        attachments,
      },
    };
  }
  async function parseWhole(record: MessageRecord, source: Buffer): Promise<Parsed> {
    const parsed = await simpleParser(source, PARSE);
    const html = typeof parsed.html === 'string' && parsed.html.trim() ? parsed.html : undefined;
    const attachments = parsed.attachments.map((a, i): Attachment => ({
      id: `${record.id}:${i}`,
      name: a.filename || 'attachment',
      type: a.contentType || 'application/octet-stream',
      size: a.size ?? a.content.length,
      remoteId: `index:${i}`,
      messageId: record.id,
      ...(a.cid ? { contentId: a.cid.replace(/^<|>$/g, '') } : {}),
      ...(a.cid && a.content.length <= MAX_INLINE ? { data: a.content.toString('base64') } : {}),
    }));
    return message(
      record,
      parsed,
      { text: parsed.text?.trim() ? parsed.text : htmlText(html ?? ''), html },
      attachments,
    );
  }
  /** Large messages: headers and text parts only; every other part is downloaded when opened. */
  async function parseLarge(
    session: ImapSession,
    path: string,
    record: MessageRecord,
    row: ImapFetched,
  ): Promise<Parsed> {
    const parsed = row.headers?.length
      ? await simpleParser(Buffer.concat([row.headers, Buffer.from('\r\n')]), PARSE)
      : undefined;
    const parts = row.parts ?? [],
      isBody = (p: { type: string; filename?: string; disposition?: string }) =>
        !p.filename &&
        p.disposition?.toLowerCase() !== 'attachment' &&
        (p.type === 'text/plain' || p.type === 'text/html');
    const read = async (type: string) =>
      (
        await Promise.all(
          parts
            .filter(p => isBody(p) && p.type === type)
            .map(
              async p =>
                (await session.download(path, record.u, p.part, MAX_SOURCE))?.toString('utf8') ??
                '',
            ),
        )
      ).join('\n');
    const html = (await read('text/html')).trim() || undefined,
      text = (await read('text/plain')).trim() || htmlText(html ?? '');
    const attachments = parts
      .filter(p => !isBody(p))
      .map((p): Attachment => ({
        id: `${record.id}:${p.part}`,
        name: p.filename || 'attachment',
        type: p.type || 'application/octet-stream',
        size: p.size,
        remoteId: `part:${p.part}`,
        messageId: record.id,
        ...(p.contentId ? { contentId: p.contentId } : {}),
      }));
    return message(record, parsed, { text, html }, attachments);
  }
  /** Full threads for the given keys. Copies that vanished meanwhile are dropped; `emptied` lists threads left with none. */
  async function build(
    session: ImapSession,
    boxes: Boxes,
    idx: ImapIndex,
    account: Account,
    keys: string[],
    validity: Partial<Record<Role, string>> = {},
  ): Promise<{ threads: Thread[]; emptied: string[] }> {
    const cache = new Map<string, Parsed>(),
      wanted = new Map<string, MessageRecord>();
    for (const key of keys) for (const r of idx.records(key)) wanted.set(loc(r), r);
    for (const [role, all] of groupBy([...wanted.values()], r => r.f)) {
      const path = boxes[role];
      if (!path) continue;
      // Copies indexed under another UIDVALIDITY would fetch whatever now has their UID.
      const v = validity[role] ?? (await session.open(path)).uidValidity,
        records = all.filter(r => r.v === v);
      const small = records.filter(r => r.z <= MAX_SOURCE),
        large = records.filter(r => r.z > MAX_SOURCE);
      for (let i = 0; i < small.length; i += 50) {
        const batch = small.slice(i, i + 50);
        for (const row of await session.fetch(path, uidSet(batch.map(r => r.u)), {
          source: true,
        })) {
          const record = batch.find(r => r.u === row.uid);
          if (record && row.source) cache.set(loc(record), await parseWhole(record, row.source));
        }
      }
      for (const record of large) {
        const row = (
          await session.fetch(path, String(record.u), { headers: true, parts: true })
        )[0];
        if (row) cache.set(loc(record), await parseLarge(session, path, record, row));
      }
    }
    const threads: Thread[] = [],
      emptied: string[] = [];
    for (const key of keys) {
      for (const r of idx.records(key)) if (!cache.has(loc(r))) idx.drop(r.f, r.v, r.u, r.id);
      const records = idx.records(key);
      if (!records.length) {
        emptied.push(key);
        continue;
      }
      threads.push(normalize(account, key, records, cache));
    }
    return { threads, emptied };
  }
  function normalize(
    account: Account,
    key: string,
    records: MessageRecord[],
    cache: Map<string, Parsed>,
  ): Thread {
    const copies = new Map<string, { parsed: Parsed; out: boolean }>();
    for (const r of [...records].sort(
      (a, b) => PREFERENCE.indexOf(a.f) - PREFERENCE.indexOf(b.f),
    )) {
      const parsed = cache.get(loc(r));
      if (!parsed) continue;
      const known = copies.get(r.id);
      if (known) known.out &&= r.out;
      else copies.set(r.id, { parsed, out: r.out });
    }
    const items = [...copies.values()].sort((a, b) =>
      a.parsed.message.date.localeCompare(b.parsed.message.date),
    );
    const messages = items.map(i => ({ ...i.parsed.message, sent: i.out }));
    const flags = imapFlags(account.id, key, records),
      last = messages.at(-1);
    return {
      id: flags.id,
      remoteId: key,
      accountId: account.id,
      subject: items.find(i => i.parsed.subject)?.parsed.subject || '(No subject)',
      summary: last?.text.replace(/\s+/g, ' ').trim().slice(0, 200) ?? '',
      messages,
      date: last?.date ?? new Date().toISOString(),
      unread: flags.unread,
      status: flags.status,
      importance: 'important',
      bookmarked: flags.bookmarked,
      replyStatus: 'none',
      labels: flags.labels,
    };
  }

  // ---- Sync ----
  async function windowRows(
    session: ImapSession,
    path: string,
    role: Role,
    box: ImapBox,
    account: Account,
  ): Promise<Meta[]> {
    const limit = WINDOW[role];
    if (!limit.days)
      return box.exists
        ? metas(
            session,
            path,
            role,
            box.uidValidity,
            `${Math.max(1, box.exists - limit.max + 1)}:*`,
            account,
            true,
          )
        : [];
    const uids = (
      await session.search(path, { since: new Date(Date.now() - limit.days * 86_400_000) })
    )
      .sort((a, b) => b - a)
      .slice(0, limit.max);
    return metas(session, path, role, box.uidValidity, uidSet(uids), account);
  }
  async function syncFolder(
    session: ImapSession,
    idx: ImapIndex,
    role: Role,
    path: string,
    previous: FolderCursor | undefined,
    account: Account,
  ): Promise<{ cursor: FolderCursor; reset: boolean }> {
    const box = await session.open(path);
    const tracked = idx.folder(role);
    if (tracked?.v !== box.uidValidity) idx.resetFolder(role, box.uidValidity);
    const known = { ...idx.folder(role)!.u },
      knownUids = Object.keys(known).map(Number);
    // Without a matching cursor and index (new UIDVALIDITY, lost memory, a crash between saving the two)
    // the folder's window is read again; copies the index still knows are rechecked below.
    const incremental =
      !!previous && tracked?.v === box.uidValidity && previous.v === box.uidValidity;
    const reset = !!previous && !incremental;
    const fresh = incremental
      ? box.uidNext > previous!.n
        ? (await metas(session, path, role, box.uidValidity, `${previous!.n}:*`, account)).filter(
            m => m.record.u >= previous!.n,
          )
        : []
      : await windowRows(session, path, role, box, account);
    for (const m of fresh) {
      if (known[m.record.u]) {
        const key = idx.keyOf(known[m.record.u]);
        if (key) idx.touch(key);
      } else add(idx, m);
    }
    if (knownUids.length) {
      const set = uidSet(knownUids);
      let changed: ImapFetched[], present: Set<number>;
      if (
        incremental &&
        previous!.m &&
        box.highestModseq &&
        session.capabilities.has('CONDSTORE')
      ) {
        changed =
          box.highestModseq === previous!.m
            ? []
            : await session.fetch(path, set, {}, { changedSince: previous!.m });
        present = new Set(await session.search(path, { uid: set }));
      } else {
        changed = await session.fetch(path, set, {});
        present = new Set(changed.map(r => r.uid));
      }
      for (const row of changed) {
        if (row.flags.includes('\\Deleted')) {
          present.delete(row.uid);
          continue;
        }
        const id = known[row.uid],
          key = id && idx.keyOf(id);
        if (!key) continue;
        const record = idx
          .records(key)
          .find(r => r.f === role && r.v === box.uidValidity && r.u === row.uid);
        const seen = row.flags.includes('\\Seen'),
          flagged = row.flags.includes('\\Flagged');
        if (record && (record.seen !== seen || record.flagged !== flagged))
          idx.update(key, record, { seen, flagged });
      }
      for (const uid of knownUids)
        if (!present.has(uid)) idx.drop(role, box.uidValidity, uid, known[uid]);
    }
    return {
      cursor: {
        v: box.uidValidity,
        n: box.uidNext,
        ...(box.highestModseq ? { m: box.highestModseq } : {}),
      },
      reset,
    };
  }

  // ---- Changing messages ----
  /**
   * Confirm where a thread's copies are, finding moved ones by Message-ID. A folder rebuilt under a new UIDVALIDITY
   * can give a cached UID to unrelated mail, so cached UIDs count only under the folder's current UIDVALIDITY.
   */
  async function locate(
    session: ImapSession,
    boxes: Boxes,
    idx: ImapIndex,
    key: string,
  ): Promise<MessageRecord[]> {
    const lost: MessageRecord[] = [],
      current = new Map<Role, string>();
    const validity = async (role: Role, path: string) => {
      let v = current.get(role);
      if (v === undefined) {
        v = (await session.open(path)).uidValidity;
        current.set(role, v);
        idx.trackFolder(role, v);
      }
      return v;
    };
    for (const [role, records] of groupBy(idx.records(key), r => r.f)) {
      const path = boxes[role],
        v = path ? await validity(role, path) : undefined,
        valid = records.filter(r => r.v === v);
      const present =
        path && valid.length
          ? new Set(await session.search(path, { uid: uidSet(valid.map(r => r.u)) }))
          : new Set<number>();
      for (const r of records)
        if (r.v !== v || !present.has(r.u)) {
          idx.drop(r.f, r.v, r.u, r.id);
          lost.push(r);
        }
    }
    for (const r of lost) {
      if (synthetic(r.id) || idx.records(key).some(x => x.id === r.id)) continue;
      for (const role of SYNC_ROLES) {
        const path = boxes[role];
        if (!path) continue;
        const v = await validity(role, path),
          uids = await withId(session, path, r.id);
        if (!uids.length) continue;
        idx.put(key, { ...r, f: role, v, u: Math.max(...uids) });
        break;
      }
    }
    return idx.records(key);
  }
  async function moveTo(
    session: ImapSession,
    entry: Entry,
    idx: ImapIndex,
    key: string,
    records: MessageRecord[],
    target: Role,
  ) {
    const moving = records.filter(r => r.f !== target);
    if (!moving.length) return;
    const destination = await folderFor(entry, session, target),
      boxes = await roles(entry, session);
    for (const [role, group] of groupBy(moving, r => r.f)) {
      const path = boxes[role];
      if (!path) continue;
      const result = await session.move(
        path,
        group.map(r => r.u),
        destination,
      );
      const v = result.uidValidity ?? (await session.open(destination)).uidValidity;
      idx.trackFolder(target, v);
      for (const r of group) {
        let uid = result.map?.get(r.u);
        if (uid === undefined && !synthetic(r.id)) {
          const found = await withId(session, destination, r.id);
          if (found.length) uid = Math.max(...found);
        }
        if (uid === undefined) idx.drop(r.f, r.v, r.u, r.id);
        else idx.update(key, r, { f: target, v, u: uid });
      }
    }
  }
  /** Always stored, even where the index already agrees: another client may have changed the flag since. */
  async function setFlag(
    session: ImapSession,
    boxes: Boxes,
    idx: ImapIndex,
    key: string,
    records: MessageRecord[],
    flag: '\\Seen' | '\\Flagged',
    on: boolean,
  ) {
    const field = flag === '\\Seen' ? 'seen' : 'flagged';
    for (const [role, group] of groupBy(records, r => r.f)) {
      const path = boxes[role];
      if (!path) continue;
      await session.flags(
        path,
        group.map(r => r.u),
        on ? 'add' : 'remove',
        [flag],
      );
      for (const r of group) idx.update(key, r, { [field]: on });
    }
  }
  /** Copies of the newest message someone else wrote, or of the newest message when there is none. */
  function latest(records: MessageRecord[]): MessageRecord[] {
    const pick =
      [...records.filter(r => !r.out)].sort(byDate).at(-1) ?? [...records].sort(byDate).at(-1);
    return pick ? records.filter(r => r.id === pick.id) : [];
  }
  /** Build an RFC 5322 message locally (for Sent copies and app data). Bcc is kept, as in other clients' Sent copies. */
  async function compose(mail: SendMailOptions): Promise<Buffer> {
    const info = await nodemailer
      .createTransport({ streamTransport: true, buffer: true, newline: 'windows' })
      .sendMail({ ...mail, disableFileAccess: true, disableUrlAccess: true });
    if (!Buffer.isBuffer(info.message)) throw new Error('The message could not be encoded.');
    return info.message;
  }
  async function appFolder(
    session: ImapSession,
    entry: Entry,
    create: boolean,
  ): Promise<string | undefined> {
    const existing =
      (await roles(entry, session)).aplos ?? (await roles(entry, session, true)).aplos;
    if (existing || !create) return existing;
    await session.create(APP_FOLDER);
    // Unsubscribed folders stay out of sight in ordinary mail apps.
    try {
      await session.unsubscribe(APP_FOLDER);
    } catch {
      /* Visibility is cosmetic. */
    }
    return (await roles(entry, session, true)).aplos ?? APP_FOLDER;
  }
  /** App-data messages Aplos wrote (by their marker header), newest first, with their Message-IDs. */
  async function appRecords(
    session: ImapSession,
    path: string,
  ): Promise<Array<{ id: string; uid: number }>> {
    const uids = await session.search(path, { header: { [APP_HEADER.toLowerCase()]: APP_MARK } });
    if (!uids.length) return [];
    const marked = new RegExp(`^${APP_HEADER}:[ \\t]*${APP_MARK}[ \\t]*$`, 'im');
    const rows = (await session.fetch(path, uidSet(uids), { headers: true })).filter(
      r => !r.flags.includes('\\Deleted') && marked.test(r.headers?.toString('utf8') ?? ''),
    );
    return rows
      .sort((a, b) => b.uid - a.uid)
      .flatMap(r => {
        const id = headerId(r.headers);
        return id ? [{ id, uid: r.uid }] : [];
      });
  }
  function calendarLogin(account: Account): {
    backend: CalendarBackend;
    credentials: CalendarCredentials;
  } {
    const url = account.server?.caldav,
      password = vault.get(account.id);
    if (!options.calendar || !account.calendarConnected || !url)
      throw new ImapError('Calendar is not connected for this account.');
    if (!password)
      throw new ImapError('This account needs its app password again. Reconnect it.', 401);
    return {
      backend: options.calendar,
      credentials: { url, username: account.server?.username || account.email, password },
    };
  }
  const capabilities = (account?: Account): ProviderCapabilities => ({
    labels: false,
    importance: false,
    aliases: false,
    signatures: false,
    calendar: Boolean(account?.calendarConnected && options.calendar),
    serverSearch: true,
  });

  return {
    kind: 'imap',
    available: true,
    capabilities,
    async connect(request: ConnectRequest): Promise<Account> {
      if (request.provider !== 'imap')
        throw new ImapError('This request is not for an IMAP account.');
      const email = request.email?.trim(),
        secret = request.secret;
      if (!email || !/^[^\s@<>]+@[^\s@<>]+$/.test(email))
        throw new ImapError('Enter the full email address for this account.');
      if (!secret) throw new ImapError('Enter the app password for this account.');
      if (!vault.secure)
        throw new Error('Secure credential storage is unavailable. Connect using the desktop app.');
      const preset =
        request.preset && request.preset in IMAP_PRESETS
          ? (request.preset as ImapPreset)
          : undefined;
      const server: ServerSettings | undefined = preset
        ? {
            ...IMAP_PRESETS[preset].server,
            ...(request.server?.username ? { username: request.server.username } : {}),
          }
        : request.server;
      if (!server?.imap?.host || !server.smtp?.host)
        throw new ImapError('Enter the incoming (IMAP) and outgoing (SMTP) server settings.');
      const id = imapAccountId(email, server.imap.host),
        login = logins({ id, email, server }, secret);
      const session = client(login.imap);
      try {
        await session.connect();
        await session.list();
      } catch (error) {
        void session.logout().catch(() => {});
        throw imapFailure(error, preset, server.imap.host);
      }
      const sender = smtp(login.smtp);
      try {
        await sender.verify();
      } catch (error) {
        void session.logout().catch(() => {});
        throw smtpFailure(error, preset, server.smtp.host);
      } finally {
        sender.close();
      }
      let calendarConnected = false;
      if (server.caldav && options.calendar) {
        try {
          await options.calendar.verify({
            url: server.caldav,
            username: server.username || email,
            password: secret,
          });
          calendarConnected = true;
        } catch {
          /* Mail works without calendar access. */
        }
      }
      try {
        await vault.set(id, secret);
      } catch (error) {
        void session.logout().catch(() => {});
        throw error;
      }
      await locked(id, async entry => {
        retire(entry);
        entry.session = session;
        scheduleIdle(id, entry);
      });
      const name = request.name?.trim() || email;
      const account: Account = {
        id,
        name,
        email,
        provider: 'imap',
        preset: preset ?? 'generic',
        server,
        color: COLORS[preset ?? 'generic'],
        connected: true,
        calendarConnected,
        sendAs: [{ email, name, signature: '', isDefault: true }],
      };
      account.capabilities = capabilities(account);
      return account;
    },
    async disconnect(accountId: string) {
      await locked(accountId, async entry => {
        if (entry.timer) clearTimeout(entry.timer);
        retire(entry);
      });
      pool.delete(accountId);
      await vault.delete(accountId);
      memory.clear(accountId);
    },
    async sync(
      account: Account,
      cursor?: string,
      context: SyncContext = { has: () => false },
    ): Promise<SyncResult> {
      return run(account, async (session, entry) => {
        const boxes = await roles(entry, session, true),
          idx = index(account),
          previous = parseCursor(cursor),
          next: Cursor = { v: 1, f: {} };
        let synced = 0,
          resets = 0;
        for (const role of SYNC_ROLES) {
          const path = boxes[role];
          if (!path) {
            if (idx.folder(role)) idx.resetFolder(role, undefined);
            continue;
          }
          const result = await syncFolder(session, idx, role, path, previous?.f[role], account);
          next.f[role] = result.cursor;
          synced++;
          if (result.reset) resets++;
        }
        const changes = idx.changes(),
          has = (key: string) => context.has(`${account.id}:${key}`);
        const validity = Object.fromEntries(Object.entries(next.f).map(([role, c]) => [role, c.v]));
        const built = await build(
          session,
          boxes,
          idx,
          account,
          [...changes.changed, ...changes.touched.filter(k => !has(k))],
          validity,
        );
        const flags = changes.touched.filter(has).flatMap(k => {
          const records = idx.records(k);
          return records.length ? [imapFlags(account.id, k, records)] : [];
        });
        // The only index write of a sync, made before it returns: the service stages it with the threads and cursor.
        idx.flush();
        return {
          threads: built.threads,
          flags,
          removed: [...new Set([...changes.removed, ...built.emptied])].map(
            k => `${account.id}:${k}`,
          ),
          cursor: JSON.stringify(next),
          reset: !previous || (synced > 0 && resets === synced),
        };
      });
    },
    async search(account: Account, query: string): Promise<Thread[]> {
      const term = query.trim().slice(0, 200);
      if (!term) return [];
      return run(account, async (session, entry) => {
        const boxes = await roles(entry, session),
          idx = index(account),
          keys = new Set<string>(),
          found: Meta[] = [];
        for (const role of ['inbox', 'archive'] as Role[]) {
          const path = boxes[role];
          if (!path) continue;
          const box = await session.open(path);
          idx.trackFolder(role, box.uidValidity);
          const uids = (
            await session.search(path, {
              or: [{ subject: term }, { from: term }, { to: term }, { body: term }],
            })
          )
            .sort((a, b) => b - a)
            .slice(0, SEARCH_THREADS);
          found.push(...(await metas(session, path, role, box.uidValidity, uidSet(uids), account)));
        }
        for (const m of found
          .sort((a, b) => b.record.d.localeCompare(a.record.d))
          .slice(0, SEARCH_THREADS)) {
          const known = idx.folder(m.record.f)?.u[m.record.u];
          keys.add(known ? (idx.keyOf(known) ?? add(idx, m)) : add(idx, m));
        }
        const { threads } = await build(session, boxes, idx, account, [...keys]);
        idx.defer();
        idx.flush();
        return threads.sort((a, b) => b.date.localeCompare(a.date));
      });
    },
    async updateThread(account: Account, thread: RemoteThread, patch: Partial<Thread>) {
      const key = thread.remoteId;
      if (!key) throw new ImapError('This conversation has no server identifier.', 404);
      await run(account, async (session, entry) => {
        const boxes = await roles(entry, session),
          idx = index(account);
        try {
          let records = await locate(session, boxes, idx, key);
          if (!records.length)
            throw new ImapError('This conversation is no longer on the mail server.', 404);
          if (patch.status) {
            const targets = new Map<Role, MessageRecord[]>(),
              send = (r: MessageRecord, role: Role) => {
                if (r.f !== role) targets.set(role, [...(targets.get(role) ?? []), r]);
              };
            if (patch.status === 'trash') {
              const placed = records.filter(r => r.f !== 'sent');
              for (const r of placed.length ? placed : records) send(r, 'trash');
            } else if (patch.status === 'spam') {
              for (const r of records) if (!r.out && r.f !== 'sent') send(r, 'junk');
            } else {
              // Done or Later without INBOX in the labels is the archive action; Sent copies always stay in Sent.
              const target: Role = (
                patch.labels ? patch.labels.includes('INBOX') : patch.status === 'new'
              )
                ? 'inbox'
                : 'archive';
              for (const r of records) {
                if (r.f === 'sent') continue;
                if (!r.out) send(r, target);
                else if (r.f === 'trash' || r.f === 'junk') send(r, boxes.sent ? 'sent' : target);
              }
            }
            for (const [role, group] of targets)
              await moveTo(session, entry, idx, key, group, role);
            records = idx.records(key);
          }
          if (patch.unread !== undefined) {
            if (patch.unread)
              await setFlag(session, boxes, idx, key, latest(records), '\\Seen', false);
            else await setFlag(session, boxes, idx, key, records, '\\Seen', true);
            records = idx.records(key);
          }
          if (patch.bookmarked !== undefined)
            await setFlag(
              session,
              boxes,
              idx,
              key,
              patch.bookmarked ? latest(records) : records,
              '\\Flagged',
              patch.bookmarked,
            );
        } finally {
          idx.defer();
          idx.flush();
        }
      });
    },
    async send(account: Account, draft: Draft, thread?: Thread) {
      if (!draft.to.trim()) throw new Error('Add at least one recipient before sending.');
      const fromEmail = draft.fromEmail ?? account.email;
      for (const value of [draft.to, draft.cc, draft.bcc, draft.subject, fromEmail])
        if (/[\r\n]/.test(value)) throw new Error('Email headers cannot contain line breaks.');
      if (fromEmail.toLowerCase() !== account.email.toLowerCase())
        throw new Error('This account can only send from its own address.');
      const messageId = draft.messageId ?? `<${randomUUID()}@${account.email.split('@')[1]}>`,
        id = normalizeId(messageId)!;
      let inReplyTo: string | undefined,
        references: string | undefined,
        existing: string | undefined;
      if (draft.threadId && draft.mode !== 'new' && draft.mode !== 'forward') {
        const last = thread?.messages.filter(m => m.internetId).at(-1);
        inReplyTo = last?.internetId;
        references = [last?.references, inReplyTo].filter(Boolean).join(' ') || undefined;
        existing =
          thread?.remoteId ??
          (draft.threadId.startsWith(`${account.id}:`)
            ? draft.threadId.slice(account.id.length + 1)
            : undefined);
      }
      const mail: SendMailOptions = {
        messageId,
        date: new Date(),
        from: { name: account.name, address: account.email },
        to: draft.to,
        cc: draft.cc || undefined,
        bcc: draft.bcc || undefined,
        subject: draft.subject,
        html: draft.html,
        text: htmlText(draft.html),
        inReplyTo,
        references,
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
      };
      const preset = presetOf(account),
        sender = smtp(logins(account).smtp);
      try {
        const info = await sender.send(mail);
        if (!info.accepted.length)
          throw new ImapError('The outgoing mail server accepted none of the recipients.', 550);
      } catch (error) {
        throw smtpFailure(error, preset, account.server?.smtp.host);
      } finally {
        sender.close();
      }
      // Recorded first so the Sent copy, synced later, joins the thread this send reports.
      const threadId = await locked(account.id, async () => {
        const idx = index(account);
        const key = idx.link(id, [
          ...referenceIds(references),
          ...(existing
            ? idx
                .records(existing)
                .map(r => r.id)
                .slice(-1)
            : []),
        ]);
        idx.defer();
        idx.flush();
        return key;
      });
      // iCloud does not file mail sent over SMTP in Sent Messages; other hosts may, so give them a moment first.
      const delay = options.sentCopyDelayMs ?? (preset === 'icloud' ? 0 : 4000);
      try {
        if (delay) await sleep(delay);
        await run(account, async (session, entry) => {
          const sent = (await roles(entry, session)).sent;
          if (!sent) return;
          if ((await withId(session, sent, id, true)).length) return;
          await session.append(sent, await compose(mail), ['\\Seen'], mail.date as Date);
        });
      } catch {
        /* The message was delivered; a missing Sent copy must not turn that into a failure. */
      }
      return { id, threadId };
    },
    async findSent(account: Account, messageId: string) {
      const id = normalizeId(messageId);
      if (!id) return undefined;
      return run(account, async (session, entry) => {
        const boxes = await roles(entry, session);
        for (const role of ['sent', 'all'] as const) {
          const path = boxes[role];
          if (!path) continue;
          const uids = await withId(session, path, id, true);
          if (!uids.length) continue;
          const idx = index(account);
          let key = idx.keyOf(id);
          if (!key) {
            const v = (await session.open(path)).uidValidity;
            const [m] = await metas(session, path, 'sent', v, String(Math.max(...uids)), account);
            key = idx.link(id, m?.references ?? []);
            idx.defer();
            idx.flush();
          }
          return { id, threadId: key };
        }
        return undefined;
      });
    },
    async attachment(
      account: Account,
      thread: Thread,
      attachment: Attachment,
    ): Promise<Attachment> {
      if (attachment.data) return attachment;
      const remote = attachment.remoteId,
        messageId = attachment.messageId;
      if (!remote || !messageId) throw new Error('This attachment has no downloadable content.');
      return run(account, async (session, entry) => {
        const boxes = await roles(entry, session),
          idx = index(account),
          key = idx.keyOf(messageId) ?? thread.remoteId;
        const copies = (key ? idx.records(key) : [])
          .filter(r => r.id === messageId)
          .sort((a, b) => PREFERENCE.indexOf(a.f) - PREFERENCE.indexOf(b.f));
        for (const r of copies) {
          const path = boxes[r.f];
          if (!path || (await session.open(path)).uidValidity !== r.v) continue;
          if (remote.startsWith('part:')) {
            const data = await session.download(path, r.u, remote.slice(5), MAX_ATTACHMENT);
            if (data) return { ...attachment, size: data.length, data: data.toString('base64') };
            continue;
          }
          const row = (await session.fetch(path, String(r.u), { source: true }))[0];
          if (!row?.source) continue;
          const file = (await simpleParser(row.source, PARSE)).attachments[
            Number(remote.replace(/^index:/, ''))
          ];
          if (file)
            return {
              ...attachment,
              size: file.content.length,
              data: file.content.toString('base64'),
            };
        }
        throw new ImapError('This attachment is no longer on the mail server.', 404);
      });
    },
    listCalendars: async account => {
      const c = calendarLogin(account);
      return c.backend.listCalendars(c.credentials, account);
    },
    listEvents: async account => {
      const c = calendarLogin(account);
      return c.backend.listEvents(c.credentials, account);
    },
    saveEvent: async (account: Account, event: CalendarEvent) => {
      const c = calendarLogin(account);
      return c.backend.saveEvent(c.credentials, account, event);
    },
    deleteEvent: async (account: Account, event: CalendarEvent) => {
      const c = calendarLogin(account);
      return c.backend.deleteEvent(c.credentials, account, event);
    },
    // Record IDs are Message-IDs, resolved to UIDs only when deleting, so they stay valid across UIDVALIDITY changes.
    async readAppData(account: Account): Promise<AppDataRecord[]> {
      return run(account, async (session, entry) => {
        const path = await appFolder(session, entry, false);
        if (!path) return [];
        const found: AppDataRecord[] = [],
          seen = new Set<string>();
        for (const r of await appRecords(session, path)) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          const row = (await session.fetch(path, String(r.uid), { source: true }))[0];
          if (!row?.source) continue;
          const data = (await simpleParser(row.source, PARSE)).attachments
            .find(a => a.filename === APP_FILE)
            ?.content.toString('utf8');
          if (data !== undefined) found.push({ id: r.id, data });
        }
        return found;
      });
    },
    async writeAppData(account: Account, data: string, replaces: string[]) {
      await run(account, async (session, entry) => {
        const path = (await appFolder(session, entry, true))!,
          id = `aplos-data-${randomUUID()}@${account.email.split('@')[1]}`;
        const raw = await compose({
          messageId: `<${id}>`,
          headers: { [APP_HEADER]: APP_MARK },
          from: { name: 'Aplos Mail', address: account.email },
          to: account.email,
          subject: 'Aplos Mail sync data',
          text: 'Aplos Mail keeps its settings for this account here. Deleting this message resets them.',
          date: new Date(),
          attachments: [{ filename: APP_FILE, content: data, contentType: 'application/json' }],
        });
        await session.append(path, raw, ['\\Seen']);
        const drop = new Set(replaces.map(normalizeId).filter((x): x is string => !!x && x !== id));
        if (!drop.size) return;
        const stale = (await appRecords(session, path)).filter(r => drop.has(r.id)).map(r => r.uid);
        if (stale.length) await session.remove(path, stale);
      });
    },
    async close() {
      closed = true;
      const entries = [...pool.values()];
      pool.clear();
      for (const entry of entries) {
        if (entry.timer) clearTimeout(entry.timer);
        const session = entry.session;
        entry.session = undefined;
        if (session) await session.logout().catch(() => {});
      }
    },
  };
}
