/**
 * The sidebar's places (DESIGN 7.1) as plain data: which rows exist, in which group, with which icon and registry
 * command, and how a place maps to a screen. No React here, so the grouping is testable on its own.
 */
import type { CountsBlock } from '../data';
import type { SettingRoute, SettingSection } from '../commands';
import type { CommandId, IconName } from '../ui/props';
import type { Screen } from './index';

/** A sidebar row. Search has no screen of its own yet, so it opens a labelled placeholder; Help opens Settings at its "Help & about" section (`placeRoute`). */
export type PlaceId =
  | 'search'
  | 'home'
  | 'later'
  | 'calendar'
  | 'all'
  | 'done'
  | 'drafts'
  | 'sent'
  | 'spam'
  | 'trash'
  | 'settings'
  | 'help';

/** One row's fixed facts. */
export interface Place {
  readonly id: PlaceId;
  readonly label: string;
  readonly icon: IconName;
  readonly commandId: CommandId;
  /** Second tooltip line. */
  readonly tooltip?: string;
}

/** Done's tooltip line (DESIGN 7.4). */
export const DONE_TOOLTIP = 'Mail you finished. Press H to move one back to Home.';

const PLACES: Readonly<Record<PlaceId, Place>> = {
  search: { id: 'search', label: 'Search', icon: 'search', commandId: 'nav.search' },
  home: { id: 'home', label: 'Home', icon: 'home', commandId: 'nav.home' },
  later: { id: 'later', label: 'Later', icon: 'clock', commandId: 'nav.later' },
  calendar: { id: 'calendar', label: 'Calendar', icon: 'calendar', commandId: 'nav.calendar' },
  all: { id: 'all', label: 'All mail', icon: 'tray', commandId: 'nav.allMail' },
  done: {
    id: 'done',
    label: 'Done',
    icon: 'check-circle',
    commandId: 'nav.done',
    tooltip: DONE_TOOLTIP,
  },
  drafts: { id: 'drafts', label: 'Drafts', icon: 'file', commandId: 'nav.drafts' },
  sent: { id: 'sent', label: 'Sent', icon: 'send', commandId: 'nav.sent' },
  spam: { id: 'spam', label: 'Spam', icon: 'spam', commandId: 'nav.spam' },
  trash: { id: 'trash', label: 'Trash', icon: 'trash', commandId: 'nav.trash' },
  settings: { id: 'settings', label: 'Settings', icon: 'settings', commandId: 'app.settings' },
  help: { id: 'help', label: 'Help', icon: 'help', commandId: 'app.shortcuts' },
};

/** The first group, which carries no label. */
export const TOP_PLACES: readonly Place[] = ['search', 'home', 'later', 'calendar'].map(
  id => PLACES[id as PlaceId],
);

/** The "Mail" group, in DESIGN 7.1's order. */
export const MAIL_PLACES: readonly Place[] = ['all', 'done', 'drafts', 'sent', 'spam', 'trash'].map(
  id => PLACES[id as PlaceId],
);

/** The footer rows under the status slot. */
export const FOOTER_PLACES: readonly Place[] = ['settings', 'help'].map(
  id => PLACES[id as PlaceId],
);

/** Every place, group by group, for the minimised menu. */
export const ALL_PLACES: readonly Place[] = [...TOP_PLACES, ...MAIL_PLACES, ...FOOTER_PLACES];

const LABEL_SCREENS: Readonly<Partial<Record<PlaceId, string>>> = {
  search: 'Search',
};

/** The Settings route a place opens instead of a plain screen, when it has one (Help → "Help & about"). */
export function placeRoute(id: PlaceId): SettingRoute | null {
  return id === 'help' ? 'settings/help' : null;
}

/** The screen a place opens. Help's screen is `settings`; `placeRoute` selects the section. */
export function placeScreen(id: PlaceId): Screen {
  if (id === 'help') return 'settings';
  const label = LABEL_SCREENS[id];
  return label ? { label } : (id as Exclude<Screen, { label: string }>);
}

/** The place a screen belongs to, or null when no row stands for it (a placeholder another lane opened). */
export function screenPlace(screen: Screen): PlaceId | null {
  if (typeof screen === 'string') return screen;
  const found = (Object.keys(LABEL_SCREENS) as PlaceId[]).find(
    id => LABEL_SCREENS[id] === screen.label,
  );
  return found ?? null;
}

/** The one place that is current: Help while Settings shows its Help section, so Settings and Help never both mark. */
export function currentPlace(screen: Screen, section: SettingSection | null): PlaceId | null {
  if (screen === 'settings' && section === 'help') return 'help';
  return screenPlace(screen);
}

/** A place by id; throws on an unknown id, which would be a bug in this file. */
export function placeById(id: string): Place {
  const place = PLACES[id as PlaceId];
  if (!place) throw new Error(`unknown place ${id}`);
  return place;
}

/** The words for a screen: the places' labels, or the placeholder's own label. */
export function screenLabel(screen: Screen): string {
  return typeof screen === 'string' ? PLACES[screen].label : screen.label;
}

/** Row counts (DESIGN 7.1): Home is Do now plus Important updates, Later what has come due, Drafts the drafts. Hidden during first sync; zero shows nothing. */
export function placeCounts(
  counts: CountsBlock,
  hidden: boolean,
): Readonly<Partial<Record<PlaceId, number>>> {
  if (hidden) return {};
  const out: Partial<Record<PlaceId, number>> = {};
  if (counts.home > 0) out.home = counts.home;
  if (counts.laterDue > 0) out.later = counts.laterDue;
  if (counts.drafts > 0) out.drafts = counts.drafts;
  return out;
}
