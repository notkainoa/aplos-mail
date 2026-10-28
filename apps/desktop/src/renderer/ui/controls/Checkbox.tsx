// Checkbox (DESIGN §4.1, §6): a --control-edge ring, a check or a dash inside. A button with role="checkbox",
// so "mixed" is a real ARIA state. Mixed becomes checked on press.
import { Icon } from '../buttons-keys/Icon';
import type { CheckboxProps } from '../props';

export function Checkbox({
  checked,
  onChange,
  label,
  labelVisible = true,
  disabled = false,
}: CheckboxProps) {
  const state = checked === 'mixed' ? 'mixed' : checked ? 'checked' : 'unchecked';
  return (
    <button
      type="button"
      role="checkbox"
      className="ui-checkbox"
      data-state={state}
      data-labelled={labelVisible ? 'true' : undefined}
      aria-checked={checked}
      aria-label={labelVisible ? undefined : label}
      disabled={disabled}
      onClick={() => onChange(checked !== true)}
    >
      <span className="ui-checkbox-box" aria-hidden="true">
        {checked === 'mixed' ? (
          <Icon name="minus" size="xs" />
        ) : checked ? (
          <Icon name="check" size="xs" />
        ) : null}
      </span>
      {labelVisible ? <span className="ui-checkbox-label">{label}</span> : null}
    </button>
  );
}
