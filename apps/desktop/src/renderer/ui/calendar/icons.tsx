/**
 * The few icons the calendar family draws, from the closed `IconName` set (DESIGN 4.7). Lucide is the fallback
 * source; size and stroke come from the stylesheet (`--icon`, `--icon-stroke`), never from props.
 * Replace with the shared Icon once the buttons-keys family lands.
 */
import {
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleHelp,
  Ellipsis,
  Mail,
  MapPin,
  Video,
  X,
} from 'lucide-react';
import type { ComponentType, SVGProps } from 'react';
import type { IconName } from '../props';

type CalendarIconName = Extract<
  IconName,
  | 'calendar'
  | 'check'
  | 'chevron-left'
  | 'chevron-right'
  | 'circle'
  | 'close'
  | 'help'
  | 'mail'
  | 'more'
  | 'pin'
  | 'video'
>;

const ICONS: Record<CalendarIconName, ComponentType<SVGProps<SVGSVGElement>>> = {
  calendar: Calendar,
  check: Check,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  circle: Circle,
  close: X,
  help: CircleHelp,
  mail: Mail,
  more: Ellipsis,
  pin: MapPin,
  video: Video,
};

export function CalIcon({ name }: { name: CalendarIconName }) {
  const Glyph = ICONS[name];
  return <Glyph className="ui-cal-icon" aria-hidden="true" focusable="false" />;
}
