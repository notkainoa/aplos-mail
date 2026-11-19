/**
 * The sidebar (DESIGN 7.1), transparent on the gray shell. Top to bottom: the account switcher and the compose pencil;
 * an unlabelled group (Search, Home, Later, Calendar); a quiet "Mail" label over All mail, Done, Drafts, Sent, Spam and
 * Trash; then, when the mounted screen sets one, its slot (Calendar's MiniMonth, Calendars list and accounts); then the footer,
 * which is the status slot, Settings and Help. Each group is one `Puck`, so selection is the
 * shared `slide` puck and counts use `count`. The component draws what it is given; the shell supplies the live data.
 */
import type { ReactNode } from 'react';
import { Button } from '../ui/buttons-keys';
import { NavHead, Puck } from '../ui/surfaces';
import type { PuckItem } from '../ui/props';
import {
  FOOTER_PLACES,
  MAIL_PLACES,
  TOP_PLACES,
  placeRoute,
  placeScreen,
  currentPlace,
  originPlace,
  type Place,
  type PlaceId,
} from './nav';
import { handleRegionItemKey } from './regions';
import { SidebarSlotView } from './SidebarSlotView';
import {
  openRoute,
  useOpenThreadContext,
  useSettingsSection,
  useSidebarSlotValue,
  type Screen,
} from './index';

const MAIL_HEAD_ID = 'sidebar-mail';

/** Props for `Sidebar`. */
export interface SidebarProps {
  /** The current screen, which selects a row. */
  readonly screen: Screen;
  /** Row counts; empty while first sync runs. */
  readonly counts: Readonly<Partial<Record<PlaceId, number>>>;
  /** A row was chosen. */
  readonly onNavigate: (screen: Screen) => void;
  /** The compose pencil was pressed. */
  readonly onCompose: () => void;
  /** The sidebar toggle was pressed. */
  readonly onToggleSidebar: () => void;
  /** The account switcher and its menu. */
  readonly accountSwitcher: ReactNode;
  /** The status slot. */
  readonly status: ReactNode;
}

function toItems(
  places: readonly Place[],
  counts: Readonly<Partial<Record<PlaceId, number>>>,
): PuckItem[] {
  return places.map(place => ({
    id: place.id,
    label: place.label,
    icon: place.icon,
    commandId: place.commandId,
    tooltip: place.tooltip,
    count: counts[place.id],
  }));
}

interface GroupProps {
  readonly label: string;
  readonly places: readonly Place[];
  readonly counts: Readonly<Partial<Record<PlaceId, number>>>;
  readonly selected: PlaceId | null;
  readonly onNavigate: (screen: Screen) => void;
}

/** Where a row goes: a place with a Settings route (Help) deep-links it; the rest open their screen. */
export function selectPlace(id: PlaceId, onNavigate: (screen: Screen) => void): void {
  const route = placeRoute(id);
  if (route) openRoute(route);
  else onNavigate(placeScreen(id));
}

function PlaceGroup({ label, places, counts, selected, onNavigate }: GroupProps) {
  const here = places.some(place => place.id === selected);
  return (
    <Puck
      kind="selection"
      role="navigation"
      label={label}
      items={toItems(places, counts)}
      selectedId={here ? selected : null}
      onSelect={id => selectPlace(id as PlaceId, onNavigate)}
    />
  );
}

export function Sidebar({
  screen,
  counts,
  onNavigate,
  onCompose,
  onToggleSidebar,
  accountSwitcher,
  status,
}: SidebarProps) {
  const { from } = useOpenThreadContext();
  const current = currentPlace(screen, useSettingsSection());
  const origin = current === null ? originPlace(screen, from) : null;
  const selected = current ?? origin;
  const group = { counts, selected, onNavigate };
  const slot = useSidebarSlotValue();
  return (
    <aside
      className="aplos-sidebar"
      aria-label="Sidebar"
      data-region="sidebar"
      data-origin={origin === null ? undefined : 'true'}
      onKeyDown={handleRegionItemKey}
    >
      <div className="aplos-sidebar__top">
        <div className="aplos-sidebar__account">{accountSwitcher}</div>
        <div className="aplos-sidebar__chrome">
          <Button
            variant="icon"
            size="sm"
            icon="sidebar"
            label="Show or hide the sidebar"
            commandId="app.sidebar"
            onPress={onToggleSidebar}
          />
          <Button
            variant="icon"
            size="sm"
            icon="compose"
            label="New message"
            commandId="mail.compose"
            onPress={onCompose}
          />
        </div>
      </div>
      <PlaceGroup label="Places" places={TOP_PLACES} {...group} />
      <NavHead label="Mail" id={MAIL_HEAD_ID} />
      <PlaceGroup label="Mail" places={MAIL_PLACES} {...group} />
      {slot ? <SidebarSlotView slot={slot} /> : null}
      <div className="aplos-sidebar__foot">
        {status}
        <PlaceGroup label="App" places={FOOTER_PLACES} {...group} />
      </div>
    </aside>
  );
}
