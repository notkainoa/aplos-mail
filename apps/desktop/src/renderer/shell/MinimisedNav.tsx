/**
 * The minimised sidebar (DESIGN 7.1, setting "Sidebar minimised"): a ☰ button top-left that opens a menu with the same
 * places, the current one checked. Navigation never moves into the pane header.
 */
import { useId, useRef, useState } from 'react';
import { Button } from '../ui/buttons-keys';
import { Menu } from '../ui/surfaces';
import type { MenuEntry } from '../ui/props';
import {
  FOOTER_PLACES,
  MAIL_PLACES,
  TOP_PLACES,
  placeScreen,
  screenPlace,
  type Place,
  type PlaceId,
} from './nav';
import type { Screen } from './index';

const GROUPS: readonly (readonly Place[])[] = [TOP_PLACES, MAIL_PLACES, FOOTER_PLACES];

function entryFor(place: Place, count: number | undefined): MenuEntry {
  return {
    kind: 'item',
    id: place.id,
    label: place.label,
    icon: place.icon,
    commandId: place.commandId,
    aside: count === undefined ? undefined : String(count),
  };
}

/** The menu's rows: the three sidebar groups with a separator between them. */
export function minimisedEntries(counts: Readonly<Partial<Record<PlaceId, number>>>): MenuEntry[] {
  return GROUPS.flatMap((places, index): MenuEntry[] => {
    const rows = places.map(place => entryFor(place, counts[place.id]));
    return index === 0 ? rows : [{ kind: 'separator' }, ...rows];
  });
}

/** Props for `MinimisedNav`. */
export interface MinimisedNavProps {
  readonly screen: Screen;
  readonly counts: Readonly<Partial<Record<PlaceId, number>>>;
  readonly onNavigate: (screen: Screen) => void;
}

export function MinimisedNav({ screen, counts, onNavigate }: MinimisedNavProps) {
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = () => setAnchor(null);
  return (
    <div className="aplos-rail">
      <Button
        variant="icon"
        size="sm"
        icon="menu"
        label="Menu"
        commandId="app.sidebar"
        pressed={anchor !== null}
        popup={{ kind: 'menu', expanded: anchor !== null, controls: menuId }}
        ref={trigger}
        onPress={() => setAnchor(trigger.current)}
      />
      <Menu
        open={anchor !== null}
        anchor={anchor}
        label="Places"
        entries={minimisedEntries(counts)}
        checkedId={screenPlace(screen) ?? undefined}
        onSelect={id => {
          close();
          onNavigate(placeScreen(id as PlaceId));
        }}
        onClose={close}
      />
    </div>
  );
}
