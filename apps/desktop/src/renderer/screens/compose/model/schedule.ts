/**
 * Send later (DESIGN 7.6 header ⋯ "schedule"; ARCH 7.2: one `notBefore` mechanism with undo-send). The presets resolve
 * against the clock in local time, and the moments are named the way Later names them ("Tomorrow, 8:00 AM").
 */
import { momentLabel } from '../../later/laterPresets';

export type SchedulePresetId = 'inAnHour' | 'tomorrowMorning' | 'tomorrowAfternoon' | 'nextWeek';

/** A preset and the moment it resolves to. */
export interface SchedulePreset {
  readonly id: SchedulePresetId;
  readonly at: number;
  /** "Today, 3:00 PM", "Tomorrow, 8:00 AM", "Mon, Nov 2, 8:00 AM". */
  readonly label: string;
}

const HOUR_MS = 3_600_000;
const MORNING = 8;
const AFTERNOON = 13;

function dayAt(now: Date, plusDays: number, hour: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + plusDays, hour).getTime();
}

/** The next whole local hour at least an hour away; local setters keep it on :00 in half-hour zones. */
function inAnHour(nowMs: number): number {
  const earliest = new Date(nowMs + HOUR_MS);
  if (
    earliest.getMinutes() === 0 &&
    earliest.getSeconds() === 0 &&
    earliest.getMilliseconds() === 0
  )
    return earliest.getTime();
  earliest.setHours(earliest.getHours() + 1, 0, 0, 0);
  return earliest.getTime();
}

function nextMonday(now: Date): number {
  const ahead = (8 - now.getDay()) % 7 || 7;
  return dayAt(now, ahead, MORNING);
}

/** True when a scheduled send time is after `nowMs`. */
export function isFutureSendAt(at: number, nowMs: number): boolean {
  return at > nowMs;
}

/** The send time to use: `at` while it is still ahead, else undefined and the send goes now. */
export function clampSendAt(at: number, nowMs: number): number | undefined {
  return isFutureSendAt(at, nowMs) ? at : undefined;
}

/** The schedule presets for `nowMs`, soonest first. A preset that lands on an earlier one's moment is left out. */
export function schedulePresets(nowMs: number): readonly SchedulePreset[] {
  const now = new Date(nowMs);
  const moments: readonly (readonly [SchedulePresetId, number])[] = [
    ['inAnHour', inAnHour(nowMs)],
    ['tomorrowMorning', dayAt(now, 1, MORNING)],
    ['tomorrowAfternoon', dayAt(now, 1, AFTERNOON)],
    ['nextWeek', nextMonday(now)],
  ];
  return moments
    .filter(([, at], index) => moments.findIndex(([, other]) => other === at) === index)
    .map(([id, at]) => ({ id, at, label: momentLabel(at, nowMs) }));
}

/** The moment named inside a sentence: "Scheduled for tomorrow, 8:00 AM". */
export function scheduledLabel(at: number, nowMs: number): string {
  const label = momentLabel(at, nowMs);
  return label.startsWith('Today') || label.startsWith('Tomorrow')
    ? label.charAt(0).toLowerCase() + label.slice(1)
    : label;
}
