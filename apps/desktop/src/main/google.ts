import { createServer, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
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
  type ConnectRequest,
  type MailProvider,
  type ProviderCapabilities,
  type RemoteThread,
  type SyncContext,
  type SyncResult,
  type ThreadFlags,
} from '@aplos/engine/legacy/provider';
import {
  bundledOAuth,
  oauthClient,
  oauthEnv,
  releaseBuild,
  type OAuthClient,
} from './oauth-config';

export interface GoogleOptions {
  dataDir: string;
  encrypt?: (value: string) => Buffer;
  decrypt?: (value: Buffer) => string;
  openExternal?: (url: string) => Promise<unknown>;
  fetch?: typeof fetch;
  clientId?: string;
  clientSecret?: string;
  oauthTimeoutMs?: number;
  /** Waits between rate-limit retries; tests pass a no-op. */ sleep?: (
    ms: number,
  ) => Promise<void>;
  /** The client inlined at release build time; defaults to `bundledOAuth.google`. */
  bundled?: OAuthClient;
}
interface Token {
  access_token: string;
  refresh_token?: string;
  expiresAt: number;
}
interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  internalDate?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPart;
}
interface GmailThread {
  id: string;
  messages?: GmailMessage[];
}
type Json = Record<string, any>;
/** `uncertain` means the request may have reached Google even though no answer came back. */
export class GoogleError extends ProviderError {}
const CAPABILITIES: ProviderCapabilities = {
  labels: true,
  importance: true,
  aliases: true,
  signatures: true,
  calendar: true,
  serverSearch: true,
};
export type GoogleAdapter = MailProvider &
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
/** Threads fetched on a first sync, newest first. Older mail is reached through search. */
export const INITIAL_THREADS = 500;
const SEARCH_THREADS = 100;
/** History pages to follow before a fresh window is cheaper than replaying changes. */
const MAX_HISTORY_PAGES = 20;
/** App data is one message under a hidden user label, marked by a header so sync can recognise it without the label ID. */
/** Named so it cannot be a label the user made; Gmail search spells spaces as hyphens. */
const APP_LABEL = 'Aplos Mail Data',
  APP_QUERY = '-label:aplos-mail-data',
  APP_HEADER = 'X-Aplos-Data',
  APP_FILE = 'aplos-data.txt';
const MAX_APP_DATA = 3_000_000;
export function labelStatus(labels: string[]): ThreadFlags['status'] {
  return labels.includes('TRASH')
    ? 'trash'
    : labels.includes('SPAM')
      ? 'spam'
      : labels.includes('INBOX')
        ? 'new'
        : 'done';
}
const gmail = 'https://gmail.googleapis.com/gmail/v1/users/me';
const calendar = 'https://www.googleapis.com/calendar/v3';
const enc = encodeURIComponent;
const header = (part: GmailPart | undefined, name: string) =>
  part?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
function address(value: string) {
  const match = value.match(/^(.*?)\s*<([^<>]+)>\s*$/);
  return match
    ? { email: match[2], name: match[1].replace(/^"|"$/g, '').trim() }
    : { email: value.trim(), name: value.split('@')[0] };
}
function addresses(value: string) {
  return value
    .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map(v => address(v).email)
    .filter(Boolean);
}
function flatten(part: GmailPart | undefined): GmailPart[] {
  return part ? [part, ...(part.parts ?? []).flatMap(flatten)] : [];
}
function isBodyPart(part: GmailPart) {
  return (
    !part.filename &&
    !header(part, 'content-id') &&
    !/^attachment(?:;|$)/i.test(header(part, 'content-disposition')) &&
    ['text/plain', 'text/html'].includes(part.mimeType ?? '')
  );
}
function decode(part: GmailPart) {
  if (!part.body?.data) return '';
  const bytes = Buffer.from(part.body.data, 'base64url');
  const charset =
    header(part, 'content-type').match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
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
/** Normalize public Gmail payloads into our independent mailbox model. HTML is sanitized at display. */
export function normalizeGmailThread(raw: GmailThread, account: Account): Thread {
  const items = raw.messages ?? [];
  const messages: Message[] = items
    .map(m => {
      const parts = flatten(m.payload),
        from = address(header(m.payload, 'from'));
      const html = parts
        .filter(p => p.mimeType === 'text/html' && isBodyPart(p))
        .map(decode)
        .join('\n');
      const text =
        parts
          .filter(p => p.mimeType === 'text/plain' && isBodyPart(p))
          .map(decode)
          .join('\n') ||
        htmlText(html) ||
        m.snippet ||
        '';
      const date = new Date(
        Number(m.internalDate) || Date.parse(header(m.payload, 'date')) || Date.now(),
      ).toISOString();
      const internetId = header(m.payload, 'message-id') || undefined,
        references = header(m.payload, 'references') || undefined;
      return {
        id: m.id,
        ...(internetId ? { internetId } : {}),
        ...(references ? { references } : {}),
        from: from.email,
        fromName: from.name,
        to: addresses(header(m.payload, 'to')),
        cc: addresses(header(m.payload, 'cc')),
        date,
        text,
        html: html || undefined,
        sent: m.labelIds?.includes('SENT') ?? false,
        attachments: parts
          .filter(
            p => !isBodyPart(p) && (p.filename || p.body?.attachmentId || header(p, 'content-id')),
          )
          .map((p, i) => ({
            id: `${m.id}:${p.partId ?? i}`,
            name: p.filename || 'attachment',
            type: p.mimeType || 'application/octet-stream',
            size: p.body?.size ?? 0,
            data: p.body?.data
              ? Buffer.from(p.body.data, 'base64url').toString('base64')
              : undefined,
            remoteId: p.body?.attachmentId,
            messageId: m.id,
            contentId: header(p, 'content-id').replace(/^<|>$/g, '') || undefined,
          })),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  const labels = [...new Set(items.flatMap(m => m.labelIds ?? []))];
  return {
    id: `${account.id}:${raw.id}`,
    remoteId: raw.id,
    accountId: account.id,
    subject: header(items[0]?.payload, 'subject') || '(No subject)',
    summary: htmlText(items.at(-1)?.snippet ?? '') || messages.at(-1)?.text.slice(0, 200) || '',
    messages,
    date: messages.at(-1)?.date ?? new Date().toISOString(),
    unread: labels.includes('UNREAD'),
    status: labelStatus(labels),
    importance: labels.includes('IMPORTANT') ? 'important' : 'low',
    bookmarked: labels.includes('STARRED'),
    replyStatus: 'none',
    labels,
  };
}

const googleUnavailable = releaseBuild
  ? 'Google sign-in isn’t available in this build.'
  : 'Google sign-in isn’t available in this build. Developers: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (Aplos’s own Desktop OAuth client) in .env, then restart.';

export async function createGoogle(options: GoogleOptions): Promise<GoogleAdapter> {
  const request = options.fetch ?? fetch;
  const client =
    options.clientId !== undefined
      ? { clientId: options.clientId, clientSecret: options.clientSecret }
      : oauthClient(
          oauthEnv(process.env).GOOGLE_CLIENT_ID,
          oauthEnv(process.env).GOOGLE_CLIENT_SECRET,
          options.bundled ?? bundledOAuth.google,
        );
  const clientId = client.clientId,
    clientSecret = client.clientSecret;
  const path = join(options.dataDir, 'google-tokens.enc.json');
  const tokens: Record<string, Token> = {};
  let server: Server | undefined, cancelConnect: (() => void) | undefined;
  let persistChain = Promise.resolve();
  const refreshes = new Map<string, Promise<string>>(),
    appLabels = new Map<string, string>();
  if (options.decrypt) {
    try {
      const encrypted = JSON.parse(await readFile(path, 'utf8')) as Record<string, string>;
      for (const [id, value] of Object.entries(encrypted)) {
        const token = JSON.parse(options.decrypt(Buffer.from(value, 'base64'))) as Token;
        if (typeof token.access_token === 'string' && typeof token.expiresAt === 'number')
          tokens[id] = token;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error(
          'Saved Google credentials could not be unlocked. Check your macOS keychain.',
        );
    }
  }
  async function persist() {
    if (!options.encrypt)
      throw new Error('Secure credential storage is unavailable. Connect using the desktop app.');
    let snapshot: string;
    try {
      snapshot = JSON.stringify(
        Object.fromEntries(
          Object.entries(tokens).map(([id, value]) => [
            id,
            options.encrypt!(JSON.stringify(value)).toString('base64'),
          ]),
        ),
      );
    } catch {
      throw new Error('Google credentials could not be encrypted. Check your macOS keychain.');
    }
    const operation = persistChain.then(async () => {
      await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
      await writeFile(`${path}.tmp`, snapshot, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    });
    persistChain = operation.catch(() => {});
    try {
      await operation;
    } catch {
      throw new Error('Google credentials could not be saved securely. Check the data directory.');
    }
  }
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  /** Google's own words for a failed request: the API, its reason code and message. Never contains credentials. */
  async function googleDetail(
    url: string,
    response: Response,
  ): Promise<{ reason: string; text: string }> {
    const api = /gmail\.googleapis/.test(url)
      ? 'Gmail'
      : /calendar/.test(url)
        ? 'Google Calendar'
        : /oauth2|accounts\.google/.test(url)
          ? 'Google sign-in'
          : 'Google';
    let reason = '',
      message = '';
    try {
      const body = (await response.json()) as Json;
      const error = body?.error;
      if (typeof error === 'string') {
        reason = error;
        message = typeof body.error_description === 'string' ? body.error_description : '';
      } else if (error && typeof error === 'object') {
        reason = String(
          error.errors?.[0]?.reason ??
            error.details?.find?.((d: Json) => d?.reason)?.reason ??
            error.status ??
            '',
        );
        message = typeof error.message === 'string' ? error.message : '';
      }
    } catch {
      /* Not JSON. */
    }
    message = message.replace(/\s+/g, ' ').trim().slice(0, 300);
    return {
      reason,
      text: `${api}${reason ? ` (${reason})` : ''}${message ? `: ${message.replace(/\.?$/, '.')}` : '.'}`,
    };
  }
  const RATE_REASONS =
    /^(rateLimitExceeded|userRateLimitExceeded|RATE_LIMIT_EXCEEDED|RESOURCE_EXHAUSTED|quotaExceeded|concurrentLimitExceeded)$/;
  async function fetchJson(url: string, init: RequestInit = {}): Promise<Json> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await request(url, {
          ...init,
          signal: init.signal ?? AbortSignal.timeout(45000),
        });
      } catch {
        throw new GoogleError(
          'Google could not be reached. Check your internet connection.',
          undefined,
          true,
        );
      }
      if (response.ok) {
        if (response.status === 204) return {};
        // A 2xx whose body was lost may still have been applied, so the outcome is unknown.
        try {
          return (await response.json()) as Json;
        } catch {
          throw new GoogleError(
            'Google returned an unreadable response. Please retry.',
            response.status,
            true,
          );
        }
      }
      const status = response.status,
        detail = await googleDetail(url, response);
      // Gmail and Calendar answer per-user rate limits with 403 as well as 429. The request was refused before it ran, so retrying is safe.
      const limited = status === 429 || (status === 403 && RATE_REASONS.test(detail.reason));
      if (limited && attempt < 5) {
        const after = Number(response.headers.get('retry-after'));
        await sleep(
          Number.isFinite(after) && after > 0
            ? Math.min(after * 1000, 30000)
            : Math.min(16000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500),
        );
        continue;
      }
      if (limited)
        throw new GoogleError(
          `Google rate limit reached. Please retry shortly. ${detail.text}`,
          429,
        );
      if (status === 401)
        throw new GoogleError(
          `Google authorization expired. Reconnect this account. ${detail.text}`,
          status,
        );
      if (status === 403)
        throw new GoogleError(`Google denied this request. ${detail.text}`, status);
      if (status === 404) throw new GoogleError('Google could not find this item.', status);
      throw new GoogleError(
        `Google request failed (${status}). Please retry. ${detail.text}`,
        status,
        status >= 500,
      );
    }
  }
  async function access(id: string): Promise<string> {
    const token = tokens[id];
    if (!token) throw new Error('This Google account needs to be reconnected.');
    if (token.expiresAt > Date.now() + 60000) return token.access_token;
    if (!token.refresh_token || !clientId)
      throw new Error('Google authorization expired. Reconnect this account.');
    const active = refreshes.get(id);
    if (active) return active;
    const promise = (async () => {
      const data = await fetchJson('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          refresh_token: token.refresh_token!,
          grant_type: 'refresh_token',
          ...(clientSecret ? { client_secret: clientSecret } : {}),
        }),
      });
      if (typeof data.access_token !== 'string')
        throw new Error('Google authorization expired. Reconnect this account.');
      if (tokens[id] !== token) throw new Error('This Google account was disconnected.');
      tokens[id] = {
        access_token: data.access_token,
        refresh_token: data.refresh_token ?? token.refresh_token,
        expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      };
      await persist();
      return data.access_token as string;
    })();
    refreshes.set(id, promise);
    try {
      return await promise;
    } finally {
      refreshes.delete(id);
    }
  }
  async function api(account: Account, url: string, method = 'GET', body?: unknown): Promise<Json> {
    const token = await access(account.id);
    return fetchJson(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  async function pages(account: Account, url: string, key: string): Promise<Json[]> {
    const items: Json[] = [];
    let next: string | undefined;
    do {
      const pageUrl = new URL(url);
      if (next) pageUrl.searchParams.set('pageToken', next);
      const page = await api(account, pageUrl.toString());
      items.push(...(Array.isArray(page[key]) ? page[key] : []));
      next = typeof page.nextPageToken === 'string' ? page.nextPageToken : undefined;
    } while (next);
    return items;
  }
  const notFound = (error: unknown) => error instanceof GoogleError && error.status === 404;
  async function listIds(account: Account, limit: number, query?: string): Promise<string[]> {
    const ids: string[] = [];
    let next: string | undefined;
    do {
      const url = new URL(`${gmail}/threads`);
      url.searchParams.set('maxResults', String(Math.min(500, limit - ids.length)));
      url.searchParams.set('includeSpamTrash', 'true');
      url.searchParams.set('q', query ?? APP_QUERY);
      if (next) url.searchParams.set('pageToken', next);
      const page = await api(account, url.toString());
      for (const row of Array.isArray(page.threads) ? page.threads : [])
        if (typeof row.id === 'string') ids.push(row.id);
      next = typeof page.nextPageToken === 'string' ? page.nextPageToken : undefined;
    } while (next && ids.length < limit);
    return ids.slice(0, limit);
  }
  /** Fetch with bounded concurrency; one entry per ID, undefined when the thread no longer exists. */
  async function each<T>(
    ids: string[],
    fn: (id: string) => Promise<T>,
  ): Promise<(T | undefined)[]> {
    const result: (T | undefined)[] = new Array(ids.length);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, ids.length) }, async () => {
        while (cursor < ids.length) {
          const at = cursor++;
          try {
            result[at] = await fn(ids[at]);
          } catch (error) {
            if (!notFound(error)) throw error;
            result[at] = undefined;
          }
        }
      }),
    );
    return result;
  }
  /** Undefined for the app-data thread, which is never shown as mail. */
  async function fullThread(account: Account, id: string): Promise<Thread | undefined> {
    const raw = (await api(account, `${gmail}/threads/${enc(id)}?format=full`)) as GmailThread;
    if (raw.messages?.some(m => header(m.payload, APP_HEADER))) return undefined;
    // Gmail can store a text/HTML body in messages.attachments just like a file.
    // Resolve those body parts before normalization; ordinary files stay lazy.
    for (const message of raw.messages ?? [])
      for (const part of flatten(message.payload))
        if (isBodyPart(part) && part.body?.attachmentId && !part.body.data) {
          const body = await api(
            account,
            `${gmail}/messages/${enc(message.id)}/attachments/${enc(part.body.attachmentId)}`,
          );
          if (typeof body.data !== 'string')
            throw new Error(
              'Google did not return the complete message body. Retry syncing this account.',
            );
          part.body = { ...part.body, data: body.data };
        }
    return normalizeGmailThread(raw, account);
  }
  async function flags(account: Account, id: string): Promise<ThreadFlags> {
    const raw = (await api(account, `${gmail}/threads/${enc(id)}?format=minimal`)) as GmailThread;
    const labels = [...new Set((raw.messages ?? []).flatMap(m => m.labelIds ?? []))];
    return {
      id: `${account.id}:${id}`,
      unread: labels.includes('UNREAD'),
      bookmarked: labels.includes('STARRED'),
      status: labelStatus(labels),
      labels,
    };
  }
  async function fullThreads(account: Account, ids: string[]): Promise<Thread[]> {
    return (await each(ids, id => fullThread(account, id)))
      .filter((t): t is Thread => !!t)
      .sort((a, b) => b.date.localeCompare(a.date));
  }
  async function freshWindow(account: Account): Promise<SyncResult> {
    // Read the position first so anything that changes while the window downloads is replayed next time.
    const profile = await api(account, `${gmail}/profile`);
    const threads = await fullThreads(account, await listIds(account, INITIAL_THREADS));
    return {
      threads,
      flags: [],
      removed: [],
      cursor: profile.historyId === undefined ? undefined : String(profile.historyId),
      reset: true,
    };
  }
  async function history(
    account: Account,
    cursor: string,
    context: SyncContext,
  ): Promise<SyncResult | undefined> {
    const changed = new Set<string>(),
      relabeled = new Set<string>(),
      hidden = appLabels.get(account.id);
    let latest = cursor,
      next: string | undefined,
      pages = 0;
    do {
      const url = new URL(`${gmail}/history`);
      url.searchParams.set('startHistoryId', cursor);
      url.searchParams.set('maxResults', '500');
      for (const type of ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'])
        url.searchParams.append('historyTypes', type);
      if (next) url.searchParams.set('pageToken', next);
      let page: Json;
      try {
        page = await api(account, url.toString());
      } catch (error) {
        if (notFound(error)) return undefined;
        throw error;
      }
      for (const record of Array.isArray(page.history) ? page.history : []) {
        const keep = (item: Json) =>
          item.message?.threadId && !(hidden && item.message.labelIds?.includes(hidden));
        for (const key of ['messagesAdded', 'messagesDeleted'])
          for (const item of record[key] ?? []) if (keep(item)) changed.add(item.message.threadId);
        for (const key of ['labelsAdded', 'labelsRemoved'])
          for (const item of record[key] ?? [])
            if (keep(item)) relabeled.add(item.message.threadId);
      }
      if (page.historyId !== undefined) latest = String(page.historyId);
      next = typeof page.nextPageToken === 'string' ? page.nextPageToken : undefined;
      if (++pages >= MAX_HISTORY_PAGES && next) return undefined;
    } while (next);
    const removed: string[] = [],
      updates: ThreadFlags[] = [];
    const labelOnly = [...relabeled].filter(id => !changed.has(id));
    const known = labelOnly.filter(id => context.has(`${account.id}:${id}`));
    // A thread this device never stored only matters once it is in the inbox; then it needs its messages.
    const discovered = new Set(labelOnly.filter(id => !context.has(`${account.id}:${id}`)));
    for (const id of discovered) changed.add(id);
    (await each(known, id => flags(account, id))).forEach((value, i) => {
      if (value) updates.push(value);
      else removed.push(`${account.id}:${known[i]}`);
    });
    const ids = [...changed],
      fetched = await each(ids, id => fullThread(account, id)),
      threads: Thread[] = [];
    fetched.forEach((thread, i) => {
      const id = `${account.id}:${ids[i]}`;
      if (!thread) {
        if (context.has(id)) removed.push(id);
        return;
      }
      if (!discovered.has(ids[i]) || thread.status === 'new') threads.push(thread);
    });
    return { threads, flags: updates, removed, cursor: latest, reset: false };
  }
  /** The hidden "Aplos Mail Data" label's ID, created hidden from the label list and message list when asked. */
  async function appLabel(account: Account, create: boolean): Promise<string | undefined> {
    const cached = appLabels.get(account.id);
    if (cached) return cached;
    const find = async () =>
      ((await api(account, `${gmail}/labels`)).labels ?? []).find(
        (l: Json) => l.type === 'user' && String(l.name).toLowerCase() === APP_LABEL.toLowerCase(),
      )?.id as string | undefined;
    let id = await find();
    if (!id && create) {
      try {
        id = String(
          (
            await api(account, `${gmail}/labels`, 'POST', {
              name: APP_LABEL,
              labelListVisibility: 'labelHide',
              messageListVisibility: 'hide',
            })
          ).id,
        );
      } catch (error) {
        if (!(error instanceof GoogleError && error.status === 409)) throw error;
        id = await find();
      }
    }
    if (id) appLabels.set(account.id, id);
    return id;
  }
  /** Run an app-data step, forgetting a cached label the user deleted and trying once more. */
  async function withAppLabel<T>(
    account: Account,
    create: boolean,
    fn: (label: string | undefined) => Promise<T>,
  ): Promise<T> {
    try {
      return await fn(await appLabel(account, create));
    } catch (error) {
      // Gmail answers 400 (invalid label) or 404 for a label ID that no longer exists.
      if (
        !(error instanceof GoogleError && (error.status === 400 || error.status === 404)) ||
        !appLabels.has(account.id)
      )
        throw error;
      appLabels.delete(account.id);
      return fn(await appLabel(account, create));
    }
  }
  /** App-data messages under the label, outside Trash and Spam. */
  async function appMessages(account: Account, label: string): Promise<string[]> {
    const url = new URL(`${gmail}/messages`);
    url.searchParams.set('labelIds', label);
    url.searchParams.set('maxResults', '50');
    return ((await api(account, url.toString())).messages ?? [])
      .map((m: Json) => m.id)
      .filter((id: unknown): id is string => typeof id === 'string');
  }
  function eventModel(raw: Json, account: Account, calendarId: string): CalendarEvent {
    return {
      id: `${account.id}:${calendarId}:${raw.id}`,
      remoteId: raw.id,
      accountId: account.id,
      calendarId,
      title: raw.summary ?? '(Untitled event)',
      start: raw.start?.dateTime ?? raw.start?.date ?? '',
      end: raw.end?.dateTime ?? raw.end?.date ?? '',
      allDay: Boolean(raw.start?.date),
      location: raw.location ?? '',
      description: raw.description ?? '',
      guests: (raw.attendees ?? []).map((x: Json) => x.email).filter(Boolean),
      url: raw.htmlLink,
    };
  }
  async function listCalendars(account: Account) {
    return (await pages(account, `${calendar}/users/me/calendarList?maxResults=250`, 'items')).map(
      item => ({
        id: String(item.id),
        name: String(item.summaryOverride ?? item.summary ?? item.id),
        accountId: account.id,
        ...(calendarColor(item.backgroundColor)
          ? { color: calendarColor(item.backgroundColor) }
          : {}),
        ...(item.primary === true ? { primary: true } : {}),
      }),
    );
  }
  async function getSendAs(account: Account): Promise<NonNullable<Account['sendAs']>> {
    const response = await api(account, `${gmail}/settings/sendAs`);
    if (!Array.isArray(response.sendAs))
      throw new Error(
        'Gmail sending addresses and signatures were unavailable. Reconnect this account; only its primary address can be used.',
      );
    const aliases = new Map<string, NonNullable<Account['sendAs']>[number]>();
    for (const item of response.sendAs) {
      if (
        typeof item.sendAsEmail !== 'string' ||
        !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(item.sendAsEmail)
      )
        continue;
      if (
        !item.isPrimary &&
        item.sendAsEmail.toLowerCase() !== account.email.toLowerCase() &&
        item.verificationStatus !== 'accepted'
      )
        continue;
      aliases.set(item.sendAsEmail.toLowerCase(), {
        email: item.sendAsEmail,
        name:
          typeof item.displayName === 'string'
            ? item.displayName.replace(/[\r\n]/g, ' ')
            : account.name,
        signature: typeof item.signature === 'string' ? item.signature : '',
        isDefault: item.isDefault === true,
      });
    }
    if (!aliases.has(account.email.toLowerCase()))
      aliases.set(account.email.toLowerCase(), {
        email: account.email,
        name: account.name,
        signature: '',
        isDefault: !Array.from(aliases.values()).some(a => a.isDefault),
      });
    return Array.from(aliases.values());
  }
  return {
    kind: 'google',
    available: Boolean(clientId),
    unavailableReason: clientId ? undefined : googleUnavailable,
    capabilities: () => CAPABILITIES,
    getSendAs,
    async connect(_request?: ConnectRequest): Promise<Account> {
      if (!clientId) throw new Error(googleUnavailable);
      if (!options.encrypt || !options.decrypt)
        throw new Error('Secure credential storage is unavailable. Connect using the desktop app.');
      if (!options.openExternal)
        throw new Error('Google sign-in requires the desktop app and a system browser.');
      if (server) throw new Error('A Google sign-in is already in progress.');
      const state = randomBytes(32).toString('base64url'),
        verifier = randomBytes(48).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      let redirect = '';
      let resolveCode!: (code: string) => void, rejectCode!: (error: Error) => void;
      const codePromise = new Promise<string>((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
      });
      // Attach rejection handling before opening a browser, which may itself fail.
      void codePromise.catch(() => {});
      const listener = createServer((req, res) => {
        const url = new URL(req.url ?? '/', redirect);
        if (url.pathname !== '/oauth/callback') {
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
          rejectCode(new Error('Google sign-in was declined.'));
          return;
        }
        res.end('<p>Sign-in received. You can close this tab and return to Aplos Mail.</p>');
        resolveCode(code);
      });
      server = listener;
      cancelConnect = () => rejectCode(new Error('Google sign-in cancelled.'));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          listener.once('error', reject);
          listener.listen(0, '127.0.0.1', () => resolve());
        });
        const address = listener.address();
        if (!address || typeof address === 'string')
          throw new Error('Google sign-in could not open its local callback.');
        redirect = `http://127.0.0.1:${address.port}/oauth/callback`;
        timer = setTimeout(
          () => rejectCode(new Error('Google sign-in timed out. Please try again.')),
          options.oauthTimeoutMs ?? 180000,
        );
        const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        const params = {
          client_id: clientId,
          redirect_uri: redirect,
          response_type: 'code',
          scope:
            'openid email profile https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.settings.basic https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events',
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          access_type: 'offline',
          prompt: 'consent',
        };
        auth.search = new URLSearchParams(params).toString();
        await options.openExternal(auth.toString());
        const code = await codePromise;
        const result = await fetchJson('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            redirect_uri: redirect,
            grant_type: 'authorization_code',
            code_verifier: verifier,
            ...(clientSecret ? { client_secret: clientSecret } : {}),
          }),
        });
        if (typeof result.access_token !== 'string')
          throw new Error('Google sign-in did not return access credentials.');
        const profile = await fetchJson('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${result.access_token}` },
        });
        if (typeof profile.email !== 'string' || typeof profile.sub !== 'string')
          throw new Error('Google did not return an account identity.');
        const id = `google-${profile.sub}`;
        tokens[id] = {
          access_token: result.access_token,
          refresh_token: result.refresh_token ?? tokens[id]?.refresh_token,
          expiresAt: Date.now() + (Number(result.expires_in) || 3600) * 1000,
        };
        try {
          await persist();
        } catch (error) {
          delete tokens[id];
          throw error;
        }
        const account: Account = {
          id,
          name: profile.name ?? profile.email,
          email: profile.email,
          provider: 'google',
          preset: 'gmail',
          capabilities: CAPABILITIES,
          color: '#738c80',
          connected: true,
          calendarConnected: true,
        };
        try {
          account.sendAs = await getSendAs(account);
        } catch {
          account.sendAs = [
            { email: account.email, name: account.name, signature: '', isDefault: true },
          ];
          account.error =
            'Gmail sending addresses and signatures are unavailable. Reconnect to grant settings access; using the primary address.';
        }
        return account;
      } finally {
        if (timer) clearTimeout(timer);
        listener.close();
        server = undefined;
        cancelConnect = undefined;
      }
    },
    async disconnect(accountId: string) {
      const token = tokens[accountId];
      delete tokens[accountId];
      appLabels.delete(accountId);
      await persist();
      if (token) {
        try {
          await request('https://oauth2.googleapis.com/revoke', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: token.refresh_token ?? token.access_token }),
            signal: AbortSignal.timeout(10000),
          });
        } catch {
          /* Local disconnect remains effective while offline. */
        }
      }
    },
    async sync(
      account: Account,
      cursor?: string,
      context: SyncContext = { has: () => false },
    ): Promise<SyncResult> {
      if (cursor) {
        const result = await history(account, cursor, context);
        if (result) return result;
      }
      return freshWindow(account);
    },
    search: async (account: Account, query: string) =>
      fullThreads(account, await listIds(account, SEARCH_THREADS, query)),
    async updateThread(account: Account, thread: RemoteThread, patch: Partial<Thread>) {
      if (!thread.remoteId) throw new Error('This thread has no Gmail identifier.');
      const url = `${gmail}/threads/${enc(thread.remoteId)}`;
      if (patch.status === 'trash') await api(account, `${url}/trash`, 'POST', {});
      if (thread.status === 'trash' && patch.status && patch.status !== 'trash')
        await api(account, `${url}/untrash`, 'POST', {});
      const addLabelIds: string[] = [],
        removeLabelIds: string[] = [];
      const label = (value: boolean, name: string) =>
        (value ? addLabelIds : removeLabelIds).push(name);
      if (patch.unread !== undefined) label(patch.unread, 'UNREAD');
      if (patch.bookmarked !== undefined) label(patch.bookmarked, 'STARRED');
      if (patch.importance !== undefined) label(patch.importance === 'important', 'IMPORTANT');
      if (patch.status) {
        label(patch.labels ? patch.labels.includes('INBOX') : patch.status === 'new', 'INBOX');
        label(patch.status === 'spam', 'SPAM');
      }
      if (addLabelIds.length || removeLabelIds.length)
        await api(account, `${url}/modify`, 'POST', { addLabelIds, removeLabelIds });
    },
    async send(account: Account, draft: Draft, thread?: Thread) {
      if (!draft.to.trim()) throw new Error('Add at least one recipient before sending.');
      const fromEmail = draft.fromEmail ?? account.email;
      for (const value of [draft.to, draft.cc, draft.bcc, draft.subject, fromEmail])
        if (/[\r\n]/.test(value)) throw new Error('Email headers cannot contain line breaks.');
      const alias = account.sendAs?.find(
        item => item.email.toLowerCase() === fromEmail.toLowerCase(),
      );
      if (fromEmail.toLowerCase() !== account.email.toLowerCase() && !alias)
        throw new Error(
          'This sending address is not authorized for this account. Sync the account and choose an available address.',
        );
      let gmailId: string | undefined,
        inReplyTo: string | undefined,
        references: string | undefined;
      if (draft.threadId && draft.mode !== 'new' && draft.mode !== 'forward') {
        gmailId =
          thread?.remoteId ??
          (draft.threadId.startsWith(`${account.id}:`)
            ? draft.threadId.slice(account.id.length + 1)
            : undefined);
        if (gmailId) {
          const raw = await api(
            account,
            `${gmail}/threads/${enc(gmailId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
          );
          const payload = raw.messages?.at(-1)?.payload as GmailPart | undefined;
          inReplyTo = header(payload, 'message-id') || undefined;
          references =
            [header(payload, 'references'), inReplyTo].filter(Boolean).join(' ') || undefined;
        }
      }
      const transport = nodemailer.createTransport({
        streamTransport: true,
        buffer: true,
        newline: 'windows',
      });
      const info = await transport.sendMail({
        ...(draft.messageId ? { messageId: draft.messageId } : {}),
        from: { name: alias?.name || account.name, address: alias?.email ?? account.email },
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
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      if (!Buffer.isBuffer(info.message)) throw new Error('Email could not be encoded for Gmail.');
      const raw = info.message;
      return api(account, `${gmail}/messages/send`, 'POST', {
        raw: raw.toString('base64url'),
        ...(gmailId ? { threadId: gmailId } : {}),
      });
    },
    /** Find a message we sent by its Message-ID, to settle a send whose outcome is unknown. */
    async findSent(
      account: Account,
      messageId: string,
    ): Promise<{ id: string; threadId: string } | undefined> {
      const url = new URL(`${gmail}/messages`);
      url.searchParams.set('q', `rfc822msgid:${messageId.replace(/^<|>$/g, '')}`);
      url.searchParams.set('includeSpamTrash', 'true');
      url.searchParams.set('maxResults', '1');
      const found = (await api(account, url.toString())).messages?.[0];
      return typeof found?.id === 'string' && typeof found.threadId === 'string'
        ? { id: found.id, threadId: found.threadId }
        : undefined;
    },
    async attachment(
      account: Account,
      _thread: Thread,
      attachment: Attachment,
    ): Promise<Attachment> {
      if (attachment.data) return attachment;
      if (!attachment.remoteId || !attachment.messageId)
        throw new Error('This attachment has no downloadable content.');
      const raw = await api(
        account,
        `${gmail}/messages/${enc(attachment.messageId)}/attachments/${enc(attachment.remoteId)}`,
      );
      if (typeof raw.data !== 'string') throw new Error('Google returned an empty attachment.');
      return { ...attachment, data: Buffer.from(raw.data, 'base64url').toString('base64') };
    },
    listCalendars,
    async listEvents(account: Account): Promise<CalendarEvent[]> {
      const calendars = await listCalendars(account);
      const result: CalendarEvent[] = [];
      const min = new Date();
      min.setDate(min.getDate() - 30);
      const max = new Date();
      max.setFullYear(max.getFullYear() + 1);
      for (const c of calendars) {
        const params = new URLSearchParams({
          singleEvents: 'true',
          orderBy: 'startTime',
          maxResults: '2500',
          timeMin: min.toISOString(),
          timeMax: max.toISOString(),
        });
        const rows = await pages(
          account,
          `${calendar}/calendars/${enc(c.id)}/events?${params}`,
          'items',
        );
        result.push(
          ...rows
            .filter(row => row.status !== 'cancelled')
            .map(row => eventModel(row, account, c.id)),
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
      const path = `${calendar}/calendars/${enc(event.calendarId || 'primary')}/events${event.remoteId ? `/${enc(event.remoteId)}` : ''}`;
      const raw = await api(account, `${path}?sendUpdates=none`, event.remoteId ? 'PUT' : 'POST', {
        summary: event.title,
        description: event.description,
        location: event.location,
        start: event.allDay
          ? { date: event.start.slice(0, 10) }
          : { dateTime: new Date(event.start).toISOString() },
        end: event.allDay
          ? { date: event.end.slice(0, 10) }
          : { dateTime: new Date(event.end).toISOString() },
        attendees: event.guests.map(email => ({ email })),
      });
      return { ...event, ...eventModel(raw, account, event.calendarId || 'primary'), id: event.id };
    },
    async deleteEvent(account: Account, event: CalendarEvent) {
      if (!event.remoteId) throw new Error('This event has no Google identifier.');
      await api(
        account,
        `${calendar}/calendars/${enc(event.calendarId)}/events/${enc(event.remoteId)}?sendUpdates=none`,
        'DELETE',
      );
    },
    async readAppData(account: Account): Promise<AppDataRecord[]> {
      return withAppLabel(account, false, async label => {
        if (!label) return [];
        // Normally one message; concurrent writers or an interrupted trash leave more, and the caller merges them all.
        // Metadata first, so mail the user filed under a label of the same name is never downloaded or touched.
        const ids = await appMessages(account, label),
          meta = await each(ids, id =>
            api(
              account,
              `${gmail}/messages/${enc(id)}?format=metadata&metadataHeaders=${APP_HEADER}`,
            ),
          );
        const owned = ids.filter((_, i) => header(meta[i]?.payload, APP_HEADER));
        const rows = await each(owned, id =>
            api(account, `${gmail}/messages/${enc(id)}?format=raw`),
          ),
          records: { id: string; data: string; at: number }[] = [];
        for (const [i, row] of rows.entries()) {
          if (typeof row?.raw !== 'string') continue;
          const mail = await simpleParser(Buffer.from(row.raw, 'base64url'), {
            skipTextToHtml: true,
            skipImageLinks: true,
            skipTextLinks: true,
          });
          const file = mail.headers.has(APP_HEADER.toLowerCase())
            ? mail.attachments.find(a => a.filename === APP_FILE)
            : undefined;
          if (file)
            records.push({
              id: owned[i],
              data: file.content.toString('utf8'),
              at: Number(row.internalDate ?? 0),
            });
        }
        return records.sort((a, b) => b.at - a.at).map(({ id, data }) => ({ id, data }));
      });
    },
    async writeAppData(account: Account, data: string, replaces: string[]) {
      if (Buffer.byteLength(data) > MAX_APP_DATA)
        throw new Error('Workflow data is too large to sync through Gmail.');
      const transport = nodemailer.createTransport({
        streamTransport: true,
        buffer: true,
        newline: 'windows',
      });
      const info = await transport.sendMail({
        from: { name: 'Aplos Mail', address: account.email },
        to: account.email,
        subject: 'Aplos sync data — do not edit',
        text: 'Aplos Mail keeps encrypted workflow data for this account here. Deleting this message resets it.',
        headers: { [APP_HEADER]: 'workflow' },
        attachments: [
          {
            filename: APP_FILE,
            content: data,
            contentType: 'application/octet-stream',
            contentTransferEncoding: 'quoted-printable',
          },
        ],
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      if (!Buffer.isBuffer(info.message))
        throw new Error('Workflow data could not be encoded for Gmail.');
      const raw = info.message.toString('base64url');
      await withAppLabel(account, true, async label => {
        // Only the label: no INBOX or UNREAD, so the message never shows up as new mail.
        const created = await api(
          account,
          `${gmail}/messages/insert?internalDateSource=receivedTime`,
          'POST',
          { raw, labelIds: [label!] },
        );
        // Only the copies the caller merged: another device's copy written meanwhile must survive until it is read.
        // gmail.modify cannot delete messages, so they go to Trash; a failed trash leaves a copy the next round merges and replaces again.
        try {
          await each(
            replaces.filter(id => id !== created.id),
            id => api(account, `${gmail}/messages/${enc(id)}/trash`, 'POST', {}),
          );
        } catch {
          /* See above. */
        }
      });
    },
    close() {
      cancelConnect?.();
      server?.close();
    },
  };
}
