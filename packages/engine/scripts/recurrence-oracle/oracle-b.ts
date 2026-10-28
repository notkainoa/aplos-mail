/**
 * Oracle B: the Google Calendar emulator's own expander, written separately by the prov-emu lane
 * (read-only, imported by absolute path; it is never copied into the engine). It covers a subset
 * of RFC 5545 and throws RecurrenceError for anything else, which counts as "not supported".
 *
 * Same job and result shapes as oracle_a.py, so the merge step treats both alike.
 */
import type { CaseOverride, EventTime } from './cases';

export const ORACLE_B_DIR =
  process.env.APLOS_ORACLE_B_DIR ??
  '/Users/knewton/.t3/worktrees/aplos-mail/rv-prov-emu-gcal/packages/emulators/src/gcal';

export interface Job {
  id: string;
  start: EventTime;
  end: EventTime;
  allDay: boolean;
  tzid?: string;
  rrule?: string;
  rdate?: string[];
  exdate?: string[];
  overrides?: CaseOverride[];
  /** Comparable ms (instant for zoned series, wall-as-UTC otherwise): instances after it are not listed. */
  cutoff: number;
}

export type OracleResult =
  | {
      id: string;
      status: 'ok';
      mode: 'zoned' | 'floating' | 'date';
      durationMs: number;
      instances: string[];
      overrides: {
        recurrenceId: string;
        start: string | null;
        end: string | null;
        cancelled: boolean;
      }[];
    }
  | { id: string; status: 'refused'; error: string };

interface Emulator {
  occurrences(series: {
    allDay: boolean;
    tz: string;
    startDay: number;
    h: number;
    mi: number;
    s: number;
    recurrence: string[];
  }): Generator<{ key: string; day: number; startMs: number }>;
  validateRecurrence(lines: unknown): void;
}
interface EmulatorTz {
  localToUtc(
    p: { y: number; mo: number; d: number; h: number; mi: number; s: number },
    tz: string,
  ): number;
  localParts(
    ms: number,
    tz: string,
  ): { y: number; mo: number; d: number; h: number; mi: number; s: number };
  dayOfCivil(y: number, mo: number, d: number): number;
  utcKey(ms: number): string;
}

const CAP = 20_000;

function parts(text: string): {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
} {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/.exec(text.replace(/[-:]/g, ''));
  if (!m) throw new Error(`bad value ${text}`);
  return { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0) };
}

export async function loadOracleB(): Promise<(job: Job) => OracleResult> {
  const rrule = (await import(`${ORACLE_B_DIR}/rrule.ts`)) as Emulator;
  const tz = (await import(`${ORACLE_B_DIR}/tz.ts`)) as EmulatorTz;

  return (job: Job): OracleResult => {
    try {
      const startTz = 'local' in job.start ? job.start.tzid : undefined;
      const mode = job.allDay
        ? 'date'
        : 'utc' in job.start || startTz || job.tzid
          ? 'zoned'
          : 'floating';
      // The emulator has no floating time: UTC has no DST, so its wall clock stands in for one.
      const zone = mode === 'zoned' ? (startTz ?? job.tzid ?? 'UTC') : 'UTC';
      const msOf = (t: EventTime): number => {
        if ('utc' in t) return t.utc;
        const p = parts('date' in t ? t.date : t.local);
        if ('date' in t) return Date.UTC(p.y, p.mo - 1, p.d);
        return mode === 'zoned'
          ? tz.localToUtc(p, t.tzid ?? zone)
          : Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
      };
      const startParts =
        'utc' in job.start
          ? tz.localParts(job.start.utc, zone)
          : parts('date' in job.start ? job.start.date : job.start.local);
      const startMs = msOf(job.start);
      const durationMs = msOf(job.end) - startMs;
      const line = (name: string, text: string): string =>
        /^[A-Z]+[;:]/i.test(text) ? text : `${name}:${text}`;
      const recurrence = [
        ...(job.rrule ? [`RRULE:${job.rrule.replace(/^RRULE:/i, '')}`] : []),
        ...(job.rdate ?? []).map(t => line('RDATE', t)),
        ...(job.exdate ?? []).map(t => line('EXDATE', t)),
      ];
      rrule.validateRecurrence(recurrence);
      const series = {
        allDay: job.allDay,
        tz: zone,
        startDay: tz.dayOfCivil(startParts.y, startParts.mo, startParts.d),
        h: startParts.h,
        mi: startParts.mi,
        s: startParts.s,
        recurrence,
      };
      const keyOf = (k: string): string => (mode === 'floating' ? k.replace(/Z$/, '') : k);
      const instances: string[] = [];
      for (const occ of rrule.occurrences(series)) {
        if (occ.startMs > job.cutoff || instances.length >= CAP) break;
        instances.push(keyOf(occ.key));
      }
      const timeKey = (t: EventTime): string => {
        if ('date' in t) return t.date.replace(/-/g, '');
        if ('utc' in t) return tz.utcKey(t.utc);
        if (mode === 'zoned' || t.tzid)
          return tz.utcKey(tz.localToUtc(parts(t.local), t.tzid ?? zone));
        return t.local.replace(/[-:]/g, '');
      };
      const idKey = (id: string | EventTime): string => {
        if (typeof id !== 'string') {
          if (mode === 'date')
            return timeKey(
              'date' in id ? id : { date: ('local' in id ? id.local : '').slice(0, 10) },
            );
          return keyOf(timeKey(id));
        }
        if (mode === 'date') return id.slice(0, 8);
        if (/Z$/.test(id) || mode === 'floating') return keyOf(id);
        return tz.utcKey(tz.localToUtc(parts(id), zone));
      };
      const overrides = (job.overrides ?? []).map(o => ({
        recurrenceId: idKey(o.recurrenceId),
        start: o.start ? timeKey(o.start) : null,
        end: o.end ? timeKey(o.end) : null,
        cancelled: o.cancelled === true,
      }));
      return { id: job.id, status: 'ok', mode, durationMs, instances, overrides };
    } catch (err) {
      return {
        id: job.id,
        status: 'refused',
        error: `${(err as Error).name}: ${(err as Error).message}`,
      };
    }
  };
}
