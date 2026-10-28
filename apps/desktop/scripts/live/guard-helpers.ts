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
