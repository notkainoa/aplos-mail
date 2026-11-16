import { useEffect, useId, useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { MiniMonthProps } from '../props';
import {
  dateOf,
  dayTitle,
  monthMatrix,
  monthTitle,
  parseDate,
  shiftMonth,
  WEEKDAYS,
  weekdayOrder,
  addDays,
} from './dates';
import { CalIcon } from './icons';

/**
 * A small month for the sidebar on Calendar. Out-of-month days stay readable in `--dim`, today is a filled accent
 * badge, and the range the grid shows (a week band or one day) rests on `--puck` (DESIGN 6 MiniMonth, 7.8).
 * Arrow keys move between days; Return or Space picks the focused one.
 */
export function MiniMonth({
  month,
  today,
  range,
  weekStartsOn,
  onMonthChange,
  onPick,
}: MiniMonthProps) {
  const headId = useId();
  const tableRef = useRef<HTMLTableElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const rows = monthMatrix(month, weekStartsOn);
  const order = weekdayOrder(weekStartsOn);
  const m = Number(month.slice(5, 7));
  const inMonth = (date: string): boolean => parseDate(date).m === m;
  const title = monthTitle(month);

  // One tab stop: the start of the range, else today, else the first of the month.
  const days = rows.flat();
  const stop =
    (range && days.includes(range.start) && inMonth(range.start) ? range.start : undefined) ??
    (days.includes(today) && inMonth(today) ? today : undefined) ??
    days.find(inMonth);

  // Arrowing past the matrix changes the month; focus then follows to the day that was headed for.
  useEffect(() => {
    const date = pendingFocus.current;
    if (!date) return;
    pendingFocus.current = null;
    tableRef.current?.querySelector<HTMLElement>(`[data-date="${date}"]`)?.focus();
  }, [month]);

  const onKeyDown = (e: KeyboardEvent<HTMLTableElement>): void => {
    if (e.nativeEvent.isComposing) return;
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-date]');
    const from = target?.dataset.date;
    if (!from) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (step === undefined) return;
    e.preventDefault();
    const next = addDays(from, step);
    const el = tableRef.current?.querySelector<HTMLElement>(`[data-date="${next}"]`);
    if (el) el.focus();
    else {
      pendingFocus.current = next;
      onMonthChange(shiftMonth(month, step < 0 ? -1 : 1));
    }
  };

  return (
    <div className="ui-mini-month">
      <div className="ui-mini-month__head">
        <span className="ui-mini-month__title" id={headId} aria-live="polite">
          {title}
        </span>
        <button
          type="button"
          className="ui-mini-month__nav"
          aria-label="Previous month"
          title="Previous month"
          onClick={() => onMonthChange(shiftMonth(month, -1))}
        >
          <CalIcon name="chevron-left" />
        </button>
        <button
          type="button"
          className="ui-mini-month__nav"
          aria-label="Next month"
          title="Next month"
          onClick={() => onMonthChange(shiftMonth(month, 1))}
        >
          <CalIcon name="chevron-right" />
        </button>
      </div>
      <table
        ref={tableRef}
        className="ui-mini-month__table"
        role="grid"
        aria-labelledby={headId}
        onKeyDown={onKeyDown}
      >
        <thead>
          <tr>
            {order.map(d => (
              <th key={d} scope="col" abbr={WEEKDAYS[d]}>
                {WEEKDAYS[d][0]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row[0]}>
              {row.map((date, at) => {
                const inRange = (day: string | undefined): boolean =>
                  range !== undefined &&
                  day !== undefined &&
                  range.start <= day &&
                  day <= range.end;
                const selected = inRange(date);
                const isToday = date === today;
                // The range is one band behind the digits: each run in a row has a start and an end, so its
                // ends are round and the days between share the fill (no pill per day).
                const band = selected
                  ? `${inRange(row[at - 1]) ? '' : 'start'}${inRange(row[at + 1]) ? '' : 'end'}`
                  : '';
                return (
                  <td
                    key={date}
                    role="gridcell"
                    aria-selected={range ? selected : undefined}
                    data-band={selected ? band || 'mid' : undefined}
                  >
                    <button
                      type="button"
                      className="ui-mini-month__day"
                      data-date={date}
                      data-out={inMonth(date) ? undefined : 'true'}
                      data-today={isToday ? 'true' : undefined}
                      data-in-range={selected ? 'true' : undefined}
                      aria-label={dayTitle(date)}
                      aria-current={isToday ? 'date' : undefined}
                      tabIndex={date === stop ? 0 : -1}
                      onClick={() => onPick(date)}
                    >
                      {dateOf(date).getDate()}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
