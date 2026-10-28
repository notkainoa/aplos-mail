import { randomUUID } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import {
  ProviderError,
  calendarColor,
  type CalendarBackend,
  type CalendarCredentials,
  type CalendarInfo,
} from '@aplos/engine/legacy/provider';
import type { Account, CalendarEvent } from '@aplos/contract/legacy/types';
import {
  applyFields,
  createCalendar,
  isScheduling,
  parseComponents,
  prop,
  readEvents,
  serialize,
  utcStamp,
  zonesOf,
  type EventFields,
  type IcalComponent,
  type ParsedEvent,
} from './ical';

export class CalDavError extends ProviderError {}

type Json = any;
interface Calendar extends CalendarInfo {
  events: boolean;
  writable: boolean;
}
interface DavResponse {
  href: string;
  props: Json;
}

const timeout = 30_000,
  xml = 'application/xml; charset=utf-8',
  ics = 'text/calendar; charset=utf-8';
const conflict = 'This event changed on the server. Refresh the calendar and try again.';
const list = (value: unknown): Json[] =>
  value === undefined || value === null || value === ''
    ? []
    : Array.isArray(value)
      ? value
      : [value];
const textOf = (value: unknown): string =>
  typeof value === 'string'
    ? value.trim()
    : value && typeof value === 'object' && typeof (value as Json)['#text'] === 'string'
      ? (value as Json)['#text'].trim()
      : '';
const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === 'object';
const parent = (href: string) => href.replace(/[^/]*$/, '');
const sameEtag = (a: string, b: string) => a.replace(/^W\//, '') === b.replace(/^W\//, '');
const propfindBody = (props: string) =>
  `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/"><D:prop>${props}</D:prop></D:propfind>`;

function statusError(status: number): CalDavError {
  if (status === 401) return new CalDavError('The calendar server rejected the password.', 401);
  if (status === 403)
    return new CalDavError('The calendar server does not allow this change.', 403);
  if (status === 404 || status === 410)
    return new CalDavError('The calendar server could not find this calendar or event.', status);
  if (status === 412) return new CalDavError(conflict, 412);
  if (status >= 500)
    return new CalDavError(
      `The calendar server had a problem (HTTP ${status}). Try again later.`,
      status,
      true,
    );
  return new CalDavError(`The calendar server returned an error (HTTP ${status}).`, status);
}

/** Every address the password is sent to, including ones the server names, must be plain HTTPS. */
function secureUrl(url: string, base?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    throw new CalDavError('The calendar server gave an address Aplos could not use.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new CalDavError(
      'The calendar server gave an insecure address (not plain HTTPS), so Aplos did not send your password to it.',
    );
  return parsed.toString();
}

export function createCalDav(
  options: { fetch?: typeof fetch; now?: () => Date } = {},
): CalendarBackend {
  const http = options.fetch ?? fetch,
    now = options.now ?? (() => new Date());
  const homes = new Map<string, string>();
  const parser = new XMLParser({
    removeNSPrefix: true,
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    htmlEntities: true,
    isArray: name => ['response', 'propstat', 'href', 'comp', 'privilege'].includes(name),
  });

  /** Follows redirects itself so the login is kept across hosts, but only ever to HTTPS addresses. */
  async function request(
    credentials: CalendarCredentials,
    url: string,
    method: string,
    init: { body?: string; headers?: Record<string, string>; allow?: number[] } = {},
  ) {
    const authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64')}`;
    let target = secureUrl(url);
    for (let hop = 0; hop < 6; hop++) {
      let response: Response, text: string;
      try {
        response = await http(target, {
          method,
          body: init.body,
          headers: { authorization, ...init.headers },
          redirect: 'manual',
          signal: AbortSignal.timeout(timeout),
        });
        const location = response.headers.get('location');
        if ([301, 302, 307, 308].includes(response.status) && location) {
          target = secureUrl(location, target);
          continue;
        }
        text = await response.text();
      } catch (error) {
        if (error instanceof CalDavError) throw error;
        const name = (error as Error)?.name;
        throw new CalDavError(
          name === 'TimeoutError' || name === 'AbortError'
            ? 'The calendar server did not answer in time.'
            : 'The calendar server could not be reached.',
          undefined,
          true,
        );
      }
      if (response.ok || init.allow?.includes(response.status))
        return { response, text, url: target };
      throw statusError(response.status);
    }
    throw new CalDavError('The calendar server redirected too many times.');
  }

  function multistatus(text: string, base: string): DavResponse[] {
    let doc: Json;
    try {
      doc = parser.parse(text);
    } catch {
      throw new CalDavError('The calendar server sent a response Aplos could not read.');
    }
    return list(doc?.multistatus?.response).flatMap((r: Json) => {
      const href = textOf(list(r?.href)[0]);
      if (!href) return [];
      const props = Object.assign(
        {},
        ...list(r.propstat)
          .filter((p: Json) => !p?.status || /^HTTP\/\S+\s+2\d\d/.test(textOf(p.status)))
          .map((p: Json) => (isObject(p?.prop) ? p.prop : {})),
      );
      return [{ href: new URL(href, base).toString(), props }];
    });
  }

  async function propfind(
    credentials: CalendarCredentials,
    url: string,
    depth: '0' | '1',
    props: string,
  ) {
    const { text, url: base } = await request(credentials, url, 'PROPFIND', {
      headers: { depth, 'content-type': xml },
      body: propfindBody(props),
    });
    return { responses: multistatus(text, base), base };
  }

  /** First DAV:href inside `name` on a Depth 0 PROPFIND, resolved against the server that answered. */
  async function hrefProp(
    credentials: CalendarCredentials,
    url: string,
    name: string,
    element: string,
  ): Promise<string | undefined> {
    try {
      const { responses, base } = await propfind(credentials, url, '0', element);
      const href = responses.map(r => textOf(list(r.props[name]?.href)[0])).find(Boolean);
      return href ? new URL(href, base).toString() : undefined;
    } catch (error) {
      if (error instanceof CalDavError && [403, 404, 405].includes(error.status ?? 0)) return;
      throw error;
    }
  }

  async function discover(credentials: CalendarCredentials): Promise<string> {
    const start = new URL(
      /^https?:\/\//i.test(credentials.url.trim())
        ? credentials.url.trim()
        : `https://${credentials.url.trim()}`,
    ).toString();
    let principal = await hrefProp(
      credentials,
      start,
      'current-user-principal',
      '<D:current-user-principal/>',
    );
    if (!principal && !new URL(start).pathname.startsWith('/.well-known/'))
      principal = await hrefProp(
        credentials,
        new URL('/.well-known/caldav', start).toString(),
        'current-user-principal',
        '<D:current-user-principal/>',
      );
    const home = await hrefProp(
      credentials,
      principal ?? start,
      'calendar-home-set',
      '<C:calendar-home-set/>',
    );
    return home ?? principal ?? start;
  }

  async function home(
    credentials: CalendarCredentials,
    fresh: boolean,
  ): Promise<{ url: string; cached: boolean }> {
    const key = `${credentials.url}\n${credentials.username}`,
      cached = homes.get(key);
    if (cached && !fresh) return { url: cached, cached: true };
    const url = await discover(credentials);
    homes.set(key, url);
    return { url, cached: false };
  }

  async function calendars(credentials: CalendarCredentials, fresh = false): Promise<Calendar[]> {
    const key = `${credentials.url}\n${credentials.username}`,
      where = await home(credentials, fresh);
    let found;
    try {
      found = await propfind(
        credentials,
        where.url,
        '1',
        '<D:resourcetype/><D:displayname/><C:supported-calendar-component-set/><D:current-user-privilege-set/><A:calendar-color/>',
      );
    } catch (error) {
      if (error instanceof CalDavError && (error.status === 401 || error.status === 404))
        homes.delete(key);
      if (where.cached && error instanceof CalDavError && error.status === 404)
        return calendars(credentials, true);
      throw error;
    }
    return found.responses
      .filter(r => isObject(r.props.resourcetype) && 'calendar' in r.props.resourcetype)
      .map(r => {
        const components = list(r.props['supported-calendar-component-set']?.comp).map((c: Json) =>
          String(c?.['@_name'] ?? '').toUpperCase(),
        );
        const privileges = r.props['current-user-privilege-set'];
        const writable =
          !isObject(privileges) ||
          list(privileges.privilege).some(
            (p: Json) => isObject(p) && ['write', 'write-content', 'bind', 'all'].some(k => k in p),
          );
        let name = textOf(r.props.displayname);
        if (!name)
          try {
            name = decodeURIComponent(
              new URL(r.href).pathname.split('/').filter(Boolean).pop() ?? 'Calendar',
            );
          } catch {
            name = 'Calendar';
          }
        const color = calendarColor(textOf(r.props['calendar-color']));
        return {
          id: r.href,
          name,
          accountId: '',
          ...(color ? { color } : {}),
          events: !components.length || components.includes('VEVENT'),
          writable,
        };
      });
  }

  /** Occurrences of a repeating event always carry their own start in the id, since the first one may lack a RECURRENCE-ID. */
  function model(
    parsed: ParsedEvent,
    account: Account,
    calendarId: string,
    href: string,
    etag: string,
  ): CalendarEvent {
    const uid = parsed.uid || href,
      occurrence = parsed.recurrenceId ?? (parsed.recurring ? parsed.start.iso : undefined);
    return {
      id: `${account.id}:${calendarId}:${uid}${occurrence ? `:${occurrence}` : ''}`,
      accountId: account.id,
      calendarId,
      title: parsed.title || '(Untitled event)',
      start: parsed.start.iso,
      end: parsed.end.iso,
      allDay: parsed.start.allDay,
      location: parsed.location,
      description: parsed.description,
      guests: parsed.guests,
      remoteId: href,
      ...(etag ? { etag } : {}),
      ...(parsed.scheduling ? { scheduling: true } : {}),
    };
  }

  async function target(credentials: CalendarCredentials, calendarId: string): Promise<Calendar> {
    const all = (await calendars(credentials)).filter(c => c.events);
    if (!calendarId || calendarId === 'primary') {
      const first = all.find(c => c.writable);
      if (!first)
        throw new CalDavError('The calendar server has no calendar Aplos can add events to.');
      return first;
    }
    const found = all.find(c => c.id === calendarId);
    if (!found)
      throw new CalDavError(
        'This calendar is no longer on the calendar server. Refresh the calendar.',
        404,
      );
    if (!found.writable) throw new CalDavError('This calendar is read-only.', 403);
    return found;
  }

  /**
   * Loads the stored resource behind an event and refuses what Aplos cannot change safely: repeating events (each
   * listed copy is one expanded occurrence, but the resource is the whole series), meetings the server would email
   * attendees about, and edits made against an older copy than the server now holds.
   */
  async function stored(
    credentials: CalendarCredentials,
    event: CalendarEvent,
    action: 'change' | 'delete',
  ) {
    const verb = action === 'delete' ? 'Delete' : 'Change',
      meeting = () =>
        new CalDavError(
          `This is a meeting with invited guests, so changing it here could email them. ${verb} it in your calendar app.`,
          409,
        );
    if (event.scheduling) throw meeting();
    const href = event.remoteId!;
    const { response, text } = await request(credentials, href, 'GET', {
      headers: { accept: 'text/calendar' },
      allow: [404, 410],
    });
    if (response.status === 404 || response.status === 410) return;
    const doc = parseComponents(text),
      calendar = doc.find(c => c.name === 'VCALENDAR');
    const vevents = calendar?.components.filter(c => c.name === 'VEVENT') ?? [];
    if (!calendar || !vevents.length)
      throw new CalDavError('The calendar server returned an event Aplos could not read.');
    const master = vevents[0],
      etag = response.headers.get('etag') ?? undefined;
    if (vevents.length > 1 || ['RECURRENCE-ID', 'RRULE', 'RDATE'].some(name => prop(master, name)))
      throw new CalDavError(
        `This is a repeating event. ${verb} it in your calendar app; Aplos cannot change repeating events yet.`,
        409,
      );
    if (isScheduling(master)) throw meeting();
    if (event.etag && etag && !sameEtag(event.etag, etag)) throw new CalDavError(conflict, 412);
    return { doc, calendar, master, ifMatch: event.etag ?? etag };
  }

  return {
    async verify(credentials) {
      await calendars(credentials, true);
    },
    async listCalendars(credentials, account) {
      const list = (await calendars(credentials)).filter(c => c.events),
        first = list.find(c => c.writable);
      return list.map(c => ({
        id: c.id,
        name: c.name,
        accountId: account.id,
        ...(c.color ? { color: c.color } : {}),
        ...(c === first ? { primary: true } : {}),
      }));
    },
    async listEvents(credentials, account) {
      const at = now(),
        min = new Date(at.getTime() - 30 * 864e5),
        max = new Date(at);
      max.setUTCFullYear(max.getUTCFullYear() + 1);
      const range = `start="${utcStamp(min.getTime())}" end="${utcStamp(max.getTime())}"`;
      const body = `<?xml version="1.0" encoding="utf-8"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data><C:expand ${range}/></C:calendar-data></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range ${range}/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`;
      const results = await Promise.all(
        (await calendars(credentials))
          .filter(c => c.events)
          .map(async calendar => {
            const { text, url } = await request(credentials, calendar.id, 'REPORT', {
              headers: { depth: '1', 'content-type': xml },
              body,
            });
            return multistatus(text, url).flatMap(r => {
              const data = textOf(r.props['calendar-data']),
                etag = textOf(r.props.getetag);
              return data
                ? readEvents(data)
                    .filter(e => !e.cancelled)
                    .map(e => model(e, account, calendar.id, r.href, etag))
                : [];
            });
          }),
      );
      return results.flat();
    },
    async saveEvent(credentials, account, event) {
      const allDay = Boolean(event.allDay),
        norm = (value: string) =>
          allDay
            ? String(value).slice(0, 10)
            : Number.isFinite(Date.parse(value))
              ? new Date(value).toISOString()
              : '';
      const fields: EventFields = {
        title: String(event.title ?? '').trim(),
        location: event.location ?? '',
        description: event.description ?? '',
        guests: [
          ...new Set(
            (event.guests ?? []).map(g => g.trim()).filter(g => /^[^\s@<>"]+@[^\s@<>"]+$/.test(g)),
          ),
        ],
        allDay,
        start: norm(event.start),
        end: norm(event.end),
      };
      if (
        !fields.title ||
        !Number.isFinite(Date.parse(fields.start)) ||
        !Number.isFinite(Date.parse(fields.end)) ||
        Date.parse(fields.end) <= Date.parse(fields.start)
      )
        throw new CalDavError('A calendar event needs a title and valid start and end times.');
      const saved = (calendarId: string, href: string, response: Response): CalendarEvent => ({
        ...event,
        ...fields,
        calendarId,
        remoteId: href,
        url: undefined,
        id: event.id,
        accountId: account.id,
        etag: response.headers.get('etag') ?? undefined,
      });
      if (!event.remoteId) {
        const calendar = await target(credentials, event.calendarId);
        const uid = randomUUID(),
          href = new URL(
            `${uid}.ics`,
            calendar.id.endsWith('/') ? calendar.id : `${calendar.id}/`,
          ).toString();
        const { response } = await request(credentials, href, 'PUT', {
          headers: { 'content-type': ics, 'if-none-match': '*' },
          body: createCalendar({ ...fields, uid }, now()),
        });
        return saved(calendar.id, href, response);
      }
      const current = await stored(credentials, event, 'change');
      if (!current)
        throw new CalDavError(
          'This event is no longer on the calendar server. Refresh the calendar.',
          404,
        );
      applyFields(current.master, fields, now(), zonesOf(current.calendar as IcalComponent));
      const { response } = await request(credentials, event.remoteId, 'PUT', {
        headers: {
          'content-type': ics,
          ...(current.ifMatch ? { 'if-match': current.ifMatch } : {}),
        },
        body: serialize(current.doc),
      });
      return saved(
        event.calendarId && event.calendarId !== 'primary'
          ? event.calendarId
          : parent(event.remoteId),
        event.remoteId,
        response,
      );
    },
    async deleteEvent(credentials, _account, event) {
      if (!event.remoteId) throw new CalDavError('This event has no calendar server address.');
      const current = await stored(credentials, event, 'delete');
      if (current)
        await request(credentials, event.remoteId, 'DELETE', {
          headers: current.ifMatch ? { 'if-match': current.ifMatch } : {},
          allow: [404, 410],
        });
    },
  };
}
