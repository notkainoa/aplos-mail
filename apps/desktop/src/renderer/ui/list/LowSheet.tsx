// LowSheet (DESIGN §7.2 Low importance, §7.14). Not drawn in the mockups.
// A modal sheet opened from the LowBand: rows grouped by sender, a hover preview in a fixed area (so hover
// never moves anything), per-sender Unsubscribe once List-Unsubscribe lands, and → → to mark everything done
// (the first press arms, the second commits). Plain first version of the dialog frame; surfaces' Dialog
// (size 'md') takes the frame over when it lands. The sheet's own keys are widget keys (ControlSpec).

import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import type { LowSheetProps } from '../props';
import { EmptyLine } from './EmptyLine';
import { Action, Keycap } from './internal/Action';
import { formatCount } from './internal/format';
import { useKeycapFor } from './internal/keys';
import { ListBox } from './ListBox';
import { ListGroup } from './ListGroup';
import { ListRow } from './ListRow';

/** The armed line: "Press → again to mark all 6 done · Esc cancels" (copy pending DESIGN). */
export function armedLine(key: string, total: number): string {
  return `Press ${key} again to mark all ${formatCount(total)} done · Esc cancels`;
}

/** Elements Tab can reach inside the panel (pointer duplicates carry tabIndex -1 and are skipped). */
const TABBABLE = 'button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]';

/** The Low-importance sheet. */
export function LowSheet({
  open,
  binding,
  groups,
  total: shown,
  armed,
  markAllCommandId,
  preview,
  onPreview,
  onArm,
  onCommitAll,
  onClose,
  announce,
}: LowSheetProps) {
  const titleId = useId();
  const total = shown ?? groups.reduce((n, g) => n + g.rows.length, 0);
  const key = useKeycapFor(markAllCommandId) || '→';
  const markEventKey = key === '←' ? 'ArrowLeft' : 'ArrowRight';
  const panelRef = useRef<HTMLDivElement>(null);
  const empty = groups.length === 0;

  useEffect(() => {
    if (open && armed && announce) announce(armedLine(key, total));
  }, [open, armed, announce, key, total]);

  // On open, focus moves into the dialog: the rows' listbox, or "Back to Home" when the sheet is empty. On close
  // it returns to whatever had it before (the Home listbox), so focus is never lost (DESIGN §11.2).
  useLayoutEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    const target =
      panel?.querySelector<HTMLElement>('.ui-list-box') ??
      panel?.querySelector<HTMLElement>('.ui-empty-line button') ??
      panel;
    target?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  // When the rows run out while open, the listbox unmounts; keep focus inside on "Back to Home".
  useLayoutEffect(() => {
    if (!open || !empty) return;
    const panel = panelRef.current;
    if (panel && !panel.contains(document.activeElement))
      panel.querySelector<HTMLElement>('.ui-empty-line button')?.focus();
  }, [open, empty]);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Tab') {
      // Focus stays in the modal: Tab and ⇧Tab wrap around the panel.
      const panel = panelRef.current;
      const stops = panel ? Array.from(panel.querySelectorAll<HTMLElement>(TABBABLE)) : [];
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
      return;
    }
    if (event.shiftKey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === markEventKey && total > 0) {
      event.preventDefault();
      if (armed) onCommitAll();
      else onArm();
    }
  };

  return (
    <div className="ui-low-sheet" data-armed={armed ? 'true' : undefined}>
      <div className="ui-low-sheet__scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        className="ui-low-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="ui-low-sheet__head">
          <h2 id={titleId} className="ui-low-sheet__title">
            Low importance
          </h2>
          <span className="ui-low-sheet__count">{formatCount(total)}</span>
          <span className="ui-low-sheet__close">
            <Action
              variant="icon"
              size="sm"
              label="Close"
              icon="close"
              tooltip="Close · Esc"
              onPress={() => onClose()}
            />
          </span>
        </div>

        {empty ? (
          <EmptyLine
            text="No low-importance mail"
            action={{ label: 'Back to Home', emphasis: 'text', keys: 'Esc', onSelect: onClose }}
          />
        ) : (
          <>
            <div className="ui-low-sheet__body">
              <ListBox binding={binding}>
                {groups.map(group => (
                  <ListGroup
                    key={group.id}
                    header={{
                      id: group.id,
                      label: group.sender,
                      variant: 'section',
                      count: group.rows.length,
                      held: true,
                      action: group.onUnsubscribe
                        ? { label: 'Unsubscribe', onSelect: group.onUnsubscribe }
                        : undefined,
                    }}
                  >
                    {group.rows.map(row => (
                      <div
                        key={row.id}
                        className="ui-low-sheet__row"
                        role="presentation"
                        onPointerEnter={onPreview ? () => onPreview(row.id) : undefined}
                        onPointerLeave={onPreview ? () => onPreview(null) : undefined}
                      >
                        <ListRow {...row} />
                      </div>
                    ))}
                  </ListGroup>
                ))}
              </ListBox>
            </div>
            <p className="ui-low-sheet__preview" aria-live="off">
              {preview ? preview.text : null}
            </p>
            {/* With the shell's announcer the armed line is spoken once through it; otherwise this line is the live region. */}
            <p
              className="ui-low-sheet__foot"
              role={announce ? undefined : 'status'}
              data-armed={armed ? 'true' : undefined}
            >
              {armed ? (
                armedLine(key, total)
              ) : (
                <>
                  Press <Keycap chord={key} /> twice to mark all {formatCount(total)} done
                </>
              )}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
