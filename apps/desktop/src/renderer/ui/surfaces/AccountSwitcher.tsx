/**
 * AccountSwitcher: the sidebar's account control. The app's one monogram (ink on --raised), the account name and
 * a chevron; tooltip "Switch account"; opens the account Menu (DESIGN 4.2, 7.1).
 */
import { useId } from 'react';
import type { ComponentPropsMap } from '../props';
import { PartIcon, PartTip } from './parts';

export function AccountSwitcher({
  label,
  monogram,
  open,
  menuId,
  onOpen,
}: ComponentPropsMap['AccountSwitcher']) {
  const tipId = useId();
  return (
    <span className="ui-part-tipwrap ui-account-switcher__wrap">
      <button
        type="button"
        className="ui-account-switcher"
        data-state={open ? 'open' : 'closed'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-describedby={tipId}
        onClick={event => onOpen(event.currentTarget)}
      >
        <span className="ui-account-switcher__mono" aria-hidden="true">
          {monogram.slice(0, 2)}
        </span>
        <span className="ui-account-switcher__label">{label}</span>
        <PartIcon name="chevron-down" size="xs" />
      </button>
      <PartTip id={tipId} label="Switch account" chords={[]} />
    </span>
  );
}
