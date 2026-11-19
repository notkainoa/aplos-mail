/**
 * RRULE text <-> `Rule` (RFC 5545 §3.3.10). Parsing is strict on the MUST/MUST NOT rules, because
 * a rule Aplos misreads must never be written back; `formatRRule` is its exact inverse.
 */
import { parseIcalValue, valueKey, type IcalValue } from './time';
import type { Weekday } from './types';

export type Freq = 'SECONDLY' | 'MINUTELY' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export interface ByDay {
  weekday: Weekday;
  /** 1 = first, -1 = last; absent means every such weekday in the period. */
  ordinal?: number;
}

export interface Rule {
  freq: Freq;
  interval: number;
  count?: number;
  until?: IcalValue;
  byDay: ByDay[];
  byMonthDay: number[];
  byMonth: number[];
  byYearDay: number[];
  byWeekNo: number[];
  bySetPos: number[];
  byHour: number[];
  byMinute: number[];
  bySecond: number[];
  /** Absent means the default, Monday. Kept absent so a rule formats back as it came. */
  wkst?: Weekday;
}

export type ParseResult =
  { ok: true; rule: Rule } | { ok: false; error: 'invalid' | 'unsupported'; reason: string };

export const WEEKDAYS: readonly Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const FREQS: readonly string[] = [
  'SECONDLY',
  'MINUTELY',
  'HOURLY',
  'DAILY',
  'WEEKLY',
  'MONTHLY',
  'YEARLY',
];

/** Frequencies the expander runs; finer ones are parsed but refused at expansion. */
export const EXPANDABLE: ReadonlySet<Freq> = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

type ListKey =
  | 'bySecond'
  | 'byMinute'
  | 'byHour'
  | 'byMonthDay'
  | 'byYearDay'
  | 'byWeekNo'
  | 'byMonth'
  | 'bySetPos';
/** Rule part, field, largest absolute value, whether negatives are allowed; also the output order. */
const LISTS: [string, ListKey, number, boolean][] = [
  ['BYSECOND', 'bySecond', 60, false],
  ['BYMINUTE', 'byMinute', 59, false],
  ['BYHOUR', 'byHour', 23, false],
  ['BYMONTHDAY', 'byMonthDay', 31, true],
  ['BYYEARDAY', 'byYearDay', 366, true],
  ['BYWEEKNO', 'byWeekNo', 53, true],
  ['BYMONTH', 'byMonth', 12, false],
  ['BYSETPOS', 'bySetPos', 366, true],
];
/** Parts whose zero is meaningful (minute 0); the others count from 1. */
const FROM_ZERO = new Set(['BYSECOND', 'BYMINUTE', 'BYHOUR']);

/** A typed refusal, thrown inside the module and turned into a result at its edges. */
export class Refusal extends Error {
  constructor(
    readonly kind: 'invalid' | 'unsupported',
    reason: string,
  ) {
    super(reason);
  }
}

export function fail(reason: string, kind: Refusal['kind'] = 'invalid'): never {
  throw new Refusal(kind, reason);
}

/** Parses 'FREQ=WEEKLY;BYDAY=MO' (an 'RRULE:' prefix is allowed). */
export function parseRRule(text: string): ParseResult {
  const rule: Rule = {
    freq: 'DAILY',
    interval: 1,
    byDay: [],
    byMonthDay: [],
    byMonth: [],
    byYearDay: [],
    byWeekNo: [],
    bySetPos: [],
    byHour: [],
    byMinute: [],
    bySecond: [],
  };
  const seen = new Set<string>();
  try {
    // RFC 5545's grammar has no trailing ';', but some producers write 'FREQ=WEEKLY;BYDAY=TH;'. The
    // meaning is not in doubt, and formatRRule writes the canonical form back, so one is dropped.
    const body = text
      .trim()
      .replace(/^RRULE:/i, '')
      .replace(/;$/, '');
    for (const part of body.toUpperCase().split(';')) {
      const [name, value, extra] = part.split('=');
      if (!name || !value || extra !== undefined) fail(`'${part}' is not NAME=VALUE`);
      if (seen.has(name)) fail(`${name} appears twice`);
      seen.add(name);
      const list = LISTS.find(l => l[0] === name);
      if (name === 'RSCALE' || name === 'SKIP') {
        // RFC 7529 non-Gregorian rules: valid, but nothing here can expand them.
        fail(`${name} (RFC 7529)`, 'unsupported');
      } else if (name === 'FREQ') {
        if (!FREQS.includes(value)) fail(`unknown FREQ ${value}`);
        rule.freq = value as Freq;
      } else if (name === 'INTERVAL' || name === 'COUNT') {
        if (!/^\d{1,9}$/.test(value) || Number(value) < 1)
          fail(`${name} must be a positive integer`);
        rule[name === 'COUNT' ? 'count' : 'interval'] = Number(value);
      } else if (name === 'UNTIL') {
        rule.until = /^\d{8}(T\d{6}Z?)?$/.test(value) ? parseIcalValue(value) : undefined;
        if (!rule.until) fail(`bad UNTIL ${value}`);
      } else if (name === 'WKST') {
        if (!WEEKDAYS.includes(value as Weekday)) fail(`bad WKST ${value}`);
        rule.wkst = value as Weekday;
      } else if (name === 'BYDAY') {
        rule.byDay = value.split(',').map(token => {
          const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(token);
          const ordinal = Number(m?.[1] ?? 1);
          if (!m || ordinal === 0 || Math.abs(ordinal) > 53) fail(`bad BYDAY ${token}`);
          return m[1] === undefined
            ? { weekday: m[2] as Weekday }
            : { weekday: m[2] as Weekday, ordinal };
        });
      } else if (list) {
        const [, key, max, signed] = list;
        rule[key] = value.split(',').map(v => {
          const n = Number(v);
          const ok =
            (signed ? /^[+-]?\d{1,3}$/ : /^\d{1,3}$/).test(v) &&
            Math.abs(n) <= max &&
            (n !== 0 || FROM_ZERO.has(name));
          return ok ? n : fail(`bad ${name} ${v}`);
        });
      } else {
        fail(`unknown part ${name}`);
      }
    }
    if (!seen.has('FREQ')) fail('FREQ is required');
    checkCombinations(rule);
  } catch (err) {
    if (err instanceof Refusal) return { ok: false, error: err.kind, reason: err.message };
    throw err;
  }
  return { ok: true, rule };
}

/** The MUST and MUST NOT sentences of RFC 5545 §3.3.10. */
function checkCombinations(r: Rule): void {
  const ordinals = r.byDay.some(b => b.ordinal !== undefined);
  if (r.count !== undefined && r.until) fail('COUNT with UNTIL');
  if (ordinals && r.freq !== 'MONTHLY' && r.freq !== 'YEARLY')
    fail('BYDAY ordinal outside MONTHLY/YEARLY');
  if (ordinals && r.byWeekNo.length) fail('BYDAY ordinal with BYWEEKNO');
  if (r.byMonthDay.length && r.freq === 'WEEKLY') fail('BYMONTHDAY with WEEKLY');
  if (r.byYearDay.length && ['DAILY', 'WEEKLY', 'MONTHLY'].includes(r.freq))
    fail(`BYYEARDAY with ${r.freq}`);
  if (r.byWeekNo.length && r.freq !== 'YEARLY') fail('BYWEEKNO outside YEARLY');
  if (
    r.bySetPos.length &&
    !r.byDay.length &&
    !LISTS.some(([, key]) => key !== 'bySetPos' && r[key].length)
  )
    fail('BYSETPOS alone');
}

/** Canonical text (no 'RRULE:' prefix); `parseRRule(formatRRule(r))` gives back `r`. */
export function formatRRule(rule: Rule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.until) parts.push(`UNTIL=${valueKey(rule.until)}`);
  if (rule.count !== undefined) parts.push(`COUNT=${rule.count}`);
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byDay.length)
    parts.push(`BYDAY=${rule.byDay.map(b => `${b.ordinal ?? ''}${b.weekday}`).join(',')}`);
  for (const [name, key] of LISTS)
    if (rule[key].length) parts.push(`${name}=${rule[key].join(',')}`);
  if (rule.wkst) parts.push(`WKST=${rule.wkst}`);
  return parts.join(';');
}
