import type { CSSProperties, KeyboardEvent } from 'react';
import { useId } from 'react';
import type { ProposalCardProps } from '../props';
import { Icon } from '../compose/icons';
import { Btn } from '../compose/parts';

/**
 * The dock's one card, and the owner of its filled button (DESIGN §6 ProposalCard, §7.7, §9 rule 6): a kicker, the
 * item with its calendar mark, a consequence line, and two key rows, "Add" with Return and "Not now" with Esc. Nothing
 * is applied without a confirmation. Applied, it collapses to one check line; dismissed, it renders nothing.
 * Return and Esc belong to the registry (`ask.acceptProposal`, `ask.declineProposal`). Inside the card, Return is the
 * focused button's own click, and Esc is handled here only when the registry has not already taken it, so a dismissal
 * never runs twice.
 */
export function ProposalCard(props: ProposalCardProps) {
  const {
    kicker,
    title,
    consequence,
    color,
    confirmLabel,
    state,
    appliedText,
    onConfirm,
    onDismiss,
  } = props;
  const titleId = useId();

  if (state === 'dismissed') return null;
  if (state === 'applied') {
    return (
      <p className="ui-proposal-card" data-state="applied" role="status">
        <Icon name="check" />
        <span dir="auto">{appliedText ?? 'Done'}</span>
      </p>
    );
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      onDismiss();
    }
  }

  const mark = color ? ({ '--swatch': `var(--tag-${color})` } as CSSProperties) : undefined;
  return (
    <section
      className="ui-proposal-card"
      data-state="pending"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
    >
      <p className="ui-proposal-card__kicker" dir="auto">
        {kicker}
      </p>
      <p className="ui-proposal-card__title" id={titleId}>
        {color ? <i className="ui-proposal-card__mark" style={mark} aria-hidden="true" /> : null}
        <span dir="auto">{title}</span>
      </p>
      <p className="ui-proposal-card__consequence" dir="auto">
        {consequence}
      </p>
      <div className="ui-proposal-card__keys">
        <Btn
          variant="filled"
          size="md"
          label={confirmLabel}
          commandId="ask.acceptProposal"
          keyHint="always"
          onPress={() => onConfirm()}
        />
        <Btn
          variant="text"
          size="md"
          label="Not now"
          hint="Not now"
          commandId="ask.declineProposal"
          onPress={() => onDismiss()}
        />
      </div>
    </section>
  );
}
