import type { CalendarGridProps } from '../props';
import { keycapOf } from './keycaps';

/** A text button with its keycap for the one action the grid offers on an empty range ("New event · N", DESIGN 7.14). */
export function GridAction({ action }: { action: NonNullable<CalendarGridProps['emptyAction']> }) {
  const key = action.keys ?? (action.commandId ? keycapOf(action.commandId) : undefined);
  return (
    <button
      type="button"
      className="ui-cal-button"
      data-variant="text"
      title={key ? `${action.label} · ${key}` : action.label}
      onClick={action.onSelect}
    >
      {action.label}
      {key ? <kbd className="ui-cal-kbd">{key}</kbd> : null}
    </button>
  );
}
