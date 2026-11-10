/**
 * "Add to calendar" from the reader lands here: the shell leaves a request (`openCalendarOnPlan`), this goes to the
 * plan's day, and once the plan's entry is drawn it opens it, where the existing confirm flow takes over. Nothing is
 * created here. The request stays pending until the plan is opened or the wait runs out, so a remount in between
 * starts again from it. A plan that never shows (already added or dismissed since the offer) is dropped after
 * `PLAN_WAIT_MS`, counted from when the request was taken up.
 */
import { useEffect, useRef } from 'react';
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
  const picked = useRef<number | null>(null);
  const seq = target?.seq ?? null;
  const date = target?.date;
  const planId = target?.planId;
  useEffect(() => {
    if (seq === null || date === undefined || picked.current === seq) return;
    if (Date.now() - (target?.at ?? 0) > PLAN_WAIT_MS) return void consumeCalendarTarget(seq);
    picked.current = seq;
    apply({ type: 'pick', date: date as IsoDate });
  }, [seq, date, target?.at, apply]);
  useEffect(() => {
    if (seq === null || planId === undefined || picked.current !== seq) return;
    const id = planEntryId(planId);
    if (!entries.some(e => e.id === id)) return;
    apply({ type: 'open', id });
    consumeCalendarTarget(seq);
  }, [seq, planId, entries, apply]);
  useEffect(() => {
    if (seq === null) return;
    const giveUp = setTimeout(() => consumeCalendarTarget(seq), PLAN_WAIT_MS);
    return () => clearTimeout(giveUp);
  }, [seq]);
}
