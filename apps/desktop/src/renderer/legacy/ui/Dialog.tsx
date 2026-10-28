import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { X } from '../icons';
import { Button } from './Button';
import { cx, duration, usePresence } from './motion';

let openCount = 0;
/** True while any dialog is showing; global shortcuts stay quiet underneath. */
export const dialogOpen = () => openCount > 0;

const focusable =
  'button:not([disabled]),[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

export type DialogProps = {
  open: boolean;
  onClose: () => void;
  label: string;
  className?: string;
  /** Skip the backdrop fade (used where the reference shows the sheet immediately). */
  instant?: boolean;
  /** Clicking the backdrop closes the dialog. Defaults to true. */
  dismissable?: boolean;
  children: React.ReactNode;
};

/** A modal sheet with a blurred backdrop, focus trap, Escape to close and focus restore. */
export function Dialog(props: DialogProps) {
  const { mounted, closing } = usePresence(props.open, duration.fast);
  if (!mounted) return null;
  return createPortal(<Sheet {...props} closing={closing} />, document.body);
}

function Sheet({
  onClose,
  label,
  className,
  instant,
  dismissable = true,
  children,
  closing,
}: DialogProps & { closing: boolean }) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    openCount++;
    const previous = document.activeElement as HTMLElement | null;
    const el = panel.current;
    // Without an explicit autofocus target the sheet itself takes focus, so the close button does not open with a focus ring.
    if (el && !el.contains(document.activeElement))
      (el.querySelector<HTMLElement>('[autofocus],[data-autofocus]') ?? el).focus({
        preventScroll: true,
      });
    return () => {
      openCount--;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  function keydown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Tab' && panel.current) {
      const items = [...panel.current.querySelectorAll<HTMLElement>(focusable)].filter(
        item => item.offsetParent !== null,
      );
      if (items.length) {
        const first = items[0],
          last = items.at(-1)!;
        if (
          event.shiftKey &&
          (document.activeElement === first || document.activeElement === panel.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    // Keys typed inside a dialog never reach the mailbox shortcuts.
    event.stopPropagation();
  }
  return (
    <div
      className={cx('ui-dialog-backdrop', instant && 'is-instant', closing && 'is-closing')}
      onMouseDown={event => {
        if (dismissable && event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={cx('ui-dialog', className)}
        onKeyDown={keydown}
      >
        {children}
      </section>
    </div>
  );
}

/** The one close control every dialog uses. */
export function DialogClose({ label = 'Close', onClick }: { label?: string; onClick: () => void }) {
  return (
    <button className="ui-round-close" aria-label={label} onClick={onClick}>
      <X size={13} />
    </button>
  );
}

export function DialogHeader({
  title,
  onClose,
  closeLabel = 'Close',
}: {
  title: React.ReactNode;
  onClose: () => void;
  closeLabel?: string;
}) {
  return (
    <header className="ui-dialog-header">
      <h2>{title}</h2>
      <DialogClose label={closeLabel} onClick={onClose} />
    </header>
  );
}

/* ---------- Confirmation ---------- */

type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};
type ChoiceOptions = ConfirmOptions & {
  /** A third, destructive choice set apart on the left, such as "Delete". */ alternateLabel: string;
};
type Choice = 'confirm' | 'alternate' | null;
type Pending = ConfirmOptions & {
  alternateLabel?: string;
  resolve: (choice: Choice) => void;
  id: number;
};
let pending: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

/** An in-app replacement for window.confirm that matches the rest of the interface. */
export function confirmAction(options: ConfirmOptions) {
  return chooseAction(options).then(choice => choice === 'confirm');
}
/** A confirmation with a third way out; resolves null when the person cancels. */
export function chooseAction(options: ChoiceOptions | ConfirmOptions) {
  return new Promise<Choice>(resolve => {
    pending?.resolve(null);
    pending = { ...options, resolve, id: Date.now() };
    emit();
  });
}

export function ConfirmHost() {
  const current = useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pending,
    () => pending,
  );
  const [shown, setShown] = useState<Pending | null>(null);
  useEffect(() => {
    if (current) setShown(current);
  }, [current]);
  function settle(choice: Choice) {
    if (!current) return;
    current.resolve(choice);
    pending = null;
    emit();
  }
  const view = current ?? shown;
  return (
    <Dialog
      open={!!current}
      onClose={() => settle(null)}
      label={view?.title ?? 'Confirm'}
      className="ui-confirm"
    >
      {view && (
        <>
          <h2>{view.title}</h2>
          {view.message && <p>{view.message}</p>}
          <footer>
            {view.alternateLabel && (
              <Button
                variant="danger"
                className="ui-confirm-alternate"
                onClick={() => settle('alternate')}
              >
                {view.alternateLabel}
              </Button>
            )}
            <Button variant="secondary" onClick={() => settle(null)}>
              {view.cancelLabel ?? 'Cancel'}
            </Button>
            <Button
              variant={view.danger ? 'danger' : 'primary'}
              data-autofocus
              onClick={() => settle('confirm')}
            >
              {view.confirmLabel ?? 'OK'}
            </Button>
          </footer>
        </>
      )}
    </Dialog>
  );
}
