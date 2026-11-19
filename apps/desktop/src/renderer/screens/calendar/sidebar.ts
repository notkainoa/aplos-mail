/**
 * The sidebar's Calendar block as plain data (DESIGN 7.1, 7.8): `ui-shell` places `MiniMonth`, `CalendarList` and
 * the accounts block under the groups while Calendar is the route, and this lane supplies their props in the
 * `SidebarSlot` the shell draws. The handlers dispatch into the screen's reducer, so a pick in the mini month and
 * a click in the legend go through the same path as the keys.
 */
import { createElement } from 'react';
import type { Account, Calendar } from '../../data';
import type { SidebarSlot } from '../../shell/store-sidebar';
import type { IsoDate } from '../../ui/props';
import { yearMonthOf } from '../../ui/calendar/dates';
import { accountLabel } from '../../ui/accountLabel';
import {
  busyDays,
  calendarInfos,
  shownView,
  periodOf,
  type CalendarAction,
  type CalendarState,
} from './calendar.model';
import type { CalendarEventData } from '../../ui/props';
import { CalendarAccounts, type CalendarAccountsModel } from './CalendarAccounts';
import { accountTag, calendarAccessOf } from './accountCalendarState';

/** A `SidebarSlot` with all three parts present, so the gallery and the slot itself can draw without a check. */
export type CalendarSidebar = Required<Pick<SidebarSlot, 'miniMonth' | 'calendarAccounts'>> &
  Pick<SidebarSlot, 'calendars'>;

export interface SidebarInputs {
  readonly state: CalendarState;
  readonly calendars: readonly Calendar[];
  readonly entries: readonly CalendarEventData[];
  readonly today: IsoDate;
  readonly weekStartsOn: 0 | 1;
  readonly dispatch: (action: CalendarAction) => void;
  /** The accounts the view reads calendars from, already account-scoped when the screen is. */
  readonly accounts: readonly Account[];
  /** True once `Account/get` has answered; until then an empty list means "not yet", never "none". */
  readonly accountsLoaded: boolean;
  /** True once `Calendar/get` has answered; until then a granted account's count is honestly "Syncing…". */
  readonly calendarsLoaded: boolean;
  /** Opens the account's reconnect sheet: 'grant' for Allow calendar access, 'reconnect' for Sign in again. */
  readonly onAccessAction: (accountId: string, mode: 'reconnect' | 'grant') => void;
}

/**
 * The accounts block's model: every account in the view with its colour dot and calendar state, or the one
 * explanation when there are no accounts to list ("Syncing…" until `Account/get` answers, then "No accounts yet").
 */
export function accountLinesOf(
  accounts: readonly Account[],
  accountsLoaded: boolean,
  calendars: readonly Calendar[] | undefined,
): CalendarAccountsModel {
  if (!accountsLoaded) return { lines: [], empty: 'syncing' };
  if (accounts.length === 0) return { lines: [], empty: 'no-accounts' };
  return {
    lines: accounts.map((account, index) => ({
      accountId: account.id,
      name: accountLabel(account),
      mark: accountTag(account, index),
      state: calendarAccessOf(account, calendars),
    })),
    empty: null,
  };
}

/**
 * MiniMonth: the anchor's month unless paged away; the grid's range on the puck (one day, or the week); today's badge;
 * a quiet mark under days with something on them in the loaded range. CalendarList: a click shows or hides a calendar
 * in Aplos (never at Google); ⌥-click shows one alone and ⌥-click again brings the others back. The accounts block
 * says which accounts the list reads and each one's calendar state, so the legend is never silently empty.
 */
export function calendarSidebar({
  state,
  calendars,
  entries,
  today,
  weekStartsOn,
  dispatch,
  accounts,
  accountsLoaded,
  calendarsLoaded,
  onAccessAction,
}: SidebarInputs): CalendarSidebar {
  const shown = shownView(state);
  const period = periodOf(shown, state.anchor, weekStartsOn);
  const range =
    shown === 'month'
      ? undefined
      : { start: period.days[0], end: period.days[period.days.length - 1] };
  const infos = calendarInfos(calendars, state.solo);
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
    calendars: infos.length
      ? {
          calendars: infos,
          onToggle: id => dispatch({ type: 'toggleCalendar', id }),
          onSolo: id => dispatch({ type: 'soloCalendar', id }),
        }
      : undefined,
    calendarAccounts: createElement(CalendarAccounts, {
      model: accountLinesOf(accounts, accountsLoaded, calendarsLoaded ? calendars : undefined),
      onAction: onAccessAction,
    }),
  };
}
