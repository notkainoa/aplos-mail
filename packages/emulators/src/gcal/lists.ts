import { calInvalid, calNotFound, fullSyncRequired } from './errors';
import { instanceOf, isMaster, iso, locate, rangeOf, seriesOf, viewOf } from './events';
import { occurrences } from './rrule';
import type { CalendarRecord, CalendarStore, EventRecord } from './store';
import { parseDateTime } from './tz';
import type { AccessRole, GcalEvent } from './types';

/**
 * calendarList.list, events.list and events.instances: paging, filters, expansion and sync tokens.
 *
 * A sync token is `{kind, calendar, rev, issuedAt, epoch, user}` in base64url. `rev` is the store's
 * change counter when the first page was served, so a change made while paging is seen again by
 * the next incremental call (a repeat, never a miss).
 */

const DAY_MS = 86_400_000;
const MAX_SCAN = 200_000;
const ROLE_RANK: Record<AccessRole, number> = { freeBusyReader: 1, reader: 2, writer: 3, owner: 4 };

interface TokenData {
  k: 'e' | 'l';
  c?: string;
  r: number;
  a: number;
  e: number;
  u: string;
  /** singleEvents of the call that issued it: incremental results keep that shape. */
  s?: boolean;
  /** Expansion window of the call that issued it (null = open). */
  w?: [number | null, number | null];
}

const encode = (data: unknown): string => Buffer.from(JSON.stringify(data)).toString('base64url');

function decode<T>(text: string): T | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    return value && typeof value === 'object' ? (value as T) : undefined;
  } catch {
    return undefined;
  }
}

function checkSyncToken(
  store: CalendarStore,
  text: string,
  kind: 'e' | 'l',
  cal?: CalendarRecord,
): TokenData {
  const token = decode<TokenData>(text);
  const epoch = kind === 'l' ? store.epochFor('list') : store.epochFor(`events:${cal!.id}`);
  const stale =
    !token ||
    token.k !== kind ||
    token.u !== store.owner.sub ||
    (kind === 'e' && token.c !== cal!.id) ||
    typeof token.r !== 'number' ||
    token.r > store.rev ||
    token.e !== epoch ||
    store.now() - token.a > store.deps.settings().syncTokenHorizonMs;
  if (stale) throw fullSyncRequired();
  return token;
}

// ---------- parameters ----------

function bool(q: URLSearchParams, name: string): boolean | undefined {
  const value = q.get(name);
  if (value === null || value === '') return undefined;
  if (value !== 'true' && value !== 'false') throw calInvalid(`Invalid value for: ${name}`);
  return value === 'true';
}

function size(q: URLSearchParams, fallback: number, max: number): number {
  const raw = q.get('maxResults');
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw calInvalid('Invalid value for: maxResults');
  return Math.min(n, max);
}

function instant(q: URLSearchParams, name: string): number | undefined {
  const raw = q.get(name);
  if (raw === null || raw === '') return undefined;
  const ms = /(Z|[+-]\d{2}:\d{2})$/.test(raw) ? parseDateTime(raw) : undefined;
  if (ms === undefined) throw calInvalid(`Invalid value for: ${name}`);
  return ms;
}

// ---------- paging ----------

interface Keyed<T> {
  key: string;
  item: T;
}

const pad = (n: number, width = 16): string =>
  String(Math.max(0, Math.round(n) + 1e13)).padStart(width, '0');

function pageOf<T>(
  items: Keyed<T>[],
  pageToken: string | null,
  max: number,
  snapshot: number,
): { page: T[]; nextPageToken?: string } {
  items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  let start = 0;
  if (pageToken) {
    const cursor = decode<{ after: string }>(pageToken);
    if (!cursor || typeof cursor.after !== 'string')
      throw calInvalid('Invalid page token.', 'invalid');
    start = items.findIndex(i => i.key > cursor.after);
    if (start === -1) start = items.length;
  }
  const slice = items.slice(start, start + max);
  const more = start + max < items.length;
  return {
    page: slice.map(i => i.item),
    ...(more
      ? { nextPageToken: encode({ after: slice[slice.length - 1].key, snap: snapshot }) }
      : {}),
  };
}

/** The change counter the first page was served at; later pages keep it. */
function snapshotOf(store: CalendarStore, pageToken: string | null): number {
  const cursor = pageToken ? decode<{ snap?: number }>(pageToken) : undefined;
  return typeof cursor?.snap === 'number' ? cursor.snap : store.rev;
}

// ---------- calendar list ----------

export function listCalendarList(
  store: CalendarStore,
  q: URLSearchParams,
): Record<string, unknown> {
  const max = size(q, 100, 250);
  const syncText = q.get('syncToken');
  const showHidden = bool(q, 'showHidden');
  const showDeleted = bool(q, 'showDeleted');
  const minRole = q.get('minAccessRole');
  if (minRole && !(minRole in ROLE_RANK)) throw calInvalid('Invalid value for: minAccessRole');
  if (syncText && (minRole || showHidden === false || showDeleted === false)) {
    throw calInvalid(
      'minAccessRole cannot be combined with syncToken, and showDeleted and showHidden cannot be false with it.',
    );
  }
  const token = syncText ? checkSyncToken(store, syncText, 'l') : undefined;
  const pageToken = q.get('pageToken');
  const snapshot = snapshotOf(store, pageToken);

  const items: Keyed<unknown>[] = [];
  for (const cal of store.calendars.values()) {
    const wanted = token
      ? cal.rev > token.r
      : (!cal.deleted || showDeleted === true) &&
        (!cal.hidden || showHidden === true) &&
        (!minRole || ROLE_RANK[cal.accessRole] >= ROLE_RANK[minRole as AccessRole]);
    if (wanted) items.push({ key: pad(cal.seq, 10), item: store.entryView(cal) });
  }
  const { page, nextPageToken } = pageOf(items, pageToken, max, snapshot);
  return {
    kind: 'calendar#calendarList',
    etag: `"l${snapshot}"`,
    ...(nextPageToken
      ? { nextPageToken }
      : {
          nextSyncToken: encode({
            k: 'l',
            r: snapshot,
            a: store.now(),
            e: store.epochFor('list'),
            u: store.owner.sub,
          } satisfies TokenData),
        }),
    items: page,
  };
}

// ---------- events ----------

interface Window {
  fromMs?: number;
  toMs: number;
}

function overlaps(startMs: number, endMs: number, win: Window): boolean {
  if (startMs >= win.toMs) return false;
  if (win.fromMs === undefined) return true;
  return endMs > win.fromMs || (endMs === startMs && startMs >= win.fromMs);
}

/**
 * Occurrences nobody has edited, as events. Edited ones (exceptions) are separate records and are
 * listed by whoever lists records, so they are skipped here.
 */
function expandPlain(
  cal: CalendarRecord,
  master: EventRecord,
  win: Window,
  stopAfter = Infinity,
): GcalEvent[] {
  const out: GcalEvent[] = [];
  let scanned = 0;
  for (const occ of occurrences(seriesOf(master.event, cal.timeZone))) {
    if (occ.startMs >= win.toMs + 2 * DAY_MS || ++scanned > MAX_SCAN) break;
    const edited = cal.events.get(`${master.event.id}_${occ.key}`);
    if (edited && !edited.stale) continue;
    const instance = instanceOf(master.event, occ, cal.timeZone);
    const r = rangeOf(instance, cal.timeZone);
    if (!overlaps(r.startMs, r.endMs, win)) continue;
    out.push(instance);
    if (out.length >= stopAfter) break;
  }
  return out;
}

const hasOccurrenceIn = (cal: CalendarRecord, master: EventRecord, win: Window): boolean =>
  expandPlain(cal, master, win, 1).length > 0;

function eventWindow(store: CalendarStore, q: URLSearchParams): Window {
  const timeMax = instant(q, 'timeMax');
  return {
    fromMs: instant(q, 'timeMin'),
    toMs: timeMax ?? store.now() + store.deps.settings().expansionHorizonMs,
  };
}

/** Unordered lists keep creation order, except expanded ones, which come out chronologically as Google's do. */
function orderKey(
  orderBy: string | null,
  singleEvents: boolean,
  ev: GcalEvent,
  rec: EventRecord,
  startMs: number,
): string {
  const prefix =
    orderBy === 'startTime' || (!orderBy && singleEvents)
      ? pad(startMs)
      : orderBy === 'updated'
        ? pad(Date.parse(ev.updated))
        : pad(rec.seq, 10);
  return `${prefix}|${pad(startMs)}|${ev.id}`;
}

/** Everything listEvents collects from the query string, before scanning the store. */
interface ListQuery {
  token: TokenData | undefined;
  singleEvents: boolean;
  showDeleted: boolean;
  orderBy: string | null;
  max: number;
  updatedMin: number | undefined;
  hasWindow: boolean;
  win: Window;
  /** singleEvents of the call that issued the token, or of this call without one. */
  wasSingle: boolean;
  snapshot: number;
  pageToken: string | null;
}

function checkListParams(
  q: URLSearchParams,
  syncText: string | null,
  orderBy: string | null,
  singleEvents: boolean,
  updatedMin: number | undefined,
  hasWindow: boolean,
): void {
  // Google's list: iCalUID, orderBy, privateExtendedProperty, q, sharedExtendedProperty, timeMin, timeMax, updatedMin.
  const filtered = ['q', 'iCalUID', 'privateExtendedProperty', 'sharedExtendedProperty'].some(
    name => q.has(name),
  );
  if (syncText && (hasWindow || updatedMin !== undefined || orderBy || filtered)) {
    throw calInvalid(
      'syncToken cannot be combined with iCalUID, orderBy, privateExtendedProperty, q, sharedExtendedProperty, timeMin, timeMax or updatedMin.',
    );
  }
  if (orderBy && orderBy !== 'startTime' && orderBy !== 'updated')
    throw calInvalid('Invalid value for: orderBy');
  if (orderBy === 'startTime' && !singleEvents)
    throw calInvalid(
      'The requested ordering is not available for the particular query.',
      'badRequest',
    );
}

function listQuery(store: CalendarStore, cal: CalendarRecord, q: URLSearchParams): ListQuery {
  const settings = store.deps.settings();
  const syncText = q.get('syncToken');
  const singleEvents = bool(q, 'singleEvents') ?? false;
  const showDeleted = bool(q, 'showDeleted') ?? false;
  const orderBy = q.get('orderBy');
  const max = size(q, 250, 2500);
  const updatedMin = instant(q, 'updatedMin');
  const hasWindow = !!(q.get('timeMin') || q.get('timeMax'));
  checkListParams(q, syncText, orderBy, singleEvents, updatedMin, hasWindow);
  const token = syncText ? checkSyncToken(store, syncText, 'e', cal) : undefined;
  const win = token
    ? {
        fromMs: token.w?.[0] ?? store.now() - 30 * DAY_MS,
        toMs: token.w?.[1] ?? store.now() + settings.expansionHorizonMs,
      }
    : eventWindow(store, q);
  const wasSingle = token ? token.s === true : singleEvents;
  const pageToken = q.get('pageToken');
  const snapshot = snapshotOf(store, pageToken);
  return {
    token,
    singleEvents,
    showDeleted,
    orderBy,
    max,
    updatedMin,
    hasWindow,
    win,
    wasSingle,
    snapshot,
    pageToken,
  };
}

function collectRecord(
  cal: CalendarRecord,
  ev: GcalEvent,
  rec: EventRecord,
  opts: ListQuery,
  add: (ev: GcalEvent, rec: EventRecord) => void,
): void {
  const cancelled = ev.status === 'cancelled';
  const deletedSince = opts.updatedMin !== undefined && Date.parse(ev.updated) >= opts.updatedMin;
  if (cancelled && !opts.showDeleted && !deletedSince) return;
  if (opts.updatedMin !== undefined && Date.parse(ev.updated) < opts.updatedMin) return;
  if (isMaster(ev)) {
    if (cancelled) {
      if (!opts.singleEvents) add(ev, rec);
    } else if (opts.singleEvents) {
      for (const instance of expandPlain(cal, rec, opts.win)) add(instance, rec);
    } else if (!opts.hasWindow || hasOccurrenceIn(cal, rec, opts.win)) {
      add(ev, rec);
    }
    return;
  }
  if (rec.stale && !opts.showDeleted && !deletedSince) return;
  const r = rangeOf(ev, cal.timeZone);
  if (!opts.hasWindow || overlaps(r.startMs, r.endMs, opts.win)) add(ev, rec);
}

function collectEvents(
  store: CalendarStore,
  cal: CalendarRecord,
  opts: ListQuery,
): Keyed<GcalEvent>[] {
  const items: Keyed<GcalEvent>[] = [];
  const add = (ev: GcalEvent, rec: EventRecord): void => {
    const key = opts.token
      ? `${pad(rec.rev, 12)}|${ev.id}`
      : orderKey(opts.orderBy, opts.singleEvents, ev, rec, rangeOf(ev, cal.timeZone).startMs);
    items.push({ key, item: viewOf(ev) });
  };
  for (const rec of cal.events.values()) {
    const ev = rec.event;
    if (opts.token) {
      if (rec.rev <= opts.token.r) continue;
      if (opts.wasSingle && isMaster(ev) && ev.status !== 'cancelled')
        for (const instance of expandPlain(cal, rec, opts.win)) add(instance, rec);
      else add(ev, rec);
      continue;
    }
    collectRecord(cal, ev, rec, opts, add);
  }
  return items;
}

export function listEvents(
  store: CalendarStore,
  cal: CalendarRecord,
  q: URLSearchParams,
): Record<string, unknown> {
  const opts = listQuery(store, cal, q);
  const items = collectEvents(store, cal, opts);
  const { page, nextPageToken } = pageOf(items, opts.pageToken, opts.max, opts.snapshot);
  const nextSyncToken = encode({
    k: 'e',
    c: cal.id,
    r: opts.snapshot,
    a: store.now(),
    e: store.epochFor(`events:${cal.id}`),
    u: store.owner.sub,
    s: opts.wasSingle,
    ...(opts.token?.w
      ? { w: opts.token.w }
      : opts.hasWindow && opts.singleEvents
        ? { w: [opts.win.fromMs ?? null, opts.win.toMs] }
        : {}),
  } satisfies TokenData);
  return eventsEnvelope(store, cal, page, nextPageToken, nextPageToken ? undefined : nextSyncToken);
}

function eventsEnvelope(
  store: CalendarStore,
  cal: CalendarRecord,
  items: GcalEvent[],
  nextPageToken?: string,
  nextSyncToken?: string,
): Record<string, unknown> {
  return {
    kind: 'calendar#events',
    etag: `"e${store.rev}"`,
    summary: cal.summaryOverride ?? cal.summary,
    ...(cal.description !== undefined ? { description: cal.description } : {}),
    updated: iso(store.now()),
    timeZone: cal.timeZone,
    accessRole: cal.accessRole,
    defaultReminders: cal.primary ? [{ method: 'popup', minutes: 30 }] : [],
    ...(nextPageToken ? { nextPageToken } : {}),
    ...(nextSyncToken ? { nextSyncToken } : {}),
    items,
  };
}

export function listInstances(
  store: CalendarStore,
  cal: CalendarRecord,
  eventId: string,
  q: URLSearchParams,
): Record<string, unknown> {
  const located = locate(cal, eventId);
  const master = located.record;
  if (!master) throw calNotFound();
  if (!isMaster(master.event)) throw calInvalid('Not a recurring event.');
  if (master.event.status === 'cancelled') throw calNotFound();
  const showDeleted = bool(q, 'showDeleted') ?? false;
  const max = size(q, 250, 2500);
  const win = eventWindow(store, q);
  const hasWindow = !!(q.get('timeMin') || q.get('timeMax'));
  const pageToken = q.get('pageToken');
  const items: Keyed<GcalEvent>[] = [];
  const add = (ev: GcalEvent): void => {
    const startMs = rangeOf(ev, cal.timeZone).startMs;
    items.push({ key: `${pad(startMs)}|${ev.id}`, item: viewOf(ev) });
  };
  for (const ev of expandPlain(cal, master, win)) add(ev);
  for (const rec of cal.events.values()) {
    const ev = rec.event;
    if (
      ev.recurringEventId !== master.event.id ||
      rec.stale ||
      (ev.status === 'cancelled' && !showDeleted)
    )
      continue;
    const r = rangeOf(ev, cal.timeZone);
    if (!hasWindow || overlaps(r.startMs, r.endMs, win)) add(ev);
  }
  const { page, nextPageToken } = pageOf(items, pageToken, max, store.rev);
  return eventsEnvelope(store, cal, page, nextPageToken);
}
