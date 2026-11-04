/**
 * The sidebar's Calendar block as plain data (DESIGN 7.1, 7.8): `ui-shell` places `MiniMonth` and `CalendarList` under
 * the groups while Calendar is the route, and this lane supplies their props. The handlers dispatch into the screen's
 * reducer, so a pick in the mini month and a click in the legend go through the same path as the keys.
 */
import type { Calendar } from '../../data';
import type { CalendarListProps, IsoDate, MiniMonthProps } from '../../ui/props';
import { yearMonthOf } from '../../ui/calendar/dates';
import {
  busyDays,
  calendarInfos,
  shownView,
  periodOf,
  type CalendarAction,
  type CalendarState,
} from './calendar.model';
import type { CalendarEventData } from '../../ui/props';

export interface CalendarSidebar {
  readonly miniMonth: MiniMonthProps;
  readonly calendarList: CalendarListProps;
}

export interface SidebarInputs {
  readonly state: CalendarState;
  readonly calendars: readonly Calendar[];
  readonly entries: readonly CalendarEventData[];
  readonly today: IsoDate;
  readonly weekStartsOn: 0 | 1;
  readonly dispatch: (action: CalendarAction) => void;
}

/**
 * MiniMonth: the anchor's month unless paged away; the grid's range on the puck (one day, or the week); today's badge;
 * a quiet mark under days with something on them in the loaded range. CalendarList: a click shows or hides a calendar
 * in Aplos (never at Google); ⌥-click shows one alone and ⌥-click again brings the others back.
 */
export function calendarSidebar({
  state,
  calendars,
  entries,
  today,
  weekStartsOn,
  dispatch,
}: SidebarInputs): CalendarSidebar {
  const shown = shownView(state);
  const period = periodOf(shown, state.anchor, weekStartsOn);
  const range =
    shown === 'month'
      ? undefined
      : { start: period.days[0], end: period.days[period.days.length - 1] };
  return {
    miniMonth: {
      month: state.miniMonth ?? yearMonthOf(state.anchor),
      today,
      ...(range ? { range } : {}),
      weekStartsOn,
      onMonthChange: month => dispatch({ type: 'miniMonth', month }),
      onPick: date => dispatch({ type: 'pick', date }),
      marks: busyDays(entries),
    },
    calendarList: {
      calendars: calendarInfos(calendars, state.solo),
      onToggle: id => dispatch({ type: 'toggleCalendar', id }),
      onSolo: id => dispatch({ type: 'soloCalendar', id }),
    },
  };
}
