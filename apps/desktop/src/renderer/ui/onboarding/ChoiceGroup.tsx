import { useEffect, useRef } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import type { ChoiceGroupProps } from '../props';
import { syncTabStops } from './radio';

/** The id of the ChoiceRow a radio belongs to, or null when the event did not start on a radio. */
function rowIdOf(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const radio = target.closest('[role="radio"]');
  return radio?.closest<HTMLElement>('.ui-choice-row')?.id || null;
}

/**
 * The radiogroup around radio ChoiceRows, e.g. the AI provider choice (DESIGN 7.11). It owns `role="radiogroup"`
 * and its name, keeps one tab stop (the chosen row, or the first when none is chosen) and reports the chosen row's
 * id through `onChange`. The rows draw themselves and move focus with the arrow keys; a click on a row or Space
 * or Return on it reports here. A row's own `onPress` may be set too: both name the same row, so choosing twice is
 * harmless.
 */
export function ChoiceGroup({ label, labelledBy, value, onChange, children }: ChoiceGroupProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Rows mark their own tab stop, but the group re-checks when the chosen value moves.
  useEffect(() => {
    syncTabStops(ref.current?.querySelector<HTMLElement>('[role="radio"]') ?? null);
  }, [value, children]);

  const onClick = (e: MouseEvent<HTMLDivElement>): void => {
    const id = rowIdOf(e.target);
    if (id !== null) onChange(id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.nativeEvent.isComposing || (e.key !== ' ' && e.key !== 'Enter')) return;
    const id = rowIdOf(e.target);
    if (id !== null) onChange(id);
  };

  return (
    <div
      ref={ref}
      className="ui-choice-group"
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}
