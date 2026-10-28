/**
 * Dialog: the modal surface. Opaque --paper, radius 16, --elev-dialog, --scrim behind, `settle` in (DESIGN 4.6, 6).
 * It owns the screen's filled button (passed in `footer`). Focus moves in on open, stays inside while open
 * and returns to the opener on close. Esc or a press on the scrim closes it. It stays mounted, inert, for the
 * `settle` out duration so the exit plays.
 */
import { useEffect, useId, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { motions } from '../generated/motion';
import type { ComponentPropsMap } from '../props';
import { usePresence } from './parts';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  title,
  description,
  size,
  children,
  footer,
  initialFocusId,
  onClose,
}: ComponentPropsMap['Dialog']) {
  const titleId = useId();
  const descId = useId();
  const ref = useRef<HTMLElement | null>(null);
  const { mounted, leaving } = usePresence(open, motions.settle.durations.out);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = ref.current;
    const target =
      (initialFocusId ? document.getElementById(initialFocusId) : null) ??
      el?.querySelector<HTMLElement>(FOCUSABLE) ??
      el;
    target?.focus({ preventScroll: true });
    return () => opener?.focus({ preventScroll: true });
  }, [open, initialFocusId]);

  if (!mounted) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || leaving) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !ref.current) return;
    const focusables = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onScrim = (event: MouseEvent<HTMLDivElement>) => {
    if (!leaving && event.target === event.currentTarget) onClose();
  };

  return (
    <div
      className="ui-dialog__scrim"
      data-state={leaving ? 'leaving' : 'open'}
      aria-hidden={leaving ? true : undefined}
      inert={leaving}
      onMouseDown={onScrim}
    >
      <section
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className="ui-dialog"
        data-size={size}
        data-state={leaving ? 'leaving' : 'open'}
        onKeyDown={onKeyDown}
      >
        <div className="ui-dialog__head">
          <h2 className="ui-dialog__title" id={titleId}>
            {title}
          </h2>
          {description ? (
            <p className="ui-dialog__description" id={descId}>
              {description}
            </p>
          ) : null}
        </div>
        <div className="ui-dialog__body">{children}</div>
        {footer ? <div className="ui-dialog__foot">{footer}</div> : null}
      </section>
    </div>
  );
}
