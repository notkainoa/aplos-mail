/**
 * The sidebar's screen slot (additive): what the mounted screen adds under the place groups. Calendar puts its
 * MiniMonth and its Calendars list there (DESIGN 7.1, 7.8). The shell draws the parts with the ui components, so a
 * screen hands over props and never styles the sidebar. Of the mounted slots the latest wins whole (nothing is merged
 * across slots); one screen is mounted at a time. A slot compares by reference, so the caller memoises it.
 */
import { createStore } from './store-core';
import type { CalendarListProps, MiniMonthProps } from '../ui/props';

/** The parts a screen may show in the sidebar. A missing part is not drawn. */
export interface SidebarSlot {
  /** The small month. */
  readonly miniMonth?: MiniMonthProps;
  /** The "Calendars" list. */
  readonly calendars?: CalendarListProps;
}

const stack: SidebarSlot[] = [];
const slotStore = createStore<SidebarSlot | null>(null);

function publish(): void {
  slotStore.set(stack.at(-1) ?? null);
}

/** Adds a slot above the existing ones; returns the function that removes it (safe to call twice). */
export function addSidebarSlot(slot: SidebarSlot): () => void {
  stack.push(slot);
  publish();
  return () => {
    const at = stack.indexOf(slot);
    if (at >= 0) stack.splice(at, 1);
    publish();
  };
}

export const getSidebarSlot = slotStore.get;
export const subscribeSidebarSlot = slotStore.subscribe;
