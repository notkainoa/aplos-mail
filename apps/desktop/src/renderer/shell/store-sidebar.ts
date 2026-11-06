/**
 * The sidebar's screen slot (additive): what the mounted screen adds under the place groups. Calendar puts its
 * MiniMonth and its Calendars list there (DESIGN 7.1, 7.8). The shell draws the parts with the ui components, so a
 * screen hands over props and never styles the sidebar. Of the mounted slots the latest wins whole (nothing is merged
 * across slots); one screen is mounted at a time. A screen keeps its place in the stack as it updates its slot (`setSidebarSlot`); the sidebar redraws when the slot's
 * reference changes, so memoise it.
 */
import { createStore } from './store-core';
import type { ReactNode } from 'react';
import type { CalendarListProps, MiniMonthProps } from '../ui/props';

/** The parts a screen may show in the sidebar. A missing part is not drawn. */
export interface SidebarSlot {
  /** The small month. */
  readonly miniMonth?: MiniMonthProps;
  /** The "Calendars" list. */
  readonly calendars?: CalendarListProps;
  /** The accounts block (ui-calendar's `CalendarAccounts`), pinned above the foot so the scrollable slot can never clip it. */
  readonly calendarAccounts?: ReactNode;
}

interface Entry {
  readonly owner: object;
  slot: SidebarSlot;
}

const stack: Entry[] = [];
const slotStore = createStore<SidebarSlot | null>(null);

function publish(): void {
  slotStore.set(stack.at(-1)?.slot ?? null);
}

/**
 * Sets what `owner` shows (null removes it). The first slot an owner sets goes on top of the stack; later calls from
 * the same owner replace it in place, so a screen that re-renders keeps its place and "latest mounted wins" does not
 * turn into "latest rendered wins". The store notifies only when the winning slot's reference changes.
 */
export function setSidebarSlot(owner: object, slot: SidebarSlot | null): void {
  const at = stack.findIndex(entry => entry.owner === owner);
  if (slot === null) {
    if (at >= 0) stack.splice(at, 1);
  } else if (at >= 0) {
    stack[at]!.slot = slot;
  } else {
    stack.push({ owner, slot });
  }
  publish();
}

/** Adds a slot above the existing ones; returns the function that removes it (safe to call twice). */
export function addSidebarSlot(slot: SidebarSlot): () => void {
  const owner = {};
  setSidebarSlot(owner, slot);
  return () => setSidebarSlot(owner, null);
}

export const getSidebarSlot = slotStore.get;
export const subscribeSidebarSlot = slotStore.subscribe;
