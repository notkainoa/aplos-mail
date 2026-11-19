/**
 * Golden corpus inputs: the case types and the zoned / floating / all-day case builders, shared by
 * the chunks. Expected outputs are never written here: generate.ts runs both oracles over these
 * inputs and records only what they agree on.
 */

export type EventTime = { utc: number } | { date: string } | { local: string; tzid?: string };

export interface CaseOverride {
  recurrenceId: string | EventTime;
  start?: EventTime;
  end?: EventTime;
  cancelled?: boolean;
}

export interface CaseEvent {
  start: EventTime;
  end: EventTime;
  allDay: boolean;
  tzid?: string;
  rrule?: string;
  rdate?: string[];
  exdate?: string[];
  overrides?: CaseOverride[];
}

export interface Case {
  id: string;
  tags: string[];
  note?: string;
  /** Input intent only: the case exercises a refusal. The refusal kind still comes from the oracles. */
  refusal?: true;
  event: CaseEvent;
  /** ISO instants; occurrences overlapping [from, to) are expected. */
  range: { from: string; to: string };
  limit?: number;
}

export const LA = 'America/Los_Angeles';
export const LON = 'Europe/London';
export const SYD = 'Australia/Sydney';
export const NY = 'America/New_York';
export const TYO = 'Asia/Tokyo';

export const RANGE = { from: '2026-01-01T00:00:00Z', to: '2028-01-01T00:00:00Z' };

export function addWall(local: string, minutes: number): string {
  const ms = Date.parse(`${local}Z`) + minutes * 60_000;
  return new Date(ms).toISOString().slice(0, 19);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export type Extra = Partial<Omit<Case, 'id' | 'tags' | 'event'>> &
  Partial<Pick<CaseEvent, 'rdate' | 'exdate' | 'overrides' | 'tzid'>>;

export function split(extra: Extra): { event: Partial<CaseEvent>; rest: Partial<Case> } {
  const { rdate, exdate, overrides, tzid, ...rest } = extra;
  const event: Partial<CaseEvent> = {};
  if (rdate) event.rdate = rdate;
  if (exdate) event.exdate = exdate;
  if (overrides) event.overrides = overrides;
  if (tzid) event.tzid = tzid;
  return { event, rest };
}

/** A zoned event: wall clock `local` in `tz`, lasting `minutes`. */
export function zoned(
  id: string,
  tags: string[],
  tz: string,
  local: string,
  minutes: number,
  rrule: string | undefined,
  extra: Extra = {},
): Case {
  const { event, rest } = split(extra);
  return {
    id,
    tags,
    range: RANGE,
    ...rest,
    event: {
      start: { local, tzid: tz },
      end: { local: addWall(local, minutes), tzid: tz },
      allDay: false,
      ...(rrule ? { rrule } : {}),
      ...event,
    },
  };
}

export function floating(
  id: string,
  tags: string[],
  local: string,
  minutes: number,
  rrule: string | undefined,
  extra: Extra = {},
): Case {
  const { event, rest } = split(extra);
  return {
    id,
    tags,
    range: RANGE,
    ...rest,
    event: {
      start: { local },
      end: { local: addWall(local, minutes) },
      allDay: false,
      ...(rrule ? { rrule } : {}),
      ...event,
    },
  };
}

export function allDay(
  id: string,
  tags: string[],
  date: string,
  days: number,
  rrule: string | undefined,
  extra: Extra = {},
): Case {
  const { event, rest } = split(extra);
  return {
    id,
    tags,
    range: RANGE,
    ...rest,
    event: {
      start: { date },
      end: { date: addDays(date, days) },
      allDay: true,
      ...(rrule ? { rrule } : {}),
      ...event,
    },
  };
}

export const at = (local: string, tz: string): EventTime => ({ local, tzid: tz });
