/**
 * Popover: an opaque floating panel for rich content (event detail, citation quotes, "Why it's here")
 * (DESIGN 6 Popover, 4.6). 'dialog' takes focus and gives it back to the anchor on Esc; 'tooltip' is read-only
 * hover content and never takes focus, but Esc still dismisses it (WCAG 1.4.13). `reveal` in and out.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { motions } from '../generated/motion';
import type { ComponentPropsMap } from '../props';
import { useDismiss, useFloating, usePresence } from './parts';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Popover({
  open,
  anchor,
  label,
  role,
  placement = 'below-start',
  children,
  onClose,
}: ComponentPropsMap['Popover']) {
  const { mounted, leaving } = usePresence(open, motions.reveal.durations.out);
  const { ref, style, placed } = useFloating(mounted, anchor, placement);
  useDismiss(open, ref, anchor, onClose);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open || role !== 'dialog') return;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? el)?.focus({ preventScroll: true });
  }, [open, role, ref]);

  // Hover content never holds focus, so its Esc listens on the document while it is open.
  useEffect(() => {
    if (!open || role !== 'tooltip') return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) close.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, role]);

  if (!mounted) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || leaving) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      anchor?.focus({ preventScroll: true });
      onClose();
    }
  };

  return (
    <div
      ref={ref}
      role={role}
      aria-label={label}
      aria-hidden={leaving ? true : undefined}
      inert={leaving}
      tabIndex={role === 'dialog' ? -1 : undefined}
      className="ui-popover"
      data-role={role}
      data-state={leaving ? 'leaving' : 'open'}
      data-placement={placement}
      data-placed={placed ? 'true' : undefined}
      style={style}
      onKeyDown={role === 'dialog' ? onKeyDown : undefined}
    >
      {children}
    </div>
  );
}
