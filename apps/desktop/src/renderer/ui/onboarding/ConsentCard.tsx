import type { ConsentCardProps } from '../props';
import { OnbIcon } from './icons';
import { StepAction } from './StepAction';

/**
 * The AI step's one card (`--elev-card`): Provider, Model and "What is sent", then Allow (filled, Return) and
 * "Not now". Background summaries wait for the answer (DESIGN 7.11). Esc and Return are routed by the command
 * registry; Allow takes focus on mount. A hosted provider adds the lock line about Ollama and LM Studio.
 */
export function ConsentCard({
  provider,
  model,
  sent,
  showLocalNote,
  onAllow,
  onNotNow,
}: ConsentCardProps) {
  return (
    <section className="ui-consent-card" aria-label="What is sent">
      <div className="ui-consent-card__card">
        <dl className="ui-consent-card__facts">
          <dt>Provider</dt>
          <dd>{provider}</dd>
          <dt>Model</dt>
          <dd>{model}</dd>
          <dt>What is sent</dt>
          <dd>{sent}</dd>
        </dl>
      </div>
      {showLocalNote ? (
        <p className="ui-consent-card__note">
          <OnbIcon name="lock" />
          Ollama and LM Studio keep all of this on your Mac.
        </p>
      ) : null}
      <div className="ui-consent-card__actions">
        <StepAction
          placement="body"
          autoFocus
          button={{
            label: 'Allow',
            emphasis: 'filled',
            keys: 'Return',
            keyHint: 'always',
            onSelect: onAllow,
          }}
        />
        <StepAction
          placement="body"
          button={{ label: 'Not now', emphasis: 'text', onSelect: onNotNow }}
        />
      </div>
    </section>
  );
}
