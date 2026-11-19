/** The pure decisions behind the sidebar slot's scrolling region (`SidebarSlotView`). */
import type { SidebarSlot } from './store-sidebar';

/** The two measures that say whether an element's content overflows it. */
export interface Extent {
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/** The measures that say whether more content waits below the visible part. */
export interface ScrollExtent extends Extent {
  readonly scrollTop: number;
}

/** True while the region scrolls and its bottom is not yet in view: the slot draws a hairline there as the cue. */
export function moreBelow(el: ScrollExtent): boolean {
  return overflows(el) && el.scrollTop + el.clientHeight < el.scrollHeight - 1;
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
