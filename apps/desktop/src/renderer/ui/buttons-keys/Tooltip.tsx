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
import { realKeySeen, realPointerOf, realPointerSeen } from './inputIntent';
import { KeyCaps } from './Kbd';
import { useControlKeys } from './keyHints';
import { mergeRefs } from './mergeRefs';

/** Pointer rest before a tooltip opens. DESIGN gives no token for it; the mockups use half a second. After one closes, the next opens at once for `timing.revealGrace`. */
const OPEN_DELAY_MS = 500;
/** Keep the bubble this far inside the window edge. */
const EDGE_PX = 8;
/** The gap between trigger and bubble (the stylesheet's --space-1 + --space-half). */
const GAP_PX = 6;

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
  /** Opened inside the grace window after another tooltip closed: shown at once, without the reveal animation. */
  instant?: boolean;
  /** Viewport point under (below) or over (above) which the bubble centres; null until measured. */
  anchor?: { x: number; y: number } | null;
  ref?: Ref<HTMLDivElement>;
}

/** The floating bubble itself, separate so it can be drawn and tested without a pointer. */
export function TooltipBubble({
  id,
  label,
  detail,
  caps = [],
  placement = 'below',
  instant = false,
  anchor = null,
  ref,
}: BubbleProps) {
  const style = anchor
    ? ({ '--tip-x': `${anchor.x}px`, '--tip-y': `${anchor.y}px` } as CSSProperties)
    : undefined;
  return (
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className="ui-tooltip"
      data-placement={placement}
      data-instant={instant ? 'true' : undefined}
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
  onPointerMove?: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (event: PointerEvent<HTMLElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
  onBlur?: (event: FocusEvent<HTMLElement>) => void;
};

export function Tooltip({
  label,
  detail,
  commandId,
  keys,
  children,
  placement = 'below',
  disabled = false,
}: TooltipProps) {
  const id = useId();
  const reasonId = `${id}-reason`;
  const caps = useControlKeys(commandId, keys);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{
    x: number;
    y: number;
    placement: 'below' | 'above';
  } | null>(null);
  const [instant, setInstant] = useState(false);
  const openRef = useRef(false);
  // Set by pointerenter: the element may have been drawn under a resting cursor, so the rest timer
  // waits for a genuine move over the trigger (a mount-under-cursor enter produces none).
  const armedRef = useRef(false);
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
      const reveal = (inGrace: boolean) => {
        openRef.current = true;
        setInstant(inGrace);
        setOpen(true);
      };
      const inGrace = Date.now() - lastClosedAt < timing.revealGrace;
      if (immediate || inGrace) reveal(inGrace);
      else timer.current = setTimeout(() => reveal(false), OPEN_DELAY_MS);
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
    // The bubble is placed once from the trigger's rect, so scrolling or resizing closes it rather than leaving it adrift.
    const onMove = () => hide();
    document.addEventListener('keydown', onKey);
    document.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, hide]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const width = bubbleRef.current?.offsetWidth ?? 0;
    const half = width / 2;
    const centre = rect.left + rect.width / 2;
    const x = Math.min(
      Math.max(centre, half + EDGE_PX),
      Math.max(window.innerWidth - half - EDGE_PX, half + EDGE_PX),
    );
    // Flip to the side with room: the bubble plus its gap must fit inside the window edge.
    const needed = (bubbleRef.current?.offsetHeight ?? 0) + GAP_PX + EDGE_PX;
    const roomBelow = window.innerHeight - rect.bottom;
    const roomAbove = rect.top;
    let side = placement;
    if (side === 'below' && roomBelow < needed && roomAbove > roomBelow) side = 'above';
    else if (side === 'above' && roomAbove < needed && roomBelow > roomAbove) side = 'below';
    setAnchor({ x, y: side === 'above' ? rect.top : rect.bottom, placement: side });
  }, [open, placement, label, detail, caps.length]);

  const child = children as ReactElement<TriggerProps>;
  const own = child.props;

  const trigger = cloneElement(child, {
    ref: mergeRefs<HTMLElement>(triggerRef, own.ref),
    // A detail (the reason a control is disabled) is described permanently by a hidden twin, so it is read on focus
    // and not one render later; the open bubble only describes a trigger that has no detail.
    'aria-describedby': detail ? reasonId : open ? id : own['aria-describedby'],
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      own.onPointerEnter?.(event);
      if (event.pointerType !== 'touch') armedRef.current = true;
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      own.onPointerMove?.(event);
      if (!armedRef.current || event.pointerType === 'touch') return;
      if (realPointerOf(event.nativeEvent) || realPointerSeen()) {
        armedRef.current = false;
        show(false);
      }
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      own.onPointerLeave?.(event);
      armedRef.current = false;
      hide();
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      own.onPointerDown?.(event);
      armedRef.current = false;
      hide();
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      own.onFocus?.(event);
      // Script focus can match :focus-visible without any keyboard use (launch, focus restore).
      if (event.currentTarget.matches(':focus-visible') && realKeySeen()) show(true);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      own.onBlur?.(event);
      hide();
    },
  });

  return (
    <>
      {trigger}
      {detail ? (
        <span id={reasonId} className="ui-visually-hidden">
          {detail}
        </span>
      ) : null}
      {open && typeof document !== 'undefined'
        ? createPortal(
            <TooltipBubble
              ref={bubbleRef}
              id={id}
              label={label}
              detail={detail}
              caps={caps}
              placement={anchor?.placement ?? placement}
              instant={instant}
              anchor={anchor}
            />,
            document.body,
          )
        : null}
    </>
  );
}
