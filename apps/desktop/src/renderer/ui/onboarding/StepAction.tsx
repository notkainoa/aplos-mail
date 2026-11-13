import type { StepButton } from '../props';
import { displayChord } from '../buttons-keys/keyHints';
import { OnbIcon } from './icons';
import { keycapOfButton } from './keycaps';

/**
 * A button of an onboarding step: the filled main action (Return, 40 px in the body) or a quiet text verb. Its
 * keycap shows inline when `keyHint` is 'always' (the filled default), only with "Show all key hints" for 'hint',
 * and only in the tooltip for 'tooltip' (the text default). Never revealed by hover (DESIGN 5 rule 17, 8).
 * Internal to the onboarding family.
 */
export function StepAction({
  button,
  placement,
  autoFocus,
}: {
  button: StepButton;
  placement: 'body' | 'footer';
  autoFocus?: boolean;
}) {
  const key = keycapOfButton(button);
  const hint = button.keyHint ?? (button.emphasis === 'filled' ? 'always' : 'tooltip');
  const size = button.emphasis === 'filled' ? (placement === 'body' ? 'lg' : 'md') : 'sm';
  return (
    <button
      type="button"
      className="ui-onb-button"
      data-variant={button.emphasis}
      data-size={size}
      data-busy={button.busy ? 'true' : undefined}
      aria-busy={button.busy ? true : undefined}
      disabled={button.disabled}
      autoFocus={autoFocus}
      title={key ? `${button.label} · ${displayChord(key)}` : undefined}
      onClick={button.onSelect}
    >
      {button.icon ? <OnbIcon name={button.icon} /> : null}
      <span>{button.label}</span>
      {button.busy ? <span className="ui-onb-spinner" aria-hidden="true" /> : null}
      {key && hint !== 'tooltip' ? (
        <kbd className="ui-onb-kbd" data-key-hint={hint}>
          {displayChord(key)}
        </kbd>
      ) : null}
    </button>
  );
}
