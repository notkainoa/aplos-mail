// A plain button in the three idioms (filled, text, icon) plus an inline keycap, private to the list and
// reader families. It mirrors ButtonProps closely so it can be swapped for buttons-keys' Button + Kbd +
// Tooltip once they land. The tooltip is the native `title` for now (label plus key from the registry).

import { createContext, useContext, type MouseEvent } from 'react';
import type { IconName } from '../../props';
import { Icon } from './Icon';

/** True inside a ListBox: buttons there are pointer duplicates of their keys (README Accessibility). */
export const InListbox = createContext(false);

/** Whether the component renders inside a ListBox. */
export function useInListbox(): boolean {
  return useContext(InListbox);
}

/** One keycap: 18 px, radius 4, caption, --sunken (DESIGN §6 Kbd). Shown always where it is rendered; never by hover. */
export function Keycap({ chord }: { chord: string }) {
  if (!chord) return null;
  return <kbd className="ui-list-kbd">{chord}</kbd>;
}

export interface ActionProps {
  variant: 'filled' | 'text' | 'icon';
  /** 28 / 32 px. */
  size?: 'sm' | 'md';
  /** Visible label, or the accessible name of an icon button. */
  label: string;
  icon?: IconName;
  /** Inline keycap (main actions only). */
  keycap?: string;
  /** Tooltip text; defaults to the label. */
  tooltip?: string;
  /** Hide the label visually (narrow focus letter); it stays the accessible name. */
  labelHidden?: boolean;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  /** Inside an option: tabIndex -1 and aria-hidden, a pointer duplicate of its key. */
  duplicate?: boolean;
  pressed?: boolean;
  expanded?: boolean;
  controls?: string;
  onPress: (anchor: HTMLButtonElement) => void;
}

/** Plain button: radius 8, press scale, focus ring; one filled per screen is the caller's job. */
export function Action({
  variant,
  size = 'sm',
  label,
  icon,
  keycap,
  tooltip,
  labelHidden,
  tone = 'default',
  disabled,
  duplicate,
  pressed,
  expanded,
  controls,
  onPress,
}: ActionProps) {
  const iconOnly = variant === 'icon' || labelHidden === true;
  const handle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!disabled) onPress(event.currentTarget);
  };
  return (
    <button
      type="button"
      className="ui-list-btn"
      data-variant={variant}
      data-size={size}
      data-tone={tone === 'danger' ? 'danger' : undefined}
      data-label-hidden={labelHidden ? 'true' : undefined}
      aria-label={iconOnly ? label : undefined}
      title={tooltip ?? label}
      tabIndex={duplicate ? -1 : undefined}
      aria-hidden={duplicate ? true : undefined}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-controls={controls}
      disabled={disabled}
      onClick={handle}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {icon ? <Icon name={icon} /> : null}
      {variant === 'icon' || labelHidden ? null : <span className="ui-list-btn__label">{label}</span>}
      {keycap ? <Keycap chord={keycap} /> : null}
    </button>
  );
}
