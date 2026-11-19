/** Minimal iCalendar (RFC 5545) reading and writing for CalDAV events. */

export interface IcalProp {
  name: string;
  params: Record<string, string>;
  value: string;
  line: string;
}
export interface IcalComponent {
  name: string;
  props: IcalProp[];
  components: IcalComponent[];
}
/** `iso` is `YYYY-MM-DD` for dates and an ISO UTC string for date-times; `ms` is the UTC instant (midnight UTC for dates). */
export interface IcalTime {
  iso: string;
  allDay: boolean;
  ms: number;
}
export interface EventFields {
  title: string;
  location: string;
  description: string;
  guests: string[];
  allDay: boolean;
  start: string;
  end: string;
}
/** `recurring` marks one occurrence of a repeating event; `scheduling` marks a meeting the server would email attendees about. */
export interface ParsedEvent {
  uid: string;
  recurrenceId?: string;
  recurring: boolean;
  scheduling: boolean;
  title: string;
  location: string;
  description: string;
  guests: string[];
  start: IcalTime;
  end: IcalTime;
  cancelled: boolean;
}

const day = 864e5;

export function unfold(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .filter(line => line.trim());
}

export function parseLine(line: string): IcalProp | undefined {
  let i = 0;
  while (i < line.length && line[i] !== ';' && line[i] !== ':') i++;
  const name = line.slice(0, i).trim().toUpperCase(),
    params: Record<string, string> = {};
  if (!name) return;
  while (line[i] === ';') {
    let j = ++i;
    while (j < line.length && !'=;:'.includes(line[j])) j++;
    const key = line.slice(i, j).toUpperCase();
    let value = '';
    if (line[j] === '=') {
      let quoted = false;
      i = ++j;
      while (j < line.length && (quoted || (line[j] !== ';' && line[j] !== ':'))) {
        if (line[j] === '"') quoted = !quoted;
        j++;
      }
      value = line.slice(i, j).replace(/"/g, '');
    }
    if (key) params[key] = value;
    i = j;
  }
  return line[i] === ':' ? { name, params, value: line.slice(i + 1), line } : undefined;
}

export function parseComponents(text: string): IcalComponent[] {
  const root: IcalComponent = { name: '', props: [], components: [] },
    stack = [root];
  for (const line of unfold(text)) {
    const prop = parseLine(line);
    if (!prop) continue;
    const top = stack[stack.length - 1],
      kind = prop.value.trim().toUpperCase();
    if (prop.name === 'BEGIN') {
      const child = { name: kind, props: [], components: [] };
      top.components.push(child);
      stack.push(child);
    } else if (prop.name === 'END') {
      const at = stack.map(c => c.name).lastIndexOf(kind);
      if (at > 0) stack.length = at;
    } else top.props.push(prop);
  }
  return root.components;
}

/** Folds to 75 octets per line without splitting a UTF-8 sequence; continuation lines start with a space. */
export function fold(line: string): string {
  if (Buffer.byteLength(line) <= 75) return line;
  const out: string[] = [];
  let current = '',
    size = 0,
    limit = 75;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (size + n > limit) {
      out.push(current);
      current = '';
      size = 0;
      limit = 74;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join('\r\n ');
}

function lines(c: IcalComponent): string[] {
  return [
    `BEGIN:${c.name}`,
    ...c.props.map(p => p.line),
    ...c.components.flatMap(lines),
    `END:${c.name}`,
  ];
}
export function serialize(components: IcalComponent[]): string {
  return components.flatMap(lines).map(fold).join('\r\n') + '\r\n';
}

export const unescapeText = (value: string) =>
  value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
export const escapeText = (value: string) =>
  value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');

export function makeProp(
  name: string,
  value: string,
  params: Record<string, string> = {},
): IcalProp {
  const clean = (s: string) => s.replace(/[\r\n]+/g, ' ');
  const head =
    name +
    Object.entries(params)
      .map(([k, v]) => `;${k}=${/[;:,]/.test(v) ? `"${clean(v).replace(/"/g, '')}"` : clean(v)}`)
      .join('');
  return { name, params, value: clean(value), line: `${head}:${clean(value)}` };
}

export const prop = (c: IcalComponent, name: string) => c.props.find(p => p.name === name);
const text = (c: IcalComponent, name: string) => {
  const p = prop(c, name);
  return p ? unescapeText(p.value) : '';
};

// ---- time zones ----

const formatters = new Map<string, Intl.DateTimeFormat | null>();
function formatter(zone: string) {
  if (!formatters.has(zone)) {
    try {
      formatters.set(
        zone,
        new Intl.DateTimeFormat('en-US', {
          timeZone: zone,
          hourCycle: 'h23',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      );
    } catch {
      formatters.set(zone, null);
    }
  }
  return formatters.get(zone) ?? undefined;
}
/** The IANA zone a TZID names, also accepting vendor prefixes like `/mozilla.org/20050126_1/America/New_York`. */
export function ianaZone(tzid: string): string | undefined {
  const parts = tzid.split('/').filter(Boolean);
  return [tzid, parts.slice(-3).join('/'), parts.slice(-2).join('/')].find(
    zone => zone && formatter(zone),
  );
}
/** UTC offset in ms of `zone` at the instant `ms`. */
export function zoneOffset(ms: number, zone: string): number {
  const p = Object.fromEntries(
    formatter(zone)!
      .formatToParts(new Date(ms))
      .map(x => [x.type, x.value]),
  );
  return (
    Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) -
    Math.floor(ms / 1000) * 1000
  );
}
/**
 * Wall-clock time (expressed as if it were UTC) to an instant. Ambiguous times take the first occurrence and
 * times inside a DST gap use the offset from before the gap, as RFC 5545 section 3.3.5 requires.
 */
function wallToUtc(wall: number, offsetAt: (ms: number) => number): number {
  const before = offsetAt(wall - day),
    after = offsetAt(wall + day);
  const valid = [wall - before, wall - after].filter(t => offsetAt(t) === wall - t);
  return valid.length ? Math.min(...valid) : wall - before;
}
const pad = (n: number, size = 2) => String(n).padStart(size, '0');
const compact = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
};
export const utcStamp = (ms: number) => `${compact(ms)}Z`;

function parseWall(value: string): number | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?/.exec(value.trim());
  return m
    ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))
    : undefined;
}
function parseOffset(value: string | undefined): number | undefined {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(value?.trim() ?? '');
  return m
    ? (m[1] === '-' ? -1 : 1) * ((+m[2] * 60 + +m[3]) * 60 + +(m[4] ?? 0)) * 1000
    : undefined;
}
const weekdays = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
function ruleDay(
  year: number,
  month: number,
  rule: Record<string, string>,
  fallback: number,
): number | undefined {
  const byDay = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(rule.BYDAY ?? ''),
    monthDays = (rule.BYMONTHDAY ?? '').split(',').filter(Boolean).map(Number);
  const length = new Date(Date.UTC(year, month + 1, 0)).getUTCDate(),
    weekday = (d: number) => new Date(Date.UTC(year, month, d)).getUTCDay();
  if (!byDay)
    return monthDays[0] ? (monthDays[0] < 0 ? length + monthDays[0] + 1 : monthDays[0]) : fallback;
  const target = weekdays.indexOf(byDay[2]);
  const matches = Array.from({ length }, (_, i) => i + 1).filter(
    d => weekday(d) === target && (!monthDays.length || monthDays.includes(d)),
  );
  const n = Number(byDay[1] ?? 1);
  return n < 0 ? matches[matches.length + n] : matches[n - 1];
}
/**
 * UTC offset at the instant `ms` from a VTIMEZONE's STANDARD/DAYLIGHT observances (yearly BYMONTH/BYDAY rules and RDATEs).
 * Observance onsets are local times in the offset in force before the change (TZOFFSETFROM).
 */
function vtimezoneOffset(vtz: IcalComponent, ms: number): number | undefined {
  const year = new Date(ms).getUTCFullYear();
  let best: { at: number; offset: number } | undefined,
    earliest: { at: number; offset: number } | undefined;
  for (const obs of vtz.components.filter(c => c.name === 'STANDARD' || c.name === 'DAYLIGHT')) {
    const start = parseWall(prop(obs, 'DTSTART')?.value ?? ''),
      to = parseOffset(prop(obs, 'TZOFFSETTO')?.value),
      from = parseOffset(prop(obs, 'TZOFFSETFROM')?.value) ?? to;
    if (start === undefined || to === undefined || from === undefined) continue;
    if (!earliest || start - from < earliest.at) earliest = { at: start - from, offset: from };
    const onsets = [start];
    const rrule = prop(obs, 'RRULE');
    if (rrule) {
      const rule = Object.fromEntries(
        rrule.value
          .split(';')
          .map(part => part.split('=') as [string, string])
          .map(([k, v]) => [k.toUpperCase(), v ?? '']),
      );
      const until = rule.UNTIL ? parseWall(rule.UNTIL) : undefined,
        s = new Date(start);
      if (rule.FREQ === 'YEARLY')
        for (const y of [year - 1, year, year + 1]) {
          const month = rule.BYMONTH ? Number(rule.BYMONTH.split(',')[0]) - 1 : s.getUTCMonth(),
            d = ruleDay(y, month, rule, s.getUTCDate());
          if (d !== undefined)
            onsets.push(
              Date.UTC(y, month, d, s.getUTCHours(), s.getUTCMinutes(), s.getUTCSeconds()),
            );
        }
      if (until !== undefined) onsets.splice(0, onsets.length, ...onsets.filter(t => t <= until));
    }
    for (const r of obs.props.filter(p => p.name === 'RDATE'))
      for (const v of r.value.split(',')) {
        const t = parseWall(v);
        if (t !== undefined) onsets.push(t);
      }
    for (const onset of onsets) {
      const at = onset - from;
      if (onset >= start && at <= ms && (!best || at > best.at)) best = { at, offset: to };
    }
  }
  return best?.offset ?? earliest?.offset;
}

/** An offset-at-instant function for a TZID: the IANA zone it names, else its VTIMEZONE. */
function offsetFor(
  tzid: string | undefined,
  zones: Map<string, IcalComponent>,
): ((ms: number) => number) | undefined {
  if (!tzid) return;
  const iana = ianaZone(tzid);
  if (iana) return ms => zoneOffset(ms, iana);
  const vtz = zones.get(tzid);
  if (vtz && vtimezoneOffset(vtz, 0) !== undefined) return ms => vtimezoneOffset(vtz, ms)!;
}

/** Resolves a wall-clock time to UTC. Unknown TZIDs without a usable VTIMEZONE are treated as floating (this computer's zone). */
function toUtc(wall: number, tzid: string | undefined, zones: Map<string, IcalComponent>): number {
  const offsetAt = offsetFor(tzid, zones);
  if (offsetAt) return wallToUtc(wall, offsetAt);
  const d = new Date(wall);
  return new Date(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
  ).getTime();
}

const timeAt = (ms: number, allDay: boolean): IcalTime => ({
  iso: allDay ? new Date(ms).toISOString().slice(0, 10) : new Date(ms).toISOString(),
  allDay,
  ms,
});

export function parseTime(
  p: IcalProp | undefined,
  zones: Map<string, IcalComponent>,
): IcalTime | undefined {
  const value = p?.value.trim().split(',')[0] ?? '';
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (date) return timeAt(Date.UTC(+date[1], +date[2] - 1, +date[3]), true);
  const wall = parseWall(value);
  if (wall === undefined || !/T\d{6}Z?$/i.test(value)) return;
  return timeAt(/Z$/i.test(value) ? wall : toUtc(wall, p!.params.TZID, zones), false);
}

function duration(value: string | undefined): number | undefined {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(
    value?.trim() ?? '',
  );
  if (!m) return;
  const [w, d, h, min, s] = m.slice(2).map(x => Number(x ?? 0));
  return (m[1] === '-' ? -1 : 1) * ((((w * 7 + d) * 24 + h) * 60 + min) * 60 + s) * 1000;
}

export const zonesOf = (calendar: IcalComponent) =>
  new Map(
    calendar.components
      .filter(c => c.name === 'VTIMEZONE')
      .map(c => [prop(c, 'TZID')?.value.trim() ?? '', c]),
  );

export function eventTimes(
  vevent: IcalComponent,
  zones: Map<string, IcalComponent>,
): { start?: IcalTime; end?: IcalTime } {
  const start = parseTime(prop(vevent, 'DTSTART'), zones);
  if (!start) return {};
  const end = parseTime(prop(vevent, 'DTEND'), zones);
  if (end) return { start, end };
  const length = duration(prop(vevent, 'DURATION')?.value) ?? (start.allDay ? day : 0);
  return { start, end: timeAt(start.ms + length, start.allDay) };
}

function mailto(p: IcalProp): string {
  const value = p.value.trim();
  if (!/^mailto:/i.test(value)) return '';
  try {
    return decodeURIComponent(value.slice(7)).trim();
  } catch {
    return value.slice(7).trim();
  }
}

/**
 * A scheduling object (RFC 6638): the server sends invitations or cancellations when it changes. Attendees marked
 * SCHEDULE-AGENT=CLIENT without an ORGANIZER are the plain guest lists Aplos itself writes.
 */
export const isScheduling = (vevent: IcalComponent) =>
  Boolean(prop(vevent, 'ORGANIZER')) ||
  vevent.props.some(
    p => p.name === 'ATTENDEE' && (p.params['SCHEDULE-AGENT'] ?? '').toUpperCase() !== 'CLIENT',
  );

export function readEvents(data: string): ParsedEvent[] {
  const out: ParsedEvent[] = [];
  for (const calendar of parseComponents(data).filter(c => c.name === 'VCALENDAR')) {
    const zones = zonesOf(calendar),
      vevents = calendar.components.filter(c => c.name === 'VEVENT');
    const uid = (v: IcalComponent) => prop(v, 'UID')?.value.trim() ?? '';
    for (const vevent of vevents) {
      const { start, end } = eventTimes(vevent, zones);
      if (!start || !end) continue;
      const guests = [
        ...new Set(
          vevent.props
            .filter(p => p.name === 'ATTENDEE')
            .map(mailto)
            .filter(Boolean),
        ),
      ];
      // Expanded CalDAV results may leave RECURRENCE-ID off the first occurrence (RFC 4791 section 9.6.5), so siblings count too.
      const recurring =
        ['RECURRENCE-ID', 'RRULE', 'RDATE'].some(name => prop(vevent, name)) ||
        vevents.some(v => v !== vevent && uid(v) === uid(vevent));
      out.push({
        uid: uid(vevent),
        recurrenceId: parseTime(prop(vevent, 'RECURRENCE-ID'), zones)?.iso,
        recurring,
        scheduling: isScheduling(vevent),
        title: text(vevent, 'SUMMARY'),
        location: text(vevent, 'LOCATION'),
        description: text(vevent, 'DESCRIPTION'),
        guests,
        start,
        end,
        cancelled: prop(vevent, 'STATUS')?.value.trim().toUpperCase() === 'CANCELLED',
      });
    }
  }
  return out;
}

// ---- writing ----

/** Writes in the event's own zone (IANA or its VTIMEZONE) so a repeating event keeps its local time across DST; otherwise UTC. */
function timeProp(
  name: string,
  value: string,
  allDay: boolean,
  tzid?: string,
  zones: Map<string, IcalComponent> = new Map(),
): IcalProp {
  if (allDay) return makeProp(name, value.slice(0, 10).replace(/-/g, ''), { VALUE: 'DATE' });
  const ms = Date.parse(value),
    offsetAt = offsetFor(tzid, zones);
  return offsetAt
    ? makeProp(name, compact(ms + offsetAt(ms)), { TZID: tzid! })
    : makeProp(name, utcStamp(ms));
}
// Guests are written without an ORGANIZER and with SCHEDULE-AGENT=CLIENT so the server never emails them (RFC 6638 section 7.1).
const attendee = (email: string) =>
  makeProp('ATTENDEE', `mailto:${email}`, { 'SCHEDULE-AGENT': 'CLIENT' });

export function createCalendar(fields: EventFields & { uid: string }, now: Date): string {
  const props = [
    makeProp('UID', fields.uid),
    makeProp('DTSTAMP', utcStamp(now.getTime())),
    timeProp('DTSTART', fields.start, fields.allDay),
    timeProp('DTEND', fields.end, fields.allDay),
    makeProp('SUMMARY', escapeText(fields.title)),
  ];
  if (fields.location) props.push(makeProp('LOCATION', escapeText(fields.location)));
  if (fields.description) props.push(makeProp('DESCRIPTION', escapeText(fields.description)));
  props.push(...fields.guests.map(attendee));
  return serialize([
    {
      name: 'VCALENDAR',
      props: [
        makeProp('VERSION', '2.0'),
        makeProp('PRODID', '-//Aplos Mail//EN'),
        makeProp('CALSCALE', 'GREGORIAN'),
      ],
      components: [{ name: 'VEVENT', props, components: [] }],
    },
  ]);
}

export function timesChanged(
  vevent: IcalComponent,
  fields: EventFields,
  zones: Map<string, IcalComponent>,
): boolean {
  const { start, end } = eventTimes(vevent, zones);
  return (
    !start ||
    !end ||
    start.allDay !== fields.allDay ||
    start.iso !== fields.start ||
    end.iso !== fields.end
  );
}

const owned = new Set([
  'DTSTAMP',
  'LAST-MODIFIED',
  'SEQUENCE',
  'DTSTART',
  'DTEND',
  'DURATION',
  'SUMMARY',
  'LOCATION',
  'DESCRIPTION',
  'ATTENDEE',
]);
/**
 * Rewrites the fields Aplos edits on an existing VEVENT in place. Everything else (UID, RRULE, EXDATE, ORGANIZER,
 * alarms, X- properties) is kept, and edited properties whose value did not change keep their original line and parameters.
 */
export function applyFields(
  vevent: IcalComponent,
  fields: EventFields,
  now: Date,
  zones: Map<string, IcalComponent>,
): void {
  const out = vevent.props.filter(p => !owned.has(p.name) || (p.name === 'ATTENDEE' && !mailto(p))),
    stamp = utcStamp(now.getTime());
  out.push(makeProp('DTSTAMP', stamp));
  if (prop(vevent, 'LAST-MODIFIED')) out.push(makeProp('LAST-MODIFIED', stamp));
  const sequence = prop(vevent, 'SEQUENCE');
  if (sequence) out.push(makeProp('SEQUENCE', String((parseInt(sequence.value, 10) || 0) + 1)));
  if (timesChanged(vevent, fields, zones)) {
    const tzid = prop(vevent, 'DTSTART')?.params.TZID;
    out.push(
      timeProp('DTSTART', fields.start, fields.allDay, tzid, zones),
      timeProp(
        'DTEND',
        fields.end,
        fields.allDay,
        prop(vevent, 'DTEND')?.params.TZID ?? tzid,
        zones,
      ),
    );
  } else
    out.push(
      ...vevent.props.filter(
        p => p.name === 'DTSTART' || p.name === 'DTEND' || p.name === 'DURATION',
      ),
    );
  for (const [name, value] of [
    ['SUMMARY', fields.title],
    ['LOCATION', fields.location],
    ['DESCRIPTION', fields.description],
  ] as const) {
    const old = prop(vevent, name);
    if (old && unescapeText(old.value) === value) out.push(old);
    else {
      if (value) out.push(makeProp(name, escapeText(value)));
      if (name === 'DESCRIPTION')
        out.splice(0, out.length, ...out.filter(p => p.name !== 'X-ALT-DESC'));
    }
  }
  const existing = new Map(
    vevent.props.filter(p => p.name === 'ATTENDEE').map(p => [mailto(p).toLowerCase(), p]),
  );
  out.push(...fields.guests.map(email => existing.get(email.toLowerCase()) ?? attendee(email)));
  vevent.props = out;
}
