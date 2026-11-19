/**
 * Routes and the current screen (F9, gap list U3/S15).
 *
 * `openRoute` records a pending Settings deep link; the Settings screen reads it with
 * `useSettingsTarget`, opens the section, scrolls the row into view, focuses its control and then
 * calls `consumeRoute(seq)` so a remount does not scroll again. The shell's current screen is a
 * second tiny store: `useAppRoute()` reads it and `navigate(screen)` sets it.
 */
import { parseSettingRoute } from '../commands';
import { createStore } from './store-core';
import { settleReturn } from './store-return';
import type { SettingSection } from '../commands';
import type { ShellRoute } from './index';

/** The screens the shell can show: a mail view, the calendar, Settings, or a label view. */
export type Screen =
  | 'home'
  | 'later'
  | 'all'
  | 'drafts'
  | 'sent'
  | 'trash'
  | 'spam'
  | 'done'
  | 'calendar'
  | 'settings'
  | { readonly label: string };

/** A pending Settings deep link. `seq` is new for every `openRoute`, so opening the same row twice still fires. */
export interface RouteTarget {
  readonly route: ShellRoute;
  readonly section: SettingSection;
  /** The row anchor, absent for a bare section ("settings/ai"). */
  readonly row?: string;
  readonly seq: number;
}

/** Screens a visit to the reader passes through: showing one keeps the places saved for the return. */
const KEEPS_RETURN: readonly string[] = ['thread', 'compose'];

const screenStore = createStore<Screen>('home');
const routeStore = createStore<RouteTarget | null>(null);
const sectionStore = createStore<SettingSection | null>(null);
let seq = 0;

function sameScreen(a: Screen, b: Screen): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.label === b.label;
}

/**
 * Shows `screen`; the same screen keeps its snapshot. A pending Settings deep link belongs to the visit `setRoute`
 * opened, so showing any other screen drops it (a stale link must not steer the next visit).
 */
export function setScreen(screen: Screen): void {
  // Showing a screen other than through Esc in the reader drops the places saved for that return (the reader's own
  // pop-out to the compose page is part of the same visit).
  if (typeof screen === 'string' || !KEEPS_RETURN.includes(screen.label)) settleReturn(screen);
  if (screen !== 'settings' && routeStore.get()) routeStore.set(null);
  if (!sameScreen(screenStore.get(), screen)) screenStore.set(screen);
}

/** Opens Settings on a route's section and leaves the route pending for Settings; an unparseable route does nothing. */
export function setRoute(route: ShellRoute): void {
  const parsed = parseSettingRoute(route);
  if (!parsed) return;
  seq += 1;
  routeStore.set({ route, section: parsed.section, row: parsed.row, seq });
  setScreen('settings');
}

/** Settings reports the section it shows (null when it closes or shows its default), so the sidebar can mark Help. */
export function setSettingsSection(section: SettingSection | null): void {
  if (sectionStore.get() !== section) sectionStore.set(section);
}

/** Marks the pending route handled; ignored when a newer route has arrived. */
export function consumeRoute(handled: number): void {
  if (routeStore.get()?.seq === handled) routeStore.set(null);
}

export const getScreen = screenStore.get;
export const subscribeScreen = screenStore.subscribe;
export const getRoute = routeStore.get;
export const subscribeRoute = routeStore.subscribe;
export const getSettingsSection = sectionStore.get;
export const subscribeSettingsSection = sectionStore.subscribe;
