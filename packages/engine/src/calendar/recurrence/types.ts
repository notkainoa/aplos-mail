/**
 * Shapes shared by the recurrence module. `EventTime` mirrors the port proposal's
 * (plan 20 port-proposal §3.1); switch to the frozen port type once `ports.ts` carries it.
 */

/** An instant (`utc`, ms), an all-day date (`date`, 'YYYY-MM-DD'), or a wall-clock reading, zoned or floating. */
export type EventTime = { utc: number } | { date: string } | { local: string; tzid?: string };

/** RFC 5545 weekday codes. */
export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

/** One occurrence override (RECURRENCE-ID in iCalendar, an exception instance in Google). */
export interface Override {
  /** The ORIGINAL start of the occurrence: an EventTime or an occurrence key. */
  recurrenceId: string | EventTime;
  start?: EventTime;
  end?: EventTime;
  cancelled?: boolean;
}

/** A recurring master as stored (ADR-20: masters plus overrides, expansion on query). */
export interface Series {
  start: EventTime;
  end: EventTime;
  allDay: boolean;
  /** Zone the wall clock repeats in when `start` is an instant or a bare local time. */
  tzid?: string;
  /** 'FREQ=...' or 'RRULE:FREQ=...'; more than one rule is refused as unsupported. */
  rrule?: string | string[];
  /** iCalendar lines ('RDATE;TZID=Europe/London:20261025T090000') or bare values. */
  rdate?: string[];
  exdate?: string[];
  overrides?: Override[];
}

export interface Occurrence {
  /** Occurrence key of the ORIGINAL start (see `occurrenceKey`). */
  recurrenceId: string;
  /** `{utc}` for zoned events, `{local}` for floating ones, `{date}` for all-day ones. */
  start: EventTime;
  end: EventTime;
  overridden: boolean;
}

export interface ExpandRequest extends Series {
  /** Instants in ms; an occurrence is returned when it overlaps [from, to). */
  range: { from: number; to: number };
  /** Default 5,000. */
  limit?: number;
  /** Where floating and all-day times sit on the timeline for range checks and sorting (default UTC). */
  floatingZone?: string;
}

export type ExpandResult =
  | { ok: true; occurrences: Occurrence[]; truncated: boolean }
  | {
      ok: false;
      /** 'unsupported': valid but outside what Aplos expands (HOURLY and finer, several RRULEs). 'invalid': broken input. */
      refused: 'unsupported' | 'invalid';
      reason: string;
      /** The master's own first instance when it overlaps the range: callers show only this and never write the series. */
      occurrences: Occurrence[];
    };
