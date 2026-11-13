import { useId } from 'react';
import type { OnboardingStepProps } from '../props';
import { OnbIcon } from './icons';
import { StepAction } from './StepAction';

const DEMO_TIP = 'Load sample mail to look around. Remove it any time in Settings.';

/**
 * One onboarding step in the separate 640 × 600 window (DESIGN 6, 7.11, 7.12): full-bleed white paper, the 48 px
 * strip with "Try demo mail", a top-anchored sans `heading` title inside a 64 px side margin (Welcome alone is a
 * centred `display` line with `safe center`), a lede, the body, an action row and the footer with the step
 * dashes, the fixed note and the step's buttons. One visually hidden `role="status"` carries the phase text.
 * Return and Esc are routed by the command registry, not here; the filled action takes focus on mount.
 */
export function OnboardingStep({
  layout,
  title,
  titleId,
  lede,
  children,
  moreOptions,
  actions,
  footer,
  onTryDemo,
  phaseStatus,
}: OnboardingStepProps) {
  const uid = useId();
  const tipId = `${uid}-demo`;
  const moreId = `${uid}-more`;
  const firstFilled = actions?.findIndex(a => a.emphasis === 'filled') ?? -1;
  const { dashes, note, buttons } = footer;

  return (
    <div className="ui-onboarding-step" data-layout={layout}>
      <div className="ui-onboarding-step__strip">
        {onTryDemo ? (
          <>
            <button
              type="button"
              className="ui-onb-button ui-onboarding-step__demo"
              data-variant="text"
              data-size="xs"
              title={DEMO_TIP}
              aria-describedby={tipId}
              onClick={onTryDemo}
            >
              Try demo mail
            </button>
            <span className="ui-onboarding-step__sr" id={tipId}>
              {DEMO_TIP}
            </span>
          </>
        ) : null}
      </div>

      <main className="ui-onboarding-step__body" data-layout={layout} aria-labelledby={titleId}>
        <div className="ui-onboarding-step__content">
          <header className="ui-onboarding-step__head">
            <h1 className="ui-onboarding-step__title" id={titleId} dir="auto">
              {title}
            </h1>
            {lede ? <p className="ui-onboarding-step__lede">{lede}</p> : null}
          </header>
          {children}
          {moreOptions ? (
            <>
              <button
                type="button"
                className="ui-onb-button ui-onboarding-step__more"
                data-variant="text"
                data-size="sm"
                aria-expanded={moreOptions.expanded}
                aria-controls={moreId}
                onClick={moreOptions.onToggle}
              >
                <span>More options</span>
                <span
                  className="ui-onboarding-step__chevron"
                  data-expanded={moreOptions.expanded ? 'true' : 'false'}
                >
                  <OnbIcon name="chevron-down" />
                </span>
              </button>
              <div
                className="ui-onboarding-step__more-content"
                id={moreId}
                hidden={!moreOptions.expanded}
              >
                {moreOptions.content}
              </div>
            </>
          ) : null}
          {actions && actions.length > 0 ? (
            <div className="ui-onboarding-step__actions">
              {actions.map((button, i) => (
                <StepAction
                  key={button.label}
                  button={button}
                  placement="body"
                  autoFocus={i === firstFilled}
                />
              ))}
            </div>
          ) : null}
        </div>
      </main>

      <footer className="ui-onboarding-step__foot">
        {dashes ? (
          <div className="ui-onboarding-step__steps">
            <div
              className="ui-onboarding-step__dashes"
              role="img"
              aria-label={`Step ${dashes.step} of ${dashes.of}`}
            >
              {Array.from({ length: dashes.of }, (_, i) => (
                <i
                  key={i}
                  data-state={i + 1 < dashes.step ? 'done' : i + 1 === dashes.step ? 'on' : 'todo'}
                />
              ))}
            </div>
            <span className="ui-onboarding-step__where" aria-hidden="true">
              {`Step ${dashes.step} of ${dashes.of}`}
            </span>
          </div>
        ) : null}
        <span className="ui-onboarding-step__note">
          {note === 'setupContinues' ? (
            'Setup continues in the background.'
          ) : (
            <>
              <kbd className="ui-onb-kbd">Esc</kbd> opens Aplos
            </>
          )}
        </span>
        <div className="ui-onboarding-step__buttons">
          {buttons.map(button => (
            <StepAction key={button.label} button={button} placement="footer" />
          ))}
        </div>
      </footer>

      <p className="ui-onboarding-step__sr" role="status">
        {phaseStatus}
      </p>
    </div>
  );
}
