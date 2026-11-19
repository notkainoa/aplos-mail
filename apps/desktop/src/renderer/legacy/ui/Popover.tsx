import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useFloating, type Anchor, type Placement } from './floating';
import { cx, duration, usePresence } from './motion';

export type PopoverProps = {
  open: boolean;
  anchor: Anchor;
  onClose: () => void;
  placement?: Placement;
  gap?: number;
  className?: string;
  role?: string;
  label?: string;
  /** Match the anchor's width (account switchers, selects). */
  matchWidth?: boolean;
  /** Close when the pointer goes down outside. Defaults to true. */
  dismissOnOutside?: boolean;
  children: React.ReactNode;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
};

/** A floating surface anchored to an element or point, with scale-in and fade-out. */
export function Popover(props: PopoverProps) {
  const { mounted, closing } = usePresence(props.open, duration.fast);
  if (!mounted) return null;
  return createPortal(<Surface {...props} closing={closing} />, document.body);
}

function Surface({
  anchor,
  onClose,
  placement = 'bottom-start',
  gap = 6,
  className,
  role,
  label,
  matchWidth,
  dismissOnOutside = true,
  children,
  closing,
  onKeyDown,
}: PopoverProps & { closing: boolean }) {
  const { ref, style, side } = useFloating(anchor, placement, gap, !closing);
  useEffect(() => {
    if (closing) return;
    function down(event: PointerEvent) {
      const target = event.target as Node;
      if (ref.current?.contains(target)) return;
      // The trigger toggles itself; closing here would immediately reopen it.
      if (anchor instanceof HTMLElement && anchor.contains(target)) return;
      if (dismissOnOutside) onClose();
    }
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        if (anchor instanceof HTMLElement) anchor.focus({ preventScroll: true });
      }
    }
    addEventListener('pointerdown', down, true);
    addEventListener('keydown', key, true);
    return () => {
      removeEventListener('pointerdown', down, true);
      removeEventListener('keydown', key, true);
    };
  }, [closing, anchor, onClose, dismissOnOutside]);
  const width = matchWidth && anchor instanceof HTMLElement ? anchor.offsetWidth : undefined;
  return (
    <div
      ref={ref}
      role={role}
      aria-label={label}
      className={cx('ui-popover', closing && 'is-closing', className)}
      data-side={side}
      style={{ ...style, position: 'fixed', minWidth: width }}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}
