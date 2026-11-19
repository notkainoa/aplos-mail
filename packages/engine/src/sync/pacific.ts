const PACIFIC = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

/** The Pacific wall-clock reading of `t`, expressed as if it were UTC (for offset arithmetic). */
function pacificWall(t: number): number {
  const parts: Record<string, number> = {};
  for (const part of PACIFIC.formatToParts(t))
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

/**
 * The next midnight in America/Los_Angeles strictly after `now`: when Gmail's daily quotas reset
 * (proto-google 3, plan 20 D6). Handles both daylight-saving changes, which happen at 02:00.
 */
export function nextPacificMidnight(now: number): number {
  const wall = new Date(pacificWall(now));
  const targetWall = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1);
  let guess = targetWall + 8 * 3600_000;
  for (let i = 0; i < 3; i++) {
    const drift = targetWall - pacificWall(guess);
    if (drift === 0) break;
    guess += drift;
  }
  return guess;
}
