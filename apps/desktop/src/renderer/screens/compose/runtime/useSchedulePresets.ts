import { useMemo } from 'react';
import { getNow, useNow } from '../../../data';
import { schedulePresets, type SchedulePreset } from '../model/schedule';

/**
 * The "Send later" presets for the clock now. They are recomputed each time the menu opens and on every minute tick,
 * so "In an hour" and "Tomorrow" never go stale while the composer stays open.
 */
export function useSchedulePresets(menuOpen: boolean): readonly SchedulePreset[] {
  const minute = useNow({ granularity: 'minute' });
  return useMemo(() => schedulePresets(menuOpen ? getNow() : minute), [menuOpen, minute]);
}
