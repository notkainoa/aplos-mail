/**
 * Internal parts shared by the surfaces and status families: icons, keycaps from the registry, a plain
 * button and an overlay tooltip, floating placement and dismissal. Not part of the frozen surface.
 *
 * These stand in for buttons-keys' Button, Kbd and Tooltip, which land in a parallel package. When they
 * do, PartButton / PartKeys / PartTip delegate to them and every caller in surfaces/ and status/ keeps working.
 */
import {
  AtSign,
  ArrowRight,
  ArrowUp,
  Bell,
  BellOff,
  Bookmark,
  Calendar,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  Circle,
  CircleAlert,
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
  Key,
  Keyboard,
  Laptop,
  Link,
  Lock,
  Mail,
  MapPin,
  Menu as MenuGlyph,
  MessageSquare,
  Mic,
  Minus,
  Monitor,
  Moon,
  PanelLeft,
  Paperclip,
  Pause,
  Phone,
  Plus,
  RefreshCw,
  Repeat,
  Reply,
  ReplyAll,
  Search,
  Send,
  Server,
  Settings,
  ShieldAlert,
  ShoppingCart,
  SquareArrowOutUpRight,
  SquarePen,
  Sun,
  Tag,
  Trash2,
  Type,
  Undo2,
  User,
  Users,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { createAppRegistry, type Registry } from '../../commands/index';
import { ChordText, CommandKeysContext } from '../buttons-keys/keyHints';
import type { Anchor, CommandId, IconName, KeyHint, LiteralKey } from '../props';

/* ───────────── Icons: the closed IconName set, Lucide fallback (DESIGN 4.7) ───────────── */

const GLYPHS: Record<IconName, LucideIcon> = {
  home: House,
  clock: Clock,
  calendar: Calendar,
  today: CalendarDays,
  tray: Inbox,
  file: File,
  'file-text': FileText,
  'file-image': FileImage,
  'file-archive': FileArchive,
  'file-sheet': FileSpreadsheet,
  send: Send,
  trash: Trash2,
  spam: ShieldAlert,
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
  menu: MenuGlyph,
  'arrow-right': ArrowRight,
  'arrow-up': ArrowUp,
  refresh: RefreshCw,
  mic: Mic,
  'cloud-off': CloudOff,
  alert: CircleAlert,
  plus: Plus,
  minus: Minus,
  sun: Sun,
  moon: Moon,
  monitor: Monitor,
  key: Key,
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
  pin: MapPin,
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

/** One monoline icon: 16 px, 14 px ('sm') in chips and status lines, 12 px ('xs') for the smallest marks. Always decorative. */
export function PartIcon({ name, size = 'md' }: { name: IconName; size?: 'md' | 'sm' | 'xs' }) {
  const Glyph = GLYPHS[name];
  return (
    <Glyph
      className="ui-part-icon"
      data-size={size}
      data-icon={name}
      aria-hidden="true"
      focusable="false"
    />
  );
}

/* ───────────── Keycaps from the registry (DESIGN 8) ───────────── */

let registry: Registry | null = null;

/** Display chords for a command, from the registry ("J or ↓" → ["J", "↓"]); a literal key wins. */
export function keysFor(commandId?: CommandId, literal?: LiteralKey): readonly string[] {
  if (literal) return [literal];
  if (!commandId) return [];
  registry ??= createAppRegistry();
  const text = registry.describeKeys(commandId);
  return text ? text.split(' or ') : [];
}

/**
 * `keysFor` from the registry the shell mounted (remaps, the swipe-direction swap and the keys that work on the
 * current screen show). Where no `CommandKeysProvider` is mounted — the gallery, tests, previews — it answers
 * exactly as `keysFor` does: the default catalog's keys.
 */
export function useKeysFor(): (commandId?: CommandId, literal?: LiteralKey) => readonly string[] {
  const describe = useContext(CommandKeysContext);
  if (!describe) return keysFor;
  return (commandId, literal) => {
    if (literal) return [literal];
    if (!commandId) return [];
    const text = describe(commandId);
    return text ? text.split(' or ') : [];
  };
}

/** Caps for a set of chords, alternatives joined with "or". 'hint' caps show only in the "Show all key hints" mode. */
export function PartKeys({
  chords,
  reveal = 'always',
  id,
}: {
  chords: readonly string[];
  reveal?: 'always' | 'hint';
  /** So an `aria-labelledby` can name the keys the caller shows. */
  id?: string;
}) {
  if (chords.length === 0) return null;
  return (
    <span id={id} className="ui-part-keys" data-reveal={reveal}>
      {chords.map((chord, i) => (
        <span key={chord} className="ui-part-keys__group">
          {i > 0 ? <span className="ui-part-keys__or">or</span> : null}
          <kbd className="ui-part-kbd">
            <ChordText chord={chord} />
          </kbd>
        </span>
      ))}
    </span>
  );
}

/* ───────────── Overlay tooltip: label, detail and keys; never moves layout ───────────── */

/** The tooltip body a trigger points at with aria-describedby. Shown on hover or keyboard focus of its wrapper. */
export function PartTip({
  id,
  label,
  detail,
  chords,
  placement = 'below',
}: {
  id: string;
  label?: string;
  detail?: string;
  chords: readonly string[];
  placement?: 'below' | 'above' | 'end';
}) {
  return (
    <span role="tooltip" id={id} className="ui-part-tip" data-placement={placement}>
      <span className="ui-part-tip__line">
        {label ? <span>{label}</span> : null}
        <PartKeys chords={chords} />
      </span>
      {detail ? <span className="ui-part-tip__detail">{detail}</span> : null}
    </span>
  );
}

/* ───────────── Plain button: filled | text | icon (DESIGN 4.6) ───────────── */

/** Props of the internal button. Mirrors the frozen ButtonProps closely so the swap to Button is mechanical. */
export interface PartButtonProps {
  variant: 'filled' | 'text' | 'icon';
  label: string;
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName;
  trailingIcon?: 'chevron-down' | 'chevron-right' | 'up-down';
  labelVisible?: boolean;
  commandId?: CommandId;
  keys?: LiteralKey;
  keyHint?: KeyHint;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  /** Unavailable for now but still focusable (aria-disabled): for a focused button that goes busy, so focus is never lost. */
  softDisabled?: boolean;
  pressed?: boolean;
  /** Tooltip first line when it differs from the visible label (the Ask button's "Ask about your mail"). */
  tipLabel?: string;
  /** Tooltip second line. */
  detail?: string;
  /** Tooltip side; default below. */
  tipPlacement?: 'below' | 'above' | 'end';
  popup?: { kind: 'menu' | 'dialog'; expanded: boolean; controls: string };
  /** Pointer duplicate inside an option or menu item: out of the tab order and hidden from AT. */
  presentational?: boolean;
  id?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  onPress: (event: MouseEvent<HTMLButtonElement>) => void;
}

/** Icon-only controls always carry a tooltip (DESIGN 11.3); text controls carry one when keys live there. */
function wantsTip(props: PartButtonProps, chords: ReturnType<typeof keysFor>): boolean {
  const { variant, detail, tipLabel, keyHint = 'tooltip', presentational } = props;
  return (
    !presentational &&
    (variant === 'icon' ||
      detail !== undefined ||
      tipLabel !== undefined ||
      (chords.length > 0 && keyHint !== 'always'))
  );
}

export function PartButton(props: PartButtonProps) {
  const {
    variant,
    label,
    size = 'md',
    icon,
    trailingIcon,
    labelVisible,
    commandId,
    keys,
    keyHint = 'tooltip',
    tone = 'default',
    disabled,
    softDisabled,
    pressed,
    tipLabel,
    detail,
    tipPlacement,
    popup,
    presentational,
    id,
    buttonRef,
    onPress,
  } = props;
  const tipId = useId();
  const chords = useKeysFor()(commandId, keys);
  const showLabel = variant !== 'icon' || labelVisible === true;
  const inlineKeys = keyHint === 'always' || keyHint === 'hint';
  const hasTip = wantsTip(props, chords);
  const button = (
    <button
      type="button"
      id={id}
      ref={buttonRef}
      className="ui-part-button"
      data-variant={variant}
      data-size={size}
      data-tone={tone}
      data-labelled={variant === 'icon' && showLabel ? 'true' : undefined}
      aria-label={showLabel ? undefined : label}
      aria-pressed={pressed}
      aria-haspopup={popup ? popup.kind : undefined}
      aria-expanded={popup ? popup.expanded : undefined}
      aria-controls={popup ? popup.controls : undefined}
      aria-describedby={hasTip ? tipId : undefined}
      aria-hidden={presentational ? true : undefined}
      tabIndex={presentational ? -1 : undefined}
      aria-disabled={softDisabled ? true : undefined}
      disabled={disabled}
      onClick={event => {
        if (!softDisabled) onPress(event);
      }}
    >
      {icon ? <PartIcon name={icon} /> : null}
      {showLabel ? <span className="ui-part-button__label">{label}</span> : null}
      {inlineKeys ? (
        <PartKeys chords={chords} reveal={keyHint === 'hint' ? 'hint' : 'always'} />
      ) : null}
      {trailingIcon ? <PartIcon name={trailingIcon} size="xs" /> : null}
    </button>
  );
  if (!hasTip) return button;
  return (
    <span className="ui-part-tipwrap">
      {button}
      <PartTip
        id={tipId}
        label={tipLabel ?? label}
        detail={detail}
        chords={chords}
        placement={tipPlacement}
      />
    </span>
  );
}

/* ───────────── Floating placement and dismissal (Menu, Popover) ───────────── */

/** A button this narrow is an icon trigger (⋯, a chevron): its menu hangs from the trigger's end edge, not its start. */
const ICON_TRIGGER_MAX = 40;

/** The menu's preferred side for its trigger: an icon trigger opens end-aligned, a text trigger start-aligned. */
export function menuPlacementFor(anchor: Anchor): FloatPlacement {
  if (!anchor) return 'below-start';
  return anchor.getBoundingClientRect().width <= ICON_TRIGGER_MAX ? 'below-end' : 'below-start';
}

export type FloatPlacement = 'below-start' | 'below-end' | 'above-start' | 'left' | 'right';

/** A space token in px. Tokens are emitted in rem (DESIGN 11.6), so a rem value is scaled by the root font size. */
export function spaceToken(name: string): number {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return 0;
  const root = getComputedStyle(document.documentElement);
  const raw = root.getPropertyValue(name).trim();
  const value = parseFloat(raw);
  if (!Number.isFinite(value)) return 0;
  return raw.endsWith('rem') ? value * (parseFloat(root.fontSize) || 16) : value;
}

/**
 * Positions a fixed surface against its anchor and keeps it inside the window. Coordinates travel as CSS custom
 * properties (data, not styling). Until placed (server render, first paint) the surface sits in flow.
 */
export function useFloating(open: boolean, anchor: Anchor, placement: FloatPlacement) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ x: number; y: number } | null>(null);

  const place = useCallback(() => {
    const el = ref.current;
    if (!el || !anchor) return;
    const a = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = spaceToken('--space-1');
    const pad = spaceToken('--shell-pad');
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = a.left;
    let y = a.bottom + gap;
    if (placement === 'below-end') x = a.right - w;
    // Out of room on the left: line up with the anchor's left edge instead.
    if (placement === 'below-end' && x < pad && a.left + w <= vw - pad) x = a.left;
    // Out of room on the right: line up with the anchor's right edge instead of sitting flush against the window.
    if (placement === 'below-start' && x + w > vw - pad && a.right - w >= pad) x = a.right - w;
    if (placement === 'above-start') y = a.top - h - gap;
    if (placement === 'left') {
      x = a.left - w - gap;
      y = a.top;
    }
    if (placement === 'right') {
      x = a.right + gap;
      y = a.top;
    }
    // Flip vertically when the preferred side runs out of room, then clamp inside the window.
    if (placement.startsWith('below') && y + h > vh - pad && a.top - h - gap >= pad)
      y = a.top - h - gap;
    if (placement === 'above-start' && y < pad) y = a.bottom + gap;
    x = Math.max(pad, Math.min(x, vw - w - pad));
    y = Math.max(pad, Math.min(y, vh - h - pad));
    const next = { x: Math.round(x), y: Math.round(y) };
    // The same spot keeps the same object, so a re-place that changes nothing does not render again.
    setCoords(prev => (prev && prev.x === next.x && prev.y === next.y ? prev : next));
  }, [anchor, placement]);

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return;
    }
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, place]);

  // The first measure is taken while the surface still sits in flow at its container's width; once placed it is fixed
  // and sized by its content, so its size changes after placement (a long recipient list opened far from its anchor).
  // Place it again whenever its size changes (the observer also reports once when it starts); the same size gives the
  // same spot, so this settles.
  const placed = coords !== null;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !placed || !el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => place());
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, placed, place]);

  const style = coords
    ? ({ '--float-x': `${coords.x}px`, '--float-y': `${coords.y}px` } as CSSProperties)
    : undefined;
  return { ref, style, placed };
}

/** An outside pointer press closes a floating surface; presses on its anchor are left to the anchor. Esc is each surface's own key handler. */
export function useDismiss(
  open: boolean,
  surface: { current: HTMLElement | null },
  anchor: Anchor,
  onClose: () => void,
) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (surface.current?.contains(target) || anchor?.contains(target)) return;
      close.current();
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => document.removeEventListener('pointerdown', onPointer, true);
  }, [open, surface, anchor]);
}

/**
 * Keeps a surface mounted for its exit motion after `open` turns false (DESIGN 4.8 `reveal` / `settle` out).
 * `mounted` says whether to render; `leaving` is true during the out duration, for data-state="leaving".
 */
export function usePresence(open: boolean, outMs: number): { mounted: boolean; leaving: boolean } {
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setShown(true);
      return;
    }
    const t = setTimeout(() => setShown(false), outMs);
    return () => clearTimeout(t);
  }, [open, outMs]);
  return { mounted: open || shown, leaving: !open && shown };
}

/** Visually hidden text for assistive tech. */
export function SrOnly({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <span className="ui-sr-only" id={id}>
      {children}
    </span>
  );
}

/** Lower-cases the first letter, for verbs inside a sentence ("Delete forever" → "delete forever"). */
export function lowerFirst(text: string): string {
  return text ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/** A count in the en-US style the harness uses ("9,999"). */
export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** Wall-clock time in the en-US style the harness uses ("2:14 PM"), in local time. Stand-in for ui/format.ts. */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** "today", "tomorrow" or the weekday ("Tuesday") of a moment, relative to `now`, in local time. */
export function dayWord(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(at) - startOf(now)) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return at.toLocaleDateString('en-US', { weekday: 'long' });
}

/** True while the user prefers reduced motion (system setting or the app's data-motion hook). */
export function prefersReducedMotion(query: string): boolean {
  if (typeof window === 'undefined') return false;
  return (
    document.documentElement.dataset.motion === 'reduced' ||
    (typeof window.matchMedia === 'function' && window.matchMedia(query).matches)
  );
}
