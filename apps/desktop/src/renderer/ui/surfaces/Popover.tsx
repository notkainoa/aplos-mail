/**
 * Popover: an opaque floating panel for rich content (event detail, citation quotes, "Why it's here")
 * (DESIGN 6 Popover, 4.6). 'dialog' takes focus and gives it back to the anchor on Esc; 'tooltip' is read-only
 * hover content and never takes focus.
 */
import { useEffect, type KeyboardEvent } from 'react';
import type { ComponentPropsMap } from '../props';
import { useDismiss, useFloating } from './parts';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Popover({ open, anchor, label, role, placement = 'below-start', children, onClose }: ComponentPropsMap['Popover']) {
  const { ref, style, placed } = useFloating(open, anchor, placement);
  useDismiss(open, ref, anchor, onClose);

  useEffect(() => {
    if (!open || role !== 'dialog') return;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el)?.focus({ preventScroll: true });
  }, [open, role, ref]);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      anchor?.focus();
    }
  };

  return (
    <div
      ref={ref}
      role={role}
      aria-label={label}
      tabIndex={role === 'dialog' ? -1 : undefined}
      className="ui-popover"
      data-role={role}
      data-placement={placement}
      data-placed={placed ? 'true' : undefined}
      style={style}
      onKeyDown={role === 'dialog' ? onKeyDown : undefined}
    >
      {children}
    </div>
  );
}
