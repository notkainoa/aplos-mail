// The Calendar screen (lane ui-calendar). The shell's screen slot renders `CalendarScreen` for the `calendar` place.
// `CalendarStates.tsx` (the demo fixtures) stays out of the barrel so it can never bundle into the app;
// the gallery deep-imports it (review2 6).
export { CalendarScreen, type CalendarScreenProps } from './CalendarScreen';
export {
  CalendarView,
  type CalendarViewProps,
  CALENDAR_PANE_TOOLS,
  CALENDAR_PANE_TOOLS_READ_ONLY,
} from './CalendarView';
export { calendarSidebar, type CalendarSidebar, type SidebarInputs } from './sidebar';
