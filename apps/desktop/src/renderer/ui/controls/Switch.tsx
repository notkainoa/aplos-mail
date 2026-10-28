// Switch (DESIGN §6): 30 × 18, the thumb travels on --spring-thumb. A button with role="switch".
import type { SwitchProps } from '../props';
import { Tooltip } from '../buttons-keys/Tooltip';

export function Switch({
  checked,
  onChange,
  label,
  labelledBy,
  disabled = false,
  disabledReason,
}: SwitchProps) {
  // An explained-disabled switch stays focusable and hoverable so its tooltip can say why.
  const explained = disabled && Boolean(disabledReason);
  const control = (
    <button
      type="button"
      role="switch"
      className="ui-switch"
      data-state={checked ? 'on' : 'off'}
      aria-checked={checked}
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      disabled={disabled && !explained}
      aria-disabled={explained ? true : undefined}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
    >
      <span className="ui-switch-thumb" aria-hidden="true" />
    </button>
  );
  if (!explained) return control;
  return (
    <Tooltip label={label} detail={disabledReason}>
      {control}
    </Tooltip>
  );
}
