import { useId } from 'react';
import type { StepLogProps } from '../props';
import { Icon } from '../compose/icons';

/**
 * One steady line naming the real step ("Reading 14 emails from Jordan"), which folds into a dim, expandable step log
 * once the answer lands (DESIGN §6 StepLog, §7.7). While working the line is a polite status with one thin,
 * non-blinking caret: no shimmer, no pulsing dot. Folded, it is a disclosure button with the finished steps below.
 */
export function StepLog({ current, summary, steps, expanded, onToggle }: StepLogProps) {
  const listId = useId();
  if (current) {
    return (
      <div className="ui-step-log" data-state="working">
        <p className="ui-step-log__current" role="status" dir="auto">
          {current}
          <span className="ui-step-log__caret" aria-hidden="true" />
        </p>
      </div>
    );
  }
  return (
    <div className="ui-step-log" data-state={expanded ? 'open' : 'folded'}>
      <button
        type="button"
        className="ui-step-log__toggle"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={onToggle}
      >
        <Icon name="chevron-right" size="xs" />
        <span dir="auto">{summary}</span>
      </button>
      <ul id={listId} className="ui-step-log__steps" hidden={!expanded}>
        {steps.map((step, index) => (
          <li key={`${index}:${step}`} dir="auto">
            {step}
          </li>
        ))}
      </ul>
    </div>
  );
}
