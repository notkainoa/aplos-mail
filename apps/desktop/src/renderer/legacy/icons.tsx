import React, { useSyncExternalStore } from 'react';
import * as Lucide from 'lucide-react';
import { invoke } from './bridge';

type Props = {
  size?: number | string;
  className?: string;
  fill?: string;
  strokeWidth?: number | string;
  style?: React.CSSProperties;
  'aria-hidden'?: boolean | 'true' | 'false';
};
type Weight = 'light' | 'regular' | 'medium' | 'semibold';

// On macOS icons are system symbols drawn by the OS; Lucide stays as the fallback elsewhere and while symbols load.
const loaded = new Map<string, string>();
const failed = new Set<string>();
const pending = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;
let flushQueued = false;
const scale = typeof window !== 'undefined' && window.devicePixelRatio > 2 ? 3 : 2;

function flush() {
  flushQueued = false;
  const items = [...pending];
  pending.clear();
  if (!items.length) return;
  invoke<Record<string, string>>('symbols.render', { items, scale })
    .then(result => {
      for (const item of items) {
        const value = result?.[item];
        if (value) loaded.set(item, value);
        else failed.add(item);
      }
    })
    .catch(() => {
      for (const item of items) failed.add(item);
    })
    .finally(() => {
      version++;
      for (const listener of listeners) listener();
    });
}
function request(key: string) {
  if (loaded.has(key) || failed.has(key) || pending.has(key)) return;
  pending.add(key);
  if (!flushQueued) {
    flushQueued = true;
    queueMicrotask(flush);
  }
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => version;

function symbol(
  fallback: React.ComponentType<any>,
  name: string,
  options: { filled?: string; ratio?: number; weight?: Weight } = {},
) {
  const Icon = ({
    size = 24,
    className,
    fill,
    style,
    strokeWidth: _strokeWidth,
    ...rest
  }: Props) => {
    useSyncExternalStore(subscribe, snapshot, snapshot);
    const box = Math.max(8, Math.round(Number(size) || 24));
    const symbolName = fill && fill !== 'none' && options.filled ? options.filled : name;
    const point = Math.round(box * (options.ratio ?? 0.82) * 10) / 10;
    const key = `${symbolName}:${box}:${point}:${options.weight ?? 'regular'}`;
    request(key);
    const data = loaded.get(key);
    if (!data) {
      const Fallback = fallback;
      return (
        <Fallback size={size} className={className} fill={fill ?? 'none'} style={style} {...rest} />
      );
    }
    return (
      <i
        aria-hidden="true"
        className={'sym' + (className ? ' ' + className : '')}
        style={{
          width: box,
          height: box,
          WebkitMaskImage: `url(${data})`,
          maskImage: `url(${data})`,
          ...style,
        }}
      />
    );
  };
  Icon.displayName = `Symbol(${name})`;
  return Icon;
}

export const Archive = symbol(Lucide.Archive, 'archivebox');
export const ArrowLeft = symbol(Lucide.ArrowLeft, 'arrow.left');
export const ArrowRight = symbol(Lucide.ArrowRight, 'arrow.right');
export const ArrowUp = symbol(Lucide.ArrowUp, 'arrow.up', { weight: 'semibold' });
export const ArrowUpRight = symbol(Lucide.ArrowUpRight, 'arrow.up.right');
export const Bell = symbol(Lucide.Bell, 'bell');
export const Bold = symbol(Lucide.Bold, 'bold');
export const Bookmark = symbol(Lucide.Bookmark, 'bookmark', { filled: 'bookmark.fill' });
export const CalendarDays = symbol(Lucide.CalendarDays, 'calendar');
export const Check = symbol(Lucide.Check, 'checkmark');
export const CheckCheck = symbol(Lucide.CheckCheck, 'checkmark.circle');
export const ChevronDown = symbol(Lucide.ChevronDown, 'chevron.down', { ratio: 0.7 });
export const ChevronUp = symbol(Lucide.ChevronUp, 'chevron.up', { ratio: 0.7 });
export const ChevronLeft = symbol(Lucide.ChevronLeft, 'chevron.left', { ratio: 0.7 });
export const ChevronRight = symbol(Lucide.ChevronRight, 'chevron.right', { ratio: 0.7 });
export const ChevronsLeft = symbol(Lucide.ChevronsLeft, 'chevron.left.2', { ratio: 0.7 });
export const ChevronsRight = symbol(Lucide.ChevronsRight, 'chevron.right.2', { ratio: 0.7 });
export const ChevronsUpDown = symbol(Lucide.ChevronsUpDown, 'chevron.up.chevron.down', {
  ratio: 0.7,
});
export const Clock = symbol(Lucide.Clock, 'clock');
export const Columns2 = symbol(Lucide.Columns2, 'rectangle.split.2x1');
export const Ban = symbol(Lucide.Ban, 'nosign');
export const Forward = symbol(Lucide.Forward, 'arrowshape.turn.up.right');
export const Gear = symbol(Lucide.Settings, 'gearshape');
export const MailOpen = symbol(Lucide.MailOpen, 'envelope.open');
export const ReplyAll = symbol(Lucide.ReplyAll, 'arrowshape.turn.up.left.2');
export const CircleCheck = symbol(Lucide.CircleCheck, 'checkmark.circle.fill');
export const Copy = symbol(Lucide.Copy, 'doc.on.doc');
export const ClipboardPaste = symbol(Lucide.ClipboardPaste, 'doc.on.clipboard');
export const KeyRound = symbol(Lucide.KeyRound, 'key');
export const CornerDownLeft = symbol(Lucide.CornerDownLeft, 'return', { ratio: 0.75 });
export const CornerUpLeft = symbol(Lucide.CornerUpLeft, 'arrowshape.turn.up.left');
export const Download = symbol(Lucide.Download, 'arrow.down.circle');
export const ExternalLink = symbol(Lucide.ExternalLink, 'arrow.up.forward.square');
export const FileText = symbol(Lucide.FileText, 'doc');
export const HelpCircle = symbol(Lucide.HelpCircle, 'questionmark.circle');
export const History = symbol(Lucide.History, 'clock.arrow.circlepath');
export const Home = symbol(Lucide.Home, 'house');
export const ImageOff = symbol(Lucide.ImageOff, 'photo');
export const ImageIcon = symbol(Lucide.Image, 'photo');
export const Info = symbol(Lucide.Info, 'info.circle');
export const Inbox = symbol(Lucide.Inbox, 'tray');
export const Italic = symbol(Lucide.Italic, 'italic');
export const Keyboard = symbol(Lucide.Keyboard, 'keyboard');
export const Layers = symbol(Lucide.Layers, 'square.stack');
export const Link = symbol(Lucide.Link, 'link');
export const List = symbol(Lucide.List, 'list.bullet');
export const ListOrdered = symbol(Lucide.ListOrdered, 'list.number');
export const Loader2 = Lucide.Loader2;
export const Mail = symbol(Lucide.Mail, 'envelope');
export const MapPin = symbol(Lucide.MapPin, 'mappin.and.ellipse');
export const MessageCircle = symbol(Lucide.MessageCircle, 'bubble.left');
export const Mic = symbol(Lucide.Mic, 'mic');
export const Monitor = symbol(Lucide.Monitor, 'desktopcomputer');
export const MoreHorizontal = symbol(Lucide.MoreHorizontal, 'ellipsis');
export const MenuLines = symbol(Lucide.Menu, 'line.3.horizontal');
export const PanelLeft = symbol(Lucide.PanelLeft, 'sidebar.left');
export const Paperclip = symbol(Lucide.Paperclip, 'paperclip');
export const Plus = symbol(Lucide.Plus, 'plus');
export const RectangleVertical = symbol(Lucide.RectangleVertical, 'rectangle.portrait');
export const RefreshCw = symbol(Lucide.RefreshCw, 'arrow.clockwise');
export const Reply = symbol(Lucide.Reply, 'arrowshape.turn.up.left');
export const Search = symbol(Lucide.Search, 'magnifyingglass');
export const Send = symbol(Lucide.Send, 'paperplane');
export const ShieldAlert = symbol(Lucide.ShieldAlert, 'exclamationmark.octagon');
export const ShieldCheck = symbol(Lucide.ShieldCheck, 'checkmark.shield');
export const SpellCheck = symbol(Lucide.SpellCheck2, 'textformat.abc.dottedunderline');
export const Square = symbol(Lucide.Square, 'square');
export const SquarePen = symbol(Lucide.SquarePen, 'square.and.pencil');
export const StopCircle = symbol(Lucide.StopCircle, 'stop.circle');
export const Strikethrough = symbol(Lucide.Strikethrough, 'strikethrough');
export const TextQuote = symbol(Lucide.TextQuote, 'text.quote');
export const Trash2 = symbol(Lucide.Trash2, 'trash');
export const RotateCcw = symbol(Lucide.RotateCcw, 'arrow.counterclockwise');
export const Underline = symbol(Lucide.Underline, 'underline');
export const Undo2 = symbol(Lucide.Undo2, 'arrow.uturn.backward');
export const Users = symbol(Lucide.Users, 'person.2');
export const Volume2 = symbol(Lucide.Volume2, 'speaker.wave.2');
export const WifiOff = symbol(Lucide.WifiOff, 'wifi.slash');
export const X = symbol(Lucide.X, 'xmark');
