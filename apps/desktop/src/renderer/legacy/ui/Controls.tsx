import { ChevronsUpDown } from '../icons';
import { cx } from './motion';

/** An on/off switch: the thumb slides, stretches while pressed, and the track tint fades. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cx('ui-switch', checked && 'is-on', className)}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-switch-thumb" />
    </button>
  );
}

/** A checkbox whose tick draws itself in. */
export function Checkbox({
  checked,
  onChange,
  label,
  hideLabel,
  disabled,
  indeterminate,
  className,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hideLabel?: boolean;
  disabled?: boolean;
  indeterminate?: boolean;
  className?: string;
}) {
  return (
    <label className={cx('ui-checkbox', disabled && 'is-disabled', className)}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={hideLabel ? label : undefined}
        ref={el => {
          if (el) el.indeterminate = !!indeterminate;
        }}
        onChange={e => onChange(e.target.checked)}
      />
      <span className="ui-checkbox-box" aria-hidden="true">
        <svg viewBox="0 0 12 12">
          {indeterminate ? <path d="M3 6h6" /> : <path d="M2.6 6.3l2.2 2.2 4.6-4.9" />}
        </svg>
      </span>
      {!hideLabel && <span className="ui-checkbox-label">{label}</span>}
    </label>
  );
}

type SelectProps<T extends string> = {
  value: T;
  onChange: (value: T) => void;
  options: [T, string][] | { value: T; label: string; disabled?: boolean }[];
  label: string;
  variant?: 'plain' | 'field';
  disabled?: boolean;
  className?: string;
};
/**
 * A pop-up button over a native select, so macOS shows its own menu while the closed
 * control matches the rest of the interface.
 */
export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  variant = 'plain',
  disabled,
  className,
}: SelectProps<T>) {
  const list = options.map(option =>
    Array.isArray(option) ? { value: option[0], label: option[1], disabled: false } : option,
  );
  const current = list.find(option => option.value === value);
  return (
    <span className={cx('ui-select', 'ui-select-' + variant, disabled && 'is-disabled', className)}>
      <span className="ui-select-value" aria-hidden="true">
        {current?.label ?? 'Choose…'}
      </span>
      <ChevronsUpDown size={13} />
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value as T)}
      >
        {list.map(option => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  );
}

/** A labelled text field. */
export function Field({
  label,
  children,
  hint,
  className,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
  className?: string;
}) {
  return (
    <label className={cx('ui-field', className)}>
      <span className="ui-field-label">{label}</span>
      {children}
      {hint && <span className="ui-field-hint">{hint}</span>}
    </label>
  );
}
