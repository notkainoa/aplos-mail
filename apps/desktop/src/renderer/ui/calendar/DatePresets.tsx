import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { DatePresetId, DatePresetsProps } from '../props';
import {
  addDays,
  dateOf,
  dayOf,
  formatClock,
  monthMatrix,
  monthTitle,
  parseYearMonth,
  shiftMonth,
  shortDay,
  shortWeekday,
  timeOf,
  timeOptions,
  WEEKDAYS,
  yearMonthOf,
} from './dates';
import { displayChord } from '../buttons-keys/keyHints';
import { CalIcon } from './icons';

const LABELS: Record<DatePresetId, string> = {
  evening: 'Today evening',
  tomorrow: 'Tomorrow',
  weekend: 'This weekend',
  nextWeek: 'Next week',
  someday: 'Someday',
};

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

type Entry = DatePresetId | 'date';

/**
 * Presets 1 to 5 with their digits always visible, "Pick a date…" with a month calendar and a time, Return to
 * confirm (DESIGN 6 DatePresets, 7.3). A popover under the button that opened it. It handles only its own keys:
 * digits, arrows (or J and K), Return and Esc, all IME-safe.
 */
export function DatePresets(props: DatePresetsProps) {
  const {
    open,
    anchor,
    purpose,
    presets,
    activeId,
    onActiveChange,
    onPick,
    calendarOpen,
    month,
    onMonthChange,
    pickedDate,
    onPickDate,
    pickedTime,
    onTimeChange,
    onConfirmDate,
    onClose,
  } = props;
  const uid = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const title = purpose === 'later' ? 'Later until' : 'Due date';
  const confirmLabel = purpose === 'later' ? 'Move to Later' : 'Set due date';
  const order: Entry[] = [...presets.map(p => p.id), 'date'];
  const itemId = (id: Entry): string => `${uid}-${id}`;

  // Sit under the anchor, kept inside the window. The runtime writes the position as custom properties.
  useIsoLayoutEffect(() => {
    const root = rootRef.current;
    if (!open || !root) return;
    const rect = anchor?.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect?.left ?? 0, window.innerWidth - root.offsetWidth));
    const y = Math.max(0, Math.min(rect?.bottom ?? 0, window.innerHeight - root.offsetHeight));
    root.style.setProperty('--anchor-x', `${x}px`);
    root.style.setProperty('--anchor-y', `${y}px`);
  });

  // Take focus on open and give it back to the opener on close.
  useEffect(() => {
    if (!open) return undefined;
    const opener = anchor;
    menuRef.current?.focus({ preventScroll: true });
    return () => opener?.focus({ preventScroll: true });
  }, [open, anchor]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.nativeEvent.isComposing) return;
    const target = e.target as HTMLElement;
    const handled = (): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'Escape') {
      handled();
      onClose();
      return;
    }
    if (target.tagName === 'SELECT') return; // the time list keeps its own keys
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (/^[1-5]$/.test(e.key)) {
      const preset = presets[Number(e.key) - 1];
      if (preset) {
        handled();
        onPick(preset.id);
      }
      return;
    }
    if (e.key === 'Enter') {
      handled();
      if (activeId !== 'date') onPick(activeId);
      else if (calendarOpen) {
        if (pickedDate) onConfirmDate();
      } else onActiveChange('date');
      return;
    }

    const lower = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (activeId === 'date' && calendarOpen) {
      const step = {
        ArrowLeft: -1,
        h: -1,
        ArrowRight: 1,
        l: 1,
        ArrowUp: -7,
        k: -7,
        ArrowDown: 7,
        j: 7,
      }[lower];
      if (step !== undefined) {
        handled();
        const base = pickedDate ?? `${month}-01`;
        const next = pickedDate ? addDays(base, step) : base;
        onPickDate(next);
        if (yearMonthOf(next) !== month) onMonthChange(yearMonthOf(next));
        return;
      }
    }
    const move = { ArrowDown: 1, j: 1, ArrowUp: -1, k: -1 }[lower];
    if (move !== undefined) {
      handled();
      const at = order.indexOf(activeId);
      const next = order[Math.max(0, Math.min(order.length - 1, at + move))];
      if (next !== activeId) onActiveChange(next);
    }
  };

  const weeks = monthMatrix(month, 0);
  const inMonth = (date: string): boolean => Number(date.slice(5, 7)) === parseYearMonth(month).m;
  const times = timeOptions(pickedTime);

  const entry = (id: Entry, content: ReactNode, onClick: () => void, digit?: number) => {
    const active = activeId === id;
    return (
      <div
        key={id}
        id={itemId(id)}
        role="menuitem"
        className="ui-date-presets__item"
        data-active={active ? 'true' : 'false'}
        data-id={id}
        aria-keyshortcuts={digit ? String(digit) : undefined}
        onClick={onClick}
      >
        {digit ? (
          <span className="ui-date-presets__num" aria-hidden="true">
            {digit}
          </span>
        ) : null}
        {content}
        {/* With the month open, Return confirms in the footer button, which carries the keycap. */}
        {active && !(id === 'date' && calendarOpen) ? (
          <kbd className="ui-date-presets__kbd">{displayChord('Return')}</kbd>
        ) : null}
      </div>
    );
  };

  return (
    <>
      <div className="ui-date-presets__outside" aria-hidden="true" onClick={onClose} />
      <div
        ref={rootRef}
        className="ui-date-presets"
        data-purpose={purpose}
        data-calendar-open={calendarOpen ? 'true' : 'false'}
        onKeyDown={onKeyDown}
      >
        <div
          ref={menuRef}
          role="menu"
          tabIndex={-1}
          className="ui-date-presets__menu"
          aria-label={title}
          aria-activedescendant={itemId(activeId)}
        >
          <div className="ui-date-presets__label" role="presentation">
            {title}
          </div>
          {presets.map((preset, i) =>
            entry(
              preset.id,
              <>
                <span className="ui-date-presets__text">{LABELS[preset.id]}</span>
                {preset.at ? (
                  <span className="ui-date-presets__aside">{`${shortWeekday(dayOf(preset.at))} ${timeOf(preset.at)}`}</span>
                ) : null}
              </>,
              () => onPick(preset.id),
              i + 1,
            ),
          )}
          <div className="ui-date-presets__sep" role="separator" />
          {entry(
            'date',
            <>
              <CalIcon name="calendar" />
              <span className="ui-date-presets__text">Pick a date…</span>
              {calendarOpen && pickedDate ? (
                <span className="ui-date-presets__aside">{shortDay(pickedDate)}</span>
              ) : null}
            </>,
            () => onActiveChange('date'),
          )}
        </div>

        {calendarOpen ? (
          <div className="ui-date-presets__calendar" role="group" aria-label="Pick a date">
            <div className="ui-date-presets__month">
              <b aria-live="polite">{monthTitle(month)}</b>
              <button
                type="button"
                className="ui-cal-icon-button"
                aria-label="Previous month"
                title="Previous month"
                tabIndex={-1}
                onClick={() => onMonthChange(shiftMonth(month, -1))}
              >
                <CalIcon name="chevron-left" />
              </button>
              <button
                type="button"
                className="ui-cal-icon-button"
                aria-label="Next month"
                title="Next month"
                tabIndex={-1}
                onClick={() => onMonthChange(shiftMonth(month, 1))}
              >
                <CalIcon name="chevron-right" />
              </button>
            </div>
            <div className="ui-date-presets__grid" role="grid" aria-label={monthTitle(month)}>
              <div role="row" className="ui-date-presets__dow">
                {WEEKDAYS.map(d => (
                  <span key={d} role="columnheader" aria-label={d}>
                    {d[0]}
                  </span>
                ))}
              </div>
              {weeks.map(week => (
                <div role="row" className="ui-date-presets__week" key={week[0]}>
                  {week.map(date => (
                    <span role="gridcell" key={date} aria-selected={pickedDate === date}>
                      <button
                        type="button"
                        className="ui-date-presets__day"
                        data-out={inMonth(date) ? undefined : 'true'}
                        data-picked={pickedDate === date ? 'true' : undefined}
                        aria-label={shortDay(date)}
                        tabIndex={-1}
                        onClick={() => {
                          onActiveChange('date');
                          onPickDate(date);
                        }}
                      >
                        {dateOf(date).getDate()}
                      </button>
                    </span>
                  ))}
                </div>
              ))}
            </div>
            <div className="ui-date-presets__foot">
              <select
                className="ui-date-presets__time"
                aria-label="Time"
                value={pickedTime}
                onChange={e => onTimeChange(e.target.value)}
              >
                {times.map(t => (
                  <option key={t} value={t}>
                    {formatClock(t)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ui-cal-button"
                data-variant="text"
                disabled={!pickedDate}
                onClick={onConfirmDate}
              >
                {confirmLabel}
                <kbd className="ui-cal-kbd">{displayChord('Return')}</kbd>
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
