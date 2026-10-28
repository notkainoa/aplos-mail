// Button (DESIGN §4.6, §6): three idioms only, filled | text | icon. Radius 8, heights 28 / 32 / 40, press inset.
// One filled button per screen, owned by the topmost surface; that is the screen's job, not this file's.
// Keycaps: inline when keyHint says so ('always', or 'hint' in "Show all key hints"), a badge overlay while ⌘ is
// held, and always in the tooltip. Hover never reveals one.
import { useRef, useState, type MouseEvent } from 'react';
import { timing } from '../generated/motion';
import type { ButtonProps } from '../props';
import { Icon } from './Icon';
import { KeyCaps } from './Kbd';
import { showsInline, useControlKeys, useKeyHints } from './keyHints';
import { Tooltip } from './Tooltip';
import { useDelayedFlag } from './useDelayedFlag';

export function Button(props: ButtonProps) {
  const {
    variant,
    label,
    size = 'md',
    icon,
    trailingIcon,
    commandId,
    keys,
    keyHint = 'tooltip',
    tone = 'default',
    disabled = false,
    disabledReason,
    busy = false,
    pressed,
    popup,
    onPress,
    type = 'button',
    id,
    ref,
  } = props;
  const labelVisible = variant !== 'icon' || props.labelVisible === true;
  const caps = useControlKeys(commandId, keys);
  const { showKeys } = useKeyHints();
  const showSpinner = useDelayedFlag(busy, timing.spinnerDelay);
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const [clipped, setClipped] = useState(false);

  // An explained-disabled button stays focusable and hoverable so its tooltip can say why.
  const explained = disabled && Boolean(disabledReason);
  const inline = labelVisible && showsInline(keyHint, showKeys);
  const badge = !inline && showKeys === 'held';
  const needsTooltip = variant === 'icon' || explained || (caps.length > 0 && keyHint !== 'always');
  const state = disabled ? 'disabled' : busy ? 'busy' : undefined;
  const spinning = busy && showSpinner;
  // A long label ellipsises inside its container; the full text is the native title, set only while it is clipped
  // (and only without a tooltip, which already says the label).
  const checkClipped = () => {
    const el = labelRef.current;
    setClipped(Boolean(el) && (el as HTMLSpanElement).scrollWidth > (el as HTMLSpanElement).clientWidth);
  };

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (disabled || busy) {
      event.preventDefault();
      return;
    }
    onPress();
  };

  const button = (
    <button
      ref={ref}
      id={id}
      type={type}
      className="ui-button"
      data-variant={variant}
      data-size={size}
      data-tone={tone}
      data-state={state}
      data-labelled={labelVisible ? 'true' : undefined}
      data-spinner={spinning ? (icon ? 'icon' : 'overlay') : undefined}
      title={labelVisible && !needsTooltip && clipped ? label : undefined}
      disabled={disabled && !explained}
      aria-disabled={explained ? true : undefined}
      aria-label={labelVisible ? undefined : label}
      aria-pressed={pressed}
      aria-busy={busy || undefined}
      aria-haspopup={popup ? popup.kind : undefined}
      aria-expanded={popup ? popup.expanded : undefined}
      aria-controls={popup?.controls}
      onClick={onClick}
      onPointerEnter={labelVisible ? checkClipped : undefined}
      onFocus={labelVisible ? checkClipped : undefined}
    >
      {spinning ? (
        <span className="ui-button-spinner" aria-hidden="true" />
      ) : icon ? (
        <Icon name={icon} />
      ) : null}
      {labelVisible ? <span ref={labelRef} className="ui-button-label">{label}</span> : null}
      {trailingIcon ? <Icon name={trailingIcon} size="xs" /> : null}
      {inline && caps.length > 0 ? (
        <span className="ui-button-keys" aria-hidden="true">
          <KeyCaps caps={caps.slice(0, 1)} reveal="always" />
        </span>
      ) : null}
      {badge && caps.length > 0 ? (
        <span className="ui-button-badge" aria-hidden="true">
          <KeyCaps caps={caps.slice(0, 1)} reveal="badge" />
        </span>
      ) : null}
    </button>
  );

  if (!needsTooltip) return button;
  return (
    <Tooltip
      label={label}
      detail={explained ? disabledReason : undefined}
      commandId={commandId}
      keys={keys}
      disabled={popup?.expanded}
    >
      {button}
    </Tooltip>
  );
}
