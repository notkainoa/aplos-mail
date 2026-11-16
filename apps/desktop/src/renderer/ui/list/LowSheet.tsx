// LowSheet (DESIGN §7.2 Low importance, §7.14). Not drawn in the mockups.
// A modal sheet opened from the LowBand: rows grouped by sender, a hover preview in a fixed area (so hover
// never moves anything), per-sender Unsubscribe once List-Unsubscribe lands, and the Done key: a tap of → marks the
// cursor row done, holding → for HOLD_ALL_MS marks everything done (the button fills left to right while it is held).
// Every sender gets its header, even a single row named like its sender (owner, 2026-11-15). Plain first version of
// the dialog frame; surfaces' Dialog (size 'md') takes the frame over when it lands. The sheet's own keys are widget
// keys (ControlSpec).

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { motions } from '../generated/motion';
import type { LowSheetProps } from '../props';
import { EmptyLine } from './EmptyLine';
import { Action } from './internal/Action';
import { createDoneHold } from './internal/doneHold';
import { formatCount } from './internal/format';
import { useKeycapFor } from './internal/keys';
import { ListBox } from './ListBox';
import { ListGroup } from './ListGroup';
import { ListRow } from './ListRow';

/** How long the Done key is held to mark everything done, in ms (a tap marks the one row under the cursor). */
export const HOLD_ALL_MS: number = motions.hold.durations.all;

/** The Done key's controller for this sheet, and whether a hold is in progress (the button's fill). */
function useDoneHold(onOne: () => void, onAll: () => void) {
  const [holding, setHolding] = useState(false);
  const latest = useRef({ onOne, onAll });
  useEffect(() => {
    latest.current = { onOne, onAll };
  });
  const controller = useMemo(
    () =>
      createDoneHold({
        holdMs: HOLD_ALL_MS,
        onOne: () => latest.current.onOne(),
        onAll: () => latest.current.onAll(),
        onHolding: setHolding,
      }),
    [],
  );
  useEffect(() => controller.stop, [controller]);
  return { holding, press: controller.press, release: controller.release, stop: controller.stop };
}

/** Elements Tab can reach inside the panel (pointer duplicates carry tabIndex -1 and are skipped). */
const TABBABLE = 'button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]';

/** Focus the rows' listbox, or "Back to Home" when the sheet is empty, or the panel itself. */
function focusInto(panel: HTMLElement | null): void {
  const target =
    panel?.querySelector<HTMLElement>('.ui-list-box') ??
    panel?.querySelector<HTMLElement>('.ui-empty-line button') ??
    panel;
  target?.focus();
}

/** The Low-importance sheet. */
export function LowSheet({
  open,
  binding,
  groups,
  total: shown,
  markAllCommandId,
  preview,
  onPreview,
  onDoneCursor,
  onCommitAll,
  onClose,
}: LowSheetProps) {
  const titleId = useId();
  const total = shown ?? groups.reduce((n, g) => n + g.rows.length, 0);
  const key = useKeycapFor(markAllCommandId) || '→';
  const markEventKey = key === '←' ? 'ArrowLeft' : 'ArrowRight';
  const panelRef = useRef<HTMLDivElement>(null);
  const empty = groups.length === 0;

  const hold = useDoneHold(onDoneCursor, onCommitAll);
  const stopHold = hold.stop;

  // On open, focus moves into the dialog. On close it returns to whatever had it before (the Home listbox or the
  // Low importance row), so focus is never lost (DESIGN §11.2).
  useLayoutEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusInto(panelRef.current);
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  // The sheet opens before its rows arrive (and swaps between rows and the empty line as mail is cleared): whenever the
  // element that held focus unmounts, focus falls to the page, so it is moved back inside. Esc then always reaches the sheet.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel || panel.contains(document.activeElement)) return;
    const active = document.activeElement;
    if (active === null || active === document.body) focusInto(panel);
  });

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
      stopHold();
      onClose();
    } else if (event.key === markEventKey && total > 0) {
      event.preventDefault();
      if (!event.repeat) hold.press();
    }
  };

  const onKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== markEventKey) return;
    event.preventDefault();
    hold.release();
  };

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) stopHold();
  };

  return (
    <div className="ui-low-sheet">
      <div className="ui-low-sheet__scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={panelRef}
        className="ui-low-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={onBlur}
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
                {groups.map(group => {
                  const rows = group.rows.map(row => (
                    <div
                      key={row.id}
                      className="ui-low-sheet__row"
                      role="presentation"
                      onPointerEnter={onPreview ? () => onPreview(row.id) : undefined}
                      onPointerLeave={onPreview ? () => onPreview(null) : undefined}
                    >
                      <ListRow {...row} />
                    </div>
                  ));
                  return (
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
                      {rows}
                    </ListGroup>
                  );
                })}
              </ListBox>
            </div>
            {/* One row under the list, so hovering a row never moves anything: the hovered row's preview on the left, one
                line, ellipsis (empty while idle), the sheet's own button on the right. The button names the gesture
                (Hold →) and fills left to right while the key is held; a click marks all done at once. */}
            <div className="ui-low-sheet__bar">
              <span className="ui-low-sheet__bar-text">
                <p className="ui-low-sheet__preview" aria-live="off">
                  {preview ? preview.text : null}
                </p>
              </span>
              <span className="ui-low-sheet__all" data-holding={hold.holding ? 'true' : undefined}>
                <Action
                  variant="filled"
                  size="sm"
                  label={`Mark all ${formatCount(total)} done`}
                  keycap={key}
                  tooltip={`Mark all ${formatCount(total)} done · hold ${key}`}
                  keycapHold
                  onPress={() => onCommitAll()}
                />
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
