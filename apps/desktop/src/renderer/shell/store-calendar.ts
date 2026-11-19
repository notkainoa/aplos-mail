/**
 * "Show this plan in the calendar": a pending request the Calendar screen takes up when it mounts or is already showing.
 * The reader's "Add to calendar" offer uses it: it opens the Calendar on the plan's day with the plan open, where the
 * existing confirm flow (Add to calendar, Not now, Enable editing, the write errors) runs. `seq` is new for every open,
 * so asking twice for the same plan still fires; the Calendar calls `consumeCalendarTarget(seq)` once it has handled it.
 */
import { createStore } from './store-core';
import { setScreen } from './store-route';

/** What the Calendar should open on. */
export interface CalendarTarget {
  /** The plan (`Plan.id`) to open. */
  readonly planId: string;
  /** The plan's first day, local, as `YYYY-MM-DD`. */
  readonly date: string;
  readonly seq: number;
  /** When it was asked (epoch ms): a request nobody picked up in time is stale, not something to do hours later. */
  readonly at: number;
}

const targetStore = createStore<CalendarTarget | null>(null);
let seq = 0;

/** Shows the Calendar on `date` with the plan open. Nothing is created: confirming stays in the Calendar. */
export function openCalendarOnPlan(plan: { readonly planId: string; readonly date: string }): void {
  seq += 1;
  targetStore.set({ ...plan, seq, at: Date.now() });
  setScreen('calendar');
}

/** Marks the pending request handled; ignored when a newer one has arrived. */
export function consumeCalendarTarget(handled: number): void {
  if (targetStore.get()?.seq === handled) targetStore.set(null);
}

export const getCalendarTarget = targetStore.get;
export const subscribeCalendarTarget = targetStore.subscribe;
