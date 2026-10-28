import type { CSSProperties, ReactNode } from 'react';
import type { SettingRowProps } from '../props';
import { SetIcon } from './icons';

/**
 * A settings row: 40 px, or 48 px with a one-line description of what the setting does. Hairline separators and a
 * fixed control column on the right (DESIGN 6 SettingRow, 7.10). The label element has the DOM id `id`, so the
 * control can name itself with `aria-labelledby={id}`; the description has the id `${id}-description`.
 * A folded row is one button; its long text opens beneath it.
 */
export function SettingRow({
  id,
  label,
  description,
  descriptionTone = 'default',
  tag,
  mark,
  meta,
  control,
  disclosure,
  below,
}: SettingRowProps) {
  const descriptionId = `${id}-description`;
  const contentId = `${id}-content`;

  const text: ReactNode = (
    <span className="ui-setting-row__text">
      <span className="ui-setting-row__line">
        {mark ? (
          <span
            className="ui-setting-row__mark"
            aria-hidden="true"
            style={{ '--swatch': `var(--tag-${mark})` } as CSSProperties}
          />
        ) : null}
        <span className="ui-setting-row__label" id={id} dir="auto">
          {label}
        </span>
        {meta ? <span className="ui-setting-row__meta" dir="auto">{meta}</span> : null}
        {tag ? <span className="ui-setting-row__tag">{tag}</span> : null}
      </span>
      {description ? (
        <span className="ui-setting-row__description" id={descriptionId} data-tone={descriptionTone}>
          {descriptionTone === 'attention' ? <SetIcon name="alert" /> : null}
          <span className="ui-setting-row__description-text" dir="auto">{description}</span>
        </span>
      ) : null}
    </span>
  );

  if (disclosure) {
    return (
      <div className="ui-setting-row" data-has-description={description ? 'true' : 'false'} data-disclosure="true">
        <button
          type="button"
          className="ui-setting-row__toggle"
          aria-expanded={disclosure.expanded}
          aria-controls={contentId}
          aria-describedby={description ? descriptionId : undefined}
          onClick={disclosure.onToggle}
        >
          {text}
          <span className="ui-setting-row__control" data-expanded={disclosure.expanded ? 'true' : 'false'}>
            <SetIcon name="chevron-down" />
          </span>
        </button>
        <div className="ui-setting-row__content" id={contentId} hidden={!disclosure.expanded}>
          {disclosure.content}
        </div>
        {below ? <div className="ui-setting-row__below">{below}</div> : null}
      </div>
    );
  }

  return (
    <div className="ui-setting-row" data-has-description={description ? 'true' : 'false'}>
      <div className="ui-setting-row__main">
        {text}
        {control ? <div className="ui-setting-row__control">{control}</div> : null}
      </div>
      {below ? <div className="ui-setting-row__below">{below}</div> : null}
    </div>
  );
}
