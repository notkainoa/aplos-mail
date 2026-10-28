// LowSheet (DESIGN §7.2 Low importance, §7.14). Not drawn in the mockups.
// A modal sheet opened from the LowBand: rows grouped by sender, a hover preview in a fixed area (so hover
// never moves anything), per-sender Unsubscribe once List-Unsubscribe lands, and → → to mark everything done
// (the first press arms, the second commits). Plain first version of the dialog frame; surfaces' Dialog
// (size 'md') takes the frame over when it lands. The sheet's own keys are widget keys (ControlSpec).

import { useEffect, useId, type KeyboardEvent } from 'react';
import type { LowSheetProps } from '../props';
import { EmptyLine } from './EmptyLine';
import { Action, Keycap } from './internal/Action';
import { formatCount } from './internal/format';
import { keycapFor } from './internal/keys';
import { ListBox } from './ListBox';
import { ListGroup } from './ListGroup';
import { ListRow } from './ListRow';

/** The armed line: "Press → again to mark all 6 done · Esc cancels" (copy pending DESIGN). */
export function armedLine(key: string, total: number): string {
  return `Press ${key} again to mark all ${formatCount(total)} done · Esc cancels`;
}

/** The Low-importance sheet. */
export function LowSheet({
  open,
  binding,
  groups,
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
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const key = keycapFor(markAllCommandId) || '→';

  useEffect(() => {
    if (open && armed && announce) announce(armedLine(key, total));
  }, [open, armed, announce, key, total]);

  if (!open) return null;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowRight' && total > 0) {
      event.preventDefault();
      if (armed) onCommitAll();
      else onArm();
    }
  };

  return (
    <div className="ui-low-sheet" data-armed={armed ? 'true' : undefined}>
      <div className="ui-low-sheet__scrim" aria-hidden="true" onClick={onClose} />
      <div className="ui-low-sheet__panel" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <div className="ui-low-sheet__head">
          <h2 id={titleId} className="ui-low-sheet__title">
            Low importance
          </h2>
          <span className="ui-low-sheet__count">{formatCount(total)}</span>
          <span className="ui-low-sheet__close">
            <Action variant="icon" size="sm" label="Close" icon="close" tooltip="Close · Esc" onPress={() => onClose()} />
          </span>
        </div>

        {groups.length === 0 ? (
          <EmptyLine text="No low-importance mail." action={{ label: 'Back to Home', emphasis: 'text', keys: 'Esc', onSelect: onClose }} />
        ) : (
          <>
            <div className="ui-low-sheet__body">
              <ListBox binding={binding}>
                {groups.map((group) => (
                  <ListGroup
                    key={group.id}
                    header={{
                      id: group.id,
                      label: group.sender,
                      variant: 'section',
                      count: group.rows.length,
                      held: true,
                      action: group.onUnsubscribe ? { label: 'Unsubscribe', onSelect: group.onUnsubscribe } : undefined,
                    }}
                  >
                    {group.rows.map((row) => (
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
            <p className="ui-low-sheet__foot" role="status" data-armed={armed ? 'true' : undefined}>
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
