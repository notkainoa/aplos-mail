/**
 * What a screen puts under the place groups (`useSidebarSlot`): the MiniMonth and the Calendars list, drawn here from
 * the screen's props so a screen never styles the sidebar. The region scrolls when the window is too short for it, and
 * only then is it a tab stop (a scroller nobody can reach by keyboard fails the accessibility check).
 */
import { useEffect, useRef, useState } from 'react';
import { CalendarList, MiniMonth } from '../ui/calendar';
import type { SidebarSlot } from './store-sidebar';

/** True while the element's content is taller than the element itself. */
function useScrolls(): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setScrolls(el.scrollHeight > el.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, []);
  return [ref, scrolls];
}

/** Props for `SidebarSlotView`. */
export interface SidebarSlotViewProps {
  readonly slot: SidebarSlot;
}

export function SidebarSlotView({ slot }: SidebarSlotViewProps) {
  const [ref, scrolls] = useScrolls();
  if (!slot.miniMonth && !slot.calendars) return null;
  const reach = scrolls ? { tabIndex: 0, role: 'region', 'aria-label': 'Calendar' } : {};
  return (
    <div ref={ref} className="aplos-sidebar__slot" {...reach}>
      {slot.miniMonth ? <MiniMonth {...slot.miniMonth} /> : null}
      {slot.calendars ? <CalendarList {...slot.calendars} /> : null}
    </div>
  );
}
