import { Buffer } from 'node:buffer';
import { types } from 'node:util';
import { RunnerError } from './errors';
import { decodeRaw, isPlainAddress, recipientAddresses, UnparseableMessage } from './recipients';
import type { RequestCount, Tier } from './types';

/**
 * The safety core of the live runner. Every request a probe makes goes through `createGuardedFetch`,
 * and the guard decides BEFORE a byte is sent. The design is default-deny: a request is allowed only
 * if it matches a row of the table below and passes that row's extra checks. Anything unknown
 * (a new endpoint, another host, an odd URL form) is refused, so a mistake in a probe can only
 * make a run fail, never touch the mailbox.
 *
 * The guard never puts an address, id, URL or token in an error message or a log.
 */

export type GuardReason =
  | 'origin-not-allowed'
  | 'unsupported-request'
  | 'url-not-canonical'
  | 'method-override'
  | 'tier-r-read-only'
  | 'unknown-endpoint'
  | 'batch-unsupported'
  | 'permanent-delete'
  | 'settings-write'
  | 'filter-forward'
  | 'filter-not-created-by-run'
  | 'label-not-created-by-run'
  | 'calendar-list-write'
  | 'calendar-put-replaces'
  | 'calendar-not-own'
  | 'calendar-event-not-created-by-run'
  | 'label-spam-trash'
  | 'calendar-send-updates'
  | 'calendar-attendees'
  | 'calendar-rsvp'
  | 'calendar-write-not-allowed'
  | 'calendar-field'
  | 'calendar-run-id'
  | 'body-unparseable'
  | 'send-tier'
  | 'send-upload-type'
  | 'send-unparseable'
  | 'send-recipients'
  | 'draft-not-verified-self';

export class GuardRefusal extends RunnerError {
  constructor(
    readonly reason: GuardReason,
    readonly api?: string,
  ) {
    super(`Guard refused a request (${reason}${api ? `, ${api}` : ''})`);
    this.name = 'GuardRefusal';
  }
}

export interface GuardOptions {
  tier: Tier;
  /** The account's own address. Required for S-self; it is only ever compared, never logged. */
  selfAddress?: string;
  /**
   * Ids of filters this run created. Only these may be deleted. The guard adds the ids of filters
   * it sees created, so a probe cannot delete a filter it did not make.
   */
  allowRunFilterIds?: Set<string>;
  /**
   * Turns on run-scoped calendar writes (tier M only; orchestrator decision 2026-10-28). The agent
   * test account may create, rename, re-time, re-describe and delete events on its own primary
   * calendar, only events this run created, each tagged with this id in a private extended
   * property; no attendees, no RSVPs, no notifications, no PUT. Absent means no calendar writes.
   */
  calendarRunId?: string;
}

export interface GuardedFetch {
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response>;
  /** Requests that were actually sent, by API method name and HTTP verb. */
  requests(): RequestCount[];
  /** How often each refusal reason fired. */
  refusals(): Partial<Record<GuardReason, number>>;
  createdLabelIds: ReadonlySet<string>;
}

// ---------- the rule table ----------

const GMAIL_HOST = 'https://gmail.googleapis.com';
const API_HOST = 'https://www.googleapis.com';
const OAUTH_HOST = 'https://oauth2.googleapis.com';
const OPENID_HOST = 'https://openidconnect.googleapis.com';
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([GMAIL_HOST, API_HOST, OAUTH_HOST, OPENID_HOST]);

type Kind = 'read' | 'write' | 'send' | 'token' | 'forbidden';
/** Extra checks and bookkeeping a row needs. */
type Effect =
  | 'label-create'
  | 'label-delete'
  | 'filter-create'
  | 'filter-delete'
  | 'draft-write'
  | 'draft-send'
  | 'send-json'
  | 'send-media'
  | 'calendar-write'
  | 'label-modify';

interface Rule {
  origin: string;
  methods: readonly string[];
  path: RegExp;
  api: string;
  kind: Kind;
  reason?: GuardReason;
  effect?: Effect;
}

// An id segment: letters, digits and a few safe marks. No ':' (custom verbs) and no encoded slashes.
const ID = String.raw`(?:[A-Za-z0-9._~+=@-]|%40|%23|%2[bB])+`;

function pathOf(template: string): RegExp {
  const source = template
    .split('/')
    .map(part => (part.startsWith(':') ? ID : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${source}$`);
}

const GM = '/gmail/v1/users/me/';
const UP = '/upload/gmail/v1/users/me/';
const CAL = '/calendar/v3/';

const gmail = (methods: string[], tail: string, api: string, kind: Kind, extra: Partial<Rule> = {}): Rule => ({
  origin: GMAIL_HOST, methods, path: pathOf(GM + tail), api, kind, ...extra,
});
const calendar = (methods: string[], tail: string, api: string, kind: Kind, extra: Partial<Rule> = {}): Rule => ({
  origin: API_HOST, methods, path: pathOf(CAL + tail), api, kind, ...extra,
});

/** First match wins, so specific rows come before the catch-alls at the end of each group. */
const RULES: readonly Rule[] = [
  // OAuth. The token endpoint is the one POST tier R may make (access-token refresh).
  { origin: OAUTH_HOST, methods: ['POST'], path: /^\/token$/, api: 'oauth.token', kind: 'token' },
  { origin: OPENID_HOST, methods: ['GET'], path: /^\/v1\/userinfo$/, api: 'oauth.userinfo', kind: 'read' },
  { origin: API_HOST, methods: ['GET'], path: /^\/oauth2\/v3\/userinfo$/, api: 'oauth.userinfo', kind: 'read' },

  // Gmail reads
  gmail(['GET'], 'profile', 'gmail.users.getProfile', 'read'),
  gmail(['GET'], 'labels', 'gmail.users.labels.list', 'read'),
  gmail(['GET'], 'labels/:id', 'gmail.users.labels.get', 'read'),
  gmail(['GET'], 'history', 'gmail.users.history.list', 'read'),
  gmail(['GET'], 'messages', 'gmail.users.messages.list', 'read'),
  gmail(['GET'], 'messages/:id', 'gmail.users.messages.get', 'read'),
  gmail(['GET'], 'messages/:id/attachments/:aid', 'gmail.users.messages.attachments.get', 'read'),
  gmail(['GET'], 'threads', 'gmail.users.threads.list', 'read'),
  gmail(['GET'], 'threads/:id', 'gmail.users.threads.get', 'read'),
  gmail(['GET'], 'drafts', 'gmail.users.drafts.list', 'read'),
  gmail(['GET'], 'drafts/:id', 'gmail.users.drafts.get', 'read'),
  gmail(['GET'], 'settings/filters', 'gmail.users.settings.filters.list', 'read'),
  gmail(['GET'], 'settings/filters/:id', 'gmail.users.settings.filters.get', 'read'),
  gmail(['GET'], 'settings/sendAs', 'gmail.users.settings.sendAs.list', 'read'),

  // Gmail permanent deletes: refused in every tier
  gmail(['DELETE'], 'messages/:id', 'gmail.users.messages.delete', 'forbidden', { reason: 'permanent-delete' }),
  gmail(['POST'], 'messages/batchDelete', 'gmail.users.messages.batchDelete', 'forbidden', { reason: 'permanent-delete' }),
  gmail(['DELETE'], 'threads/:id', 'gmail.users.threads.delete', 'forbidden', { reason: 'permanent-delete' }),
  gmail(['DELETE'], 'drafts/:id', 'gmail.users.drafts.delete', 'forbidden', { reason: 'permanent-delete' }),

  // Gmail reversible writes (tiers M and S-self)
  gmail(['POST'], 'labels', 'gmail.users.labels.create', 'write', { effect: 'label-create' }),
  gmail(['DELETE'], 'labels/:id', 'gmail.users.labels.delete', 'write', { effect: 'label-delete' }),
  gmail(['POST'], 'messages/batchModify', 'gmail.users.messages.batchModify', 'write', { effect: 'label-modify' }),
  gmail(['POST'], 'messages/:id/modify', 'gmail.users.messages.modify', 'write', { effect: 'label-modify' }),
  gmail(['POST'], 'threads/:id/modify', 'gmail.users.threads.modify', 'write', { effect: 'label-modify' }),
  gmail(['POST'], 'drafts', 'gmail.users.drafts.create', 'write', { effect: 'draft-write' }),
  gmail(['PUT'], 'drafts/:id', 'gmail.users.drafts.update', 'write', { effect: 'draft-write' }),
  gmail(['POST'], 'settings/filters', 'gmail.users.settings.filters.create', 'write', { effect: 'filter-create' }),
  gmail(['DELETE'], 'settings/filters/:id', 'gmail.users.settings.filters.delete', 'write', { effect: 'filter-delete' }),
  // Every other settings write (sendAs, forwarding, delegates, imap, pop, vacation, language, ...)
  { origin: GMAIL_HOST, methods: ['POST', 'PUT', 'PATCH', 'DELETE'], path: /^\/gmail\/v1\/users\/me\/settings(?:\/.*)?$/, api: 'gmail.users.settings.write', kind: 'forbidden', reason: 'settings-write' },

  // Gmail sends (tier S-self only, recipients checked)
  gmail(['POST'], 'messages/send', 'gmail.users.messages.send', 'send', { effect: 'send-json' }),
  gmail(['POST'], 'drafts/send', 'gmail.users.drafts.send', 'send', { effect: 'draft-send' }),
  { origin: GMAIL_HOST, methods: ['POST'], path: pathOf(UP + 'messages/send'), api: 'gmail.users.messages.send', kind: 'send', effect: 'send-media' },
  { origin: GMAIL_HOST, methods: ['POST'], path: pathOf(UP + 'drafts/send'), api: 'gmail.users.drafts.send', kind: 'send', effect: 'send-media' },
  // A batch could hide any of the above in a part, so batches are not supported at all yet.
  { origin: GMAIL_HOST, methods: ['POST'], path: /^\/batch\/gmail\/v1$/, api: 'gmail.batch', kind: 'forbidden', reason: 'batch-unsupported' },
  { origin: API_HOST, methods: ['POST'], path: /^\/batch\/calendar\/v3$/, api: 'calendar.batch', kind: 'forbidden', reason: 'batch-unsupported' },

  // Calendar reads
  calendar(['GET'], 'users/me/calendarList', 'calendar.calendarList.list', 'read'),
  calendar(['GET'], 'users/me/calendarList/:id', 'calendar.calendarList.get', 'read'),
  calendar(['GET'], 'calendars/:cid/events', 'calendar.events.list', 'read'),
  calendar(['GET'], 'calendars/:cid/events/:id', 'calendar.events.get', 'read'),
  calendar(['GET'], 'calendars/:cid/events/:id/instances', 'calendar.events.instances', 'read'),

  // Calendar: the calendar list is never written; PUT replaces the whole event (and its guests)
  { origin: API_HOST, methods: ['POST', 'PUT', 'PATCH', 'DELETE'], path: /^\/calendar\/v3\/users\/me\/calendarList(?:\/.*)?$/, api: 'calendar.calendarList.write', kind: 'forbidden', reason: 'calendar-list-write' },
  calendar(['PUT'], 'calendars/:cid/events/:id', 'calendar.events.update', 'forbidden', { reason: 'calendar-put-replaces' }),
  calendar(['POST'], 'calendars/:cid/events', 'calendar.events.insert', 'write', { effect: 'calendar-write' }),
  calendar(['PATCH'], 'calendars/:cid/events/:id', 'calendar.events.patch', 'write', { effect: 'calendar-write' }),
  calendar(['DELETE'], 'calendars/:cid/events/:id', 'calendar.events.delete', 'write', { effect: 'calendar-write' }),
];

/** Every API method name the guard can let through. Evidence files may name only these. */
export const GUARD_API_METHODS: readonly string[] = [...new Set(RULES.filter(rule => rule.kind !== 'forbidden').map(rule => rule.api))].sort();

export function classify(method: string, url: URL): { api: string; kind: Kind } | undefined {
  const rule = RULES.find(r => r.origin === url.origin && r.methods.includes(method) && r.path.test(url.pathname));
  return rule && { api: rule.api, kind: rule.kind };
}

// ---------- helpers ----------

const VERBS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const OVERRIDE_HEADERS = ['x-http-method-override', 'x-http-method', 'x-method-override'];
/**
 * The only headers a probe may set. Anything else (Host, a verb override, Authorization, framing
 * headers) is refused rather than judged: the bearer layer adds the token itself.
 */
const ALLOWED_HEADERS: ReadonlySet<string> = new Set(['content-type', 'accept', 'accept-encoding', 'accept-language', 'cache-control', 'if-match', 'if-none-match', 'if-modified-since', 'user-agent']);
/** The only keys of `init` that are read; any other key is refused. `redirect` is read but always replaced. */
const INIT_KEYS: ReadonlySet<string> = new Set(['method', 'headers', 'body', 'redirect', 'signal']);
/** Query keys whose value the guard reads, by lowercase name. A repeat or another spelling could be read differently by Google. */
const RESERVED_QUERY_KEYS: ReadonlyMap<string, string> = new Map(['uploadType', 'sendUpdates', 'sendNotifications', 'format', 'alt'].map(key => [key.toLowerCase(), key]));
const SYSTEM_LABELS_REFUSED: ReadonlySet<string> = new Set(['SPAM', 'TRASH']);

/** Google APIs accept a verb override on a POST, which would turn a "POST" into a DELETE. */
function hasMethodOverride(url: URL, headerNames: readonly string[]): boolean {
  if (OVERRIDE_HEADERS.some(name => headerNames.includes(name))) return true;
  return [...url.searchParams.keys()].some(key => ['$httpmethod', '_method', 'x-http-method-override'].includes(key.toLowerCase()));
}

/**
 * The request as the guard understood it. It is copied out of the caller's objects ONCE, in one
 * synchronous step, and from then on only this copy is checked, logged and sent. A caller can
 * therefore not change a request after the check (a getter that answers differently the second
 * time, a header or body edited while the guard waits, a Blob whose methods lie).
 */
interface Snapshot {
  url: URL;
  method: string;
  /** Lowercase names, frozen. Handed to the layers below as plain pairs, never as a live Headers. */
  headers: readonly (readonly [string, string])[];
  body: CapturedBody;
  signal?: AbortSignal;
}

type CapturedBody = { bytes: Buffer; send?: string | Uint8Array; contentType?: string } | { blob: Blob };

function copyOf(bytes: Uint8Array): { bytes: Buffer; send: Uint8Array } {
  const copy = new Uint8Array(bytes);
  return { bytes: Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength), send: copy };
}

/** Only plain data is accepted. Intrinsic methods are used so a subclass cannot answer for the real thing. */
function captureBody(body: unknown): CapturedBody {
  if (body === undefined || body === null) return { bytes: Buffer.alloc(0) };
  if (typeof body === 'string') return { bytes: Buffer.from(body, 'utf8'), send: body };
  if (body instanceof URLSearchParams) {
    const text = URLSearchParams.prototype.toString.call(body);
    return { bytes: Buffer.from(text, 'utf8'), send: text, contentType: 'application/x-www-form-urlencoded;charset=UTF-8' };
  }
  if (types.isArrayBuffer(body)) return copyOf(new Uint8Array(body));
  if (types.isUint8Array(body)) return copyOf(body);
  if (body instanceof Blob) return { blob: body };
  // Streams and form data cannot be read without consuming them, so they cannot be checked.
  throw new GuardRefusal('body-unparseable');
}

async function resolveBody(body: CapturedBody): Promise<{ bytes: Buffer; send?: string | Uint8Array; contentType?: string }> {
  if (!('blob' in body)) return body;
  const type = Object.getOwnPropertyDescriptor(Blob.prototype, 'type')?.get?.call(body.blob) as string;
  return { ...copyOf(new Uint8Array(await Blob.prototype.arrayBuffer.call(body.blob))), ...(type ? { contentType: type } : {}) };
}

function captureHeaders(raw: unknown): [string, string][] {
  let entries: Iterable<unknown>;
  if (raw === undefined) entries = [];
  else if (raw instanceof Headers) entries = Headers.prototype.entries.call(raw);
  else if (Array.isArray(raw)) entries = raw;
  else if (raw && typeof raw === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(raw))) entries = Object.entries(raw);
  else throw new GuardRefusal('unsupported-request');
  const pairs: [string, string][] = [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new GuardRefusal('unsupported-request');
    const [name, value] = [entry[0], entry[1]] as unknown[];
    if (typeof name !== 'string' || typeof value !== 'string') throw new GuardRefusal('unsupported-request');
    pairs.push([name.toLowerCase(), value]);
  }
  // Two headers of one name are read differently by different servers.
  if (new Set(pairs.map(([name]) => name)).size !== pairs.length) throw new GuardRefusal('unsupported-request');
  new Headers(pairs); // throws on an illegal name or value
  return pairs;
}

function capture(input: unknown, init: unknown): Snapshot {
  try {
    // Only plain URLs: a Request object carries a body stream that cannot be checked unread.
    const href = typeof input === 'string' ? input : input instanceof URL ? URL.prototype.toString.call(input) : undefined;
    if (href === undefined) throw new GuardRefusal('unsupported-request');
    const url = new URL(href);
    if (init !== undefined && (init === null || typeof init !== 'object' || Object.keys(init).some(key => !INIT_KEYS.has(key)))) throw new GuardRefusal('unsupported-request');
    const options = (init ?? {}) as Record<string, unknown>;
    // Each field is read exactly once, here.
    const [rawMethod, rawHeaders, rawBody, rawSignal] = [options.method, options.headers, options.body, options.signal];
    if (rawMethod !== undefined && typeof rawMethod !== 'string') throw new GuardRefusal('unsupported-request');
    if (rawSignal !== undefined && !(rawSignal instanceof AbortSignal)) throw new GuardRefusal('unsupported-request');
    const headers = captureHeaders(rawHeaders);
    let body: CapturedBody;
    try {
      body = captureBody(rawBody);
    } catch {
      throw new GuardRefusal('body-unparseable');
    }
    return { url, method: (rawMethod ?? 'GET').toUpperCase(), headers, body, ...(rawSignal ? { signal: rawSignal } : {}) };
  } catch (error) {
    if (error instanceof GuardRefusal) throw error;
    throw new GuardRefusal('unsupported-request');
  }
}

/**
 * JSON.parse keeps the LAST of two equal keys; some parsers keep the first. A body that reads
 * differently depending on the parser could pass the check as one thing and act as another, so
 * duplicate keys at any depth are refused. The text must already be valid JSON.
 */
function hasDuplicateKeys(text: string): boolean {
  let i = 0;
  const space = (): void => {
    while (i < text.length && ' \t\n\r'.includes(text[i]!)) i++;
  };
  const string = (): string => {
    const start = i++;
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    return JSON.parse(text.slice(start, ++i)) as string;
  };
  const value = (): boolean => {
    space();
    const c = text[i];
    if (c === '"') {
      string();
    } else if (c === '{') {
      const keys = new Set<string>();
      i++;
      space();
      if (text[i] === '}') {
        i++;
        return false;
      }
      for (;;) {
        space();
        const key = string();
        if (keys.has(key)) return true;
        keys.add(key);
        space();
        i++; // ':'
        if (value()) return true;
        space();
        if (text[i++] === '}') break;
      }
    } else if (c === '[') {
      i++;
      space();
      if (text[i] === ']') {
        i++;
        return false;
      }
      for (;;) {
        if (value()) return true;
        space();
        if (text[i++] === ']') break;
      }
    } else {
      while (i < text.length && !',]} \t\n\r'.includes(text[i]!)) i++;
    }
    return false;
  };
  try {
    return value();
  } catch {
    return true; // too deep or not what was expected: refuse
  }
}

function jsonObject(bytes: Buffer, api: string): Record<string, unknown> {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value) && !hasDuplicateKeys(text)) return value as Record<string, unknown>;
  } catch {
    // fall through to the refusal
  }
  throw new GuardRefusal('body-unparseable', api);
}

/** True if any object key at any depth has one of the given names. */
function hasKeyDeep(value: unknown, names: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.some(item => hasKeyDeep(item, names));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, inner]) => names.has(key) || hasKeyDeep(inner, names));
  }
  return false;
}

function stringId(value: unknown): string | undefined {
  return value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined;
}

/** The last path segment, decoded, so `d%2b1` and `d+1` are one id in every set the guard keeps. */
function lastSegment(url: URL): string {
  const raw = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// ---------- the guard ----------

type Verdict = 'self-only' | 'unparseable' | 'other-recipients';

/** What the guard remembers between reading a request and seeing its answer. */
interface Pending {
  /** Draft write: whether the stored draft will hold only the account's own address. */
  selfOnly?: boolean;
  /** Draft update or draft send: the draft's id, taken from the path or the request body. */
  draftId?: string;
}

/** Rows whose request body must be read and checked before anything is sent. */
const BODY_CHECKED: ReadonlySet<Effect> = new Set(['send-json', 'send-media', 'draft-send', 'draft-write', 'filter-create', 'calendar-write', 'label-modify']);

const PATCH_FIELDS: ReadonlySet<string> = new Set(['summary', 'description', 'start', 'end']);
const INSERT_FIELDS: ReadonlySet<string> = new Set([...PATCH_FIELDS, 'conferenceData', 'extendedProperties']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Only `{createRequest: {requestId, conferenceSolutionKey: {type: 'hangoutsMeet'}}}`: a new Meet room, nothing copied in. */
function isMeetCreateRequest(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).join() !== 'createRequest' || !isRecord(value.createRequest)) return false;
  const request = value.createRequest;
  const keys = Object.keys(request).sort().join();
  return keys === 'conferenceSolutionKey,requestId' && typeof request.requestId === 'string'
    && isRecord(request.conferenceSolutionKey) && Object.keys(request.conferenceSolutionKey).join() === 'type'
    && request.conferenceSolutionKey.type === 'hangoutsMeet';
}

const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/;

export function createGuardedFetch(inner: typeof fetch, options: GuardOptions): GuardedFetch {
  const { tier } = options;
  const self = options.selfAddress?.toLowerCase();
  if (self !== undefined && !isPlainAddress(self)) throw new Error('selfAddress is not a plain address');
  if (tier === 'S-self' && self === undefined) throw new Error('Tier S-self needs the account address');
  const runFilterIds = options.allowRunFilterIds ?? new Set<string>();
  const createdLabelIds = new Set<string>();
  // Calendar events this run inserted. Only these may be changed or deleted.
  const runEventIds = new Set<string>();
  // Drafts this guard saw created or updated holding only the account's own address.
  const selfDrafts = new Set<string>();
  // Requests on one draft run one at a time, so the order the guard checks them in is the order
  // the server applies them in (otherwise the last answer to arrive could re-mark a draft that the
  // server has since changed to another recipient).
  const draftTails = new Map<string, Promise<void>>();
  const sent = new Map<string, RequestCount>();
  const refused: Partial<Record<GuardReason, number>> = {};

  const refuse = (reason: GuardReason, api?: string): never => {
    refused[reason] = (refused[reason] ?? 0) + 1;
    throw new GuardRefusal(reason, api);
  };

  const verdictOf = (message: Buffer): Verdict => {
    try {
      const addresses = recipientAddresses(message);
      return addresses.length > 0 && addresses.every(address => address === self) ? 'self-only' : 'other-recipients';
    } catch (error) {
      if (error instanceof UnparseableMessage) return 'unparseable';
      throw error;
    }
  };
  const verdictOfRaw = (raw: unknown): Verdict => {
    try {
      return verdictOf(decodeRaw(raw));
    } catch (error) {
      if (error instanceof UnparseableMessage) return 'unparseable';
      throw error;
    }
  };
  /** Sends: anything but "all recipients are the account itself" is refused. */
  const requireSelfOnly = (verdict: Verdict, api: string): void => {
    if (verdict === 'unparseable') refuse('send-unparseable', api);
    if (verdict === 'other-recipients') refuse('send-recipients', api);
  };

  /**
   * Run-scoped events carry only these fields. An insert must tag the event with this run's id
   * (extendedProperties.private.aplosLiveRun) and may ask for a new Meet room; a patch may rename,
   * re-time or re-describe it and may not touch the tag or the room.
   */
  const checkCalendarFields = (body: Record<string, unknown>, api: string): void => {
    const insert = api === 'calendar.events.insert';
    const allowed = insert ? INSERT_FIELDS : PATCH_FIELDS;
    if (Object.keys(body).some(key => !allowed.has(key))) refuse('calendar-field', api);
    if (body.conferenceData !== undefined && !isMeetCreateRequest(body.conferenceData)) refuse('calendar-field', api);
    if (insert) {
      const tag = body.extendedProperties;
      const run = options.calendarRunId;
      const ok = isRecord(tag) && Object.keys(tag).length === 1 && isRecord(tag.private)
        && Object.keys(tag.private).length === 1 && run !== undefined && tag.private.aplosLiveRun === run;
      if (!ok) refuse('calendar-run-id', api);
    }
  };

  const ownCalendar = (url: URL): boolean => {
    let id: string;
    try {
      id = decodeURIComponent(url.pathname.split('/')[4] ?? '').toLowerCase();
    } catch {
      return false;
    }
    return id === 'primary' || (self !== undefined && id === self);
  };

  const withDraftLock = <T>(key: string | undefined, work: () => Promise<T>): Promise<T> => {
    if (key === undefined) return work();
    const turn = (draftTails.get(key) ?? Promise.resolve()).then(work);
    const tail = turn.then(() => undefined, () => undefined);
    draftTails.set(key, tail);
    void tail.then(() => {
      if (draftTails.get(key) === tail) draftTails.delete(key);
    });
    return turn;
  };

  /** Checks the body of a rule that needs it. Throws a refusal, or returns what to remember. */
  function checkBody(rule: Rule, url: URL, headers: ReadonlyMap<string, string>, bytes: Buffer): Pending {
    const api = rule.api;
    // The server picks its parser from the content type, so a body checked as JSON must be
    // labelled as JSON (and a media upload as a plain RFC 822 message), nothing else.
    const type = headers.get('content-type')?.trim().toLowerCase();
    if (rule.effect === 'send-media' && url.searchParams.get('uploadType') !== 'media') refuse('send-upload-type', api);
    // (An empty body has no parser to confuse; rows that need a body refuse it below.)
    if (bytes.length && (rule.effect === 'send-media' ? type !== 'message/rfc822' : type === undefined || !JSON_TYPE.test(type))) refuse('body-unparseable', api);
    switch (rule.effect) {
      case 'send-json':
        requireSelfOnly(verdictOfRaw(jsonObject(bytes, api).raw), api);
        return {};
      case 'send-media':
        // Only the simple media upload (checked above), where the body IS the RFC 822 message.
        // Multipart and resumable uploads wrap it in framing this guard does not parse.
        requireSelfOnly(verdictOf(bytes), api);
        return {};
      case 'draft-send': {
        const body = jsonObject(bytes, api);
        const draftId = typeof body.id === 'string' ? body.id : undefined;
        // The guard cannot see a stored draft's recipients, so only drafts it verified itself may be sent.
        if (draftId === undefined || !selfDrafts.has(draftId)) refuse('draft-not-verified-self', api);
        if (body.message !== undefined) requireSelfOnly(verdictOfRaw((body.message as { raw?: unknown } | null)?.raw), api);
        return { draftId };
      }
      case 'draft-write': {
        const message = jsonObject(bytes, api).message as { raw?: unknown } | undefined;
        if (!message || typeof message !== 'object') refuse('body-unparseable', api);
        // A draft may hold other recipients; it just stops being sendable by this guard.
        const draftId = rule.methods[0] === 'PUT' ? lastSegment(url) : undefined;
        if (draftId !== undefined) selfDrafts.delete(draftId);
        return { selfOnly: verdictOfRaw(message?.raw) === 'self-only', draftId };
      }
      case 'filter-create':
        // A filter can forward every matching message to another address, which is a send.
        if (hasKeyDeep(jsonObject(bytes, api), new Set(['forward']))) refuse('filter-forward', api);
        return {};
      case 'label-modify': {
        // Spam reports go back to Google and Trash is purged after 30 days: neither is reversible.
        const added = jsonObject(bytes, api).addLabelIds;
        if (added !== undefined && (!Array.isArray(added) || added.some(label => typeof label !== 'string'))) refuse('body-unparseable', api);
        if ((added as string[] | undefined)?.some(label => SYSTEM_LABELS_REFUSED.has(label.toUpperCase()))) refuse('label-spam-trash', api);
        return {};
      }
      case 'calendar-write': {
        // Calendar writes exist only in tier M with a run id (orchestrator decision 2026-10-28).
        if (tier !== 'M' || options.calendarRunId === undefined) refuse('calendar-write-not-allowed', api);
        // Guests are notified by default, so "none" must be written out, not left to a default.
        // sendNotifications is the older spelling of the same switch: only an explicit "false" is safe.
        const notifications = url.searchParams.get('sendNotifications');
        if (url.searchParams.get('sendUpdates') !== 'none' || (notifications !== null && notifications !== 'false')) refuse('calendar-send-updates', api);
        if (bytes.length) {
          const body = jsonObject(bytes, api);
          if (hasKeyDeep(body, new Set(['responseStatus']))) refuse('calendar-rsvp', api);
          if (hasKeyDeep(body, new Set(['attendees']))) refuse('calendar-attendees', api);
          checkCalendarFields(body, api);
        } else if (api !== 'calendar.events.delete') {
          refuse('calendar-run-id', api);
        }
        return {};
      }
      default:
        return {};
    }
  }

  /** Bookkeeping that only a successful answer may change. */
  async function remember(rule: Rule, url: URL, pending: Pending, response: Response): Promise<void> {
    if (!response.ok) return;
    const createdId = async (): Promise<string | undefined> => stringId(await response.clone().json().catch(() => undefined));
    switch (rule.effect) {
      case 'label-create': {
        const id = await createdId();
        if (id !== undefined) createdLabelIds.add(id);
        break;
      }
      case 'label-delete':
        createdLabelIds.delete(lastSegment(url));
        break;
      case 'filter-create': {
        const id = await createdId();
        if (id !== undefined) runFilterIds.add(id);
        break;
      }
      case 'filter-delete':
        runFilterIds.delete(lastSegment(url));
        break;
      case 'draft-write': {
        const id = pending.draftId ?? (await createdId());
        if (pending.selfOnly && id !== undefined) selfDrafts.add(id);
        break;
      }
      case 'draft-send':
        if (pending.draftId !== undefined) selfDrafts.delete(pending.draftId);
        break;
      case 'calendar-write': {
        if (rule.api === 'calendar.events.insert') {
          // Only an event Google stored with this run's tag becomes changeable or deletable.
          const created = await response.clone().json().catch(() => undefined);
          const id = stringId(created);
          const tag = isRecord(created) && isRecord(created.extendedProperties) && isRecord(created.extendedProperties.private)
            ? created.extendedProperties.private.aplosLiveRun : undefined;
          if (id !== undefined && tag === options.calendarRunId) runEventIds.add(id);
        } else if (rule.api === 'calendar.events.delete') {
          runEventIds.delete(lastSegment(url));
        }
        break;
      }
    }
  }

  const guarded = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    // Nothing above this line awaits: the caller's objects are copied before anything can interleave.
    let request: Snapshot;
    try {
      request = capture(input, init);
    } catch (error) {
      if (error instanceof GuardRefusal) return refuse(error.reason, error.api);
      throw error;
    }
    const { url, method } = request;
    const headers = new Map(request.headers);

    if (url.protocol !== 'https:' || !ALLOWED_ORIGINS.has(url.origin) || url.username || url.password) return refuse('origin-not-allowed');
    if (/%2f|%5c|%00|\/\//i.test(url.pathname)) return refuse('url-not-canonical');
    if (!VERBS.has(method)) return refuse('unsupported-request');
    if (hasMethodOverride(url, [...headers.keys()])) return refuse('method-override');
    if ([...headers.keys()].some(name => !ALLOWED_HEADERS.has(name))) return refuse('unsupported-request');

    // A repeated key could be read as its first value by Google and its last by this guard.
    // Reads may repeat other keys (labelIds, metadataHeaders); writes may repeat none.
    const spelled = [...url.searchParams.keys()];
    const keys = spelled.map(key => key.toLowerCase());
    const repeated = keys.filter((key, at) => keys.indexOf(key) !== at);
    if (repeated.some(key => method !== 'GET' || RESERVED_QUERY_KEYS.has(key))) return refuse('unsupported-request');
    if (spelled.some((key, at) => RESERVED_QUERY_KEYS.has(keys[at]!) && RESERVED_QUERY_KEYS.get(keys[at]!) !== key)) return refuse('unsupported-request');

    const isToken = method === 'POST' && url.origin === OAUTH_HOST && url.pathname === '/token';
    if (tier === 'R' && method !== 'GET' && !isToken) return refuse('tier-r-read-only');

    const rule = RULES.find(r => r.origin === url.origin && r.methods.includes(method) && r.path.test(url.pathname));
    if (!rule) return refuse('unknown-endpoint');
    if (rule.kind === 'forbidden') return refuse(rule.reason ?? 'unknown-endpoint', rule.api);
    if (rule.kind === 'write' && tier === 'R') return refuse('tier-r-read-only', rule.api);
    if (rule.kind === 'send' && tier !== 'S-self') return refuse('send-tier', rule.api);

    // Deletes and calendar writes are limited to things this run made.
    if (rule.effect === 'label-delete' && !createdLabelIds.has(lastSegment(url))) return refuse('label-not-created-by-run', rule.api);
    if (rule.effect === 'filter-delete' && !runFilterIds.has(lastSegment(url))) return refuse('filter-not-created-by-run', rule.api);
    if (rule.effect === 'calendar-write') {
      if (!ownCalendar(url)) return refuse('calendar-not-own', rule.api);
      // The owner's own events (and their guests) are never touched: only events this run inserted.
      if (rule.api !== 'calendar.events.insert' && !runEventIds.has(lastSegment(url))) return refuse('calendar-event-not-created-by-run', rule.api);
    }

    const body = await resolveBody(request.body).catch(() => refuse('body-unparseable', rule.api));
    if (body.contentType !== undefined && !headers.has('content-type')) headers.set('content-type', body.contentType);
    const bodyChecked = rule.effect !== undefined && BODY_CHECKED.has(rule.effect);
    // Draft updates and draft sends queue per draft id; a send names its draft in the body.
    const lockKey = rule.effect === 'draft-write' && method === 'PUT' ? lastSegment(url) : rule.effect === 'draft-send' ? draftIdOf(body.bytes) : undefined;

    return withDraftLock(lockKey, async () => {
      const pending = bodyChecked ? checkBody(rule, url, headers, body.bytes) : {};
      // Deletes carry no body, so the tier and run-id gate is repeated here for them.
      if (rule.effect === 'calendar-write' && (tier !== 'M' || options.calendarRunId === undefined)) refuse('calendar-write-not-allowed', rule.api);

      const key = `${rule.api}\0${method}`;
      const entry = sent.get(key) ?? { method: rule.api, httpMethod: method, count: 0 };
      entry.count++;
      sent.set(key, entry);

      // What is sent is built from the snapshot alone. A redirect could leave the allowed hosts
      // after the check, so redirects are errors.
      const outgoing: RequestInit = Object.freeze({
        method,
        headers: Object.freeze([...headers].map(pair => Object.freeze(pair))) as unknown as [string, string][],
        redirect: 'error' as const,
        ...(body.send !== undefined && body.bytes.length ? { body: body.send as BodyInit } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const response = await inner(url.href, outgoing);
      await remember(rule, url, pending, response);
      return response;
    });
  };

  return Object.assign(guarded, {
    requests: (): RequestCount[] => [...sent.values()].map(entry => ({ ...entry })),
    refusals: () => ({ ...refused }),
    createdLabelIds,
  });
}

/** The draft a drafts.send body names, or undefined; the real check happens later, under the lock. */
function draftIdOf(bytes: Buffer): string | undefined {
  try {
    const id = jsonObject(bytes, 'gmail.users.drafts.send').id;
    return typeof id === 'string' ? id : undefined;
  } catch {
    return undefined;
  }
}

// ---------- shared request-log helpers ----------

/** Adds request tallies together (used when a run has more than one guard). */
export function mergeRequests(...lists: RequestCount[][]): RequestCount[] {
  const merged = new Map<string, RequestCount>();
  for (const entry of lists.flat()) {
    const key = `${entry.method}\0${entry.httpMethod}`;
    const existing = merged.get(key);
    if (existing) existing.count += entry.count;
    else merged.set(key, { ...entry });
  }
  return [...merged.values()];
}

/** What was sent after `before` was taken. */
export function requestsSince(before: RequestCount[], after: RequestCount[]): RequestCount[] {
  const earlier = new Map(before.map(entry => [`${entry.method}\0${entry.httpMethod}`, entry.count]));
  return after
    .map(entry => ({ ...entry, count: entry.count - (earlier.get(`${entry.method}\0${entry.httpMethod}`) ?? 0) }))
    .filter(entry => entry.count > 0);
}

/** Tier R's after-the-fact check: no write may appear in the log, apart from the token refresh. */
export function readOnlyViolations(requests: RequestCount[]): RequestCount[] {
  return requests.filter(entry => entry.httpMethod !== 'GET' && entry.method !== 'oauth.token');
}
