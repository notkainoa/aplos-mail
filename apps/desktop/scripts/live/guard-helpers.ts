import { Buffer } from 'node:buffer';
import { RunnerError } from './errors';

/**
 * Self-contained helpers of the safety core (guard.ts): pure constants and functions that do not
 * depend on one guard instance's state. They throw the same refusals, so the refusal type lives
 * here too and guard.ts re-exports it. The guard never puts an address, id, URL or token in an
 * error message or a log.
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
  | 'draft-not-verified-self'
  | 'draft-not-created-by-run'
  | 'query-not-allowed'
  | 'token-body';

export class GuardRefusal extends RunnerError {
  constructor(
    readonly reason: GuardReason,
    readonly api?: string,
  ) {
    super(`Guard refused a request (${reason}${api ? `, ${api}` : ''})`);
    this.name = 'GuardRefusal';
  }
}

// ---------- request-shape constants ----------

export const VERBS: ReadonlySet<string> = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
export const OVERRIDE_HEADERS = ['x-http-method-override', 'x-http-method', 'x-method-override'];
/**
 * The only headers a probe may set. Anything else (Host, a verb override, Authorization, framing
 * headers) is refused rather than judged: the bearer layer adds the token itself.
 */
export const ALLOWED_HEADERS: ReadonlySet<string> = new Set([
  'content-type',
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'user-agent',
]);
/** The only keys of `init` that are read; any other key is refused. `redirect` is read but always replaced. */
export const INIT_KEYS: ReadonlySet<string> = new Set([
  'method',
  'headers',
  'body',
  'redirect',
  'signal',
]);
/** Query keys whose value the guard reads, by lowercase name. A repeat or another spelling could be read differently by Google. */
export const RESERVED_QUERY_KEYS: ReadonlyMap<string, string> = new Map(
  ['uploadType', 'sendUpdates', 'sendNotifications', 'format', 'alt'].map(key => [
    key.toLowerCase(),
    key,
  ]),
);
/**
 * The only query keys a read may carry: the documented parameters of the Gmail and Calendar reads
 * in the rule table, plus `fields` and `prettyPrint`. Left out on purpose: `access_token`, `key`
 * and `oauth_token` (another credential could act on another account), `alt` and `uploadType`
 * (another response or upload form), `quotaUser`, `callback` and `$.xgafv`.
 */
export const READ_QUERY_KEYS: readonly string[] = [
  'fields',
  'prettyPrint',
  // Gmail
  'format',
  'metadataHeaders',
  'maxResults',
  'pageToken',
  'q',
  'labelIds',
  'includeSpamTrash',
  'startHistoryId',
  'labelId',
  'historyTypes',
  // Calendar
  'timeMin',
  'timeMax',
  'singleEvents',
  'orderBy',
  'showDeleted',
  'syncToken',
  'updatedMin',
  'timeZone',
  'maxAttendees',
  'iCalUID',
  'eventTypes',
  'privateExtendedProperty',
  'sharedExtendedProperty',
  'showHiddenInvitations',
  'originalStart',
  'minAccessRole',
  'showHidden',
];
export const SYSTEM_LABELS_REFUSED: ReadonlySet<string> = new Set(['SPAM', 'TRASH']);

/** Google APIs accept a verb override on a POST, which would turn a "POST" into a DELETE. */
export function hasMethodOverride(url: URL, headerNames: readonly string[]): boolean {
  if (OVERRIDE_HEADERS.some(name => headerNames.includes(name))) return true;
  return [...url.searchParams.keys()].some(key =>
    ['$httpmethod', '_method', 'x-http-method-override'].includes(key.toLowerCase()),
  );
}

// ---------- body helpers ----------

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

export function jsonObject(bytes: Buffer, api: string): Record<string, unknown> {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && !Array.isArray(value) && !hasDuplicateKeys(text))
      return value as Record<string, unknown>;
  } catch {
    // fall through to the refusal
  }
  throw new GuardRefusal('body-unparseable', api);
}

/** True if any object key at any depth has one of the given names. */
export function hasKeyDeep(value: unknown, names: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.some(item => hasKeyDeep(item, names));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, inner]) => names.has(key) || hasKeyDeep(inner, names));
  }
  return false;
}

export function stringId(value: unknown): string | undefined {
  return value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string'
    ? (value as { id: string }).id
    : undefined;
}

/** The last path segment exactly as written in the URL, not decoded. */
export function rawLastSegment(url: URL): string {
  return url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
}

/** The last path segment, decoded, so `d%2b1` and `d+1` are one id in every set the guard keeps. */
export function lastSegment(url: URL): string {
  const raw = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

// ---------- calendar field sets ----------

export const PATCH_FIELDS: ReadonlySet<string> = new Set([
  'summary',
  'description',
  'start',
  'end',
]);
export const INSERT_FIELDS: ReadonlySet<string> = new Set([
  ...PATCH_FIELDS,
  'conferenceData',
  'extendedProperties',
]);

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Only `{createRequest: {requestId, conferenceSolutionKey: {type: 'hangoutsMeet'}}}`: a new Meet room, nothing copied in. */
export function isMeetCreateRequest(value: unknown): boolean {
  if (
    !isRecord(value) ||
    Object.keys(value).join() !== 'createRequest' ||
    !isRecord(value.createRequest)
  )
    return false;
  const request = value.createRequest;
  const keys = Object.keys(request).sort().join();
  return (
    keys === 'conferenceSolutionKey,requestId' &&
    typeof request.requestId === 'string' &&
    isRecord(request.conferenceSolutionKey) &&
    Object.keys(request.conferenceSolutionKey).join() === 'type' &&
    request.conferenceSolutionKey.type === 'hangoutsMeet'
  );
}

/** The content type a body checked as JSON must carry (and a media upload must not). */
export const JSON_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/;

// ---------- exact body shapes (a key the guard does not know is a key it did not check) ----------

/** True if every key of `value` is in `allowed`. */
export const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(value).every(key => allowed.includes(key));

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');

const spamOrTrash = (labels: unknown): boolean =>
  isStringList(labels) && labels.some(label => SYSTEM_LABELS_REFUSED.has(label.toUpperCase()));

/**
 * messages.batchModify takes `ids`; messages.modify and threads.modify only the two label lists.
 * Each list is a list of strings, and nothing may be added to Spam or Trash.
 */
export function labelModifyProblem(
  body: Record<string, unknown>,
  api: string,
): GuardReason | undefined {
  const keys =
    api === 'gmail.users.messages.batchModify'
      ? ['ids', 'addLabelIds', 'removeLabelIds']
      : ['addLabelIds', 'removeLabelIds'];
  if (!onlyKeys(body, keys)) return 'body-unparseable';
  if (Object.values(body).some(value => !isStringList(value))) return 'body-unparseable';
  // Spam reports go back to Google and Trash is purged after 30 days: neither is reversible.
  return spamOrTrash(body.addLabelIds) ? 'label-spam-trash' : undefined;
}

/** The documented filter criteria, each a plain value. */
const FILTER_CRITERIA = [
  'from',
  'to',
  'subject',
  'query',
  'negatedQuery',
  'hasAttachment',
  'excludeChats',
  'size',
  'sizeComparison',
];

/**
 * A filter is `{criteria, action}` and its action only adds or removes labels: never forward,
 * never Trash or Spam (in either list), never any other action.
 */
export function filterProblem(body: Record<string, unknown>): GuardReason | undefined {
  // A filter can forward every matching message to another address, which is a send.
  if (hasKeyDeep(body, new Set(['forward']))) return 'filter-forward';
  const { criteria, action } = body;
  if (!onlyKeys(body, ['criteria', 'action']) || !isRecord(criteria) || !isRecord(action))
    return 'body-unparseable';
  if (
    !onlyKeys(criteria, FILTER_CRITERIA) ||
    Object.values(criteria).some(value => isRecord(value) || Array.isArray(value) || value === null)
  )
    return 'body-unparseable';
  if (
    !onlyKeys(action, ['addLabelIds', 'removeLabelIds']) ||
    Object.values(action).some(value => !isStringList(value))
  )
    return 'body-unparseable';
  return spamOrTrash(action.addLabelIds) || spamOrTrash(action.removeLabelIds)
    ? 'label-spam-trash'
    : undefined;
}

/** A draft resource as drafts.create, drafts.update and drafts.send take it. */
export function draftShapeOk(body: Record<string, unknown>): boolean {
  if (!onlyKeys(body, ['id', 'message'])) return false;
  return (
    body.message === undefined ||
    (isRecord(body.message) && onlyKeys(body.message, ['raw', 'threadId']))
  );
}

// ---------- the token endpoint ----------

const FORM_TYPE = /^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/;
const OPTIONAL_TOKEN_FIELDS = ['client_secret'];
const TOKEN_FIELDS: Record<string, readonly string[]> = {
  refresh_token: ['grant_type', 'refresh_token', 'client_id'],
  authorization_code: ['grant_type', 'code', 'client_id', 'redirect_uri', 'code_verifier'],
};
/** The sign-in's own loopback redirect, nothing else. */
const LOOPBACK_REDIRECT = /^http:\/\/127\.0\.0\.1:\d{1,5}\/oauth\/callback$/;

/**
 * The token endpoint takes exactly an access-token refresh (and, on the sign-in's own guard, the
 * one code exchange): a form body with exactly the expected keys, each once and non-empty.
 */
export function tokenBodyProblem(
  bytes: Buffer,
  type: string | undefined,
  allowCodeExchange: boolean,
): GuardReason | undefined {
  if (type === undefined || !FORM_TYPE.test(type)) return 'token-body';
  let fields: URLSearchParams;
  try {
    fields = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return 'token-body';
  }
  const keys = [...fields.keys()];
  const grant = fields.get('grant_type') ?? '';
  const required = TOKEN_FIELDS[grant];
  if (!required || (grant === 'authorization_code' && !allowCodeExchange)) return 'token-body';
  const ok =
    new Set(keys).size === keys.length &&
    required.every(key => keys.includes(key)) &&
    keys.every(key => required.includes(key) || OPTIONAL_TOKEN_FIELDS.includes(key)) &&
    [...fields.values()].every(value => value !== '') &&
    (grant !== 'authorization_code' || LOOPBACK_REDIRECT.test(fields.get('redirect_uri') ?? ''));
  return ok ? undefined : 'token-body';
}
