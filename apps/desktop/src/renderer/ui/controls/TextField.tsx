// TextField (DESIGN §6, §11.1): --sunken fill and a calm --line-strong ring at rest (decision 20). Under Increase
// Contrast the tokens remap --line-strong to --control-edge, so this file needs no second rule.
// The name is always real: a visible <label>, or aria-label when the design is placeholder-led.
import type { KeyboardEvent } from 'react';
import { Icon } from '../buttons-keys/Icon';
import { Kbd } from '../buttons-keys/Kbd';
import type { TextFieldProps } from '../props';

export function TextField({
  id,
  value,
  onChange,
  label,
  labelVisible = false,
  placeholder,
  type = 'text',
  size = 'md',
  icon,
  trailingKeys,
  mono = false,
  error,
  disabled = false,
  readOnly = false,
  onSubmit,
  autoFocus,
  ref,
}: TextFieldProps) {
  const errorId = `${id}-error`;
  const state = error ? 'invalid' : disabled ? 'disabled' : readOnly ? 'readonly' : undefined;
  // Addresses, server URLs and keys are not prose: no autocorrect, no capital, no spell check.
  const literal = mono || type === 'email' || type === 'url' || type === 'password';

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || !onSubmit) return;
    event.preventDefault();
    onSubmit();
  };

  return (
    <div
      className="ui-text-field"
      data-size={size}
      data-state={state}
      data-mono={mono ? 'true' : undefined}
    >
      {labelVisible ? (
        <label className="ui-text-field-label" htmlFor={id}>
          {label}
        </label>
      ) : null}
      <div className="ui-text-field-box">
        {icon ? <Icon name={icon} /> : null}
        <input
          ref={ref}
          id={id}
          className="ui-text-field-input"
          type={type}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readOnly}
          autoFocus={autoFocus}
          aria-label={labelVisible ? undefined : label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          autoComplete="off"
          autoCapitalize={literal ? 'off' : undefined}
          autoCorrect={literal ? 'off' : undefined}
          spellCheck={literal ? false : undefined}
          onChange={event => onChange(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {trailingKeys ? (
          <span className="ui-text-field-keys" aria-hidden="true">
            <Kbd chord={trailingKeys} reveal="always" />
          </span>
        ) : null}
      </div>
      {error ? (
        <p id={errorId} className="ui-text-field-error" role="status">
          <Icon name="alert" size="sm" />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
