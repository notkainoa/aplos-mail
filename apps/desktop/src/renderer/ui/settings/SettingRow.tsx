import type { CSSProperties, ReactNode } from 'react';
import type { SettingRowProps } from '../props';
import { SetIcon } from './icons';

/**
 * A settings row: 40 px, or 48 px with a one-line description of what the setting does. Hairline separators and a
 * fixed control column on the right (DESIGN 6 SettingRow, 7.10). The label element has the DOM id `id`, so the
 * control can name itself with `aria-labelledby={id}`; the description has the id `${id}-description`.
 * A folded row is one button; its long text opens beneath it.
 *
 * `paletteId` (`setting.<section>.<rowAnchor>`) makes the row an anchor for deep links and ⌘K: the row element
 * gets the DOM id `<rowAnchor>` (the last segment) and `data-palette-id`, so `settings/<section>#<rowAnchor>`
 * scrolls to it and the screen can focus its control. `scroll-margin` keeps the row clear of the sticky header.
 */
/** `setting.<section>.<rowAnchor>` to `<rowAnchor>`; undefined for anything that does not have that shape. */
export function anchorOf(paletteId: string | undefined): string | undefined {
  if (!paletteId) return undefined;
  const parts = paletteId.split('.');
  return parts.length >= 3 && parts[0] === 'setting' ? parts.slice(2).join('.') : undefined;
}

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
  paletteId,
}: SettingRowProps) {
  const anchor = anchorOf(paletteId);
  // The label already owns `id`; when the anchor is the same word the label is the deep link's target.
  const rowId = anchor !== undefined && anchor !== id ? anchor : undefined;
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
        {meta ? (
          <span className="ui-setting-row__meta" dir="auto">
            {meta}
          </span>
        ) : null}
        {tag ? <span className="ui-setting-row__tag">{tag}</span> : null}
      </span>
      {description ? (
        <span
          className="ui-setting-row__description"
          id={descriptionId}
          data-tone={descriptionTone}
        >
          {descriptionTone === 'attention' ? <SetIcon name="alert" /> : null}
          <span className="ui-setting-row__description-text" dir="auto">
            {description}
          </span>
        </span>
      ) : null}
    </span>
  );

  if (disclosure) {
    return (
      <div
        id={rowId}
        className="ui-setting-row"
        data-has-description={description ? 'true' : 'false'}
        data-disclosure="true"
        data-setting-anchor={anchor}
      >
        <button
          type="button"
          className="ui-setting-row__toggle"
          aria-expanded={disclosure.expanded}
          aria-controls={contentId}
          aria-describedby={description ? descriptionId : undefined}
          onClick={disclosure.onToggle}
        >
          {text}
          <span
            className="ui-setting-row__control"
            data-expanded={disclosure.expanded ? 'true' : 'false'}
          >
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
    <div
      id={rowId}
      className="ui-setting-row"
      data-has-description={description ? 'true' : 'false'}
      data-setting-anchor={anchor}
    >
      <div className="ui-setting-row__main">
        {text}
        {control ? <div className="ui-setting-row__control">{control}</div> : null}
      </div>
      {below ? <div className="ui-setting-row__below">{below}</div> : null}
    </div>
  );
}
