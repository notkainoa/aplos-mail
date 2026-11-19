// Button (DESIGN §4.6, §6): three idioms only, filled | text | icon. Radius 8, heights 28 / 32 / 40, press inset.
// One filled button per screen, owned by the topmost surface; that is the screen's job, not this file's.
// Keycaps: inline when keyHint says so ('always', or 'hint' in "Show all key hints"), a badge overlay while ⌘ is
// held, and always in the tooltip. Hover never reveals one.
import { useId, useRef, useState, type MouseEvent, type RefObject } from 'react';
import { timing } from '../generated/motion';
import type { ButtonProps } from '../props';
import { buttonNaming, type ButtonNaming } from './buttonName';
import { Icon } from './Icon';
import { KeyCaps } from './Kbd';
import { showsInline, useControlKeys, useKeyHints } from './keyHints';
import { Tooltip } from './Tooltip';
import { useDelayedFlag } from './useDelayedFlag';

interface ButtonModel {
  labelVisible: boolean;
  caps: ReturnType<typeof useControlKeys>;
  // An explained-disabled button stays focusable and hoverable so its tooltip can say why.
  explained: boolean;
  inline: boolean;
  badge: boolean;
  needsTooltip: boolean;
  spinning: boolean;
}

/** What the button shows, derived from its props and the key-hint settings. */
function useButtonModel(props: ButtonProps): ButtonModel {
  const { variant, commandId, keys, keyHint = 'tooltip', disabled = false, busy = false } = props;
  const labelVisible = variant !== 'icon' || props.labelVisible === true;
  const caps = useControlKeys(commandId, keys);
  const { showKeys } = useKeyHints();
  const showSpinner = useDelayedFlag(busy, timing.spinnerDelay);
  const explained = disabled && Boolean(props.disabledReason);
  const inline = labelVisible && showsInline(keyHint, showKeys);
  const badge = !inline && showKeys === 'held';
  const needsTooltip = variant === 'icon' || explained || (caps.length > 0 && keyHint !== 'always');
  return {
    labelVisible,
    caps,
    explained,
    inline,
    badge,
    needsTooltip,
    spinning: busy && showSpinner,
  };
}

/** A long label ellipsises inside its container; the full text is the native title, set only while it is clipped. */
function useLabelClip() {
  const labelRef = useRef<HTMLSpanElement | null>(null);
  const [clipped, setClipped] = useState(false);
  const checkClipped = () => {
    const el = labelRef.current;
    setClipped(
      Boolean(el) && (el as HTMLSpanElement).scrollWidth > (el as HTMLSpanElement).clientWidth,
    );
  };
  return { labelRef, clipped, checkClipped };
}

/** The attributes of the <button>, in the order the markup has always carried them. */
function buttonAttributes(
  props: ButtonProps,
  model: ButtonModel,
  clip: { clipped: boolean; checkClipped: () => void },
  naming: ButtonNaming,
) {
  const {
    variant,
    label,
    size = 'md',
    icon,
    tone = 'default',
    disabled = false,
    busy = false,
  } = props;
  const { labelVisible, explained, needsTooltip, spinning } = model;
  const { popup } = props;
  const state = disabled ? 'disabled' : busy ? 'busy' : undefined;
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (disabled || busy) {
      event.preventDefault();
      return;
    }
    props.onPress();
  };
  return {
    ref: props.ref,
    id: naming.buttonId,
    type: props.type ?? 'button',
    className: 'ui-button',
    'data-variant': variant,
    'data-size': size,
    'data-tone': tone,
    'data-state': state,
    'data-labelled': labelVisible ? 'true' : undefined,
    'data-spinner': spinning ? (icon ? 'icon' : 'overlay') : undefined,
    // Only without a tooltip, which already says the label.
    title: labelVisible && !needsTooltip && clip.clipped ? label : undefined,
    disabled: disabled && !explained,
    'aria-disabled': explained ? true : undefined,
    'aria-label': naming.ariaLabel,
    'aria-labelledby': naming.labelledby,
    'aria-pressed': props.pressed,
    'aria-busy': busy || undefined,
    'aria-haspopup': popup ? popup.kind : undefined,
    'aria-expanded': popup ? popup.expanded : undefined,
    'aria-controls': popup?.controls,
    onClick,
    onPointerEnter: labelVisible ? clip.checkClipped : undefined,
    onFocus: labelVisible ? clip.checkClipped : undefined,
  };
}

interface FaceProps {
  props: ButtonProps;
  model: ButtonModel;
  labelRef: RefObject<HTMLSpanElement | null>;
  labelId: string | undefined;
}

/** Spinner or icon, label, trailing icon, then the inline keycap or the held-⌘ badge. */
function ButtonFace({ props, model, labelRef, labelId }: FaceProps) {
  const { icon, trailingIcon, label } = props;
  const { labelVisible, caps, inline, badge, spinning } = model;
  const hasCaps = caps.length > 0;
  return (
    <>
      {spinning ? (
        <span className="ui-button-spinner" aria-hidden="true" />
      ) : icon ? (
        <Icon name={icon} />
      ) : null}
      {labelVisible ? (
        <span ref={labelRef} id={labelId} className="ui-button-label">
          {label}
        </span>
      ) : null}
      {trailingIcon ? <Icon name={trailingIcon} size="xs" /> : null}
      {inline && hasCaps ? (
        <span className="ui-button-keys" aria-hidden="true">
          <KeyCaps caps={caps.slice(0, 1)} reveal="always" />
        </span>
      ) : null}
      {badge && hasCaps ? (
        <span className="ui-button-badge" aria-hidden="true">
          <KeyCaps caps={caps.slice(0, 1)} reveal="badge" />
        </span>
      ) : null}
    </>
  );
}

export function Button(props: ButtonProps) {
  const model = useButtonModel(props);
  const { labelRef, clipped, checkClipped } = useLabelClip();
  const naming = buttonNaming(props, model.labelVisible, useId());
  const button = (
    <button {...buttonAttributes(props, model, { clipped, checkClipped }, naming)}>
      <ButtonFace props={props} model={model} labelRef={labelRef} labelId={naming.labelId} />
    </button>
  );

  if (!model.needsTooltip) return button;
  return (
    <Tooltip
      label={props.label}
      detail={model.explained ? props.disabledReason : undefined}
      commandId={props.commandId}
      keys={props.keys}
      disabled={props.popup?.expanded}
    >
      {button}
    </Tooltip>
  );
}
