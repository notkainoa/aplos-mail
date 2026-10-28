// A plain button in the three idioms (filled, text, icon) plus an inline keycap, private to the list and
// reader families. It mirrors ButtonProps closely so it can be swapped for buttons-keys' Button + Kbd +
// Tooltip once they land. The tooltip is the native `title` for now (label plus key from the registry).

import { createContext, useContext, type MouseEvent } from 'react';
import type { IconName, KeyHint } from '../../props';
import { Icon } from './Icon';
import { showsInline, useShowKeys } from './keyHints';

/** True inside a ListBox: buttons there are pointer duplicates of their keys (README Accessibility). */
export const InListbox = createContext(false);

/** Whether the component renders inside a ListBox. */
export function useInListbox(): boolean {
  return useContext(InListbox);
}

/** One keycap: 18 px, radius 4, caption, --sunken (DESIGN §6 Kbd). Shown always where it is rendered; never by hover. */
export function Keycap({ chord, reveal }: { chord: string; reveal?: 'hint' | 'badge' }) {
  if (!chord) return null;
  return (
    <kbd className="ui-list-kbd" data-reveal={reveal} aria-hidden={reveal ? true : undefined}>
      {chord}
    </kbd>
  );
}

export interface ActionProps {
  variant: 'filled' | 'text' | 'icon';
  /** 28 / 32 px. */
  size?: 'sm' | 'md';
  /** Visible label, or the accessible name of an icon button. */
  label: string;
  icon?: IconName;
  /** Inline keycap shown always (main actions only: Space, Return). */
  keycap?: string;
  /** The command's keycap for the key-hint modes: inline with "Show all key hints" when `keyHint` is 'hint', a badge while ⌘ is held. */
  hintKey?: string;
  /** Where `hintKey` shows inline (DESIGN §8); default 'tooltip' = only in the tooltip and the ⌘-held badge. */
  keyHint?: KeyHint;
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
  hintKey,
  keyHint = 'tooltip',
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
  const showKeys = useShowKeys();
  const hintInline = !keycap && !!hintKey && showsInline(keyHint, showKeys);
  const hintBadge = !keycap && !hintInline && !!hintKey && showKeys === 'held';
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
      onDoubleClick={event => event.stopPropagation()}
    >
      {icon ? <Icon name={icon} /> : null}
      {variant === 'icon' || labelHidden ? null : (
        <span className="ui-list-btn__label">{label}</span>
      )}
      {keycap ? <Keycap chord={keycap} /> : null}
      {hintInline && hintKey ? <Keycap chord={hintKey} reveal="hint" /> : null}
      {hintBadge && hintKey ? <Keycap chord={hintKey} reveal="badge" /> : null}
    </button>
  );
}
