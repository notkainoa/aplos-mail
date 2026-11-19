/**
 * Small parts the compose and ask families share until the buttons-keys family (Button, Kbd, Tooltip) lands on this
 * branch. They are deliberately the same three idioms (filled, text, icon) and the same keycap, so swapping them for
 * the real components is a one-file change. Nothing here is exported from the family barrels.
 */
import type { MouseEvent, ReactNode, Ref } from 'react';
import type { CommandId, IconName, LiteralKey } from '../props';
import { ChordText } from '../buttons-keys/keyHints';
import { Tooltip } from '../buttons-keys/Tooltip';
import { Icon } from './icons';
import { keycapsFor } from './keycaps';

/** One keycap (18 px, `--sunken`). Never revealed by hover. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="ui-compose-kbd">
      {typeof children === 'string' ? <ChordText chord={children} /> : children}
    </kbd>
  );
}

/** The keycaps of a registry command, or one literal key where DESIGN requires it (Return, Esc, Tab). */
export function Keycaps({ commandId, literal }: { commandId?: CommandId; literal?: LiteralKey }) {
  const caps = literal ? [literal as string] : keycapsFor(commandId);
  return (
    <>
      {caps.map(cap => (
        <Kbd key={cap}>{cap}</Kbd>
      ))}
    </>
  );
}

export interface BtnProps {
  variant: 'filled' | 'text' | 'icon';
  /** Visible text; for the icon variant, the accessible name and tooltip. */
  label: string;
  size?: 'sm' | 'md';
  icon?: IconName;
  trailingIcon?: IconName;
  commandId?: CommandId;
  keys?: LiteralKey;
  /** 'always' draws the keycap inline; anything else keeps it in the tooltip. */
  keyHint?: 'always' | 'tooltip';
  tone?: 'default' | 'danger';
  pressed?: boolean;
  disabled?: boolean;
  /** Tooltip text for a text button (icon buttons use `label`); the registry keys are appended. */
  hint?: string;
  /** `-1` for pointer duplicates of keys. */
  tabIndex?: number;
  onPress: (anchor: HTMLButtonElement) => void;
  id?: string;
  controls?: string;
  expanded?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

/** filled, text or icon. Press, focus and hover are in the stylesheet; this file only decides the markup. */
export function Btn(props: BtnProps) {
  const {
    variant,
    label,
    size = 'sm',
    icon,
    trailingIcon,
    commandId,
    keys,
    keyHint = 'tooltip',
    tone = 'default',
  } = props;
  const caps = keys ? [keys as string] : keycapsFor(commandId);
  const base = props.hint ?? (variant === 'icon' ? label : undefined);
  const button = (
    <button
      type="button"
      ref={props.ref}
      id={props.id}
      className="ui-compose-btn"
      data-variant={variant}
      data-size={size}
      data-tone={tone === 'danger' ? 'danger' : undefined}
      aria-label={variant === 'icon' ? label : undefined}
      aria-pressed={props.pressed}
      aria-controls={props.controls}
      aria-expanded={props.expanded}
      disabled={props.disabled}
      tabIndex={props.tabIndex}
      onClick={(event: MouseEvent<HTMLButtonElement>) => props.onPress(event.currentTarget)}
    >
      {icon ? <Icon name={icon} /> : null}
      {variant === 'icon' ? null : <span className="ui-compose-btn__label">{label}</span>}
      {trailingIcon ? <Icon name={trailingIcon} size="sm" /> : null}
      {keyHint === 'always' && caps.length ? (
        <Keycaps commandId={commandId} literal={keys} />
      ) : null}
    </button>
  );
  // The real Tooltip, not a native title: it shows on hover and on keyboard focus, carries the keycaps, and flips to
  // the side with room so a footer at the window's edge never clips it.
  if (!base) return button;
  return (
    <Tooltip label={base} commandId={commandId} keys={keys} placement="above">
      {button}
    </Tooltip>
  );
}
