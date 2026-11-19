/**
 * Gmail's daily quota resets at midnight America/Los_Angeles. The offset is -8 h in winter and -7 h
 * in summer, so this asks Intl for the wall clock instead of using a fixed offset.
 */
const ZONE = 'America/Los_Angeles';

const wallClock = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The Pacific wall-clock fields at an instant. */
function wallAt(epochMs: number): Wall {
  const out: Record<string, number> = {};
  for (const part of wallClock.formatToParts(epochMs)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour % 24,
    minute: out.minute,
    second: out.second,
  };
}

/**
 * Epoch ms of the next 00:00 in America/Los_Angeles strictly after `now` (exactly at midnight, the
 * answer is the following midnight). The day is 23 h long at the spring transition and 25 h at the
 * autumn one; both come out right because transitions happen at 02:00, never at midnight.
 */
export function nextPacificMidnight(now: number): number {
  const { year, month, day } = wallAt(now);
  // Midnight of the next calendar day, as a plain UTC date (Date.UTC rolls month and year over).
  const target = new Date(Date.UTC(year, month - 1, day + 1));
  const [y, m, d] = [target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate()];
  const wallMidnightAsUtc = target.getTime();
  // Pacific is UTC-8 or UTC-7; exactly one of the two candidates shows 00:00 on the wall.
  for (const offsetHours of [7, 8]) {
    const candidate = wallMidnightAsUtc + offsetHours * 3_600_000;
    const w = wallAt(candidate);
    if (
      w.year === y &&
      w.month === m &&
      w.day === d &&
      w.hour === 0 &&
      w.minute === 0 &&
      w.second === 0
    )
      return candidate;
  }
  throw new Error('no Pacific midnight found'); // unreachable: no zone rule puts a transition at midnight
}
