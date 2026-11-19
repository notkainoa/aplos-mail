/** The bulk bar's More menu (DESIGN 7.4): small, anchored to the More button, closed by Esc or a choice. */
import { Menu } from '../../ui/surfaces';
import type { BulkMenu as BulkMenuState } from './useBulkBar';

export function BulkMenu({ menu }: { readonly menu: BulkMenuState }) {
  return (
    <Menu
      open={menu.anchor !== null}
      anchor={menu.anchor}
      label="More"
      entries={menu.entries}
      onSelect={menu.onSelect}
      onClose={menu.onClose}
    />
  );
}
