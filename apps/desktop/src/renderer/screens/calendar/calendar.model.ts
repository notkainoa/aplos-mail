/**
 * The Calendar screen's model (DESIGN 7.8, 7.14, 4.2, 8 Calendar keys, 11; plan 30 U7 acceptance 6). Pure: plain
 * functions from contract values (`Event`, `Plan`, `Calendar`, epoch ms) to the props the calendar family takes, plus
 * the screen's decisions as one reducer, `update`, which returns the next state and the effects the container runs
 * (contract calls, toasts, opening a thread). No React, no hooks, no clock: `now` comes in through the context.
 *
 * Times: the grid reads ISO strings in the machine's zone (ui/calendar/dates). Instants become local wall-clock
 * strings with their offset (`toIsoDateTime`), all-day dates local midnight, so DST days lay out by the wall clock.
 *
 * Readings of map-calendar.md's UNCLEAR items used here (UI-screens decisions): ↑/↓ walk events in time order
 * (CalendarGrid does the walk; `walk` below picks the next one after a delete); week start follows the locale with
 * `Settings.ui.calendar.weekStart` overriding it; colour is the calendar's `colorTag`, else DESIGN 4.2's stable hash of
 * the name; visibility is Aplos-side (`Calendar/set {shown}`), and solo is session state; a held RSVP reads
 * "Replying Yes to Priya · Undo Z"; "persisted" is any stored row (`sync` other than `localOnly`), so only an
 * unsaved draft lacks Delete; `following` is never offered.
 */
export * from './model/period';
export * from './model/entries';
export * from './model/editor';
export * from './model/rsvp';
export * from './model/times';
export * from './model/state';
export * from './model/update';
export * from './model/commands';
export * from './model/view';
