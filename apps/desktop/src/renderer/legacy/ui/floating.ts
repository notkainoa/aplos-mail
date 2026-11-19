import { useLayoutEffect, useRef, useState } from 'react';

export type Placement =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'top-start'
  | 'top-end'
  | 'bottom-start'
  | 'bottom-end'
  | 'right-start';
export type Anchor = HTMLElement | DOMRect | { x: number; y: number } | null | undefined;

const margin = 8;
function rectOf(anchor: Anchor): DOMRect | null {
  if (!anchor) return null;
  if (anchor instanceof HTMLElement) return anchor.getBoundingClientRect();
  if (anchor instanceof DOMRect) return anchor;
  return new DOMRect(anchor.x, anchor.y, 0, 0);
}

/** Places a floating element beside its anchor, flipping to the other side and clamping to the window. */
export function place(
  anchor: DOMRect,
  size: { width: number; height: number },
  placement: Placement,
  gap: number,
) {
  const [side, align = 'center'] = placement.split('-') as [
    'top' | 'bottom' | 'left' | 'right',
    'start' | 'end' | 'center',
  ];
  const vw = innerWidth,
    vh = innerHeight;
  let resolved = side;
  if (
    side === 'bottom' &&
    anchor.bottom + gap + size.height > vh - margin &&
    anchor.top - gap - size.height >= margin
  )
    resolved = 'top';
  if (
    side === 'top' &&
    anchor.top - gap - size.height < margin &&
    anchor.bottom + gap + size.height <= vh - margin
  )
    resolved = 'bottom';
  if (side === 'right' && anchor.right + gap + size.width > vw - margin) resolved = 'left';
  if (side === 'left' && anchor.left - gap - size.width < margin) resolved = 'right';
  let top = 0,
    left = 0;
  if (resolved === 'top' || resolved === 'bottom') {
    top = resolved === 'bottom' ? anchor.bottom + gap : anchor.top - gap - size.height;
    left =
      align === 'start'
        ? anchor.left
        : align === 'end'
          ? anchor.right - size.width
          : anchor.left + anchor.width / 2 - size.width / 2;
  } else {
    left = resolved === 'right' ? anchor.right + gap : anchor.left - gap - size.width;
    top =
      align === 'start'
        ? anchor.top
        : align === 'end'
          ? anchor.bottom - size.height
          : anchor.top + anchor.height / 2 - size.height / 2;
  }
  left = Math.max(margin, Math.min(left, vw - size.width - margin));
  top = Math.max(margin, Math.min(top, vh - size.height - margin));
  // The transform origin points back at the anchor so scale-in animations grow out of it.
  const originX = Math.max(0, Math.min(size.width, anchor.left + anchor.width / 2 - left));
  const originY = Math.max(0, Math.min(size.height, anchor.top + anchor.height / 2 - top));
  return { top, left, side: resolved, origin: `${originX}px ${originY}px` };
}

export function useFloating(anchor: Anchor, placement: Placement, gap = 6, active = true) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties & { '--origin'?: string }>({
    visibility: 'hidden',
    top: 0,
    left: 0,
  });
  const [side, setSide] = useState<string>(placement.split('-')[0]);
  useLayoutEffect(() => {
    if (!active) return;
    function update() {
      const el = ref.current;
      const rect = rectOf(anchor);
      if (!el || !rect) return;
      const result = place(
        rect,
        { width: el.offsetWidth, height: el.offsetHeight },
        placement,
        gap,
      );
      setStyle({ top: result.top, left: result.left, transformOrigin: result.origin });
      setSide(result.side);
    }
    update();
    const observer = new ResizeObserver(update);
    if (ref.current) observer.observe(ref.current);
    addEventListener('resize', update);
    return () => {
      observer.disconnect();
      removeEventListener('resize', update);
    };
  }, [anchor, placement, gap, active]);
  return { ref, style, side };
}
