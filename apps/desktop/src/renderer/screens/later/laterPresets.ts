/**
 * The Later choices (DESIGN 7.3): Today evening, Tomorrow, This weekend, Next week, Someday, resolved against the
 * clock in local time. The engine's `Later/presets` is the source of truth once `api` exposes it; this mirrors its
 * rules (evening only before 5 PM, This weekend only Monday to Thursday, Next week on the owner's first weekday) so
 * the picker and the drag targets show the same moments the engine will.
 */
import { toIsoDateTime } from '../../data';
import type { DatePresetId, DatePresetOption } from '../../ui/props';

/** A preset and the moment it resolves to; Someday has none. */
export interface LaterPreset {
  readonly id: DatePresetId;
  readonly until?: number;
}

const EVENING_CUTOFF_HOUR = 17;
const EVENING_HOUR = 18;
const MORNING_HOUR = 8;

function dayAt(now: Date, plusDays: number, hour: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + plusDays, hour).getTime();
}

/** The presets for `nowMs`. `firstWeekday` is 0 (Sunday) to 6, the day "Next week" starts on. */
export function laterPresets(nowMs: number, firstWeekday = 1): readonly LaterPreset[] {
  const now = new Date(nowMs);
  const weekday = now.getDay();
  const presets: LaterPreset[] = [];
  if (now.getHours() < EVENING_CUTOFF_HOUR)
    presets.push({ id: 'evening', until: dayAt(now, 0, EVENING_HOUR) });
  presets.push({ id: 'tomorrow', until: dayAt(now, 1, MORNING_HOUR) });
  if (weekday >= 1 && weekday <= 4)
    presets.push({ id: 'weekend', until: dayAt(now, 6 - weekday, MORNING_HOUR) });
  const untilNextWeek = (firstWeekday - weekday + 7) % 7 || 7;
  presets.push({ id: 'nextWeek', until: dayAt(now, untilNextWeek, MORNING_HOUR) });
  presets.push({ id: 'someday' });
  return presets;
}

/** The presets as `DatePresets` takes them. */
export function presetOptions(presets: readonly LaterPreset[]): DatePresetOption[] {
  return presets.map(preset => ({
    id: preset.id,
    at: preset.until === undefined ? undefined : toIsoDateTime(preset.until),
  }));
}

/** The preset with this id, if it is on offer right now. */
export function presetById(
  presets: readonly LaterPreset[],
  id: DatePresetId,
): LaterPreset | undefined {
  return presets.find(preset => preset.id === id);
}

const DAY_MS = 86_400_000;

function midnight(ms: number): number {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** "8:00 AM" */
export function clockOf(date: Date): string {
  const hour = ((date.getHours() + 11) % 12) + 1;
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hour}:${minutes} ${date.getHours() >= 12 ? 'PM' : 'AM'}`;
}

/** "Wed, Nov 4" */
export function dayLabel(date: Date): string {
  return `${WEEKDAYS[date.getDay()]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;
}

/** "Today, 6:00 PM", "Tomorrow, 8:00 AM", "Sat, Oct 31, 8:00 AM", or "Someday": what a drop target is named. */
export function momentLabel(until: number | undefined, nowMs: number): string {
  if (until === undefined) return 'Someday';
  const date = new Date(until);
  const ahead = Math.round((midnight(until) - midnight(nowMs)) / DAY_MS);
  if (ahead === 0) return `Today, ${clockOf(date)}`;
  if (ahead === 1) return `Tomorrow, ${clockOf(date)}`;
  return `${dayLabel(date)}, ${clockOf(date)}`;
}

/** A short name for a toast: "Tomorrow", "This weekend", "Someday", or the day for a picked date. */
export function presetName(id: DatePresetId): string {
  switch (id) {
    case 'evening':
      return 'Today evening';
    case 'tomorrow':
      return 'Tomorrow';
    case 'weekend':
      return 'This weekend';
    case 'nextWeek':
      return 'Next week';
    case 'someday':
      return 'Someday';
  }
}
