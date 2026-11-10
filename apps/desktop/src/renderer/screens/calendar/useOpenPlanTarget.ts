/**
 * "Add to calendar" from the reader lands here: the shell leaves a request (`openCalendarOnPlan`), this goes to the
 * plan's day, and once the plan's entry is drawn it opens it, where the existing confirm flow takes over. Nothing is
 * created here. A plan that never shows (already added or dismissed since the offer) is dropped after a moment.
 */
import { useEffect, useState } from 'react';
import { consumeCalendarTarget, useCalendarTarget } from '../../shell';
import type { IsoDate } from '../../ui/props';
import type { CalendarAction } from './model/state';
import { planEntryId } from './model/entries';

/** How long to wait for the plan's entry before giving up on the request. */
export const PLAN_WAIT_MS = 4_000;

export function useOpenPlanTarget(
  apply: (action: CalendarAction) => boolean,
  entries: readonly { readonly id: string }[],
): void {
  const target = useCalendarTarget();
  const [wanted, setWanted] = useState<string | null>(null);
  useEffect(() => {
    if (!target) return;
    apply({ type: 'pick', date: target.date as IsoDate });
    setWanted(planEntryId(target.planId));
    consumeCalendarTarget(target.seq);
  }, [target, apply]);
  useEffect(() => {
    if (!wanted) return;
    if (entries.some(e => e.id === wanted)) {
      apply({ type: 'open', id: wanted });
      setWanted(null);
      return;
    }
    const giveUp = setTimeout(() => setWanted(null), PLAN_WAIT_MS);
    return () => clearTimeout(giveUp);
  }, [wanted, entries, apply]);
}
