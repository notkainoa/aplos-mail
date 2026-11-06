/** The pure decisions behind the sidebar slot's scrolling region (`SidebarSlotView`). */
import type { SidebarSlot } from './store-sidebar';

/** The two measures that say whether an element's content overflows it. */
export interface Extent {
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** True while the content is taller than the element (one pixel of rounding slack). */
export function overflows(el: Extent): boolean {
  return el.scrollHeight > el.clientHeight + 1;
}

/**
 * Which parts the slot draws, as a key. The observer watches the region's children, so it is set up again when this
 * changes (a part added or dropped later, or the slot emptied) instead of keeping nodes that are gone.
 */
export function partsKey(slot: SidebarSlot): string {
  return `${slot.miniMonth ? 'month' : ''}|${slot.calendars ? 'calendars' : ''}|${slot.calendarAccounts ? 'accounts' : ''}`;
}
