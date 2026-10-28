/**
 * Google resets daily quotas at midnight America/Los_Angeles. Days there are 23, 24 or 25 hours
 * long, so "next midnight" is found by asking the time zone, never by adding 24 hours.
 */
const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

export interface PacificParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function pacificParts(ms: number): PacificParts {
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
  };
}

/** Pacific calendar date, e.g. '2026-11-01'. Daily counters are keyed by it. */
export function pacificDay(ms: number): string {
  const p = pacificParts(ms);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The first instant after `ms` at which the Pacific clock reads 00:00. */
export function nextPacificMidnight(ms: number): number {
  const p = pacificParts(ms);
  // Midnight UTC of the next Pacific date; Pacific midnight is 7 h (PDT) or 8 h (PST) later.
  const nextDate = Date.UTC(p.year, p.month - 1, p.day + 1);
  for (const offsetHours of [7, 8]) {
    const candidate = nextDate + offsetHours * 3600_000;
    const local = pacificParts(candidate);
    if (local.hour === 0 && local.minute === 0) return candidate;
  }
  throw new Error('Could not find Pacific midnight');
}
