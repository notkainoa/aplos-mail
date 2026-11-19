// The closed icon set of DESIGN §4.7, drawn with Lucide at 16 / 14 / 12 px, 1.5 stroke, currentColor.
//
// SEAM: SF Symbols arrive later through the native helper. When they do, the shell provides an
// `IconSetContext` renderer that returns the SF glyph for a name (or null to fall back to Lucide here);
// no caller changes. Lucide stays the fallback.
//
// There is no AI glyph (DESIGN §3 principle 9): nothing here maps to a star, sparkle, wand, brain or robot.
// 'bubble' is a speech bubble, 'search' is the magnifier, bookmarks are a bookmark.
import { createContext, useContext, type ReactNode } from 'react';
import {
  ArrowRight,
  ArrowUp,
  AtSign,
  Bell,
  BellOff,
  Bookmark,
  Calendar,
  CalendarCheck,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  Circle,
  CircleCheck,
  CircleHelp,
  Clock,
  CloudOff,
  Download,
  Ellipsis,
  ExternalLink,
  Eye,
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  Forward,
  Globe,
  GripVertical,
  Hourglass,
  House,
  Inbox,
  Keyboard,
  KeyRound,
  Laptop,
  Link,
  Lock,
  Mail,
  Menu,
  MessageSquare,
  Mic,
  Minus,
  Monitor,
  Moon,
  OctagonAlert,
  PanelLeft,
  Paperclip,
  Pause,
  Phone,
  Pin,
  Plus,
  RefreshCw,
  Repeat,
  Reply,
  ReplyAll,
  Search,
  Send,
  Server,
  Settings,
  ShoppingCart,
  SquareArrowOutUpRight,
  SquarePen,
  Sun,
  Tag,
  Trash2,
  TriangleAlert,
  Type,
  Undo2,
  User,
  Users,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { IconName } from '../props';

/** 'md' 16 px everywhere, 'sm' 14 px in chips and status lines, 'xs' 12 px for the smallest marks (DESIGN §4.7). */
export type IconSize = 'md' | 'sm' | 'xs';

/** The Lucide glyph of every IconName. The compile-time Record makes a missing name an error. */
export const LUCIDE_ICONS: Readonly<Record<IconName, LucideIcon>> = {
  home: House,
  clock: Clock,
  calendar: Calendar,
  today: CalendarCheck,
  tray: Inbox,
  file: File,
  'file-text': FileText,
  'file-image': FileImage,
  'file-archive': FileArchive,
  'file-sheet': FileSpreadsheet,
  send: Send,
  trash: Trash2,
  spam: OctagonAlert,
  settings: Settings,
  help: CircleHelp,
  compose: SquarePen,
  search: Search,
  bubble: MessageSquare,
  bookmark: Bookmark,
  more: Ellipsis,
  check: Check,
  'check-circle': CircleCheck,
  circle: Circle,
  reply: Reply,
  'reply-all': ReplyAll,
  forward: Forward,
  paperclip: Paperclip,
  link: Link,
  'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight,
  'chevron-up': ChevronUp,
  'chevron-down': ChevronDown,
  'up-down': ChevronsUpDown,
  close: X,
  menu: Menu,
  'arrow-right': ArrowRight,
  'arrow-up': ArrowUp,
  refresh: RefreshCw,
  mic: Mic,
  'cloud-off': CloudOff,
  alert: TriangleAlert,
  plus: Plus,
  minus: Minus,
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
  key: KeyRound,
  server: Server,
  laptop: Laptop,
  lock: Lock,
  cart: ShoppingCart,
  phone: Phone,
  undo: Undo2,
  bell: Bell,
  'bell-off': BellOff,
  keyboard: Keyboard,
  user: User,
  users: Users,
  globe: Globe,
  mail: Mail,
  at: AtSign,
  external: ExternalLink,
  pin: Pin,
  video: Video,
  download: Download,
  pause: Pause,
  type: Type,
  sidebar: PanelLeft,
  tag: Tag,
  eye: Eye,
  hourglass: Hourglass,
  grip: GripVertical,
  'pop-out': SquareArrowOutUpRight,
  repeat: Repeat,
};

/** Pixel size per step. The CSS gives the same sizes from --icon / --icon-sm / --icon-xs; these are the attribute fallback. */
const PIXELS: Readonly<Record<IconSize, number>> = { md: 16, sm: 14, xs: 12 };
const STROKE = 1.5;

/** Optional native renderer (SF Symbols). Return null to fall back to the Lucide glyph. */
export type IconRenderer = (name: IconName, size: IconSize) => ReactNode | null;

/** Provided by the shell once the native helper can draw SF Symbols. Null today. */
export const IconSetContext = createContext<IconRenderer | null>(null);

export interface IconProps {
  /** One of the closed icon names. */
  name: IconName;
  /** Default 'md' (16 px). */
  size?: IconSize;
}

/** A decorative icon: always `aria-hidden`; the control that holds it carries the name. */
export function Icon({ name, size = 'md' }: IconProps) {
  const native = useContext(IconSetContext);
  const custom = native ? native(name, size) : null;
  const Glyph = LUCIDE_ICONS[name];
  return (
    <span className="ui-icon" data-icon={name} data-size={size} aria-hidden="true">
      {custom ?? <Glyph size={PIXELS[size]} strokeWidth={STROKE} focusable="false" />}
    </span>
  );
}
