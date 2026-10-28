/**
 * Confirm: a confirmation as two key rows (DESIGN 6, 7.9). The default row comes first and is focused.
 * Destructive: Cancel is the default (Return cancels), the confirm row needs ⇧Return and reads in --stamp-ink.
 * Otherwise the confirm row is the default (Return) and Cancel takes Esc; Return on a focused Cancel row cancels.
 * Esc always cancels.
 */
import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import type { ComponentPropsMap, LiteralKey } from '../props';
import { Dialog } from './Dialog';
import { PartKeys, lowerFirst } from './parts';

function KeyRow({
  row,
  label,
  keys,
  primary,
  danger,
  onPress,
}: {
  row: 'confirm' | 'cancel';
  label: string;
  keys: LiteralKey;
  primary: boolean;
  danger: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      className="ui-confirm__row"
      data-row={row}
      data-primary={primary ? 'true' : undefined}
      data-tone={danger ? 'danger' : undefined}
      onClick={onPress}
    >
      <span className="ui-confirm__row-label">{label}</span>
      <PartKeys chords={[keys]} />
    </button>
  );
}

export function Confirm({
  question,
  consequence,
  confirmLabel,
  cancelLabel = 'Cancel',
  destructive,
  presentation,
  onConfirm,
  onCancel,
  announce,
}: ComponentPropsMap['Confirm']) {
  const questionId = useId();
  const consequenceId = useId();
  const rowsRef = useRef<HTMLDivElement | null>(null);

  // Announce once on entry (DESIGN 11.3); later prop changes do not repeat it.
  const entry = useRef(
    destructive
      ? `${question} ${cancelLabel} is selected. Press Return to ${lowerFirst(cancelLabel)} or Shift Return to ${lowerFirst(confirmLabel)}.`
      : `${question} ${confirmLabel} is selected. Press Return to ${lowerFirst(confirmLabel)} or Esc to ${lowerFirst(cancelLabel)}.`,
  );
  const announceRef = useRef(announce);
  useEffect(() => {
    announceRef.current?.(entry.current);
  }, []);

  useEffect(() => {
    if (presentation === 'inline')
      rowsRef.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }, [presentation]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (destructive) {
        if (event.shiftKey) onConfirm();
        else onCancel();
      } else if (!event.shiftKey) {
        // Return never confirms from the Cancel row: it activates the row that has focus.
        const row =
          event.target instanceof HTMLElement
            ? event.target.closest<HTMLElement>('[data-row]')?.dataset.row
            : undefined;
        if (row === 'cancel') onCancel();
        else onConfirm();
      }
    } else if (event.key === 'Escape' && presentation === 'inline') {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const rows = Array.from(rowsRef.current?.querySelectorAll<HTMLElement>('button') ?? []);
      const at = rows.indexOf(document.activeElement as HTMLElement);
      rows[(at + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length]?.focus();
    }
  };

  const cancelRow = (
    <KeyRow
      key="cancel"
      row="cancel"
      label={cancelLabel}
      keys={destructive ? 'Return' : 'Esc'}
      primary={destructive}
      danger={false}
      onPress={onCancel}
    />
  );
  const confirmRow = (
    <KeyRow
      key="confirm"
      row="confirm"
      label={confirmLabel}
      keys={destructive ? '⇧Return' : 'Return'}
      primary={!destructive}
      danger={destructive}
      onPress={onConfirm}
    />
  );
  const rows = (
    <div ref={rowsRef} className="ui-confirm__rows" onKeyDown={onKeyDown}>
      {destructive ? [cancelRow, confirmRow] : [confirmRow, cancelRow]}
    </div>
  );

  if (presentation === 'dialog') {
    return (
      <Dialog open title={question} description={consequence} size="sm" onClose={onCancel}>
        <div
          className="ui-confirm"
          data-presentation="dialog"
          data-destructive={destructive ? 'true' : undefined}
        >
          {rows}
        </div>
      </Dialog>
    );
  }

  return (
    <div
      className="ui-confirm"
      role="group"
      aria-labelledby={questionId}
      aria-describedby={consequenceId}
      data-presentation="inline"
      data-destructive={destructive ? 'true' : undefined}
    >
      <p className="ui-confirm__question" id={questionId}>
        {question}
      </p>
      <p className="ui-confirm__consequence" id={consequenceId}>
        {consequence}
      </p>
      {rows}
    </div>
  );
}
