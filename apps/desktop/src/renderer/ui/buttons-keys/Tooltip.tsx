// Tooltip (DESIGN §6): label plus keycaps from the registry, `reveal` motion, --elev-float on opaque --paper.
// This is where key hints live. It opens on pointer rest (or keyboard focus) and closes on leave, blur,
// press and Esc; it is `aria-describedby` of its trigger while open and never takes focus.
//
// Plain first version: the bubble is portalled to <body> and placed from the trigger's rect. The motion
// runtime owns nothing here; the open animation is CSS on the reveal tokens.
import {
  cloneElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type PointerEvent,
  type ReactElement,
  type Ref,
} from 'react';
import { createPortal } from 'react-dom';
import { timing } from '../generated/motion';
import type { ShortcutChord, TooltipProps } from '../props';
import { KeyCaps } from './Kbd';
import { useControlKeys } from './keyHints';
import { mergeRefs } from './mergeRefs';

/** Pointer rest before a tooltip opens. DESIGN gives no token for it; the mockups use half a second. After one closes, the next opens at once for `timing.revealGrace`. */
const OPEN_DELAY_MS = 500;
/** Keep the bubble this far inside the window edge. */
const EDGE_PX = 8;

let lastClosedAt = 0;

interface BubbleProps {
  /** DOM id the trigger's `aria-describedby` points at. */
  id?: string;
  /** First line. */
  label: string;
  /** Optional second line. */
  detail?: string;
  /** Keycaps after the label. */
  caps?: readonly ShortcutChord[];
  placement?: 'below' | 'above';
  /** Viewport point under (below) or over (above) which the bubble centres; null until measured. */
  anchor?: { x: number; y: number } | null;
  ref?: Ref<HTMLDivElement>;
}

/** The floating bubble itself, separate so it can be drawn and tested without a pointer. */
export function TooltipBubble({ id, label, detail, caps = [], placement = 'below', anchor = null, ref }: BubbleProps) {
  const style = anchor ? ({ '--tip-x': `${anchor.x}px`, '--tip-y': `${anchor.y}px` } as CSSProperties) : undefined;
  return (
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className="ui-tooltip"
      data-placement={placement}
      data-state={anchor ? 'open' : 'measuring'}
      style={style}
    >
      <span className="ui-tooltip-line">
        <span className="ui-tooltip-label">{label}</span>
        <KeyCaps caps={caps} reveal="always" />
      </span>
      {detail ? <span className="ui-tooltip-detail">{detail}</span> : null}
    </div>
  );
}

type TriggerProps = {
  ref?: Ref<HTMLElement>;
  'aria-describedby'?: string;
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
};

export function Tooltip({ label, detail, commandId, keys, children, placement = 'below', disabled = false }: TooltipProps) {
  const id = useId();
  const caps = useControlKeys(commandId, keys);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const openRef = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const hide = useCallback(() => {
    clearTimer();
    if (openRef.current) lastClosedAt = Date.now();
    openRef.current = false;
    setOpen(false);
    setAnchor(null);
  }, [clearTimer]);

  const show = useCallback(
    (immediate: boolean) => {
      if (disabled) return;
      clearTimer();
      const reveal = () => {
        openRef.current = true;
        setOpen(true);
      };
      if (immediate || Date.now() - lastClosedAt < timing.revealGrace) reveal();
      else timer.current = setTimeout(reveal, OPEN_DELAY_MS);
    },
    [disabled, clearTimer],
  );

  useEffect(() => {
    if (disabled) hide();
  }, [disabled, hide]);

  useEffect(() => clearTimer, [clearTimer]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, hide]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const width = bubbleRef.current?.offsetWidth ?? 0;
    const half = width / 2;
    const centre = rect.left + rect.width / 2;
    const x = Math.min(Math.max(centre, half + EDGE_PX), Math.max(window.innerWidth - half - EDGE_PX, half + EDGE_PX));
    setAnchor({ x, y: placement === 'above' ? rect.top : rect.bottom });
  }, [open, placement, label, detail, caps.length]);

  const child = children as ReactElement<TriggerProps>;
  const own = child.props;

  const trigger = cloneElement(child, {
    ref: mergeRefs<HTMLElement>(triggerRef, own.ref),
    'aria-describedby': open ? id : own['aria-describedby'],
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      own.onPointerEnter?.(event);
      if (event.pointerType !== 'touch') show(false);
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      own.onPointerLeave?.(event);
      hide();
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      own.onPointerDown?.(event);
      hide();
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      own.onFocus?.(event);
      if (event.currentTarget.matches(':focus-visible')) show(true);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      own.onBlur?.(event);
      hide();
    },
  });

  return (
    <>
      {trigger}
      {open && typeof document !== 'undefined'
        ? createPortal(
            <TooltipBubble
              ref={bubbleRef}
              id={id}
              label={label}
              detail={detail}
              caps={caps}
              placement={placement}
              anchor={anchor}
            />,
            document.body,
          )
        : null}
    </>
  );
}
