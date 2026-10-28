import { Buffer } from 'node:buffer';
import { types } from 'node:util';
import {
  ALLOWED_HEADERS,
  draftShapeOk,
  filterProblem,
  GuardRefusal,
  hasKeyDeep,
  hasMethodOverride,
  INIT_KEYS,
  INSERT_FIELDS,
  isMeetCreateRequest,
  isRecord,
  JSON_TYPE,
  jsonObject,
  labelModifyProblem,
  lastSegment,
  PATCH_FIELDS,
  rawLastSegment,
  READ_QUERY_KEYS,
  RESERVED_QUERY_KEYS,
  stringId,
  tokenBodyProblem,
  VERBS,
  type GuardReason,
} from './guard-helpers';
import { decodeRaw, isPlainAddress, recipientAddresses, UnparseableMessage } from './recipients';
import type { RequestCount, Tier } from './types';

export { GuardRefusal } from './guard-helpers';
export type { GuardReason } from './guard-helpers';

/**
 * The safety core of the live runner. Every request a probe makes goes through `createGuardedFetch`,
 * and the guard decides BEFORE a byte is sent. The design is default-deny: a request is allowed only
 * if it matches a row of the table below and passes that row's extra checks. Anything unknown
 * (a new endpoint, another host, an odd URL form) is refused, so a mistake in a probe can only
 * make a run fail, never touch the mailbox.
 *
 * The guard never puts an address, id, URL or token in an error message or a log.
 */

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
  /**
   * The sign-in's own guard only: also lets the one authorization-code exchange through the token
   * endpoint (exact keys, loopback redirect). Every other guard sends nothing there but a refresh.
   */
  allowCodeExchange?: boolean;
}

export interface GuardedFetch {
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response>;
  /** Requests that were actually sent, by API method name and HTTP verb. */
  requests(): RequestCount[];
  /** How often each refusal reason fired. */
  refusals(): Partial<Record<GuardReason, number>>;
  /** Copies, made fresh on every read: changing one changes nothing in the guard. */
  readonly createdLabelIds: ReadonlySet<string>;
  readonly createdFilterIds: ReadonlySet<string>;
}

// ---------- the rule table ----------

const GMAIL_HOST = 'https://gmail.googleapis.com';
const API_HOST = 'https://www.googleapis.com';
const OAUTH_HOST = 'https://oauth2.googleapis.com';
const OPENID_HOST = 'https://openidconnect.googleapis.com';
const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  GMAIL_HOST,
  API_HOST,
  OAUTH_HOST,
  OPENID_HOST,
]);

type Kind = 'read' | 'write' | 'send' | 'token' | 'forbidden';
/** Extra checks and bookkeeping a row needs. */
type Effect =
  | 'token'
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
  /** The only query keys a non-GET request of this row may carry (none when absent). */
  query?: readonly string[];
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

const gmail = (
  methods: string[],
  tail: string,
  api: string,
  kind: Kind,
  extra: Partial<Rule> = {},
): Rule => ({
  origin: GMAIL_HOST,
  methods,
  path: pathOf(GM + tail),
  api,
  kind,
  ...extra,
});
const calendar = (
  methods: string[],
  tail: string,
  api: string,
  kind: Kind,
  extra: Partial<Rule> = {},
): Rule => ({
  origin: API_HOST,
  methods,
  path: pathOf(CAL + tail),
  api,
  kind,
  ...extra,
});

/** Calendar writes: the notification switches (checked below) and the Meet-room version, nothing else. */
const CALENDAR_WRITE_QUERY = ['sendUpdates', 'sendNotifications', 'conferenceDataVersion'];

/** First match wins, so specific rows come before the catch-alls at the end of each group. */
const RULES: readonly Rule[] = [
  // OAuth. The token endpoint is the one POST tier R may make (access-token refresh).
  {
    origin: OAUTH_HOST,
    methods: ['POST'],
    path: /^\/token$/,
    api: 'oauth.token',
    kind: 'token',
    effect: 'token',
  },
  {
    origin: OPENID_HOST,
    methods: ['GET'],
    path: /^\/v1\/userinfo$/,
    api: 'oauth.userinfo',
    kind: 'read',
  },
  {
    origin: API_HOST,
    methods: ['GET'],
    path: /^\/oauth2\/v3\/userinfo$/,
    api: 'oauth.userinfo',
    kind: 'read',
  },

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
  gmail(['DELETE'], 'messages/:id', 'gmail.users.messages.delete', 'forbidden', {
    reason: 'permanent-delete',
  }),
  gmail(['POST'], 'messages/batchDelete', 'gmail.users.messages.batchDelete', 'forbidden', {
    reason: 'permanent-delete',
  }),
  gmail(['DELETE'], 'threads/:id', 'gmail.users.threads.delete', 'forbidden', {
    reason: 'permanent-delete',
  }),
  gmail(['DELETE'], 'drafts/:id', 'gmail.users.drafts.delete', 'forbidden', {
    reason: 'permanent-delete',
  }),

  // Gmail reversible writes (tiers M and S-self)
  gmail(['POST'], 'labels', 'gmail.users.labels.create', 'write', { effect: 'label-create' }),
  gmail(['DELETE'], 'labels/:id', 'gmail.users.labels.delete', 'write', { effect: 'label-delete' }),
  gmail(['POST'], 'messages/batchModify', 'gmail.users.messages.batchModify', 'write', {
    effect: 'label-modify',
  }),
  gmail(['POST'], 'messages/:id/modify', 'gmail.users.messages.modify', 'write', {
    effect: 'label-modify',
  }),
  gmail(['POST'], 'threads/:id/modify', 'gmail.users.threads.modify', 'write', {
    effect: 'label-modify',
  }),
  gmail(['POST'], 'drafts', 'gmail.users.drafts.create', 'write', { effect: 'draft-write' }),
  gmail(['PUT'], 'drafts/:id', 'gmail.users.drafts.update', 'write', { effect: 'draft-write' }),
  gmail(['POST'], 'settings/filters', 'gmail.users.settings.filters.create', 'write', {
    effect: 'filter-create',
  }),
  gmail(['DELETE'], 'settings/filters/:id', 'gmail.users.settings.filters.delete', 'write', {
    effect: 'filter-delete',
  }),
  // Every other settings write (sendAs, forwarding, delegates, imap, pop, vacation, language, ...)
  {
    origin: GMAIL_HOST,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    path: /^\/gmail\/v1\/users\/me\/settings(?:\/.*)?$/,
    api: 'gmail.users.settings.write',
    kind: 'forbidden',
    reason: 'settings-write',
  },

  // Gmail sends (tier S-self only, recipients checked)
  gmail(['POST'], 'messages/send', 'gmail.users.messages.send', 'send', { effect: 'send-json' }),
  gmail(['POST'], 'drafts/send', 'gmail.users.drafts.send', 'send', { effect: 'draft-send' }),
  // The media upload of messages.send only. drafts.send has no media form here: its upload body is
  // a whole message, which would skip the "only drafts this run verified" check above.
  {
    origin: GMAIL_HOST,
    methods: ['POST'],
    path: pathOf(UP + 'messages/send'),
    api: 'gmail.users.messages.send',
    kind: 'send',
    effect: 'send-media',
    query: ['uploadType'],
  },
  // A batch could hide any of the above in a part, so batches are not supported at all yet.
  {
    origin: GMAIL_HOST,
    methods: ['POST'],
    path: /^\/batch\/gmail\/v1$/,
    api: 'gmail.batch',
    kind: 'forbidden',
    reason: 'batch-unsupported',
  },
  {
    origin: API_HOST,
    methods: ['POST'],
    path: /^\/batch\/calendar\/v3$/,
    api: 'calendar.batch',
    kind: 'forbidden',
    reason: 'batch-unsupported',
  },

  // Calendar reads
  calendar(['GET'], 'users/me/calendarList', 'calendar.calendarList.list', 'read'),
  calendar(['GET'], 'users/me/calendarList/:id', 'calendar.calendarList.get', 'read'),
  calendar(['GET'], 'calendars/:cid/events', 'calendar.events.list', 'read'),
  calendar(['GET'], 'calendars/:cid/events/:id', 'calendar.events.get', 'read'),
  calendar(['GET'], 'calendars/:cid/events/:id/instances', 'calendar.events.instances', 'read'),

  // Calendar: the calendar list is never written; PUT replaces the whole event (and its guests)
  {
    origin: API_HOST,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
    path: /^\/calendar\/v3\/users\/me\/calendarList(?:\/.*)?$/,
    api: 'calendar.calendarList.write',
    kind: 'forbidden',
    reason: 'calendar-list-write',
  },
  calendar(['PUT'], 'calendars/:cid/events/:id', 'calendar.events.update', 'forbidden', {
    reason: 'calendar-put-replaces',
  }),
  calendar(['POST'], 'calendars/:cid/events', 'calendar.events.insert', 'write', {
    effect: 'calendar-write',
    query: CALENDAR_WRITE_QUERY,
  }),
  calendar(['PATCH'], 'calendars/:cid/events/:id', 'calendar.events.patch', 'write', {
    effect: 'calendar-write',
    query: CALENDAR_WRITE_QUERY,
  }),
  calendar(['DELETE'], 'calendars/:cid/events/:id', 'calendar.events.delete', 'write', {
    effect: 'calendar-write',
    query: ['sendUpdates', 'sendNotifications'],
  }),
];

/** Every API method name the guard can let through. Evidence files may name only these. */
export const GUARD_API_METHODS: readonly string[] = [
  ...new Set(RULES.filter(rule => rule.kind !== 'forbidden').map(rule => rule.api)),
].sort();

export function classify(method: string, url: URL): { api: string; kind: Kind } | undefined {
  const rule = RULES.find(
    r => r.origin === url.origin && r.methods.includes(method) && r.path.test(url.pathname),
  );
  return rule && { api: rule.api, kind: rule.kind };
}

// ---------- helpers ----------

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

type CapturedBody =
  { bytes: Buffer; send?: string | Uint8Array; contentType?: string } | { blob: Blob };

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
    return {
      bytes: Buffer.from(text, 'utf8'),
      send: text,
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    };
  }
  if (types.isArrayBuffer(body)) return copyOf(new Uint8Array(body));
  if (types.isUint8Array(body)) return copyOf(body);
  if (body instanceof Blob) return { blob: body };
  // Streams and form data cannot be read without consuming them, so they cannot be checked.
  throw new GuardRefusal('body-unparseable');
}

async function resolveBody(
  body: CapturedBody,
): Promise<{ bytes: Buffer; send?: string | Uint8Array; contentType?: string }> {
  if (!('blob' in body)) return body;
  const type = Object.getOwnPropertyDescriptor(Blob.prototype, 'type')?.get?.call(
    body.blob,
  ) as string;
  return {
    ...copyOf(new Uint8Array(await Blob.prototype.arrayBuffer.call(body.blob))),
    ...(type ? { contentType: type } : {}),
  };
}

function captureHeaders(raw: unknown): [string, string][] {
  let entries: Iterable<unknown>;
  if (raw === undefined) entries = [];
  else if (raw instanceof Headers) entries = Headers.prototype.entries.call(raw);
  else if (Array.isArray(raw)) entries = raw;
  else if (
    raw &&
    typeof raw === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    entries = Object.entries(raw);
  else throw new GuardRefusal('unsupported-request');
  const pairs: [string, string][] = [];
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) throw new GuardRefusal('unsupported-request');
    const [name, value] = [entry[0], entry[1]] as unknown[];
    if (typeof name !== 'string' || typeof value !== 'string')
      throw new GuardRefusal('unsupported-request');
    pairs.push([name.toLowerCase(), value]);
  }
  // Two headers of one name are read differently by different servers.
  if (new Set(pairs.map(([name]) => name)).size !== pairs.length)
    throw new GuardRefusal('unsupported-request');
  new Headers(pairs); // throws on an illegal name or value
  return pairs;
}

function capture(input: unknown, init: unknown): Snapshot {
  try {
    // Only plain URLs: a Request object carries a body stream that cannot be checked unread.
    const href =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? URL.prototype.toString.call(input)
          : undefined;
    if (href === undefined) throw new GuardRefusal('unsupported-request');
    const url = new URL(href);
    if (
      init !== undefined &&
      (init === null ||
        typeof init !== 'object' ||
        Object.keys(init).some(key => !INIT_KEYS.has(key)))
    )
      throw new GuardRefusal('unsupported-request');
    const options = (init ?? {}) as Record<string, unknown>;
    // Each field is read exactly once, here.
    const [rawMethod, rawHeaders, rawBody, rawSignal] = [
      options.method,
      options.headers,
      options.body,
      options.signal,
    ];
    if (rawMethod !== undefined && typeof rawMethod !== 'string')
      throw new GuardRefusal('unsupported-request');
    if (rawSignal !== undefined && !(rawSignal instanceof AbortSignal))
      throw new GuardRefusal('unsupported-request');
    const headers = captureHeaders(rawHeaders);
    let body: CapturedBody;
    try {
      body = captureBody(rawBody);
    } catch {
      throw new GuardRefusal('body-unparseable');
    }
    return {
      url,
      method: (rawMethod ?? 'GET').toUpperCase(),
      headers,
      body,
      ...(rawSignal ? { signal: rawSignal } : {}),
    };
  } catch (error) {
    if (error instanceof GuardRefusal) throw error;
    throw new GuardRefusal('unsupported-request');
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
const BODY_CHECKED: ReadonlySet<Effect> = new Set([
  'token',
  'send-json',
  'send-media',
  'draft-send',
  'draft-write',
  'filter-create',
  'calendar-write',
  'label-modify',
]);

export function createGuardedFetch(inner: typeof fetch, options: GuardOptions): GuardedFetch {
  const { tier } = options;
  const self = options.selfAddress?.toLowerCase();
  if (self !== undefined && !isPlainAddress(self))
    throw new Error('selfAddress is not a plain address');
  if (tier === 'S-self' && self === undefined)
    throw new Error('Tier S-self needs the account address');
  // Copied once: neither the caller nor a probe can change what the guard checks against later.
  const runFilterIds = new Set(options.allowRunFilterIds ?? []);
  const calendarRunId = options.calendarRunId;
  const allowCodeExchange = options.allowCodeExchange === true;
  const createdLabelIds = new Set<string>();
  // Calendar events this run inserted. Only these may be changed or deleted.
  const runEventIds = new Set<string>();
  // Draft ids exactly as Gmail returned them to this guard's creates. Only these may be updated or sent.
  const runDrafts = new Set<string>();
  // Run drafts whose last checked write held only the account's own address.
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
      return addresses.length > 0 && addresses.every(address => address === self)
        ? 'self-only'
        : 'other-recipients';
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
    if (body.conferenceData !== undefined && !isMeetCreateRequest(body.conferenceData))
      refuse('calendar-field', api);
    if (insert) {
      const tag = body.extendedProperties;
      const run = calendarRunId;
      const ok =
        isRecord(tag) &&
        Object.keys(tag).length === 1 &&
        isRecord(tag.private) &&
        Object.keys(tag.private).length === 1 &&
        run !== undefined &&
        tag.private.aplosLiveRun === run;
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
    const tail = turn.then(
      () => undefined,
      () => undefined,
    );
    draftTails.set(key, tail);
    void tail.then(() => {
      if (draftTails.get(key) === tail) draftTails.delete(key);
    });
    return turn;
  };

  /** Sends: the whole body is one message whose every recipient is the account itself. */
  const checkSendJson = (bytes: Buffer, api: string): Pending => {
    const body = jsonObject(bytes, api);
    // Exact keys only, like every other checked body: a send carries the message and its thread.
    if (Object.keys(body).some(key => key !== 'raw' && key !== 'threadId'))
      refuse('body-unparseable', api);
    if (body.threadId !== undefined && typeof body.threadId !== 'string')
      refuse('body-unparseable', api);
    requireSelfOnly(verdictOfRaw(body.raw), api);
    return {};
  };

  /** The simple media upload only, where the body IS the RFC 822 message. */
  const checkSendMedia = (bytes: Buffer, api: string): Pending => {
    requireSelfOnly(verdictOf(bytes), api);
    return {};
  };

  const checkDraftSend = (bytes: Buffer, api: string): Pending => {
    const body = jsonObject(bytes, api);
    if (!draftShapeOk(body)) refuse('body-unparseable', api);
    const draftId = typeof body.id === 'string' ? body.id : undefined;
    // The guard cannot see a stored draft's recipients, so only drafts it verified itself may be
    // sent, named exactly as Gmail returned them (another spelling could be read as the same id).
    if (draftId === undefined || !runDrafts.has(draftId) || !selfDrafts.has(draftId))
      refuse('draft-not-verified-self', api);
    if (body.message !== undefined)
      requireSelfOnly(verdictOfRaw((body.message as { raw?: unknown } | null)?.raw), api);
    return { draftId };
  };

  const checkDraftWrite = (rule: Rule, url: URL, bytes: Buffer, api: string): Pending => {
    const body = jsonObject(bytes, api);
    const message = body.message as { raw?: unknown } | undefined;
    if (!message || typeof message !== 'object' || !draftShapeOk(body))
      refuse('body-unparseable', api);
    const draftId = rule.methods[0] === 'PUT' ? lastSegment(url) : undefined;
    // The body may not name a draft other than the one in the path (and a create names none).
    if (body.id !== undefined && body.id !== draftId) refuse('body-unparseable', api);
    // Any update makes the draft unsendable until this update's own body is found self-only; a
    // draft may hold other recipients, it just stops being sendable by this guard.
    if (draftId !== undefined) selfDrafts.delete(draftId);
    return { selfOnly: verdictOfRaw(message?.raw) === 'self-only', draftId };
  };

  /** Filters: criteria plus label actions only (no forward, no Trash or Spam, no other action). */
  const checkFilterCreate = (bytes: Buffer, api: string): Pending => {
    const problem = filterProblem(jsonObject(bytes, api));
    if (problem) refuse(problem, api);
    return {};
  };

  /** Label changes: the exact keys of the method and never into Spam or Trash. */
  const checkLabelModify = (bytes: Buffer, api: string): Pending => {
    const problem = labelModifyProblem(jsonObject(bytes, api), api);
    if (problem) refuse(problem, api);
    return {};
  };

  const checkCalendarWrite = (url: URL, bytes: Buffer, api: string): Pending => {
    // Calendar writes exist only in tier M with a run id (orchestrator decision 2026-10-28).
    if (tier !== 'M' || calendarRunId === undefined) refuse('calendar-write-not-allowed', api);
    // Guests are notified by default, so "none" must be written out, not left to a default.
    // sendNotifications is the older spelling of the same switch: only an explicit "false" is safe.
    const notifications = url.searchParams.get('sendNotifications');
    if (
      url.searchParams.get('sendUpdates') !== 'none' ||
      (notifications !== null && notifications !== 'false')
    )
      refuse('calendar-send-updates', api);
    if (bytes.length) {
      const body = jsonObject(bytes, api);
      if (hasKeyDeep(body, new Set(['responseStatus']))) refuse('calendar-rsvp', api);
      if (hasKeyDeep(body, new Set(['attendees']))) refuse('calendar-attendees', api);
      checkCalendarFields(body, api);
    } else if (api !== 'calendar.events.delete') {
      refuse('calendar-run-id', api);
    }
    return {};
  };

  /** Checks the body of a rule that needs it. Throws a refusal, or returns what to remember. */
  function checkBody(
    rule: Rule,
    url: URL,
    headers: ReadonlyMap<string, string>,
    bytes: Buffer,
  ): Pending {
    const api = rule.api;
    // The server picks its parser from the content type, so a body checked as JSON must be
    // labelled as JSON (and a media upload as a plain RFC 822 message), nothing else.
    const type = headers.get('content-type')?.trim().toLowerCase();
    // The token endpoint reads a form, so its body has its own check.
    if (rule.effect === 'token') {
      const problem = tokenBodyProblem(bytes, type, allowCodeExchange);
      if (problem) refuse(problem, api);
      return {};
    }
    if (rule.effect === 'send-media' && url.searchParams.get('uploadType') !== 'media')
      refuse('send-upload-type', api);
    // (An empty body has no parser to confuse; rows that need a body refuse it below.)
    if (
      bytes.length &&
      (rule.effect === 'send-media'
        ? type !== 'message/rfc822'
        : type === undefined || !JSON_TYPE.test(type))
    )
      refuse('body-unparseable', api);
    switch (rule.effect) {
      case 'send-json':
        return checkSendJson(bytes, api);
      case 'send-media':
        // Multipart and resumable uploads wrap the message in framing this guard does not parse.
        return checkSendMedia(bytes, api);
      case 'draft-send':
        return checkDraftSend(bytes, api);
      case 'draft-write':
        return checkDraftWrite(rule, url, bytes, api);
      case 'filter-create':
        return checkFilterCreate(bytes, api);
      case 'label-modify':
        return checkLabelModify(bytes, api);
      case 'calendar-write':
        return checkCalendarWrite(url, bytes, api);
      default:
        return {};
    }
  }

  /** Bookkeeping that only a successful answer may change. */
  async function remember(
    rule: Rule,
    url: URL,
    pending: Pending,
    response: Response,
  ): Promise<void> {
    if (!response.ok) return;
    const createdId = async (): Promise<string | undefined> =>
      stringId(
        await response
          .clone()
          .json()
          .catch(() => undefined),
      );
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
        // A create's id is kept exactly as Gmail spelled it; an update keeps its (checked) path id.
        const id = pending.draftId ?? (await createdId());
        if (id === undefined) break;
        if (pending.draftId === undefined) runDrafts.add(id);
        if (pending.selfOnly) selfDrafts.add(id);
        break;
      }
      case 'draft-send':
        if (pending.draftId !== undefined) {
          selfDrafts.delete(pending.draftId);
          runDrafts.delete(pending.draftId);
        }
        break;
      case 'calendar-write': {
        if (rule.api === 'calendar.events.insert') {
          // Only an event Google stored with this run's tag becomes changeable or deletable.
          const created = await response
            .clone()
            .json()
            .catch(() => undefined);
          const id = stringId(created);
          const tag =
            isRecord(created) &&
            isRecord(created.extendedProperties) &&
            isRecord(created.extendedProperties.private)
              ? created.extendedProperties.private.aplosLiveRun
              : undefined;
          if (id !== undefined && tag === calendarRunId) runEventIds.add(id);
        } else if (rule.api === 'calendar.events.delete') {
          runEventIds.delete(lastSegment(url));
        }
        break;
      }
    }
  }

  /** The shape of any request: origin, verb, headers and query keys, in that order. */
  const checkRequestShape = (
    url: URL,
    method: string,
    headers: ReadonlyMap<string, string>,
  ): void => {
    if (
      url.protocol !== 'https:' ||
      !ALLOWED_ORIGINS.has(url.origin) ||
      url.username ||
      url.password
    )
      refuse('origin-not-allowed');
    if (/%2f|%5c|%00|\/\//i.test(url.pathname)) refuse('url-not-canonical');
    if (!VERBS.has(method)) refuse('unsupported-request');
    if (hasMethodOverride(url, [...headers.keys()])) refuse('method-override');
    if ([...headers.keys()].some(name => !ALLOWED_HEADERS.has(name))) refuse('unsupported-request');

    // A repeated key could be read as its first value by Google and its last by this guard.
    // Reads may repeat other keys (labelIds, metadataHeaders); writes may repeat none.
    const spelled = [...url.searchParams.keys()];
    const keys = spelled.map(key => key.toLowerCase());
    const repeated = keys.filter((key, at) => keys.indexOf(key) !== at);
    if (repeated.some(key => method !== 'GET' || RESERVED_QUERY_KEYS.has(key)))
      refuse('unsupported-request');
    if (
      spelled.some(
        (key, at) =>
          RESERVED_QUERY_KEYS.has(keys[at]!) && RESERVED_QUERY_KEYS.get(keys[at]!) !== key,
      )
    )
      refuse('unsupported-request');
  };

  /** The tier gate and the rule table: which API method name this request counts as. */
  const ruleFor = (url: URL, method: string): Rule => {
    const isToken = method === 'POST' && url.origin === OAUTH_HOST && url.pathname === '/token';
    if (tier === 'R' && method !== 'GET' && !isToken) refuse('tier-r-read-only');

    const rule = RULES.find(
      r => r.origin === url.origin && r.methods.includes(method) && r.path.test(url.pathname),
    );
    if (!rule) return refuse('unknown-endpoint');
    if (rule.kind === 'forbidden') return refuse(rule.reason ?? 'unknown-endpoint', rule.api);
    if (rule.kind === 'write' && tier === 'R') return refuse('tier-r-read-only', rule.api);
    if (rule.kind === 'send' && tier !== 'S-self') return refuse('send-tier', rule.api);
    return rule;
  };

  /**
   * Writes take only the query keys their row lists, reads only the documented read parameters. A
   * key with '_' is refused outright: Google reads snake_case spellings as the camelCase parameter.
   */
  const checkQuery = (rule: Rule, url: URL, method: string): void => {
    const allowed = method === 'GET' ? READ_QUERY_KEYS : (rule.query ?? []);
    if ([...url.searchParams.keys()].some(key => key.includes('_') || !allowed.includes(key)))
      refuse('query-not-allowed', rule.api);
  };

  /** Deletes, draft updates and calendar writes are limited to things this run made. */
  const checkRunScoped = (rule: Rule, url: URL): void => {
    // A draft is named exactly as Gmail returned it: no encoded spelling, no other form of the id.
    if (rule.effect === 'draft-write' && rule.methods[0] === 'PUT') {
      const raw = rawLastSegment(url);
      if (raw !== lastSegment(url) || !runDrafts.has(raw))
        refuse('draft-not-created-by-run', rule.api);
    }
    if (rule.effect === 'label-delete' && !createdLabelIds.has(lastSegment(url)))
      refuse('label-not-created-by-run', rule.api);
    if (rule.effect === 'filter-delete' && !runFilterIds.has(lastSegment(url)))
      refuse('filter-not-created-by-run', rule.api);
    if (rule.effect === 'calendar-write') {
      if (!ownCalendar(url)) refuse('calendar-not-own', rule.api);
      // The owner's own events (and their guests) are never touched: only events this run inserted.
      if (rule.api !== 'calendar.events.insert' && !runEventIds.has(lastSegment(url)))
        refuse('calendar-event-not-created-by-run', rule.api);
    }
  };

  const guarded = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
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

    checkRequestShape(url, method, headers);
    const rule = ruleFor(url, method);
    checkQuery(rule, url, method);
    checkRunScoped(rule, url);

    const body = await resolveBody(request.body).catch(() => refuse('body-unparseable', rule.api));
    if (body.contentType !== undefined && !headers.has('content-type'))
      headers.set('content-type', body.contentType);
    const bodyChecked = rule.effect !== undefined && BODY_CHECKED.has(rule.effect);
    // Draft updates and draft sends queue per draft id; a send names its draft in the body.
    const lockKey =
      rule.effect === 'draft-write' && method === 'PUT'
        ? lastSegment(url)
        : rule.effect === 'draft-send'
          ? draftIdOf(body.bytes)
          : undefined;

    return withDraftLock(lockKey, async () => {
      const pending = bodyChecked ? checkBody(rule, url, headers, body.bytes) : {};
      // Deletes carry no body, so the tier and run-id gate is repeated here for them.
      if (rule.effect === 'calendar-write' && (tier !== 'M' || calendarRunId === undefined))
        refuse('calendar-write-not-allowed', rule.api);

      const key = `${rule.api}\0${method}`;
      const entry = sent.get(key) ?? { method: rule.api, httpMethod: method, count: 0 };
      entry.count++;
      sent.set(key, entry);

      // What is sent is built from the snapshot alone. A redirect could leave the allowed hosts
      // after the check, so redirects are errors.
      const outgoing: RequestInit = Object.freeze({
        method,
        headers: Object.freeze([...headers].map(pair => Object.freeze(pair))) as unknown as [
          string,
          string,
        ][],
        redirect: 'error' as const,
        ...(body.send !== undefined && body.bytes.length ? { body: body.send as BodyInit } : {}),
        ...(request.signal ? { signal: request.signal } : {}),
      });
      const response = await inner(url.href, outgoing);
      await remember(rule, url, pending, response);
      return response;
    });
  };

  // Frozen, and every view a copy: a probe holding this function cannot replace the request log the
  // runner reads, nor add ids to the sets that decide which deletes may pass.
  return Object.freeze(
    Object.defineProperties(guarded, {
      requests: { value: (): RequestCount[] => [...sent.values()].map(entry => ({ ...entry })) },
      refusals: { value: () => ({ ...refused }) },
      createdLabelIds: { get: () => new Set(createdLabelIds) },
      createdFilterIds: { get: () => new Set(runFilterIds) },
    }),
  ) as GuardedFetch;
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
  const earlier = new Map(
    before.map(entry => [`${entry.method}\0${entry.httpMethod}`, entry.count]),
  );
  return after
    .map(entry => ({
      ...entry,
      count: entry.count - (earlier.get(`${entry.method}\0${entry.httpMethod}`) ?? 0),
    }))
    .filter(entry => entry.count > 0);
}

/** Tier R's after-the-fact check: no write may appear in the log, apart from the token refresh. */
export function readOnlyViolations(requests: RequestCount[]): RequestCount[] {
  return requests.filter(entry => entry.httpMethod !== 'GET' && entry.method !== 'oauth.token');
}
